import argparse
import os
import sys
from contextlib import contextmanager
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_STORAGE_STATE_PATH = ROOT / ".state" / "linkedin_auth_state.json"
DEFAULT_BROWSER_CHANNEL = os.getenv("LINKEDIN_BROWSER_CHANNEL") or None
LOGIN_VERIFICATION_URL = "https://www.linkedin.com/feed/"


class LinkedInSessionError(RuntimeError):
    pass


class LinkedInSessionCancelled(LinkedInSessionError):
    pass


class LinkedInSessionNotSaved(LinkedInSessionError):
    pass


def load_sync_playwright():
    try:
        from playwright.sync_api import sync_playwright
    except ModuleNotFoundError as exc:
        raise LinkedInSessionError(
            "Playwright is not installed in this venv. Run "
            "'venv\\Scripts\\python.exe -m pip install playwright' and then "
            "'venv\\Scripts\\python.exe -m playwright install chromium'."
        ) from exc
    return sync_playwright


def resolve_storage_state_path(storage_state_path=None):
    raw_path = storage_state_path or os.getenv("LINKEDIN_STORAGE_STATE_PATH") or str(DEFAULT_STORAGE_STATE_PATH)
    return Path(raw_path).expanduser().resolve()


def ensure_storage_state_exists(storage_state_path=None):
    path = resolve_storage_state_path(storage_state_path)
    if not path.exists():
        raise LinkedInSessionError(
            "LinkedIn auth state not found. Run "
            f"'python scraper/linkedin_session.py --save-storage-state --storage-state \"{path}\"' "
            "after logging in to LinkedIn."
        )
    return path


def page_looks_logged_out(page):
    url = (page.url or "").lower()
    if any(token in url for token in ("/login", "/checkpoint", "/signup")):
        return True

    selectors = (
        "input[name='session_key']",
        "input[name='session_password']",
        "form.login__form",
    )
    return any(page.locator(selector).count() for selector in selectors)


def assert_logged_in(page):
    if page_looks_logged_out(page):
        raise LinkedInSessionError("LinkedIn session appears to be logged out or expired.")


@contextmanager
def open_linkedin_context(storage_state_path=None, *, headless=True, slow_mo=0, browser_channel=None):
    storage_state = ensure_storage_state_exists(storage_state_path)
    sync_playwright = load_sync_playwright()

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            headless=headless,
            slow_mo=slow_mo,
            channel=browser_channel or DEFAULT_BROWSER_CHANNEL,
        )
        context = browser.new_context(storage_state=str(storage_state))
        try:
            yield context
        finally:
            context.close()
            browser.close()


def save_storage_state_interactively(storage_state_path=None, *, browser_channel=None):
    target_path = resolve_storage_state_path(storage_state_path)
    target_path.parent.mkdir(parents=True, exist_ok=True)
    sync_playwright = load_sync_playwright()

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            headless=False,
            channel=browser_channel or DEFAULT_BROWSER_CHANNEL,
        )
        try:
            context = browser.new_context()
            page = context.new_page()
            page.goto("https://www.linkedin.com/", wait_until="domcontentloaded")

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

            verification_page = None
            try:
                verification_page = context.new_page()
                verification_page.goto(LOGIN_VERIFICATION_URL, wait_until="domcontentloaded", timeout=30000)
                assert_logged_in(verification_page)
                context.storage_state(path=str(target_path))
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
                if verification_page:
                    try:
                        verification_page.close()
                    except Exception:
                        pass
        finally:
            browser.close()

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
    args = parser.parse_args()

    try:
        if args.save_storage_state:
            saved_path = save_storage_state_interactively(
                storage_state_path=args.storage_state,
                browser_channel=args.channel,
            )
            print(f"Saved LinkedIn auth state to: {saved_path}")
            return 0

        if args.check:
            path = ensure_storage_state_exists(args.storage_state)
            print(f"LinkedIn auth state found: {path}")
            return 0

        parser.print_help()
        return 0
    except LinkedInSessionCancelled as exc:
        print(exc)
        return 0
    except LinkedInSessionNotSaved as exc:
        print(exc)
        return 0
    except LinkedInSessionError as exc:
        print(f"Session error: {exc}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
