from __future__ import annotations

import asyncio
import hashlib
from collections.abc import Mapping
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from backend.c3_artifacts import sanitize_structural_dom
from backend.c3_browser_bridge import _candidate_cdp_hosts, _rewritten_cdp_websocket_url
from backend.ledger.redaction import REDACTED, redact_payload

ALLOWED_ACTIONS = {
    "target_health",
    "page_info",
    "dom_snapshot",
    "screenshot",
    "console_tail",
    "failed_request_tail",
    "active_element",
    "popup_ownership",
    "read_attributes",
}
PROBE_MUTATION_ACTIONS = {"open_owned_popup", "click_owned_option"}
ALLOWED_ATTRIBUTES = {
    "id",
    "name",
    "role",
    "type",
    "required",
    "disabled",
    "aria-label",
    "aria-controls",
    "aria-owns",
    "aria-expanded",
    "aria-selected",
    "aria-invalid",
    "data-automation-id",
}


class C3BrowserControlError(ValueError):
    pass


class C3BrowserControls:
    def __init__(
        self,
        page: Any,
        *,
        max_text_bytes: int = 200_000,
        max_events: int = 100,
        allow_probe_mutations: bool = False,
        action_timeout_seconds: float = 2,
    ) -> None:
        self.page = page
        self.max_text_bytes = max(1_000, min(int(max_text_bytes), 500_000))
        self.max_events = max(1, min(int(max_events), 500))
        self.allow_probe_mutations = bool(allow_probe_mutations)
        self.action_timeout_seconds = max(0.01, min(float(action_timeout_seconds), 10))

    async def run(self, action: str, options: Mapping[str, Any] | None = None) -> dict[str, Any]:
        try:
            return await asyncio.wait_for(
                self._run_action(action, options), timeout=self.action_timeout_seconds
            )
        except TimeoutError as exc:
            raise C3BrowserControlError("diagnostic_action_timeout") from exc

    async def _run_action(
        self, action: str, options: Mapping[str, Any] | None = None
    ) -> dict[str, Any]:
        if action not in ALLOWED_ACTIONS and not (
            self.allow_probe_mutations and action in PROBE_MUTATION_ACTIONS
        ):
            raise C3BrowserControlError("diagnostic_action_not_allowed")
        options = options or {}
        if action == "open_owned_popup":
            return await self._open_owned_popup(options)
        if action == "click_owned_option":
            return await self._click_owned_option(options)
        if action in {"target_health", "page_info"}:
            title, _redaction = redact_payload(str(await self.page.title()))
            full_observed_url = str(self.page.url)
            result = {
                "url": _safe_url(full_observed_url),
                "url_sha256": hashlib.sha256(full_observed_url.encode("utf-8")).hexdigest(),
                "title": title,
            }
            if action == "target_health":
                result.update({"ok": True, "reachable": True})
            return result
        if action == "dom_snapshot":
            html = await self.page.evaluate(
                """() => {
                  if (!document.documentElement) return "";
                  const clone = document.documentElement.cloneNode(true);
                  clone.querySelectorAll("[value], [data-value]").forEach((element) => {
                    element.removeAttribute("value");
                    element.removeAttribute("data-value");
                  });
                  clone.querySelectorAll("textarea").forEach((element) => {
                    element.textContent = "";
                  });
                  clone.querySelectorAll("[contenteditable]").forEach((element) => {
                    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
                    const nodes = [];
                    while (walker.nextNode()) nodes.push(walker.currentNode);
                    nodes.forEach((node) => { node.nodeValue = ""; });
                  });
                  return clone.outerHTML;
                }"""
            )
            raw_html = str(html or "")
            safe, structural_truncated = sanitize_structural_dom(
                raw_html, max_bytes=self.max_text_bytes
            )
            truncated = structural_truncated or len(raw_html.encode("utf-8")) > self.max_text_bytes
            safe, redaction = redact_payload(safe)
            safe = _truncate_utf8(str(safe), self.max_text_bytes)
            return {"html": safe, "redaction": redaction, "truncated": truncated}
        if action == "screenshot":
            raise C3BrowserControlError("screenshot_redaction_unavailable")
        if action == "console_tail":
            return {
                "events": [],
                "supported": False,
                "reason": "historical_console_unavailable",
            }
        if action == "failed_request_tail":
            return {
                "events": [],
                "supported": False,
                "reason": "historical_network_unavailable",
            }
        if action == "active_element":
            value = await self.page.evaluate(
                """() => {
                  const el = document.activeElement;
                  if (!el) return {};
                  return {
                    tag: el.tagName || "", id: el.id || "", name: el.name || "",
                    role: el.getAttribute?.("role") || "", value: "value" in el ? el.value : ""
                  };
                }"""
            )
            result = dict(value) if isinstance(value, Mapping) else {}
            if result.get("value") not in (None, ""):
                result["value"] = REDACTED
            return result
        if action == "popup_ownership":
            selector = _selector(options)
            result = await self.page.evaluate(
                """(selector) => {
                  const control = document.querySelector(selector);
                  if (!control) return { found: false };
                  const popupId = control.getAttribute("aria-controls") || control.getAttribute("aria-owns") || "";
                  const popup = popupId ? document.getElementById(popupId) : null;
                  return {
                    found: true, controlId: control.id || "", popupId,
                    expanded: control.getAttribute("aria-expanded") === "true",
                    popupRole: popup?.getAttribute?.("role") || "",
                  };
                }""",
                selector,
            )
            return dict(result) if isinstance(result, Mapping) else {}
        selector = _selector(options)
        attributes = options.get("attributes")
        if not isinstance(attributes, list) or not attributes:
            raise C3BrowserControlError("attributes_required")
        if len(attributes) > 20 or any(str(name) not in ALLOWED_ATTRIBUTES for name in attributes):
            raise C3BrowserControlError("attribute_not_allowed")
        result = await self.page.evaluate(
            """({ selector, attributes }) => {
              const el = document.querySelector(selector);
              if (!el) return {};
              return Object.fromEntries(attributes.map((name) => [name, el.getAttribute(name)]));
            }""",
            {"selector": selector, "attributes": attributes},
        )
        safe, _ = redact_payload(dict(result) if isinstance(result, Mapping) else {})
        return safe

    async def _open_owned_popup(self, options: Mapping[str, Any]) -> dict[str, Any]:
        selector = _selector(options)
        result = await self.page.evaluate(
            """(selector) => {
              const control = document.querySelector(selector);
              if (!control) return { ok: false, reason: "control_not_found" };
              const popupId = control.getAttribute("aria-controls") || control.getAttribute("aria-owns") || "";
               if (!popupId) return { ok: false, reason: "popup_owner_missing" };
               if (control.matches?.('button[type="submit"], input[type="submit"], input[type="image"]') || control.formAction) {
                 return { ok: false, reason: "submit_control_blocked" };
               }
               if (/submit|final/i.test(String(control.innerText || control.value || control.getAttribute("aria-label") || ""))) {
                return { ok: false, reason: "submit_control_blocked" };
              }
              if (control.getAttribute("aria-expanded") !== "true") control.click();
              const popup = document.getElementById(popupId);
              return {
                ok: control.getAttribute("aria-expanded") === "true" || Boolean(popup),
                reason: popup || control.getAttribute("aria-expanded") === "true" ? "owned_popup_opened" : "popup_not_opened",
                controlId: control.id || "", popupId,
              };
            }""",
            selector,
        )
        return dict(result) if isinstance(result, Mapping) else {}

    async def _click_owned_option(self, options: Mapping[str, Any]) -> dict[str, Any]:
        control_selector = str(options.get("control_selector") or "")
        option_selector = str(options.get("option_selector") or "")
        if not control_selector or not option_selector:
            raise C3BrowserControlError("owned_option_selectors_required")
        if len(control_selector) > 500 or len(option_selector) > 500:
            raise C3BrowserControlError("selector_too_long")
        expected_text = str(options.get("expected_text") or "").strip()
        if not expected_text or len(expected_text) > 240:
            raise C3BrowserControlError("expected_option_text_required")
        result = await self.page.evaluate(
            r"""async ({ controlSelector, optionSelector, expectedText }) => {
              const control = document.querySelector(controlSelector);
              if (!control) return { ok: false, reason: "control_not_found" };
              const popupId = control.getAttribute("aria-controls") || control.getAttribute("aria-owns") || "";
              const popup = popupId ? document.getElementById(popupId) : null;
              if (!popup) return { ok: false, reason: "owned_popup_not_found" };
              const option = popup.querySelector(optionSelector);
              if (!option) return { ok: false, reason: "owned_option_not_found", popupId };
              const role = option.getAttribute("role") || "";
              if (!["option", "menuitem", "radio"].includes(role)) return { ok: false, reason: "option_role_not_allowed", popupId };
              const text = String(option.innerText || option.textContent || "").replace(/\s+/g, " ").trim();
              if (text !== expectedText) return { ok: false, reason: "option_text_mismatch", popupId };
              if (option.matches?.('button[type="submit"], input[type="submit"], input[type="image"]') || option.formAction || /^submit$|final submit/i.test(text)) {
                return { ok: false, reason: "submit_control_blocked", popupId };
              }
              const backing = (element) => ({
                value: "value" in element ? String(element.value || "") : "",
                text: String(element.innerText || element.textContent || "").replace(/\s+/g, " ").trim(),
                active: element.getAttribute?.("aria-activedescendant") || "",
                selected: option.getAttribute("aria-selected") || "",
                checked: Boolean(option.checked),
              });
              const before = backing(control);
              option.click();
              await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
              const after = backing(control);
              const passed = after.selected === "true" || after.checked ||
                after.value !== before.value || after.text !== before.text || after.active !== before.active;
              return {
                ok: passed,
                reason: passed ? "owned_option_clicked" : "option_click_unverified",
                popupId,
                optionText: text,
                proof: { passed, type: "backing_state_changed", before, after },
              };
            }""",
            {
                "controlSelector": control_selector,
                "optionSelector": option_selector,
                "expectedText": expected_text,
            },
        )
        return dict(result) if isinstance(result, Mapping) else {}


