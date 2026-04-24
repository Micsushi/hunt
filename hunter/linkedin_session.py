import argparse
import datetime
import json
import os
import sys
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import urlparse

from hunter.browser_runtime import (
    BrowserRuntimeError,
    load_sync_playwright,
    open_browser_context,
)
from hunter.config import get_db_path
from hunter.db import mark_linkedin_auth_available, mark_linkedin_auth_unavailable
from hunter.notifications import send_discord_webhook_message

try:
    from c1_logging import C1Logger  # type: ignore
except ImportError:
    from .c1_logging import C1Logger  # type: ignore

try:
    from playwright.sync_api import TargetClosedError as PlaywrightTargetClosedError
except (ModuleNotFoundError, ImportError):

    class PlaywrightTargetClosedError(Exception):  # type: ignore[misc]
        pass


ROOT = Path(__file__).resolve().parent.parent
DEFAULT_STORAGE_STATE_PATH = ROOT / ".state" / "linkedin_auth_state.json"
DEFAULT_AUTH_TRACE_PATH = ROOT / ".state" / "linkedin_auth_trace.jsonl"
DEFAULT_SERVER_RUNTIME_DIR = Path.home() / "data" / "hunt"
LINKEDIN_ACTIVE_ACCOUNT_FILE = ROOT / ".state" / "linkedin_active_account"
ACCOUNT_BLOCKS_FILE = ROOT / ".state" / "linkedin_account_blocks.json"
ACCOUNT_BLOCK_DAYS = 7
DEFAULT_BROWSER_CHANNEL = os.getenv("LINKEDIN_BROWSER_CHANNEL") or None
LOGIN_VERIFICATION_URL = "https://www.linkedin.com/feed/"
LOGIN_URL = "https://www.linkedin.com/login"
AUTO_RELOGIN_EMAIL_ENV = "LINKEDIN_EMAIL"
AUTO_RELOGIN_PASSWORD_ENV = "LINKEDIN_PASSWORD"
AUTO_RELOGIN_ENABLED_ENV = "LINKEDIN_AUTO_RELOGIN"
AUTO_RELOGIN_DEBUG_ENV = "LINKEDIN_RELOGIN_DEBUG"
AUTH_TRACE_PATH_ENV = "LINKEDIN_AUTH_TRACE_PATH"
LINKEDIN_ACCOUNTS_ENV = "LINKEDIN_ACCOUNTS"
ACCOUNT_CHOOSER_SELECTORS = (
    "button:has-text('Continue as')",
    "a:has-text('Continue as')",
    "button:has-text('Continue')",
    "a:has-text('Continue')",
    "button:has-text('Sign in')",
    "a:has-text('Sign in')",
    # "Welcome back" account picker card selectors (various LinkedIn versions)
    ".account-picker__account-btn",
    "[class*='account-picker__account'] button",
    "[class*='account-picker__account'] a",
    "ul[class*='account-picker'] button",
    "ul[class*='account-picker'] li",
)
ALT_SIGN_IN_SELECTORS = (
    "a:has-text('Sign in using another account')",
    "button:has-text('Sign in using another account')",
    "text=/Sign in using another account/i",
    "a:has-text('Use a different account')",
    "button:has-text('Use a different account')",
    "text=/Use a different account/i",
)

EMAIL_FIELD_SELECTORS = (
    "input[name='session_key']",
    "input[name*='session_key']",
    "input[id*='session_key']",
    "input[autocomplete='username']",
    "input[autocomplete='email']",
    "input[name='username']",
    "input[id*='username']",
    "input[aria-label='Email or phone']",
    "input[aria-label='Email or phone number']",
    "input[placeholder='Email or phone']",
    "input[placeholder='Email or phone number']",
    "input[type='email']",
    "input[type='text']",
    "input[inputmode='email']",
    "xpath=//label[contains(normalize-space(.), 'Email') or contains(normalize-space(.), 'phone')]/following::input[not(@type='hidden') and not(@type='password')][1]",
    "#username",
)

PASSWORD_FIELD_SELECTORS = (
    "input[name='session_password']",
    "input[name*='session_password']",
    "input[id*='session_password']",
    "input[autocomplete='current-password']",
    "input[name='password']",
    "input[placeholder='Password']",
    "input[type='password']",
    "input[id*='password']",
    "xpath=//label[contains(normalize-space(.), 'Password')]/following::input[@type='password'][1]",
    "#password",
)

SUBMIT_BUTTON_SELECTORS = (
    "button[type='submit']",
    "xpath=//button[normalize-space(.)='Sign in']",
    "xpath=//a[normalize-space(.)='Sign in']",
    "button[aria-label='Sign in']",
    "button:has-text('Sign in')",
)

# LinkedIn's "Important notice" automation-detection page.
# Appears at /checkpoint/ URLs so it looks "logged out" to page_looks_logged_out;
# must be checked first.
AUTOMATION_NOTICE_SELECTOR = "button:has-text('Agree to comply')"

# Buttons LinkedIn may show between login and the feed (interstitials / confirmations).
# Only clicked when the page is neither the feed nor a login page.
POST_LOGIN_CONFIRMATION_SELECTORS = (
    "button:has-text('Yes, stay signed in')",
    "button:has-text('Stay signed in')",
    "button:has-text('Accept')",
    "button:has-text('I agree')",
    "button:has-text('Continue')",
    "a:has-text('Continue')",
    "button:has-text('Done')",
    "button:has-text('Next')",
    "button:has-text('Skip')",
    "button:has-text('Remind me later')",
    "button:has-text('Not now')",
)

AUTH_TRACE_COMPONENT_SCRIPT = """
(limit) => {
  const clean = (value, maxLen = 200) => {
    const normalized = String(value || "").replace(/\\s+/g, " ").trim();
    return normalized.length > maxLen ? normalized.slice(0, maxLen) + "..." : normalized;
  };

  const isVisible = (el) => {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (!style || style.visibility === "hidden" || style.display === "none") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const selectors = [
    "button",
    "a",
    "input",
    "textarea",
    "select",
    "label",
    "form",
    "h1",
    "h2",
    "h3",
    "h4",
    "[role='button']",
    "[role='link']",
    "[role='textbox']",
    "[aria-label]",
    "[placeholder]",
  ].join(",");

  const nodes = Array.from(document.querySelectorAll(selectors));
  const components = [];

  for (const el of nodes) {
    if (!isVisible(el)) continue;
    const tag = (el.tagName || "").toLowerCase();
    const type = clean(el.getAttribute("type") || "");
    const value =
      tag === "input"
        ? (type === "password"
            ? ((el.value || "").length ? "<redacted>" : "")
            : clean(el.value || "", 120))
        : "";
    components.push({
      tag,
      type,
      role: clean(el.getAttribute("role") || ""),
      name: clean(el.getAttribute("name") || ""),
      id: clean(el.id || ""),
      text: clean(el.innerText || el.textContent || "", 240),
      label: clean(el.getAttribute("aria-label") || "", 160),
      placeholder: clean(el.getAttribute("placeholder") || "", 160),
      href: clean(el.getAttribute("href") || "", 240),
      value,
    });
    if (components.length >= limit) break;
  }

  return {
    title: clean(document.title || "", 240),
    body_text_excerpt: clean(document.body ? document.body.innerText : "", 1200),
    component_count: components.length,
    components,
  };
}
"""

