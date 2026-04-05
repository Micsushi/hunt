import argparse
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from db import (
    claim_linkedin_job_for_enrichment,
    get_job_by_id,
    mark_linkedin_enrichment_failed,
    mark_linkedin_enrichment_succeeded,
)
from linkedin_session import LinkedInSessionError, assert_logged_in, open_linkedin_context
from url_utils import (
    detect_ats_type,
    get_apply_host,
    looks_like_linkedin_url,
    normalize_apply_url,
    normalize_optional_str,
)


try:
    from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
except ModuleNotFoundError:
    class PlaywrightTimeoutError(Exception):
        pass


DESCRIPTION_SELECTORS = (
    ".jobs-description__content",
    ".jobs-box__html-content",
    ".jobs-description-content__text",
    ".jobs-description__container",
    "section.show-more-less-html__markup",
    ".jobs-search__job-details--container",
)

DESCRIPTION_EXPAND_SELECTORS = (
    "button[aria-label*='description' i]",
    "button.jobs-description__footer-button",
    "button.inline-show-more-text__button",
    "button:has-text('See more')",
)

EXTERNAL_DESCRIPTION_SELECTORS = (
    "[data-ui='job-description']",
    "[data-qa='job-description']",
    ".job-description",
    ".job-description__text",
    ".jobDescriptionText",
    ".posting",
    ".posting-page",
    ".section-wrapper",
    ".jobs-description",
    "main",
    "article",
    "[role='main']",
)

JOB_REMOVED_PATTERNS = (
    "no longer accepting applications",
    "job is no longer available",
    "job unavailable",
    "this job has expired",
    "position has been filled",
)

APPLY_LABEL_RE = re.compile(r"\bapply\b", re.IGNORECASE)
EASY_APPLY_LABEL_RE = re.compile(r"easy apply", re.IGNORECASE)