async def run_c3_browser_control(
    target: Mapping[str, Any],
    action: str,
    options: Mapping[str, Any] | None = None,
    *,
    allow_probe_mutations: bool = False,
) -> dict[str, Any]:
    """Attach to an existing isolated lane without navigating or taking focus."""

    debug_port = int(target.get("debug_port") or 0)
    if not debug_port:
        raise C3BrowserControlError("missing_debug_port")
    try:
        from playwright.async_api import async_playwright
    except Exception as exc:  # pragma: no cover - runtime dependency
        raise C3BrowserControlError("playwright_unavailable") from exc

    async with async_playwright() as playwright:
        browser = await _connect_over_registered_cdp(playwright, target)
        primary_error: Exception | None = None
        try:
            pages = [page for context in browser.contexts for page in context.pages]
            try:
                page = await asyncio.wait_for(_select_registered_page(pages, target), timeout=2)
            except TimeoutError as exc:
                raise C3BrowserControlError("registered_page_identity_timeout") from exc
            controls = C3BrowserControls(
                page,
                allow_probe_mutations=allow_probe_mutations,
            )
            return await controls.run(action, options)
        except Exception as exc:
            primary_error = exc
            raise
        finally:
            try:
                await asyncio.wait_for(browser.close(), timeout=2)
            except TimeoutError as exc:
                if primary_error is not None:
                    primary_error.add_note("browser_close_timeout")
                else:
                    raise C3BrowserControlError("browser_close_timeout") from exc