_AUTH_TRACE_RUN_ID = None
_AUTH_TRACE_FLOW = None
_AUTH_TRACE_SEQUENCE = 0
_AUTH_TRACE_LAST_SNAPSHOT_KEY = None


class LinkedInSessionError(RuntimeError):
    pass


class LinkedInSessionCancelled(LinkedInSessionError):
    pass


class LinkedInSessionNotSaved(LinkedInSessionError):
    pass


class LinkedInAutomationFlagged(LinkedInSessionError):
    """Raised when LinkedIn shows the automation-tool compliance notice for an account."""

    pass


def _get_bool_env(name, default):
    value = os.getenv(name)
    if value is None or not value.strip():
        return default

    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    return default


def get_auto_relogin_credentials():
    email = (os.getenv(AUTO_RELOGIN_EMAIL_ENV) or "").strip()
    password = os.getenv(AUTO_RELOGIN_PASSWORD_ENV) or ""
    enabled = _get_bool_env(AUTO_RELOGIN_ENABLED_ENV, True)
    return {
        "enabled": bool(enabled and email and password),
        "email": email,
        "password": password,
    }


def _relogin_debug_enabled():
    return _get_bool_env(AUTO_RELOGIN_DEBUG_ENV, False)


def _log_relogin(message):
    if _relogin_debug_enabled():
        print(f"[linkedin_relogin] {message}", flush=True)


def _mask_secret(value):
    if value is None:
        return None
    return f"<redacted len={len(value)}>"


def _normalize_text(value):
    return " ".join((value or "").split())


def resolve_auth_trace_path():
    raw_path = os.getenv(AUTH_TRACE_PATH_ENV)
    if raw_path:
        return Path(raw_path).expanduser().resolve()
    return DEFAULT_AUTH_TRACE_PATH


def _expected_runtime_db_path():
    if os.name == "nt":
        return None
    try:
        if ROOT.resolve() != (Path.home() / "hunt").resolve():
            return None
    except Exception:
        return None
    runtime_dir_raw = os.getenv("HUNT_RUNTIME_DIR")
    runtime_dir = (
        Path(runtime_dir_raw).expanduser() if runtime_dir_raw else DEFAULT_SERVER_RUNTIME_DIR
    )
    if not runtime_dir.exists():
        return None
    return (runtime_dir / "hunt.db").resolve()


def get_db_path_warning():
    expected_runtime_db = _expected_runtime_db_path()
    try:
        current_db = Path(get_db_path()).resolve()
    except Exception:
        current_db = Path(get_db_path())
    if not expected_runtime_db or current_db == expected_runtime_db:
        return None
    return (
        "LinkedIn auth is using a different DB than the default server runtime DB. "
        f"Current: {current_db}. Expected server runtime DB: {expected_runtime_db}. "
        "Use './hunter.sh auth-auto-relogin ...' or export HUNT_DB_PATH before running "
        "hunter/linkedin_session.py so auth state updates reach the control plane and /metrics."
    )


def _append_auth_trace_record(record):
    global _AUTH_TRACE_SEQUENCE
    if not _AUTH_TRACE_RUN_ID:
        return
    trace_path = resolve_auth_trace_path()
    trace_path.parent.mkdir(parents=True, exist_ok=True)
    _AUTH_TRACE_SEQUENCE += 1
    now_utc = datetime.datetime.now(datetime.UTC)
    payload = {
        "timestamp": now_utc.isoformat().replace("+00:00", "Z"),
        "run_id": _AUTH_TRACE_RUN_ID,
        "flow": _AUTH_TRACE_FLOW,
        "seq": _AUTH_TRACE_SEQUENCE,
    }
    payload.update(record)
    with trace_path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, sort_keys=True) + "\n")


def _start_auth_trace_run(flow, **metadata):
    global _AUTH_TRACE_RUN_ID, _AUTH_TRACE_FLOW, _AUTH_TRACE_SEQUENCE, _AUTH_TRACE_LAST_SNAPSHOT_KEY
    now_utc = datetime.datetime.now(datetime.UTC)
    _AUTH_TRACE_RUN_ID = now_utc.strftime("%Y%m%dT%H%M%S.%fZ") + f"-pid{os.getpid()}"
    _AUTH_TRACE_FLOW = flow
    _AUTH_TRACE_SEQUENCE = 0
    _AUTH_TRACE_LAST_SNAPSHOT_KEY = None
    _append_auth_trace_record(
        {
            "event": "run_start",
            "metadata": metadata,
        }
    )


def _finish_auth_trace_run(status, *, message=None, **metadata):
    global _AUTH_TRACE_RUN_ID, _AUTH_TRACE_FLOW, _AUTH_TRACE_SEQUENCE, _AUTH_TRACE_LAST_SNAPSHOT_KEY
    if _AUTH_TRACE_RUN_ID:
        _append_auth_trace_record(
            {
                "event": "run_end",
                "status": status,
                "message": message,
                "metadata": metadata,
            }
        )
    _AUTH_TRACE_RUN_ID = None
    _AUTH_TRACE_FLOW = None
    _AUTH_TRACE_SEQUENCE = 0
    _AUTH_TRACE_LAST_SNAPSHOT_KEY = None


def _capture_auth_screen_components(page, *, component_limit=200):
    try:
        snapshot = page.evaluate(AUTH_TRACE_COMPONENT_SCRIPT, component_limit)
        if isinstance(snapshot, dict):
            return snapshot
    except Exception as exc:
        return {
            "title": "",
            "body_text_excerpt": "",
            "component_count": 0,
            "components": [],
            "capture_error": str(exc),
        }
    return {
        "title": "",
        "body_text_excerpt": "",
        "component_count": 0,
        "components": [],
    }


def _screen_snapshot_key(snapshot):
    component_preview = [
        {
            "tag": component.get("tag"),
            "text": component.get("text"),
            "label": component.get("label"),
            "placeholder": component.get("placeholder"),
        }
        for component in snapshot.get("components", [])[:8]
    ]
    return json.dumps(
        {
            "url": snapshot.get("url"),
            "screen_type": snapshot.get("screen_type"),
            "title": snapshot.get("title"),
            "component_preview": component_preview,
        },
        sort_keys=True,
    )


