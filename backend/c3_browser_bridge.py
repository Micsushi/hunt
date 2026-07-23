from __future__ import annotations

import json
import os
import re
from typing import Any
from urllib.request import Request, urlopen


class C3BrowserBridgeError(RuntimeError):
    pass


_MAX_BRIDGE_TIMEOUT_MS = 300_000
_MUTATING_C3_COMMANDS = {
    "c3.fill_page",
    "c3.fill_remaining_with_llm",
    "c3.page_walk",
    "c3.click_next_after_fill",
    "c3.clear_page",
    "c3.cancel_session",
}


def _bounded_bridge_timeout_ms(value: Any) -> int:
    try:
        timeout_ms = int(value or 0)
    except (TypeError, ValueError, OverflowError):
        return 0
    return max(0, min(_MAX_BRIDGE_TIMEOUT_MS, timeout_ms))


RESERVED_C3_COMMAND_PAYLOAD_KEYS = frozenset(
    {
        "operationid",
        "allowsubmit",
        "triggeredby",
        "fillrunid",
        "allowforeground",
        "bringtofront",
        "bridgetimeoutms",
        "runid",
        "capabilities",
        "commandid",
        "traceid",
        "agentid",
        "laneid",
        "sessionid",
        "leaseid",
        "browsertargetid",
    }
)


def sanitize_c3_command_payload(value: Any) -> Any:
    """Recursively remove fields whose values must be owned by the backend/runtime."""

    if isinstance(value, dict):
        safe: dict[str, Any] = {}
        for key, item in value.items():
            normalized = re.sub(r"[^a-z0-9]", "", str(key).lower())
            if normalized in RESERVED_C3_COMMAND_PAYLOAD_KEYS:
                continue
            safe[str(key)] = sanitize_c3_command_payload(item)
        return safe
    if isinstance(value, list):
        return [sanitize_c3_command_payload(item) for item in value]
    if isinstance(value, tuple):
        return [sanitize_c3_command_payload(item) for item in value]
    return value


def c3_bridge_response_ok(response: Any) -> bool:
    if not isinstance(response, dict):
        return False
    receipt = response.get("commandReceipt")
    if isinstance(receipt, dict) and "ok" in receipt:
        return receipt.get("ok") is True
    return response.get("ok") is True


