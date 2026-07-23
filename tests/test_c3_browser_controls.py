import asyncio
import hashlib
import inspect
from types import SimpleNamespace

import pytest

from backend.c3_browser_controls import (
    C3BrowserControlError,
    C3BrowserControls,
    _select_registered_page,
    run_c3_browser_control,
)


class FakePage:
    def __init__(self):
        self.url = "https://example.test/apply"
        self.calls: list[tuple] = []

    async def title(self):
        self.calls.append(("title",))
        return "Apply"

    async def evaluate(self, expression, arg=None):
        self.calls.append(("evaluate", expression, arg))
        if "document.documentElement" in expression:
            return '<input value="secret"><div>candidate@example.com</div>'
        if "activeElement" in expression:
            return {"tag": "INPUT", "id": "phone", "value": "303-555-1212"}
        if "aria-controls" in expression:
            if "optionSelector" in expression:
                return {
                    "ok": True,
                    "reason": "owned_option_clicked",
                    "popupId": "source-menu",
                    "optionText": arg["expectedText"],
                    "proof": {"passed": True, "type": "backing_state_changed"},
                }
            if "control.getAttribute" in expression and "control.click" in expression:
                return {
                    "ok": True,
                    "reason": "owned_popup_opened",
                    "controlId": "source",
                    "popupId": "source-menu",
                }
            return {"controlId": "source", "popupId": "source-menu", "expanded": True}
        return {"role": "combobox", "aria-expanded": "true"}

    async def screenshot(self, **kwargs):
        self.calls.append(("screenshot", kwargs))
        return b"png"


def _run(awaitable):
    return asyncio.run(awaitable)


def test_bounded_controls_are_read_only_redacted_and_size_limited():
    page = FakePage()
    page.url = "https://example.test/apply?version=2&token=private"
    controls = C3BrowserControls(page, max_text_bytes=1000)

    info = _run(controls.run("page_info"))
    dom = _run(controls.run("dom_snapshot"))
    health = _run(controls.run("target_health"))
    active = _run(controls.run("active_element"))
    popup = _run(controls.run("popup_ownership", {"selector": "#source"}))
    attrs = _run(
        controls.run(
            "read_attributes",
            {"selector": "#source", "attributes": ["role", "aria-expanded"]},
        )
    )

    expected_url_hash = hashlib.sha256(page.url.encode()).hexdigest()
    assert info == {
        "url": "https://example.test/apply",
        "url_sha256": expected_url_hash,
        "title": "Apply",
    }
    assert "secret" not in dom["html"]
    assert "candidate@example.com" not in dom["html"]
    assert dom["truncated"] is False
    assert health["reachable"] is True
    assert health["url"] == "https://example.test/apply"
    assert health["url_sha256"] == expected_url_hash
    assert "private" not in str(info)
    assert "private" not in str(health)
    assert active["value"] == "[REDACTED]"
    assert popup["popupId"] == "source-menu"
    assert attrs == {"role": "combobox", "aria-expanded": "true"}
    assert all("bringToFront" not in str(call) for call in page.calls)


def test_unmasked_screenshot_and_historical_tails_are_explicitly_unsupported():
    controls = C3BrowserControls(FakePage())

    with pytest.raises(C3BrowserControlError, match="screenshot_redaction_unavailable"):
        _run(controls.run("screenshot"))
    console = _run(controls.run("console_tail"))
    network = _run(controls.run("failed_request_tail"))

    assert console == {
        "events": [],
        "supported": False,
        "reason": "historical_console_unavailable",
    }
    assert network == {
        "events": [],
        "supported": False,
        "reason": "historical_network_unavailable",
    }


@pytest.mark.parametrize("action", ["click", "type", "evaluate", "bring_to_front", "submit"])
def test_mutating_or_arbitrary_controls_are_rejected(action: str):
    controls = C3BrowserControls(FakePage())

    with pytest.raises(C3BrowserControlError, match="diagnostic_action_not_allowed"):
        _run(controls.run(action, {"script": "document.querySelector('button').click()"}))


def test_selector_and_attribute_bounds_are_enforced():
    controls = C3BrowserControls(FakePage())

    with pytest.raises(C3BrowserControlError, match="selector_too_long"):
        _run(controls.run("read_attributes", {"selector": "#" + "x" * 600}))
    with pytest.raises(C3BrowserControlError, match="attribute_not_allowed"):
        _run(
            controls.run(
                "read_attributes",
                {"selector": "#field", "attributes": ["onclick"]},
            )
        )