def _trace_auth_screen(page, event="screen_snapshot", *, force=False, **payload):
    global _AUTH_TRACE_LAST_SNAPSHOT_KEY
    if not _AUTH_TRACE_RUN_ID:
        return
    snapshot = _capture_auth_screen_components(page)
    current_url = _page_url(page)
    snapshot.update(
        {
            "event": event,
            "url": current_url,
            "host": _page_host(page),
            "screen_type": _classify_login_screen(page),
        }
    )
    snapshot.update(payload)
    snapshot_key = _screen_snapshot_key(snapshot)
    if not force and snapshot_key == _AUTH_TRACE_LAST_SNAPSHOT_KEY:
        return
    _AUTH_TRACE_LAST_SNAPSHOT_KEY = snapshot_key
    _append_auth_trace_record(snapshot)


def _log_relogin_event(event, **payload):
    _append_auth_trace_record({"event": event, **payload})
    if not _relogin_debug_enabled():
        return
    details = {"event": event}
    details.update(payload)
    _log_relogin(json.dumps(details, sort_keys=True))


def _selector_count(page, selector):
    try:
        return page.locator(selector).count()
    except Exception:
        return 0


def _page_url(page):
    return getattr(page, "url", "") or ""


def _page_host(page):
    try:
        return (urlparse(_page_url(page)).hostname or "").lower()
    except Exception:
        return ""


def _is_linkedin_page(page):
    host = _page_host(page)
    return host == "linkedin.com" or host.endswith(".linkedin.com")


def get_all_accounts():
    """Return a list of {email, password} dicts.

    Reads from LINKEDIN_ACCOUNTS (JSON array) if set, otherwise falls back to
    the single-account LINKEDIN_EMAIL / LINKEDIN_PASSWORD env vars.
    """
    raw = (os.getenv(LINKEDIN_ACCOUNTS_ENV) or "").strip()
    if raw:
        try:
            accounts = json.loads(raw)
            if isinstance(accounts, list):
                valid = [
                    a
                    for a in accounts
                    if isinstance(a, dict) and (a.get("email") or "").strip() and a.get("password")
                ]
                if valid:
                    return valid
        except (json.JSONDecodeError, ValueError):
            pass

    creds = get_auto_relogin_credentials()
    if creds["enabled"]:
        return [{"email": creds["email"], "password": creds["password"]}]
    return []


def get_active_account_index():
    """Return the persisted active account index (0-based), defaulting to 0."""
    try:
        return max(0, int(LINKEDIN_ACTIVE_ACCOUNT_FILE.read_text().strip()))
    except Exception:
        return 0


def set_active_account_index(index):
    """Write the active account index to disk."""
    LINKEDIN_ACTIVE_ACCOUNT_FILE.parent.mkdir(parents=True, exist_ok=True)
    LINKEDIN_ACTIVE_ACCOUNT_FILE.write_text(str(index))


def get_storage_state_path_for_account(index):
    """Map an account index to its storage state file path."""
    if index == 0:
        return DEFAULT_STORAGE_STATE_PATH
    return ROOT / ".state" / f"linkedin_auth_state_{index}.json"


def load_account_blocks():
    """Return a dict mapping str(account_index) -> ISO blocked-until timestamp."""
    try:
        return json.loads(ACCOUNT_BLOCKS_FILE.read_text())
    except Exception:
        return {}


def save_account_blocks(blocks):
    ACCOUNT_BLOCKS_FILE.parent.mkdir(parents=True, exist_ok=True)
    ACCOUNT_BLOCKS_FILE.write_text(json.dumps(blocks, indent=2))


def block_account_for_days(index, days=ACCOUNT_BLOCK_DAYS):
    """Block an account for the given number of days."""
    until = (datetime.datetime.utcnow() + datetime.timedelta(days=days)).isoformat()
    blocks = load_account_blocks()
    blocks[str(index)] = until
    save_account_blocks(blocks)


def is_account_blocked(index):
    """Return True if account at index is still within its cooldown period."""
    blocks = load_account_blocks()
    until_str = blocks.get(str(index))
    if not until_str:
        return False
    try:
        return datetime.datetime.utcnow() < datetime.datetime.fromisoformat(until_str)
    except Exception:
        return False


def resolve_storage_state_path(storage_state_path=None):
    raw_path = storage_state_path or os.getenv("LINKEDIN_STORAGE_STATE_PATH")
    if raw_path:
        return Path(raw_path).expanduser().resolve()
    # Multi-account mode: use the active account's dedicated file
    if (os.getenv(LINKEDIN_ACCOUNTS_ENV) or "").strip():
        index = get_active_account_index()
        return get_storage_state_path_for_account(index)
    return DEFAULT_STORAGE_STATE_PATH


def ensure_storage_state_exists(storage_state_path=None):
    path = resolve_storage_state_path(storage_state_path)
    if not path.exists():
        raise LinkedInSessionError(
            "LinkedIn auth state not found. Run "
            f"'python hunter/linkedin_session.py --save-storage-state --storage-state \"{path}\"' "
            "after logging in to LinkedIn."
        )
    return path


def page_looks_logged_out(page):
    url = _page_url(page).lower()
    if any(token in url for token in ("/login", "/checkpoint", "/signup")):
        return True

    if not hasattr(page, "locator"):
        return False

    selectors = (
        "input[name='session_key']",
        "input[name='session_password']",
        "form.login__form",
    )
    return any(page.locator(selector).count() for selector in selectors)


def assert_logged_in(page):
    if page_looks_logged_out(page):
        raise LinkedInSessionError("LinkedIn session appears to be logged out or expired.")


def _feed_loaded(page):
    url = _page_url(page).lower()
    return "/feed" in url


def _close_page(page):
    if not page:
        return
    try:
        page.close()
    except Exception:
        pass


def _close_browser(browser):
    if not browser:
        return
    try:
        browser.close()
    except Exception:
        pass