def run_c3_extension_command(target: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    """Send one command to the C3 extension through an existing CDP browser."""

    debug_port = int(target.get("debug_port") or 0)
    extension_id = str(target.get("extension_id") or "").strip()
    options_url = str(target.get("options_url") or "").strip()
    if not options_url and extension_id:
        options_url = f"chrome-extension://{extension_id}/src/options/options.html"
    if not debug_port or not extension_id:
        raise C3BrowserBridgeError("missing_debug_port_or_extension_id")
    bridge_timeout_ms = _bounded_bridge_timeout_ms(payload.get("bridge_timeout_ms"))
    expected_target_id = str(target.get("target_id") or "").strip()
    expected_tab_id = target.get("tab_id")
    if str(payload.get("command_name") or "") in _MUTATING_C3_COMMANDS and not expected_target_id:
        raise C3BrowserBridgeError("registered_target_identity_missing")
    if expected_target_id and (
        isinstance(expected_tab_id, bool) or not isinstance(expected_tab_id, int)
    ):
        raise C3BrowserBridgeError("registered_tab_identity_missing")

    try:
        from playwright.sync_api import sync_playwright
    except Exception as exc:  # pragma: no cover - import depends on runtime image
        raise C3BrowserBridgeError("playwright_unavailable") from exc

    hosts = _candidate_cdp_hosts(target)
    last_error: Exception | None = None
    with sync_playwright() as playwright:
        browser = None
        for host in hosts:
            try:
                endpoint = f"http://{host}:{debug_port}"
                kwargs = {}
                if bridge_timeout_ms:
                    kwargs["timeout"] = bridge_timeout_ms
                if host not in {"127.0.0.1", "localhost"}:
                    endpoint = _rewritten_cdp_websocket_url(host, debug_port)
                    kwargs["headers"] = {"Host": f"127.0.0.1:{debug_port}"}
                browser = playwright.chromium.connect_over_cdp(
                    endpoint,
                    **kwargs,
                )
                break
            except Exception as exc:  # pragma: no cover - live CDP availability
                last_error = exc
        if browser is None:
            detail = ""
            if last_error is not None:
                detail = f":{type(last_error).__name__}:{str(last_error)[:180]}"
            raise C3BrowserBridgeError(f"cdp_connect_failed{detail}") from last_error
        try:
            page = _find_extension_page(browser, options_url, extension_id)
            if page is None:
                page = _open_extension_page(
                    browser,
                    options_url,
                    timeout_ms=bridge_timeout_ms or 10_000,
                )
            return page.evaluate(
                """
                async ({ payload, targetUrl, expectedTargetId, expectedTabId }) => {
                  let tabId = payload.tab_id || payload.tabId || payload.command_payload?.tabId;
                  if (expectedTargetId) {
                    if (!Number.isInteger(Number(tabId)) || Number(tabId) !== Number(expectedTabId)) {
                      return { ok: false, reason: "registered_tab_identity_mismatch" };
                    }
                    if (!chrome.debugger?.getTargets) {
                      return { ok: false, reason: "registered_target_identity_unavailable" };
                    }
                    const targets = await chrome.debugger.getTargets();
                    const registered = targets.find(
                      (candidate) => Number(candidate.tabId) === Number(expectedTabId)
                    );
                    if (!registered || String(registered.id || "") !== String(expectedTargetId)) {
                      return { ok: false, reason: "registered_target_identity_mismatch" };
                    }
                  }
                  if (!tabId && targetUrl && targetUrl !== "about:blank") {
                    const wanted = String(targetUrl);
                    const wantedNoHash = wanted.split("#")[0];
                    const tabs = await chrome.tabs.query({});
                    let tab = tabs.find((candidate) => candidate.url === wanted);
                    if (!tab) {
                      tab = tabs.find((candidate) => String(candidate.url || "").split("#")[0] === wantedNoHash);
                    }
                    if (!tab) {
                      tab = await chrome.tabs.create({ url: wanted, active: false });
                      await new Promise((resolve) => setTimeout(resolve, 2500));
                    }
                    tabId = tab.id;
                    payload.tab_id = tabId;
                    payload.command_payload = {
                      ...(payload.command_payload || {}),
                      tabId
                    };
                  }
                  const responsePromise = chrome.runtime.sendMessage({
                    type: "hunt.apply.run_c3_command",
                    payload
                  });
                  const timeoutMs = Math.max(0, Math.min(300000, Number(payload.bridge_timeout_ms || 0)));
                  if (!timeoutMs) return await responsePromise;
                  return await Promise.race([
                    responsePromise,
                    new Promise((resolve) => setTimeout(() => resolve({
                      ok: false,
                      reason: "bridge_command_timeout"
                    }), timeoutMs))
                  ]);
                }
                """,
                {
                    "payload": payload,
                    "targetUrl": str(target.get("url") or ""),
                    "expectedTargetId": expected_target_id,
                    "expectedTabId": expected_tab_id,
                },
            )
        finally:
            browser.close()


def _find_extension_page(browser: Any, options_url: str, extension_id: str) -> Any | None:
    pages = [page for context in browser.contexts for page in context.pages]
    if options_url:
        for page in pages:
            if page.url == options_url:
                return page
    prefix = f"chrome-extension://{extension_id}/"
    for page in pages:
        if page.url.startswith(prefix):
            return page
    return None


def _open_extension_page(browser: Any, options_url: str, *, timeout_ms: int = 10_000) -> Any:
    if not options_url:
        raise C3BrowserBridgeError("extension_options_page_not_found")
    context = browser.contexts[0] if browser.contexts else browser.new_context()
    page = context.new_page()
    page.goto(options_url, wait_until="domcontentloaded", timeout=timeout_ms)
    return page


def _rewritten_cdp_websocket_url(host: str, debug_port: int) -> str:
    request = Request(
        f"http://{host}:{debug_port}/json/version",
        headers={"Host": f"127.0.0.1:{debug_port}"},
    )
    with urlopen(request, timeout=5) as response:
        data = json.loads(response.read().decode("utf-8"))
    websocket_url = str(data["webSocketDebuggerUrl"])
    return websocket_url.replace(f"ws://127.0.0.1:{debug_port}", f"ws://{host}:{debug_port}")


def _candidate_cdp_hosts(target: dict[str, Any]) -> list[str]:
    explicit = str(target.get("cdp_host") or os.environ.get("HUNT_C3_CDP_HOST") or "").strip()
    hosts = []
    if explicit:
        hosts.append(explicit)
    hosts.append("127.0.0.1")
    if PathLikeDocker.exists():
        hosts.append("host.docker.internal")
    return list(dict.fromkeys(hosts))


class PathLikeDocker:
    @staticmethod
    def exists() -> bool:
        return os.path.exists("/.dockerenv")