def _selector(options: Mapping[str, Any]) -> str:
    selector = str(options.get("selector") or "")
    if not selector:
        raise C3BrowserControlError("selector_required")
    if len(selector) > 500:
        raise C3BrowserControlError("selector_too_long")
    return selector


async def _select_registered_page(pages: list[Any], target: Mapping[str, Any]) -> Any:
    tab_id = target.get("tab_id")
    if tab_id is None:
        raise C3BrowserControlError("registered_tab_identity_missing")
    extension_id = str(target.get("extension_id") or "")
    extension_page = next(
        (
            page
            for page in pages
            if extension_id and str(page.url).startswith(f"chrome-extension://{extension_id}/")
        ),
        None,
    )
    if extension_page is None:
        raise C3BrowserControlError("registered_tab_identity_unavailable")
    try:
        identity = await extension_page.evaluate(
            """async (tabId) => {
              if (!chrome.debugger?.getTargets) return { found: false };
              const targets = await chrome.debugger.getTargets();
              const match = targets.find((candidate) => Number(candidate.tabId) === Number(tabId));
              if (!match) return { found: false };
              return {
                found: true,
                tabId: match.tabId,
                targetId: match.id || "",
                url: match.url || ""
              };
            }""",
            int(tab_id),
        )
    except Exception as exc:
        raise C3BrowserControlError("registered_tab_identity_unavailable") from exc
    if not isinstance(identity, Mapping) or identity.get("found") is not True:
        raise C3BrowserControlError("registered_page_not_found")
    expected_target_id = str(identity.get("targetId") or "")
    if not expected_target_id:
        raise C3BrowserControlError("registered_tab_identity_unavailable")
    pinned_target_id = str(
        target.get("target_id")
        or (
            target.get("metadata", {}).get("target_id")
            if isinstance(target.get("metadata"), Mapping)
            else ""
        )
        or ""
    )
    if pinned_target_id and pinned_target_id != expected_target_id:
        raise C3BrowserControlError("registered_target_identity_mismatch")

    matches = []
    for page in pages:
        session = None
        try:
            session = await page.context.new_cdp_session(page)
            response = await session.send("Target.getTargetInfo")
            target_info = response.get("targetInfo") if isinstance(response, Mapping) else None
            if (
                isinstance(target_info, Mapping)
                and str(target_info.get("targetId") or "") == expected_target_id
            ):
                matches.append(page)
        except Exception:
            continue
        finally:
            if session is not None:
                try:
                    await session.detach()
                except Exception:
                    pass
    if not matches:
        raise C3BrowserControlError("registered_page_not_found")
    if len(matches) != 1:
        raise C3BrowserControlError("registered_page_ambiguous")
    return matches[0]