def _handle_post_login_screens(page, *, max_rounds=5, timeout_ms=30000):
    """Click through LinkedIn interstitial / confirmation screens shown after login.

    Checks for the automation compliance notice first because that page lives at a
    /checkpoint/ URL which page_looks_logged_out would otherwise short-circuit.
    Raises LinkedInAutomationFlagged if that notice is detected so the caller can
    block the account.
    """
    for _ in range(max_rounds):
        if _feed_loaded(page):
            return

        # Must check automation notice before page_looks_logged_out because the
        # notice URL contains /checkpoint/ which that helper treats as logged out.
        try:
            automation_btn = page.locator(AUTOMATION_NOTICE_SELECTOR)
            if automation_btn.count():
                try:
                    automation_btn.first.click(timeout=timeout_ms)
                    page.wait_for_timeout(1500)
                except Exception:
                    pass
                raise LinkedInAutomationFlagged(
                    "LinkedIn detected automation activity on this account "
                    "and showed a compliance notice."
                )
        except LinkedInAutomationFlagged:
            raise
        except Exception:
            pass

        if page_looks_logged_out(page):
            return

        page.wait_for_timeout(1500)

        if _feed_loaded(page):
            return
        if page_looks_logged_out(page):
            return

        clicked = False
        for selector in POST_LOGIN_CONFIRMATION_SELECTORS:
            try:
                locator = page.locator(selector)
                if locator.count():
                    locator.first.click(timeout=timeout_ms)
                    page.wait_for_timeout(1000)
                    clicked = True
                    break
            except Exception:
                continue

        if not clicked:
            break


def _verify_session_and_save(context, target_path, *, timeout_ms=30000):
    verification_page = context.new_page()
    try:
        verification_page.goto(
            LOGIN_VERIFICATION_URL, wait_until="domcontentloaded", timeout=timeout_ms
        )
        _trace_auth_screen(
            verification_page,
            action="verify_session_loaded",
            force=True,
        )
        _handle_post_login_screens(verification_page, timeout_ms=timeout_ms)
        assert_logged_in(verification_page)
        if not _feed_loaded(verification_page):
            raise LinkedInSessionError(
                "LinkedIn login did not reach the home feed. "
                "Additional verification may still be required."
            )
        context.storage_state(path=str(target_path))
    finally:
        _close_page(verification_page)


def _login_form_available(page):
    email_input, _, password_input, _, _, _ = _get_login_form_controls(page)
    return email_input is not None and password_input is not None


def _welcome_back_available(page):
    welcome_back_selectors = (
        "h1:has-text('Welcome back')",
        "text=/Welcome back/i",
        "a:has-text('Sign in using another account')",
        "text=/Sign in using another account/i",
    )
    return any(_selector_count(page, selector) for selector in welcome_back_selectors)


def _classify_login_screen(page):
    url = _page_url(page)
    lower_url = url.lower()
    if url and not _is_linkedin_page(page):
        return "third_party_auth"
    if _feed_loaded(page):
        return "feed"
    if _login_form_available(page):
        return "login_form"
    if _welcome_back_available(page):
        return "welcome_back"
    if any(token in lower_url for token in ("/login", "/uas/login")):
        return "login_gate"
    if page_looks_logged_out(page):
        return "logged_out"
    return "unknown"


def _find_first_matching_locator(page, selectors, *, exact_text=None):
    if not hasattr(page, "locator"):
        return None, None
    for selector in selectors:
        locator = page.locator(selector)
        try:
            count = locator.count()
        except Exception:
            continue
        if not count:
            continue
        for index in range(count):
            candidate = locator.nth(index)
            try:
                if hasattr(candidate, "is_visible") and not candidate.is_visible():
                    continue
            except Exception:
                pass
            if exact_text is not None:
                try:
                    text = _normalize_text(candidate.text_content(timeout=1000))
                except Exception:
                    text = ""
                if text != exact_text:
                    continue
            return candidate, selector
    return None, None


def _get_login_form_controls(page):
    email_input, email_selector = _find_first_matching_locator(page, EMAIL_FIELD_SELECTORS)
    password_input, password_selector = _find_first_matching_locator(page, PASSWORD_FIELD_SELECTORS)
    submit_button, submit_selector = _find_first_matching_locator(
        page,
        SUBMIT_BUTTON_SELECTORS,
        exact_text="Sign in",
    )
    if submit_button is None:
        submit_button, submit_selector = _find_first_matching_locator(
            page,
            ("button[type='submit']",),
        )

    return (
        email_input,
        email_selector,
        password_input,
        password_selector,
        submit_button,
        submit_selector,
    )


def _wait_for_login_surface(page, *, email=None, timeout_ms=30000, poll_ms=500):
    remaining = max(timeout_ms, poll_ms)
    attempt = 0
    while remaining > 0:
        attempt += 1
        screen_type = _classify_login_screen(page)
        alt_counts = None
        chooser_counts = None
        if _relogin_debug_enabled():
            alt_counts = {
                selector: _selector_count(page, selector) for selector in ALT_SIGN_IN_SELECTORS
            }
            chooser_counts = {
                selector: _selector_count(page, selector) for selector in ACCOUNT_CHOOSER_SELECTORS
            }
            _log_relogin(
                f"wait_for_login_surface attempt={attempt} url={page.url} host={_page_host(page)} screen_type={screen_type} "
                f"alt_sign_in_counts={alt_counts} chooser_counts={chooser_counts} "
                f"login_form_available={_login_form_available(page)}"
            )
            _log_relogin_event(
                "screen_observed",
                attempt=attempt,
                screen_type=screen_type,
                url=page.url,
                host=_page_host(page),
                alt_sign_in_counts=alt_counts,
                chooser_counts=chooser_counts,
                login_form_available=_login_form_available(page),
            )
        _trace_auth_screen(
            page,
            attempt=attempt,
            alt_sign_in_counts=alt_counts if _relogin_debug_enabled() else None,
            chooser_counts=chooser_counts if _relogin_debug_enabled() else None,
            login_form_available=_login_form_available(page),
        )
        if screen_type == "third_party_auth":
            raise LinkedInSessionError(
                f"LinkedIn relogin navigated to a third-party auth page ({_page_host(page)})."
            )
        sign_in_other = _try_sign_in_another_account(page, timeout_ms=poll_ms)
        if _login_form_available(page):
            _log_relogin("email/password login form is available")
            _log_relogin_event("screen_ready", screen_type="login_form", url=page.url)
            return "login_form"
        chooser = _try_account_chooser_sign_in(page, email=email, timeout_ms=poll_ms)
        if chooser:
            _log_relogin(f"account chooser result: {chooser}")
            _log_relogin_event(
                "screen_ready", screen_type="welcome_back", chooser_result=chooser, url=page.url
            )
            return chooser
        if sign_in_other:
            _log_relogin(
                "clicked 'Sign in using another account' but login form is still not visible yet"
            )
            _log_relogin_event(
                "action_result",
                action="alt_sign_in_clicked",
                next_screen=_classify_login_screen(page),
                url=page.url,
            )
        page.wait_for_timeout(poll_ms)
        remaining -= poll_ms
    return None