class LinkedInEnrichmentError(RuntimeError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


def normalize_description_text(text):
    normalized = normalize_optional_str(text)
    if not normalized:
        return None

    lines = [re.sub(r"\s+", " ", line).strip() for line in normalized.splitlines()]
    cleaned = "\n".join(line for line in lines if line)
    return cleaned or None


def first_visible_locator(locators):
    for locator in locators:
        try:
            if locator.count() > 0 and locator.first.is_visible():
                return locator.first
        except Exception:
            continue
    return None


def click_expand_description(page, selectors):
    for selector in selectors:
        try:
            locator = page.locator(selector)
            if locator.count() > 0 and locator.first.is_visible():
                locator.first.click(timeout=1500)
        except Exception:
            continue


def extract_best_text(page, selectors):
    best_text = None
    for selector in selectors:
        try:
            locator = page.locator(selector)
            if locator.count() == 0:
                continue

            for raw_text in locator.all_inner_texts():
                candidate = normalize_description_text(raw_text)
                if not candidate:
                    continue
                if best_text is None or len(candidate) > len(best_text):
                    best_text = candidate
        except Exception:
            continue

    return best_text


def extract_description(
    page,
    *,
    selectors=DESCRIPTION_SELECTORS,
    expand_selectors=DESCRIPTION_EXPAND_SELECTORS,
    error_code="description_not_found",
    error_message="Could not extract the LinkedIn job description from the current page layout.",
):
    if expand_selectors:
        click_expand_description(page, expand_selectors)

    best_text = extract_best_text(page, selectors)

    if best_text:
        return best_text

    raise LinkedInEnrichmentError(error_code, error_message)


def get_locator_label(locator):
    for getter in (locator.inner_text, locator.text_content):
        try:
            return normalize_optional_str(getter())
        except Exception:
            continue
    return None


def get_locator_href(locator):
    try:
        href = locator.evaluate("(el) => el.href || el.getAttribute('href') || null")
    except Exception:
        href = None
    return normalize_apply_url(href)


def detect_job_removed(page):
    try:
        body_text = page.locator("body").inner_text(timeout=3000).lower()
    except Exception:
        return False
    return any(pattern in body_text for pattern in JOB_REMOVED_PATTERNS)


def find_easy_apply_button(page):
    locators = (
        page.get_by_role("button", name=EASY_APPLY_LABEL_RE),
        page.get_by_role("link", name=EASY_APPLY_LABEL_RE),
        page.locator("button.jobs-apply-button:has-text('Easy Apply')"),
        page.locator("a.jobs-apply-button:has-text('Easy Apply')"),
    )
    return first_visible_locator(locators)


def debug_apply_locator(page, label):
    print(f"[enrich] {label}")

    def describe(locator):
        locator_label = get_locator_label(locator)
        locator_href = get_locator_href(locator)
        try:
            tag_name = locator.evaluate("(el) => el.tagName.toLowerCase()")
        except Exception:
            tag_name = "unknown"
        print(f"  tag={tag_name} label={locator_label!r} href={locator_href!r}")

    external_button = find_external_apply_button(page)
    if external_button:
        describe(external_button)
    else:
        print("  external_apply_button=None")

    easy_button = find_easy_apply_button(page)
    if easy_button:
        describe(easy_button)
    else:
        print("  easy_apply_button=None")


def find_external_apply_button(page):
    candidates = (
        page.locator("a.jobs-apply-button, button.jobs-apply-button"),
        page.locator("[data-live-test-job-apply-button]"),
        page.get_by_role("link", name=APPLY_LABEL_RE),
        page.get_by_role("button", name=APPLY_LABEL_RE),
    )

    for locator_group in candidates:
        try:
            count = locator_group.count()
        except Exception:
            count = 0

        for index in range(count):
            locator = locator_group.nth(index)
            try:
                if not locator.is_visible():
                    continue
                label = (get_locator_label(locator) or "").lower()
                if "easy apply" in label:
                    continue
                if "apply" in label:
                    return locator
            except Exception:
                continue

    return None


def capture_external_apply_url(page, locator, *, timeout_ms, existing_apply_url=None):
    direct_href = get_locator_href(locator)
    if direct_href and not looks_like_linkedin_url(direct_href):
        return direct_href

    before_url = page.url
    popup = None
    try:
        with page.context.expect_page(timeout=min(timeout_ms, 5000)) as popup_info:
            locator.click(timeout=timeout_ms, no_wait_after=True)
        popup = popup_info.value
        popup.wait_for_load_state("domcontentloaded", timeout=timeout_ms)
        try:
            popup.wait_for_load_state("networkidle", timeout=min(timeout_ms, 5000))
        except PlaywrightTimeoutError:
            pass
        apply_url = normalize_apply_url(popup.url)
        if popup:
            popup.close()
        if apply_url and not looks_like_linkedin_url(apply_url):
            return apply_url
    except PlaywrightTimeoutError:
        pass
    except Exception:
        if popup:
            try:
                popup.close()
            except Exception:
                pass

    try:
        page.wait_for_timeout(1500)
    except Exception:
        pass

    current_page_url = normalize_apply_url(page.url)
    if current_page_url and current_page_url != before_url and not looks_like_linkedin_url(current_page_url):
        try:
            page.go_back(wait_until="domcontentloaded", timeout=timeout_ms)
        except Exception:
            pass
        return current_page_url

    existing_hint = normalize_apply_url(existing_apply_url)
    if existing_hint and not looks_like_linkedin_url(existing_hint):
        return existing_hint

    return None


def detect_apply_result(page, *, existing_apply_url=None, timeout_ms=45000):
    debug_apply_locator(page, "Apply detection candidates")
    external_apply_button = find_external_apply_button(page)
    if external_apply_button:
        apply_url = capture_external_apply_url(
            page,
            external_apply_button,
            timeout_ms=timeout_ms,
            existing_apply_url=existing_apply_url,
        )
        if apply_url:
            print(f"[enrich] Resolved external apply URL: {apply_url}")
            return {
                "apply_type": "external_apply",
                "auto_apply_eligible": 1,
                "apply_url": apply_url,
                "apply_host": get_apply_host(apply_url),
                "ats_type": detect_ats_type(apply_url),
            }
        print("[enrich] Found an external-looking apply action but could not resolve a destination URL.")

    easy_apply_button = find_easy_apply_button(page)
    if easy_apply_button:
        print("[enrich] Classified as Easy Apply.")
        return {
            "apply_type": "easy_apply",
            "auto_apply_eligible": 0,
            "apply_url": None,
            "apply_host": None,
            "ats_type": None,
        }

    if detect_job_removed(page):
        raise LinkedInEnrichmentError(
            "job_removed",
            "LinkedIn indicates the job is no longer available or accepting applications.",
        )
    raise LinkedInEnrichmentError(
        "apply_button_not_found",
        "Could not find a primary LinkedIn apply action on the job page.",
    )


def extract_external_description(context, apply_url, *, timeout_ms):
    external_page = context.new_page()
    try:
        external_page.goto(apply_url, wait_until="domcontentloaded", timeout=timeout_ms)
        try:
            external_page.wait_for_load_state("networkidle", timeout=min(timeout_ms, 5000))
        except PlaywrightTimeoutError:
            pass

        return extract_description(
            external_page,
            selectors=EXTERNAL_DESCRIPTION_SELECTORS,
            expand_selectors=(),
            error_code="external_description_not_found",
            error_message="Could not extract a usable description from the external application page.",
        )
    finally:
        try:
            external_page.close()
        except Exception:
            pass


def enrich_claimed_linkedin_job(job, *, storage_state_path=None, headless=True, slow_mo=0, timeout_ms=45000, browser_channel=None):
    with open_linkedin_context(
        storage_state_path=storage_state_path,
        headless=headless,
        slow_mo=slow_mo,
        browser_channel=browser_channel,
    ) as context:
        page = context.new_page()
        page.goto(job["job_url"], wait_until="domcontentloaded", timeout=timeout_ms)

        try:
            page.wait_for_load_state("networkidle", timeout=min(timeout_ms, 5000))
        except PlaywrightTimeoutError:
            pass

        assert_logged_in(page)

        if detect_job_removed(page):
            raise LinkedInEnrichmentError(
                "job_removed",
                "LinkedIn indicates the job is no longer available or accepting applications.",
            )

        apply_result = detect_apply_result(
            page,
            existing_apply_url=job.get("apply_url"),
            timeout_ms=timeout_ms,
        )
        try:
            description = extract_description(page)
        except LinkedInEnrichmentError as exc:
            if (
                exc.code == "description_not_found"
                and apply_result["apply_type"] == "external_apply"
                and apply_result["apply_url"]
            ):
                print("[enrich] LinkedIn page lacked a usable description. Falling back to external application page.")
                description = extract_external_description(
                    context,
                    apply_result["apply_url"],
                    timeout_ms=timeout_ms,
                )
            else:
                raise

        result = {
            "description": description,
            **apply_result,
        }
        return result


def format_error_message(error):
    if isinstance(error, LinkedInEnrichmentError):
        return f"{error.code}: {error.message}"
    if isinstance(error, LinkedInSessionError):
        return f"auth_expired: {error}"
    return f"unexpected_error: {error}"


def process_one_job(job_id=None, *, storage_state_path=None, headless=True, slow_mo=0, timeout_ms=45000, browser_channel=None, force=False):
    claimed_job = claim_linkedin_job_for_enrichment(job_id=job_id, force=force)
    if not claimed_job:
        if job_id is None:
            print("No pending LinkedIn rows are ready for enrichment.")
        else:
            print(f"Could not claim LinkedIn job id={job_id} for enrichment.")
        return 1

    print(f"[enrich] Claimed LinkedIn job id={claimed_job['id']} company={claimed_job.get('company')} title={claimed_job.get('title')}")
    try:
        result = enrich_claimed_linkedin_job(
            claimed_job,
            storage_state_path=storage_state_path,
            headless=headless,
            slow_mo=slow_mo,
            timeout_ms=timeout_ms,
            browser_channel=browser_channel,
        )
        mark_linkedin_enrichment_succeeded(
            claimed_job["id"],
            description=result["description"],
            apply_type=result["apply_type"],
            auto_apply_eligible=result["auto_apply_eligible"],
            apply_url=result["apply_url"],
            apply_host=result["apply_host"],
            ats_type=result["ats_type"],
        )

        updated_job = get_job_by_id(claimed_job["id"])
        print("[enrich] Success")
        print(f"  id: {updated_job['id']}")
        print(f"  apply_type: {updated_job['apply_type']}")
        print(f"  auto_apply_eligible: {updated_job['auto_apply_eligible']}")
        print(f"  apply_url: {updated_job['apply_url']}")
        print(f"  apply_host: {updated_job['apply_host']}")
        print(f"  ats_type: {updated_job['ats_type']}")
        print(f"  enrichment_status: {updated_job['enrichment_status']}")
        print(f"  enriched_at: {updated_job['enriched_at']}")
        return 0
    except Exception as exc:
        error_message = format_error_message(exc)
        mark_linkedin_enrichment_failed(claimed_job["id"], error_message)
        print("[enrich] Failed")
        print(f"  id: {claimed_job['id']}")
        print(f"  error: {error_message}")
        return 1


def main():
    parser = argparse.ArgumentParser(description="Enrich one LinkedIn job using a saved Playwright session.")
    parser.add_argument("--job-id", type=int, help="Specific LinkedIn job id to enrich.")
    parser.add_argument(
        "--storage-state",
        help="Path to Playwright storage state JSON. Defaults to LINKEDIN_STORAGE_STATE_PATH or .state/linkedin_auth_state.json.",
    )
    parser.add_argument("--headful", action="store_true", help="Run Chromium with a visible browser window.")
    parser.add_argument("--slow-mo", type=int, default=0, help="Optional Playwright slow_mo value in milliseconds.")
    parser.add_argument("--timeout-ms", type=int, default=45000, help="Navigation/action timeout in milliseconds.")
    parser.add_argument("--channel", help="Optional Playwright browser channel such as chrome.")
    parser.add_argument(
        "--force",
        action="store_true",
        help="Allow enriching a specific LinkedIn row even if it is not currently pending.",
    )
    args = parser.parse_args()

    if args.force and args.job_id is None:
        parser.error("--force requires --job-id")

    return process_one_job(
        job_id=args.job_id,
        storage_state_path=args.storage_state,
        headless=not args.headful,
        slow_mo=args.slow_mo,
        timeout_ms=args.timeout_ms,
        browser_channel=args.channel,
        force=args.force,
    )


if __name__ == "__main__":
    sys.exit(main())