async def _connect_over_registered_cdp(playwright: Any, target: Mapping[str, Any]) -> Any:
    debug_port = int(target.get("debug_port") or 0)
    if not debug_port:
        raise C3BrowserControlError("missing_debug_port")
    last_error: Exception | None = None
    for host in _candidate_cdp_hosts(dict(target)):
        try:
            endpoint = f"http://{host}:{debug_port}"
            kwargs: dict[str, Any] = {"timeout": 2_000}
            if host not in {"127.0.0.1", "localhost"}:
                endpoint = await asyncio.wait_for(
                    asyncio.to_thread(_rewritten_cdp_websocket_url, host, debug_port),
                    timeout=6,
                )
                kwargs["headers"] = {"Host": f"127.0.0.1:{debug_port}"}
            return await playwright.chromium.connect_over_cdp(endpoint, **kwargs)
        except Exception as exc:  # pragma: no cover - live CDP availability
            last_error = exc
    raise C3BrowserControlError("cdp_connect_failed") from last_error


def _safe_url(value: str) -> str:
    try:
        parsed = urlsplit(value)
    except ValueError:
        return ""
    if not parsed.scheme or not parsed.netloc:
        return ""
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, "", ""))


def _truncate_utf8(value: str, limit: int) -> str:
    return value.encode("utf-8")[:limit].decode("utf-8", errors="ignore")