def _try_account_chooser_sign_in(page, *, email=None, timeout_ms=30000):
    for selector in ACCOUNT_CHOOSER_SELECTORS:
        locator = page.locator(selector)
        try:
            count = locator.count()
        except Exception:
            continue
        if not count:
            continue
        try:
            locator.first.click(timeout=timeout_ms)
            page.wait_for_timeout(1500)
            _log_relogin(f"clicked chooser selector: {selector}")
            _log_relogin_event("click", target="chooser", selector=selector, url=page.url)
            _trace_auth_screen(
                page,
                action="after_chooser_click",
                selector=selector,
                force=True,
            )
        except Exception:
            continue
        if _login_form_available(page):
            return "login_form"
        return "clicked"

    # Fallback for "Welcome back" screen: find the account card by email text
    # or just click the first item in any account list on the page.
    if email:
        try:
            locator = page.locator(f"text={email}")
            if locator.count():
                locator.first.click(timeout=timeout_ms)
                page.wait_for_timeout(1500)
                _log_relogin("clicked chooser using exact email text match")
                _log_relogin_event(
                    "click", target="chooser_email_match", selector=f"text={email}", url=page.url
                )
                _trace_auth_screen(
                    page,
                    action="after_chooser_email_click",
                    selector=f"text={email}",
                    force=True,
                )
                if _login_form_available(page):
                    return "login_form"
                return "clicked"
        except Exception:
            pass

    try:
        if page.locator("h1:has-text('Welcome back')").count():
            for sel in (
                # Newer LinkedIn welcome-back screens sometimes render the
                # remembered account as a clickable div/span card and mask the
                # email, so the full-email text fallback above will not match.
                "text=/@/",
                "[role='button']:has-text('@')",
                "button:has-text('@')",
                "a:has-text('@')",
                "ul li button",
                "ul li a",
                "ul li",
            ):
                locator = page.locator(sel)
                if locator.count():
                    locator.first.click(timeout=timeout_ms)
                    page.wait_for_timeout(1500)
                    _log_relogin(f"clicked welcome-back fallback selector: {sel}")
                    _log_relogin_event(
                        "click", target="welcome_back_fallback", selector=sel, url=page.url
                    )
                    _trace_auth_screen(
                        page,
                        action="after_welcome_back_fallback_click",
                        selector=sel,
                        force=True,
                    )
                    if _login_form_available(page):
                        return "login_form"
                    return "clicked"
    except Exception:
        pass

    return None


def _try_sign_in_another_account(page, *, timeout_ms=30000):
    """Click 'Sign in using another account' if present, to reach the email/password form."""
    for selector in ALT_SIGN_IN_SELECTORS:
        try:
            locator = page.locator(selector)
            count = locator.count()
            if not count:
                continue
            for index in range(count):
                candidate = locator.nth(index)
                try:
                    if hasattr(candidate, "is_visible") and not candidate.is_visible():
                        continue
                except Exception:
                    pass
                try:
                    candidate.click(timeout=timeout_ms)
                    page.wait_for_timeout(1500)
                    _log_relogin(f"clicked alternate sign-in selector: {selector} [index={index}]")
                    _log_relogin_event(
                        "click",
                        target="alt_sign_in",
                        selector=selector,
                        index=index,
                        url=page.url,
                    )
                    _trace_auth_screen(
                        page,
                        action="after_alt_sign_in_click",
                        selector=selector,
                        index=index,
                        force=True,
                    )
                    return True
                except Exception as exc:
                    _log_relogin(
                        f"alternate sign-in click failed for selector: {selector} [index={index}] error={exc}"
                    )
                    _log_relogin_event(
                        "click_failed",
                        target="alt_sign_in",
                        selector=selector,
                        index=index,
                        url=page.url,
                        error=str(exc),
                    )
                    try:
                        candidate.click(timeout=timeout_ms, force=True)
                        page.wait_for_timeout(1500)
                        _log_relogin(
                            f"force-clicked alternate sign-in selector: {selector} [index={index}]"
                        )
                        _log_relogin_event(
                            "click",
                            target="alt_sign_in",
                            selector=selector,
                            index=index,
                            forced=True,
                            url=page.url,
                        )
                        _trace_auth_screen(
                            page,
                            action="after_alt_sign_in_force_click",
                            selector=selector,
                            index=index,
                            forced=True,
                            force=True,
                        )
                        return True
                    except Exception as force_exc:
                        _log_relogin(
                            f"alternate sign-in force click failed for selector: {selector} "
                            f"[index={index}] error={force_exc}"
                        )
                        _log_relogin_event(
                            "click_failed",
                            target="alt_sign_in",
                            selector=selector,
                            index=index,
                            forced=True,
                            url=page.url,
                            error=str(force_exc),
                        )
        except Exception as exc:
            _log_relogin(f"alternate sign-in selector probe failed: {selector} error={exc}")
            _log_relogin_event(
                "probe_failed",
                target="alt_sign_in",
                selector=selector,
                url=page.url,
                error=str(exc),
            )
            continue
    return False


def _submit_login_form(page, *, email, password, timeout_ms=30000):
    _log_relogin(f"starting relogin on url={page.url}")
    _log_relogin_event(
        "screen_observed",
        screen_type=_classify_login_screen(page),
        url=page.url,
        host=_page_host(page),
    )
    _trace_auth_screen(page, action="submit_login_form_started", force=True)
    # Give LinkedIn's login surface a moment to hydrate before chooser detection.
    page.wait_for_timeout(1000)
    (
        email_input,
        email_selector,
        password_input,
        password_selector,
        submit_button,
        submit_selector,
    ) = _get_login_form_controls(page)

    if email_input is None or password_input is None:
        _log_relogin("login form not visible yet; waiting for login surface")
        surface = _wait_for_login_surface(page, email=email, timeout_ms=min(timeout_ms, 5000))
        (
            email_input,
            email_selector,
            password_input,
            password_selector,
            submit_button,
            submit_selector,
        ) = _get_login_form_controls(page)
        if surface == "clicked":
            return "chooser_clicked"

    if email_input is None or password_input is None:
        _log_relogin(
            "login surface still unavailable; navigating directly to LOGIN_URL and retrying"
        )
        page.goto(LOGIN_URL, wait_until="domcontentloaded", timeout=timeout_ms)
        page.wait_for_timeout(1000)
        surface = _wait_for_login_surface(page, email=email, timeout_ms=min(timeout_ms, 5000))
        (
            email_input,
            email_selector,
            password_input,
            password_selector,
            submit_button,
            submit_selector,
        ) = _get_login_form_controls(page)
        if surface == "clicked":
            return "chooser_clicked"

    if email_input is None or password_input is None:
        _log_relogin(f"login form unavailable after retries; final url={page.url}")
        raise LinkedInSessionError(
            "LinkedIn login form or account chooser was not available for auto relogin."
        )
    if submit_button is None:
        _log_relogin(f"submit button unavailable on url={page.url}")
        raise LinkedInSessionError(
            "LinkedIn login submit button was not available for auto relogin."
        )

    if not _is_linkedin_page(page):
        raise LinkedInSessionError(
            f"Refusing to fill credentials on a non-LinkedIn page ({_page_host(page)})."
        )

    _log_relogin("filling email/password form and submitting")
    _log_relogin_event(
        "form_controls_selected",
        email_selector=email_selector,
        password_selector=password_selector,
        submit_selector=submit_selector,
        url=page.url,
    )
    _trace_auth_screen(
        page,
        action="before_form_fill",
        email_selector=email_selector,
        password_selector=password_selector,
        submit_selector=submit_selector,
        force=True,
    )
    _log_relogin_event("fill", field="email", value=email, url=page.url)
    email_input.fill(email, timeout=timeout_ms)
    _log_relogin_event("fill", field="password", value=_mask_secret(password), url=page.url)
    password_input.fill(password, timeout=timeout_ms)
    _log_relogin_event(
        "click",
        target="submit",
        selector=submit_selector or "login_submit",
        url=page.url,
    )
    submit_button.click(timeout=timeout_ms)
    page.wait_for_timeout(1500)
    _trace_auth_screen(
        page,
        action="after_submit_click",
        submit_selector=submit_selector or "login_submit",
        force=True,
    )
    return "form_submitted"