def test_probe_mutations_require_explicit_mode_and_owned_popup_proof():
    readonly = C3BrowserControls(FakePage())
    with pytest.raises(C3BrowserControlError, match="diagnostic_action_not_allowed"):
        _run(readonly.run("open_owned_popup", {"selector": "#source"}))

    page = FakePage()
    controls = C3BrowserControls(page, allow_probe_mutations=True)
    opened = _run(controls.run("open_owned_popup", {"selector": "#source"}))
    clicked = _run(
        controls.run(
            "click_owned_option",
            {
                "control_selector": "#source",
                "option_selector": "[role=option]:nth-child(2)",
                "expected_text": "Referral",
            },
        )
    )

    assert opened["reason"] == "owned_popup_opened"
    assert clicked == {
        "ok": True,
        "reason": "owned_option_clicked",
        "popupId": "source-menu",
        "optionText": "Referral",
        "proof": {"passed": True, "type": "backing_state_changed"},
    }
    opener_script = next(
        call[1] for call in page.calls if call[0] == "evaluate" and "control.click" in str(call[1])
    )
    assert 'input[type="submit"]' in opener_script
    option_script = next(
        call[1] for call in page.calls if call[0] == "evaluate" and "optionSelector" in str(call[1])
    )
    assert "backing_state_changed" in option_script


def test_page_selection_requires_exact_pinned_tab_target_and_never_falls_back():
    class FakeCDPSession:
        def __init__(self, page):
            self.page = page

        async def send(self, method):
            assert method == "Target.getTargetInfo"
            return {"targetInfo": {"targetId": self.page.target_id, "url": self.page.url}}

        async def detach(self):
            return None

    class FakeContext:
        async def new_cdp_session(self, page):
            return FakeCDPSession(page)

    class ExactPage(FakePage):
        def __init__(self, url, target_id):
            super().__init__()
            self.url = url
            self.target_id = target_id
            self.context = FakeContext()

    class ExtensionPage(ExactPage):
        async def evaluate(self, expression, arg=None):
            if "chrome.debugger.getTargets" in expression:
                assert arg == 7
                return {
                    "found": True,
                    "tabId": 7,
                    "targetId": "target-wanted",
                    "url": "https://example.test/apply?job=1",
                }
            return await super().evaluate(expression, arg)

    wanted = ExactPage("https://example.test/auth/sign-in?job=1", "target-wanted")
    replacement = ExactPage("https://example.test/apply?job=1", "target-replacement")
    other = ExactPage("https://example.test/other", "target-other")
    extension = ExtensionPage("chrome-extension://ext-1/options.html", "target-extension")
    fingerprint = hashlib.sha256(wanted.url.encode("utf-8")).hexdigest()
    fingerprint = hashlib.sha256(b"https://example.test/apply?job=1").hexdigest()
    target = {
        "tab_id": 7,
        "extension_id": "ext-1",
        "target_id": "target-wanted",
        "url_sha256": fingerprint,
    }

    assert _run(_select_registered_page([extension, other, wanted], target)) is wanted
    with pytest.raises(C3BrowserControlError, match="registered_page_not_found"):
        _run(_select_registered_page([extension, other, replacement], target))

    with pytest.raises(C3BrowserControlError, match="registered_target_identity_mismatch"):
        _run(
            _select_registered_page(
                [extension, wanted],
                {**target, "target_id": "target-replaced"},
            )
        )


def test_browser_control_close_is_bounded():
    source = inspect.getsource(run_c3_browser_control)

    assert "asyncio.wait_for(browser.close(), timeout=" in source
    assert "primary_error" in source
    assert 'primary_error.add_note("browser_close_timeout")' in source


