import os
from contextlib import contextmanager
from pathlib import Path


class BrowserRuntimeError(RuntimeError):
    pass


try:
    from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
except ModuleNotFoundError:
    class PlaywrightTimeoutError(Exception):
        pass


def load_sync_playwright():
    try:
        from playwright.sync_api import sync_playwright
    except ModuleNotFoundError as exc:
        raise BrowserRuntimeError(
            "Playwright is not installed in this venv. Run "
            "'venv\\Scripts\\python.exe -m pip install playwright' and then "
            "'venv\\Scripts\\python.exe -m playwright install chromium'."
        ) from exc
    return sync_playwright


@contextmanager
def open_browser_context(*, headless=True, slow_mo=0, browser_channel=None, storage_state_path=None):
    sync_playwright = load_sync_playwright()
    storage_state = None
    if storage_state_path:
        storage_state = str(Path(storage_state_path).expanduser().resolve())

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            headless=headless,
            slow_mo=slow_mo,
            channel=browser_channel or None,
        )
        context_kwargs = {}
        if storage_state:
            context_kwargs["storage_state"] = storage_state
        context = browser.new_context(**context_kwargs)
        try:
            yield context
        finally:
            context.close()
            browser.close()