def _attempt_auto_relogin_in_context(context, target_path, *, email, password, timeout_ms=30000):
    page = context.new_page()
    try:
        page.goto(LOGIN_VERIFICATION_URL, wait_until="domcontentloaded", timeout=timeout_ms)
        _log_relogin(f"opened verification url; current url={page.url}")
        _log_relogin_event(
            "screen_observed",
            screen_type=_classify_login_screen(page),
            url=page.url,
            host=_page_host(page),
        )
        _trace_auth_screen(page, action="verification_page_loaded", force=True)
        if not page_looks_logged_out(page) and _feed_loaded(page):
            _log_relogin("existing session already reaches feed")
            _log_relogin_event("session_reused", url=page.url)
            _verify_session_and_save(context, target_path, timeout_ms=timeout_ms)
            return "session_reused"

        _submit_login_form(page, email=email, password=password, timeout_ms=timeout_ms)
        # Handle any post-login confirmation screens on the current page before
        # opening the verification page so session cookies are fully set.
        _handle_post_login_screens(page, timeout_ms=timeout_ms)
        _verify_session_and_save(context, target_path, timeout_ms=timeout_ms)
        return "relogged"
    finally:
        _close_page(page)


def _attempt_session_reuse_in_context(context, target_path, *, timeout_ms=30000):
    page = context.new_page()
    try:
        page.goto(LOGIN_VERIFICATION_URL, wait_until="domcontentloaded", timeout=timeout_ms)
        _handle_post_login_screens(page, timeout_ms=timeout_ms)
        assert_logged_in(page)
        if not _feed_loaded(page):
            raise LinkedInSessionError(
                "LinkedIn saved auth state did not reach the home feed. "
                "Additional verification may still be required."
            )
        context.storage_state(path=str(target_path))
        return "session_reused"
    finally:
        _close_page(page)


def _all_accounts_blocked_discord_alert(n_accounts):
    msg = (
        f"Hunt: all {n_accounts} LinkedIn account(s) are blocked for "
        f"{ACCOUNT_BLOCK_DAYS} days due to automation detection. "
        "No scraping will run until accounts are unblocked or new ones are added. "
        "Manual intervention required."
    )
    mark_linkedin_auth_unavailable(msg)
    send_discord_webhook_message(msg)
    return msg