def test_remote_cdp_host_is_tried_before_localhost(monkeypatch):
    calls = []

    class Chromium:
        async def connect_over_cdp(self, endpoint, **kwargs):
            calls.append((endpoint, kwargs))
            if endpoint.startswith("ws://remote-cdp:"):
                return SimpleNamespace(contexts=[], close=lambda: None)
            raise AssertionError(f"unexpected endpoint: {endpoint}")

    monkeypatch.setattr(
        "backend.c3_browser_controls._candidate_cdp_hosts",
        lambda target: [target["cdp_host"], "127.0.0.1"],
    )
    monkeypatch.setattr(
        "backend.c3_browser_controls._rewritten_cdp_websocket_url",
        lambda host, port: f"ws://{host}:{port}/devtools/browser/one",
    )

    from backend.c3_browser_controls import _connect_over_registered_cdp

    browser = _run(
        _connect_over_registered_cdp(
            SimpleNamespace(chromium=Chromium()),
            {"debug_port": 9222, "cdp_host": "remote-cdp"},
        )
    )

    assert browser is not None
    assert calls == [
        (
            "ws://remote-cdp:9222/devtools/browser/one",
            {"timeout": 2_000, "headers": {"Host": "127.0.0.1:9222"}},
        )
    ]


def test_page_selection_rejects_url_only_identity():
    page = FakePage()
    fingerprint = hashlib.sha256(page.url.encode("utf-8")).hexdigest()

    with pytest.raises(C3BrowserControlError, match="registered_tab_identity_missing"):
        _run(_select_registered_page([page], {"url_sha256": fingerprint}))


def test_dom_snapshot_enforces_byte_limit_for_multibyte_text():
    class UnicodePage(FakePage):
        async def evaluate(self, expression, arg=None):
            if "document.documentElement" in expression:
                return "😀" * 600
            return await super().evaluate(expression, arg)

    snapshot = _run(C3BrowserControls(UnicodePage(), max_text_bytes=1000).run("dom_snapshot"))

    assert len(snapshot["html"].encode("utf-8")) <= 1000
    assert snapshot["truncated"] is True


def test_browser_action_timeout_cancels_hung_cdp_evaluation():
    class HangingPage(FakePage):
        async def evaluate(self, expression, arg=None):
            del expression, arg
            await asyncio.Event().wait()

    controls = C3BrowserControls(HangingPage(), action_timeout_seconds=0.02)

    with pytest.raises(C3BrowserControlError, match="diagnostic_action_timeout"):
        _run(controls.run("dom_snapshot"))


def test_cdp_diagnostic_connection_has_backend_timeout():
    from backend.c3_browser_controls import _connect_over_registered_cdp

    assert '"timeout": 2_000' in inspect.getsource(_connect_over_registered_cdp)


def test_dom_snapshot_removes_user_entered_form_and_editable_content():
    class FormContentPage(FakePage):
        async def evaluate(self, expression, arg=None):
            self.calls.append(("evaluate", expression, arg))
            if "document.documentElement" in expression:
                return (
                    "<main><label>Street address</label><textarea>123 Main Street</textarea>"
                    '<input data-value="hunter2" value="hunter2">'
                    '<div contenteditable="true"><span>private resume body</span></div></main>'
                )
            return await super().evaluate(expression, arg)

    page = FormContentPage()
    snapshot = _run(C3BrowserControls(page).run("dom_snapshot"))

    assert "Street address" in snapshot["html"]
    assert "123 Main Street" not in snapshot["html"]
    assert "hunter2" not in snapshot["html"]
    assert "private resume body" not in snapshot["html"]
    script = page.calls[0][1]
    assert "cloneNode" in script
    assert "contenteditable" in script


def test_dom_snapshot_uses_structural_allowlist_and_bounds_labels():
    secret = "UniqueCandidate-7Q9"

    class SeededPage(FakePage):
        async def evaluate(self, expression, arg=None):
            if "document.documentElement" in expression:
                return (
                    '<main data-answer="UniqueCandidate-7Q9" '
                    'aria-description="123 Main Street" onclick="steal()">'
                    '<label aria-label="UniqueCandidate-7Q9">First name'
                    + ("x" * 1_000)
                    + "</label>"
                    '<a href="https://example.test/apply?answer=UniqueCandidate-7Q9#private">Apply</a>'
                    '<div role="combobox">UniqueCandidate-7Q9</div></main>'
                )
            return await super().evaluate(expression, arg)

    snapshot = _run(C3BrowserControls(SeededPage(), max_text_bytes=4_000).run("dom_snapshot"))

    assert secret not in snapshot["html"]
    assert "123 Main Street" not in snapshot["html"]
    assert "data-answer" not in snapshot["html"]
    assert "aria-description" not in snapshot["html"]
    assert "onclick" not in snapshot["html"]
    assert 'href="https://example.test/apply"' in snapshot["html"]
    assert "First name" in snapshot["html"]
    assert snapshot["html"].count("x") <= 240