def attempt_auto_relogin(
    storage_state_path=None,
    *,
    browser_channel=None,
    context=None,
    headless=True,
    slow_mo=0,
    timeout_ms=30000,
):
    _start_auth_trace_run(
        "auto_relogin",
        browser_channel=browser_channel or DEFAULT_BROWSER_CHANNEL,
        headless=headless,
        storage_state_path=str(resolve_storage_state_path(storage_state_path)),
        db_path=get_db_path(),
    )

    def finalize(result):
        result = dict(result)
        result["trace_path"] = str(resolve_auth_trace_path())
        result["db_path"] = get_db_path()
        _finish_auth_trace_run(
            "success" if result.get("recovered") else "failure",
            message=result.get("message"),
            attempted=result.get("attempted"),
            recovered=result.get("recovered"),
            db_path=get_db_path(),
        )
        return result

    accounts = get_all_accounts()
    if not accounts:
        target_path = resolve_storage_state_path(storage_state_path)
        if not target_path.exists():
            msg = (
                "LinkedIn auto relogin is not configured, and no saved auth state was found. "
                f"Set {AUTO_RELOGIN_EMAIL_ENV} and {AUTO_RELOGIN_PASSWORD_ENV} "
                f"or run 'python hunter/linkedin_session.py --save-storage-state --storage-state "
                f'"{target_path}"\'.'
            )
            mark_linkedin_auth_unavailable(msg)
            return finalize(
                {
                    "attempted": False,
                    "recovered": False,
                    "message": msg,
                }
            )

        try:
            if context is not None:
                mode = _attempt_session_reuse_in_context(
                    context,
                    target_path,
                    timeout_ms=timeout_ms,
                )
            else:
                with open_browser_context(
                    headless=headless,
                    slow_mo=slow_mo,
                    browser_channel=browser_channel or DEFAULT_BROWSER_CHANNEL,
                    storage_state_path=str(target_path),
                ) as relogin_context:
                    mode = _attempt_session_reuse_in_context(
                        relogin_context,
                        target_path,
                        timeout_ms=timeout_ms,
                    )
        except LinkedInAutomationFlagged as exc:
            msg = f"LinkedIn saved session check failed: {exc}"
            mark_linkedin_auth_unavailable(msg)
            return finalize(
                {
                    "attempted": True,
                    "recovered": False,
                    "message": msg,
                }
            )
        except PlaywrightTargetClosedError as exc:
            msg = f"LinkedIn saved session check aborted: browser was closed before completion ({exc})."
            mark_linkedin_auth_unavailable(msg)
            return finalize(
                {
                    "attempted": True,
                    "recovered": False,
                    "message": msg,
                }
            )
        except (BrowserRuntimeError, LinkedInSessionError) as exc:
            msg = f"LinkedIn saved session check failed: {exc}"
            mark_linkedin_auth_unavailable(msg)
            return finalize(
                {
                    "attempted": True,
                    "recovered": False,
                    "message": msg,
                }
            )

        mark_linkedin_auth_available()
        action = (
            "reused the existing saved session"
            if mode == "session_reused"
            else "refreshed the saved auth state"
        )
        return finalize(
            {
                "attempted": True,
                "recovered": True,
                "message": f"LinkedIn auto relogin {action}.",
            }
        )

    # Find the first non-blocked account starting from the current active index.
    current = get_active_account_index()
    account_index = None
    for offset in range(len(accounts)):
        idx = (current + offset) % len(accounts)
        if not is_account_blocked(idx):
            account_index = idx
            break

    if account_index is None:
        msg = _all_accounts_blocked_discord_alert(len(accounts))
        return finalize({"attempted": True, "recovered": False, "message": msg})

    if account_index != current:
        set_active_account_index(account_index)

    account = accounts[account_index]
    target_path = (
        Path(storage_state_path).expanduser().resolve()
        if storage_state_path
        else get_storage_state_path_for_account(account_index)
    )
    target_path.parent.mkdir(parents=True, exist_ok=True)
    storage_state = str(target_path) if target_path.exists() else None

    try:
        if context is not None:
            mode = _attempt_auto_relogin_in_context(
                context,
                target_path,
                email=account["email"],
                password=account["password"],
                timeout_ms=timeout_ms,
            )
        else:
            with open_browser_context(
                headless=headless,
                slow_mo=slow_mo,
                browser_channel=browser_channel or DEFAULT_BROWSER_CHANNEL,
                storage_state_path=storage_state,
            ) as relogin_context:
                mode = _attempt_auto_relogin_in_context(
                    relogin_context,
                    target_path,
                    email=account["email"],
                    password=account["password"],
                    timeout_ms=timeout_ms,
                )
    except LinkedInAutomationFlagged:
        block_account_for_days(account_index)
        C1Logger(discord=True).event(
            key="linkedin_last_automation_flagged",
            level="error",
            message=f"Hunt: LinkedIn automation detected. Account {account_index} blocked for {ACCOUNT_BLOCK_DAYS} days.",
            code="automation_detected",
            details={"account_index": account_index, "blocked_days": ACCOUNT_BLOCK_DAYS},
            discord=True,
        )
        # Find another available account to use on the next run.
        next_idx = None
        for offset in range(1, len(accounts) + 1):
            idx = (account_index + offset) % len(accounts)
            if not is_account_blocked(idx):
                next_idx = idx
                break
        if next_idx is None:
            msg = _all_accounts_blocked_discord_alert(len(accounts))
            return finalize({"attempted": True, "recovered": False, "message": msg})
        set_active_account_index(next_idx)
        mark_linkedin_auth_unavailable(
            f"Account {account_index} flagged for automation; rotated to {next_idx}."
        )
        return finalize(
            {
                "attempted": True,
                "recovered": False,
                "message": (
                    f"LinkedIn account {account_index} flagged for automation and blocked "
                    f"for {ACCOUNT_BLOCK_DAYS} days. Rotated to account {next_idx} "
                    "for the next run."
                ),
            }
        )
    except PlaywrightTargetClosedError as exc:
        msg = f"LinkedIn auto relogin aborted: browser was closed before completion ({exc})."
        mark_linkedin_auth_unavailable(msg)
        return finalize(
            {
                "attempted": True,
                "recovered": False,
                "message": msg,
            }
        )
    except (BrowserRuntimeError, LinkedInSessionError) as exc:
        msg = f"LinkedIn auto relogin failed: {exc}"
        mark_linkedin_auth_unavailable(msg)
        return finalize(
            {
                "attempted": True,
                "recovered": False,
                "message": msg,
            }
        )

    mark_linkedin_auth_available()
    action = (
        "reused the existing session"
        if mode == "session_reused"
        else "signed in with stored credentials"
    )
    return finalize(
        {
            "attempted": True,
            "recovered": True,
            "message": f"LinkedIn auto relogin {action} and refreshed the saved auth state.",
        }
    )


def rotate_linkedin_account(
    *,
    browser_channel=None,
    headless=True,
    slow_mo=0,
    timeout_ms=30000,
):
    """Advance to the next non-blocked LinkedIn account and attempt auto relogin.

    Returns a dict with keys:
      rotated (bool) : whether a different account was selected
      account_index (int) : the new active account index
      recovered (bool) : whether relogin succeeded
      message (str) : human-readable summary
    """
    accounts = get_all_accounts()
    if len(accounts) <= 1:
        return {
            "rotated": False,
            "account_index": 0,
            "recovered": False,
            "message": "Only one account configured; rotation skipped.",
        }

    current = get_active_account_index()
    # Find the next account that is not blocked.
    next_index = None
    for offset in range(1, len(accounts) + 1):
        idx = (current + offset) % len(accounts)
        if not is_account_blocked(idx):
            next_index = idx
            break

    if next_index is None:
        msg = _all_accounts_blocked_discord_alert(len(accounts))
        return {"rotated": False, "account_index": current, "recovered": False, "message": msg}

    set_active_account_index(next_index)
    account = accounts[next_index]
    target_path = get_storage_state_path_for_account(next_index)
    target_path.parent.mkdir(parents=True, exist_ok=True)
    storage_state = str(target_path) if target_path.exists() else None

    try:
        with open_browser_context(
            headless=headless,
            slow_mo=slow_mo,
            browser_channel=browser_channel or DEFAULT_BROWSER_CHANNEL,
            storage_state_path=storage_state,
        ) as relogin_context:
            mode = _attempt_auto_relogin_in_context(
                relogin_context,
                target_path,
                email=account["email"],
                password=account["password"],
                timeout_ms=timeout_ms,
            )
    except LinkedInAutomationFlagged:
        block_account_for_days(next_index)
        # Check if yet another account is available.
        fallback = None
        for offset in range(1, len(accounts) + 1):
            idx = (next_index + offset) % len(accounts)
            if not is_account_blocked(idx):
                fallback = idx
                break
        if fallback is None:
            msg = _all_accounts_blocked_discord_alert(len(accounts))
            return {
                "rotated": True,
                "account_index": next_index,
                "recovered": False,
                "message": msg,
            }
        set_active_account_index(fallback)
        mark_linkedin_auth_unavailable(
            f"Account {next_index} flagged for automation; queued account {fallback} for the next run."
        )
        return {
            "rotated": True,
            "account_index": next_index,
            "recovered": False,
            "message": (
                f"LinkedIn account {next_index} flagged for automation and blocked "
                f"for {ACCOUNT_BLOCK_DAYS} days. Queued account {fallback} for next run."
            ),
        }
    except PlaywrightTargetClosedError as exc:
        msg = f"Rotated to account {next_index} but browser was closed before completion: {exc}"
        mark_linkedin_auth_unavailable(msg)
        return {
            "rotated": True,
            "account_index": next_index,
            "recovered": False,
            "message": msg,
        }
    except (BrowserRuntimeError, LinkedInSessionError) as exc:
        msg = f"Rotated to account {next_index} but relogin failed: {exc}"
        mark_linkedin_auth_unavailable(msg)
        return {
            "rotated": True,
            "account_index": next_index,
            "recovered": False,
            "message": msg,
        }

    mark_linkedin_auth_available()
    action = (
        "reused existing session"
        if mode == "session_reused"
        else "signed in with stored credentials"
    )
    return {
        "rotated": True,
        "account_index": next_index,
        "recovered": True,
        "message": (f"Rotated to LinkedIn account {next_index}, {action} and saved auth state."),
    }


@contextmanager
def open_linkedin_context(
    storage_state_path=None, *, headless=True, slow_mo=0, browser_channel=None
):
    storage_state = ensure_storage_state_exists(storage_state_path)
    with open_browser_context(
        headless=headless,
        slow_mo=slow_mo,
        browser_channel=browser_channel or DEFAULT_BROWSER_CHANNEL,
        storage_state_path=str(storage_state),
    ) as context:
        yield context


def save_storage_state_interactively(storage_state_path=None, *, browser_channel=None):
    _start_auth_trace_run(
        "save_storage_state",
        browser_channel=browser_channel or DEFAULT_BROWSER_CHANNEL,
        storage_state_path=str(resolve_storage_state_path(storage_state_path)),
        db_path=get_db_path(),
    )
    target_path = resolve_storage_state_path(storage_state_path)
    target_path.parent.mkdir(parents=True, exist_ok=True)
    sync_playwright = load_sync_playwright()
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(
                headless=False,
                channel=browser_channel or DEFAULT_BROWSER_CHANNEL,
            )
            try:
                context = browser.new_context()
                page = context.new_page()
                page.goto("https://www.linkedin.com/", wait_until="domcontentloaded")
                _trace_auth_screen(page, action="manual_login_opened", force=True)

                print("A browser window opened for LinkedIn login.")
                print("Prefer LinkedIn's 'Sign in with email' flow here.")
                print("Google SSO popups can hang in Playwright-managed browsers.")
                print("After login, wait until your LinkedIn home/feed is visible.")
                try:
                    input("Press Enter here after login is complete, or Ctrl+C to cancel...")
                except KeyboardInterrupt as exc:
                    raise LinkedInSessionCancelled(
                        "LinkedIn auth state save cancelled. No auth state was written."
                    ) from exc

                try:
                    _verify_session_and_save(context, target_path, timeout_ms=30000)
                except LinkedInSessionError as exc:
                    raise LinkedInSessionNotSaved(
                        "LinkedIn auth state was not saved because the session does not appear "
                        "fully logged in yet. Preferred workflow: use 'Sign in with email', "
                        "wait for the LinkedIn feed to load, then press Enter."
                    ) from exc
                except Exception as exc:
                    raise LinkedInSessionNotSaved(
                        "LinkedIn auth state was not saved because the browser window or tab "
                        "closed before verification completed."
                    ) from exc
            finally:
                _close_browser(browser)
    except Exception as exc:
        _finish_auth_trace_run("failure", message=str(exc), db_path=get_db_path())
        raise

    mark_linkedin_auth_available()
    _finish_auth_trace_run(
        "success",
        message=f"Saved LinkedIn auth state to {target_path}",
        db_path=get_db_path(),
    )
    return target_path


def main():
    parser = argparse.ArgumentParser(description="Manage the saved Playwright LinkedIn session.")
    parser.add_argument(
        "--storage-state",
        help=f"Path to storage state JSON (default: {DEFAULT_STORAGE_STATE_PATH})",
    )
    parser.add_argument(
        "--save-storage-state",
        action="store_true",
        help="Open a headful browser so you can log in and save LinkedIn auth state.",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Verify that the configured auth-state file exists.",
    )
    parser.add_argument(
        "--channel",
        help="Optional Playwright browser channel such as chrome or msedge.",
    )
    parser.add_argument(
        "--auto-relogin",
        action="store_true",
        help=(
            "Reuse the saved LinkedIn auth state when possible, otherwise attempt "
            "a best-effort relogin using stored credentials."
        ),
    )
    parser.add_argument(
        "--headful",
        action="store_true",
        help="When used with --auto-relogin, show a visible browser window.",
    )
    parser.add_argument(
        "--timeout-ms",
        type=int,
        default=30000,
        help="Timeout for login verification and auto relogin steps (default: 30000).",
    )
    parser.add_argument(
        "--test-discord-webhook",
        action="store_true",
        help="Send a test message through the configured Discord webhook.",
    )
    parser.add_argument(
        "--discord-message",
        default="Hunt test: Discord webhook connectivity check.",
        help="Optional message to send with --test-discord-webhook.",
    )
    args = parser.parse_args()

    try:
        if args.save_storage_state:
            db_warning = get_db_path_warning()
            if db_warning:
                print(f"Warning: {db_warning}")
            saved_path = save_storage_state_interactively(
                storage_state_path=args.storage_state,
                browser_channel=args.channel,
            )
            print(f"Saved LinkedIn auth state to: {saved_path}")
            print(f"LinkedIn auth trace appended to: {resolve_auth_trace_path()}")
            print(f"LinkedIn auth DB path: {get_db_path()}")
            return 0

        if args.auto_relogin:
            db_warning = get_db_path_warning()
            if db_warning:
                print(f"Warning: {db_warning}")
            result = attempt_auto_relogin(
                storage_state_path=args.storage_state,
                browser_channel=args.channel,
                headless=not args.headful,
                timeout_ms=args.timeout_ms,
            )
            print(result["message"])
            if result.get("trace_path"):
                print(f"LinkedIn auth trace appended to: {result['trace_path']}")
            if result.get("db_path"):
                print(f"LinkedIn auth DB path: {result['db_path']}")
            return 0 if result.get("recovered") else 1

        if args.check:
            path = ensure_storage_state_exists(args.storage_state)
            print(f"LinkedIn auth state found: {path}")
            return 0

        if args.test_discord_webhook:
            result = send_discord_webhook_message(args.discord_message)
            if result["sent"]:
                print("Discord webhook test sent successfully.")
                return 0
            print(f"Discord webhook test failed: {result['reason']}")
            return 1

        parser.print_help()
        return 0
    except LinkedInSessionCancelled as exc:
        print(exc)
        return 0
    except LinkedInSessionNotSaved as exc:
        print(exc)
        return 0
    except BrowserRuntimeError as exc:
        print(f"Session error: {exc}")
        return 1
    except LinkedInSessionError as exc:
        print(f"Session error: {exc}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
