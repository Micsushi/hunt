import argparse
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from db import (
    claim_linkedin_job_for_enrichment,
    get_job_by_id,
    mark_linkedin_enrichment_failed,
    mark_linkedin_enrichment_succeeded,
)
from enrichment_policy import compute_retry_after, format_sqlite_timestamp
from failure_artifacts import capture_page_artifacts
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

GENERIC_DESCRIPTION_ROOT_SELECTORS = (
    "main",
    "article",
    "[role='main']",
    "body",
)

JOB_REMOVED_PATTERNS = (
    "no longer accepting applications",
    "job is no longer available",
    "job unavailable",
    "this job has expired",
    "position has been filled",
)

RATE_LIMIT_PATTERNS = (
    "too many requests",
    "try again later",
    "rate limit",
    "rate-limited",
    "temporarily blocked",
    "unusual traffic",
    "please try again later",
)

SECURITY_CHALLENGE_TITLE_PATTERNS = (
    "security verification",
    "verification required",
    "access denied",
    "attention required",
    "just a moment",
    "captcha",
)

SECURITY_CHALLENGE_URL_PATTERNS = (
    "captcha",
    "cf_chl_",
    "challenge-platform",
    "security-verification",
    "securitycheck",
    "security_check",
    "unblock",
)

SECURITY_CHALLENGE_TEXT_PATTERNS = (
    "performing security verification",
    "verify you are not a bot",
    "security service to protect against malicious bots",
    "made us think that you are a bot",
    "request unblock",
    "incident id",
    "please solve this captcha",
    "captcha to request unblock",
)

SECURITY_CHALLENGE_DOM_SELECTORS = (
    "iframe[src*='captcha' i]",
    "iframe[title*='captcha' i]",
    "textarea[name='g-recaptcha-response']",
    "textarea[name='h-captcha-response']",
    ".g-recaptcha",
    ".h-captcha",
    "[data-sitekey]",
    "form[action*='captcha' i]",
    "form[action*='challenge' i]",
    "#challenge-form",
    "#challenge-stage",
    "[id*='captcha' i]",
    "[class*='captcha' i]",
)

SECURITY_CHALLENGE_HEADING_SELECTORS = (
    "h1",
    "h2",
    "[role='heading']",
)

APPLY_LABEL_RE = re.compile(r"\bapply\b", re.IGNORECASE)
EASY_APPLY_LABEL_RE = re.compile(r"easy apply", re.IGNORECASE)
CONTINUE_APPLYING_LABEL_RE = re.compile(r"continue applying", re.IGNORECASE)

SUCCESS_STATUS_DEFAULT = "done"
SUCCESS_STATUS_UI_VERIFIED = "done_verified"
FAILURE_STATUS_DEFAULT = "failed"
FAILURE_STATUS_BLOCKED = "blocked"
FAILURE_STATUS_BLOCKED_UI_VERIFIED = "blocked_verified"
BLOCKED_ERROR_CODES = {"security_verification", "access_challenged"}
BATCH_HARD_STOP_ERROR_CODES = {"auth_expired", "rate_limited"}
FAST_UI_NETWORKIDLE_TIMEOUT_MS = 1200
DEFAULT_NETWORKIDLE_TIMEOUT_MS = 5000
DEFAULT_POST_CLICK_WAIT_MS = 1500
FAST_UI_POST_CLICK_WAIT_MS = 350
GENERIC_EXTERNAL_DESCRIPTION_MIN_CHARS = 500
GENERIC_EXTERNAL_DESCRIPTION_MIN_SIGNAL_HITS = 2
JOB_DESCRIPTION_SIGNAL_KEYWORDS = (
    "about the role",
    "responsibilities",
    "requirements",
    "qualifications",
    "minimum qualifications",
    "preferred qualifications",
    "what you'll do",
    "what you will do",
    "experience",
    "benefits",
    "job details",
    "overview",
    "department",
    "location",
    "employment type",
    "salary",
    "compensation",
)


class LinkedInEnrichmentError(RuntimeError):
    def __init__(self, code, message, *, partial_result=None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.partial_result = partial_result


def normalize_description_text(text):
    normalized = normalize_optional_str(text)
    if not normalized:
        return None

    lines = [re.sub(r"\s+", " ", line).strip() for line in normalized.splitlines()]
    cleaned = "\n".join(line for line in lines if line)
    return cleaned or None


def score_description_candidate(text):
    normalized = normalize_description_text(text)
    if not normalized:
        return -1

    lower_text = normalized.lower()
    keyword_bonus = 0
    for keyword in (
        "about the role",
        "responsibilities",
        "requirements",
        "qualifications",
        "what you'll do",
        "what you will do",
        "about you",
        "experience",
        "benefits",
    ):
        if keyword in lower_text:
            keyword_bonus += 250
    return len(normalized) + keyword_bonus


def count_job_description_signal_hits(text):
    normalized = normalize_description_text(text)
    if not normalized:
        return 0

    lower_text = normalized.lower()
    return sum(1 for keyword in JOB_DESCRIPTION_SIGNAL_KEYWORDS if keyword in lower_text)


def looks_like_usable_job_description(text):
    normalized = normalize_description_text(text)
    if not normalized:
        return False

    signal_hits = count_job_description_signal_hits(normalized)
    if len(normalized) >= GENERIC_EXTERNAL_DESCRIPTION_MIN_CHARS:
        return True
    if len(normalized) >= 250 and signal_hits >= GENERIC_EXTERNAL_DESCRIPTION_MIN_SIGNAL_HITS:
        return True
    return False


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
    best_score = -1
    for selector in selectors:
        try:
            locator = page.locator(selector)
            if locator.count() == 0:
                continue

            for raw_text in locator.all_inner_texts():
                candidate = normalize_description_text(raw_text)
                if not candidate:
                    continue
                score = score_description_candidate(candidate)
                if best_text is None or score > best_score:
                    best_text = candidate
                    best_score = score
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


def extract_generic_page_text(page, *, selectors=GENERIC_DESCRIPTION_ROOT_SELECTORS, min_chars=250):
    candidate = extract_best_text(page, selectors)
    if candidate and len(candidate) >= min_chars:
        return candidate
    return None


def get_networkidle_timeout_ms(*, fast_ui=False):
    return FAST_UI_NETWORKIDLE_TIMEOUT_MS if fast_ui else DEFAULT_NETWORKIDLE_TIMEOUT_MS


def get_post_click_wait_ms(*, fast_ui=False):
    return FAST_UI_POST_CLICK_WAIT_MS if fast_ui else DEFAULT_POST_CLICK_WAIT_MS


def settle_page_after_navigation(page, *, timeout_ms, fast_ui=False):
    try:
        page.wait_for_load_state(
            "networkidle",
            timeout=min(timeout_ms, get_networkidle_timeout_ms(fast_ui=fast_ui)),
        )
    except PlaywrightTimeoutError:
        pass


def get_page_title(page):
    try:
        return normalize_optional_str(page.title())
    except Exception:
        return None


def count_pattern_hits(text, patterns, *, min_hits=1):
    normalized = normalize_optional_str(text)
    if not normalized:
        return []

    lower_text = normalized.lower()
    hits = [pattern for pattern in patterns if pattern in lower_text]
    if len(hits) < min_hits:
        return []
    return hits


def find_present_selectors(page, selectors):
    matches = []
    for selector in selectors:
        try:
            locator = page.locator(selector)
            if locator.count() == 0:
                continue

            try:
                if locator.first.is_visible():
                    matches.append(selector)
                    continue
            except Exception:
                pass

            matches.append(selector)
        except Exception:
            continue

    return matches


def analyze_security_challenge(page):
    signals = {}

    title_hits = count_pattern_hits(get_page_title(page), SECURITY_CHALLENGE_TITLE_PATTERNS)
    if title_hits:
        signals["title"] = title_hits

    url_hits = count_pattern_hits(getattr(page, "url", None), SECURITY_CHALLENGE_URL_PATTERNS)
    if url_hits:
        signals["url"] = url_hits

    heading_hits = count_pattern_hits(
        extract_best_text(page, SECURITY_CHALLENGE_HEADING_SELECTORS),
        SECURITY_CHALLENGE_TEXT_PATTERNS + SECURITY_CHALLENGE_TITLE_PATTERNS,
    )
    if heading_hits:
        signals["heading"] = heading_hits

    body_hits = count_pattern_hits(
        extract_best_text(page, ("body",)),
        SECURITY_CHALLENGE_TEXT_PATTERNS,
        min_hits=2,
    )
    if body_hits:
        signals["text"] = body_hits

    dom_matches = find_present_selectors(page, SECURITY_CHALLENGE_DOM_SELECTORS)
    if dom_matches:
        signals["dom"] = dom_matches[:3]

    if not signals:
        return None

    categories = set(signals)
    is_security_challenge = (
        ("dom" in categories and ("text" in categories or "title" in categories or "heading" in categories or "url" in categories))
        or ("heading" in categories and ("text" in categories or "url" in categories))
        or ("title" in categories and ("text" in categories or "url" in categories))
        or ("text" in categories and "url" in categories)
    )
    if not is_security_challenge:
        return None

    return signals


def raise_if_security_challenged(page, *, error_code, page_label):
    signals = analyze_security_challenge(page)
    if not signals:
        return

    signal_labels = ", ".join(sorted(signals))
    raise LinkedInEnrichmentError(
        error_code,
        f"{page_label} appears to be blocked by a CAPTCHA or security-verification challenge (signals: {signal_labels}).",
    )


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


def detect_rate_limited(page):
    try:
        body_text = page.locator("body").inner_text(timeout=3000).lower()
    except Exception:
        return False
    return any(pattern in body_text for pattern in RATE_LIMIT_PATTERNS)


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


def find_continue_applying_button(page):
    locators = (
        page.get_by_role("link", name=CONTINUE_APPLYING_LABEL_RE),
        page.get_by_role("button", name=CONTINUE_APPLYING_LABEL_RE),
        page.locator("a:has-text('Continue applying')"),
        page.locator("button:has-text('Continue applying')"),
    )
    return first_visible_locator(locators)


def click_locator_and_capture_url(page, locator, *, timeout_ms, fast_ui=False):
    before_url = page.url
    popup = None
    try:
        with page.context.expect_page(timeout=min(timeout_ms, 5000)) as popup_info:
            locator.click(timeout=timeout_ms, no_wait_after=True)
        popup = popup_info.value
        popup.wait_for_load_state("domcontentloaded", timeout=timeout_ms)
        settle_page_after_navigation(popup, timeout_ms=timeout_ms, fast_ui=fast_ui)
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
        page.wait_for_timeout(get_post_click_wait_ms(fast_ui=fast_ui))
    except Exception:
        pass

    current_page_url = normalize_apply_url(page.url)
    if current_page_url and current_page_url != before_url and not looks_like_linkedin_url(current_page_url):
        try:
            page.go_back(wait_until="domcontentloaded", timeout=timeout_ms)
        except Exception:
            pass
        return current_page_url

    return None


def capture_external_apply_url(page, locator, *, timeout_ms, existing_apply_url=None, fast_ui=False):
    direct_href = get_locator_href(locator)
    if direct_href and not looks_like_linkedin_url(direct_href):
        return direct_href

    apply_url = click_locator_and_capture_url(page, locator, timeout_ms=timeout_ms, fast_ui=fast_ui)
    if apply_url:
        return apply_url

    continue_button = find_continue_applying_button(page)
    if continue_button:
        print("[enrich] Detected LinkedIn interstitial. Following 'Continue applying' action.")
        continue_href = get_locator_href(continue_button)
        if continue_href and not looks_like_linkedin_url(continue_href):
            return continue_href

        apply_url = click_locator_and_capture_url(page, continue_button, timeout_ms=timeout_ms, fast_ui=fast_ui)
        if apply_url:
            return apply_url

    existing_hint = normalize_apply_url(existing_apply_url)
    if existing_hint and not looks_like_linkedin_url(existing_hint):
        return existing_hint

    return None


def detect_apply_result(page, *, existing_apply_url=None, timeout_ms=45000, fast_ui=False):
    debug_apply_locator(page, "Apply detection candidates")
    external_apply_button = find_external_apply_button(page)
    if external_apply_button:
        apply_url = capture_external_apply_url(
            page,
            external_apply_button,
            timeout_ms=timeout_ms,
            existing_apply_url=existing_apply_url,
            fast_ui=fast_ui,
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


def extract_external_description(context, apply_url, *, timeout_ms, fast_ui=False):
    external_page = context.new_page()
    try:
        external_page.goto(apply_url, wait_until="domcontentloaded", timeout=timeout_ms)
        settle_page_after_navigation(external_page, timeout_ms=timeout_ms, fast_ui=fast_ui)

        raise_if_security_challenged(
            external_page,
            error_code="security_verification",
            page_label="External application page",
        )

        if detect_rate_limited(external_page):
            raise LinkedInEnrichmentError(
                "rate_limited",
                "The external application page appears to be rate-limited or temporarily blocked.",
            )

        if detect_job_removed(external_page):
            raise LinkedInEnrichmentError(
                "job_removed",
                "The external application page indicates the job is no longer available.",
            )

        try:
            return extract_description(
                external_page,
                selectors=EXTERNAL_DESCRIPTION_SELECTORS,
                expand_selectors=(),
                error_code="external_description_not_found",
                error_message="Could not extract a usable description from the external application page.",
            )
        except LinkedInEnrichmentError:
            print("[enrich] No dedicated external description block found. Falling back to broad visible page text.")
            generic_text = extract_generic_page_text(external_page)
            if generic_text:
                if not looks_like_usable_job_description(generic_text):
                    raise LinkedInEnrichmentError(
                        "external_description_not_usable",
                        "The external page loaded, but only exposed thin application-shell text rather than a usable job description.",
                    )
                print(f"[enrich] Using broad external page text fallback ({len(generic_text)} chars).")
                return generic_text
            raise
    finally:
        try:
            external_page.close()
        except Exception:
            pass


def enrich_linkedin_job_in_context(context, job, *, timeout_ms=45000, fast_ui=False):
    page = context.new_page()
    try:
        page.goto(job["job_url"], wait_until="domcontentloaded", timeout=timeout_ms)
        settle_page_after_navigation(page, timeout_ms=timeout_ms, fast_ui=fast_ui)

        assert_logged_in(page)

        raise_if_security_challenged(
            page,
            error_code="access_challenged",
            page_label="LinkedIn job page",
        )

        if detect_rate_limited(page):
            raise LinkedInEnrichmentError(
                "rate_limited",
                "LinkedIn appears to be rate-limiting or temporarily blocking requests.",
            )

        if detect_job_removed(page):
            raise LinkedInEnrichmentError(
                "job_removed",
                "LinkedIn indicates the job is no longer available or accepting applications.",
            )

        apply_result = detect_apply_result(
            page,
            existing_apply_url=job.get("apply_url"),
            timeout_ms=timeout_ms,
            fast_ui=fast_ui,
        )
        if apply_result["apply_type"] == "easy_apply":
            description = None
            try:
                description = extract_description(page)
            except LinkedInEnrichmentError:
                description = extract_generic_page_text(page, min_chars=150) or normalize_optional_str(job.get("description"))

            return {
                "description": description,
                **apply_result,
            }

        try:
            description = extract_description(page)
        except LinkedInEnrichmentError as exc:
            if not exc.partial_result:
                exc.partial_result = {
                    **apply_result,
                    "description": None,
                }
            if (
                exc.code == "description_not_found"
                and apply_result["apply_type"] == "external_apply"
                and apply_result["apply_url"]
            ):
                print("[enrich] LinkedIn page lacked a usable description. Falling back to external application page.")
                try:
                    description = extract_external_description(
                        context,
                        apply_result["apply_url"],
                        timeout_ms=timeout_ms,
                        fast_ui=fast_ui,
                    )
                except LinkedInEnrichmentError as external_exc:
                    if not external_exc.partial_result:
                        external_exc.partial_result = {
                            **apply_result,
                            "description": None,
                        }
                    raise
            else:
                raise

        result = {
            "description": description,
            **apply_result,
        }
        return result
    finally:
        try:
            page.close()
        except Exception:
            pass


def enrich_claimed_linkedin_job(job, *, storage_state_path=None, headless=True, slow_mo=0, timeout_ms=45000, browser_channel=None, fast_ui=False):
    with open_linkedin_context(
        storage_state_path=storage_state_path,
        headless=headless,
        slow_mo=slow_mo,
        browser_channel=browser_channel,
    ) as context:
        return enrich_linkedin_job_in_context(context, job, timeout_ms=timeout_ms, fast_ui=fast_ui)


def format_error_message(error):
    if isinstance(error, LinkedInEnrichmentError):
        return f"{error.code}: {error.message}"
    if isinstance(error, LinkedInSessionError):
        return f"auth_expired: {error}"
    return f"unexpected_error: {error}"


def get_error_code(error_message):
    if not error_message:
        return "unknown"
    return error_message.split(":", 1)[0].strip()


def is_blocking_error_code(error_code):
    return error_code in BATCH_HARD_STOP_ERROR_CODES or error_code in BLOCKED_ERROR_CODES


def is_hard_stop_error_code(error_code):
    return error_code in BATCH_HARD_STOP_ERROR_CODES


def is_ui_verifiable_error_code(error_code):
    return error_code in BLOCKED_ERROR_CODES


def is_non_actionable_failure_code(error_code):
    return error_code == "job_removed"


def should_stop_batch_after_failure(error_code, *, ui_verify_blocked=False):
    return is_hard_stop_error_code(error_code)


def build_failure_update_kwargs(error):
    partial_result = getattr(error, "partial_result", None)
    if not partial_result:
        return {}

    update_kwargs = {}
    for field_name in (
        "description",
        "apply_type",
        "auto_apply_eligible",
        "apply_url",
        "apply_host",
        "ats_type",
    ):
        if field_name in partial_result:
            update_kwargs[field_name] = partial_result[field_name]
    return update_kwargs


def get_success_enrichment_status(*, ui_verify=False):
    return SUCCESS_STATUS_UI_VERIFIED if ui_verify else SUCCESS_STATUS_DEFAULT


def get_failure_enrichment_status(error_code, *, ui_verify=False):
    if error_code in BLOCKED_ERROR_CODES:
        return FAILURE_STATUS_BLOCKED_UI_VERIFIED if ui_verify else FAILURE_STATUS_BLOCKED
    return FAILURE_STATUS_DEFAULT


def get_next_retry_timestamp(claimed_job, error_code, *, ui_verify=False):
    if ui_verify:
        return None

    retry_after = compute_retry_after(
        error_code,
        claimed_job.get("enrichment_attempts"),
    )
    return format_sqlite_timestamp(retry_after) if retry_after else None


def process_claimed_job(
    claimed_job,
    *,
    context=None,
    storage_state_path=None,
    headless=True,
    slow_mo=0,
    timeout_ms=45000,
    browser_channel=None,
    ui_verify=False,
):
    started_at = time.monotonic()
    print(f"[enrich] Claimed LinkedIn job id={claimed_job['id']} company={claimed_job.get('company')} title={claimed_job.get('title')}")
    try:
        if context is not None:
            result = enrich_linkedin_job_in_context(
                context,
                claimed_job,
                timeout_ms=timeout_ms,
                fast_ui=ui_verify,
            )
        else:
            result = enrich_claimed_linkedin_job(
                claimed_job,
                storage_state_path=storage_state_path,
                headless=headless,
                slow_mo=slow_mo,
                timeout_ms=timeout_ms,
                browser_channel=browser_channel,
                fast_ui=ui_verify,
            )

        mark_linkedin_enrichment_succeeded(
            claimed_job["id"],
            description=result["description"],
            apply_type=result["apply_type"],
            auto_apply_eligible=result["auto_apply_eligible"],
            apply_url=result["apply_url"],
            apply_host=result["apply_host"],
            ats_type=result["ats_type"],
            enrichment_status=get_success_enrichment_status(ui_verify=ui_verify),
        )

        updated_job = get_job_by_id(claimed_job["id"])
        elapsed_seconds = time.monotonic() - started_at
        print("[enrich] Success")
        print(f"  id: {updated_job['id']}")
        print(f"  apply_type: {updated_job['apply_type']}")
        print(f"  auto_apply_eligible: {updated_job['auto_apply_eligible']}")
        print(f"  apply_url: {updated_job['apply_url']}")
        print(f"  apply_host: {updated_job['apply_host']}")
        print(f"  ats_type: {updated_job['ats_type']}")
        print(f"  enrichment_status: {updated_job['enrichment_status']}")
        print(f"  enriched_at: {updated_job['enriched_at']}")
        print(f"  elapsed_seconds: {elapsed_seconds:.1f}")
        return {
            "status": "success",
            "job_id": claimed_job["id"],
            "apply_type": updated_job["apply_type"],
            "duration_seconds": elapsed_seconds,
        }
    except Exception as exc:
        error_message = format_error_message(exc)
        error_code = get_error_code(error_message)
        failure_update_kwargs = build_failure_update_kwargs(exc)
        if context is not None and error_code in BLOCKED_ERROR_CODES.union({"description_not_found", "external_description_not_found", "external_description_not_usable", "unexpected_error", "rate_limited"}):
            page = context.pages[-1] if getattr(context, "pages", None) else None
            if page is not None:
                try:
                    artifact_paths = capture_page_artifacts(
                        claimed_job,
                        error_code,
                        page=page,
                        source="linkedin",
                        metadata={"error_message": error_message},
                    )
                    failure_update_kwargs.update(
                        artifact_dir=artifact_paths["artifact_dir"],
                        artifact_screenshot_path=artifact_paths["artifact_screenshot_path"],
                        artifact_html_path=artifact_paths["artifact_html_path"],
                        artifact_text_path=artifact_paths["artifact_text_path"],
                    )
                except Exception:
                    pass
        next_retry_timestamp = get_next_retry_timestamp(
            claimed_job,
            error_code,
            ui_verify=ui_verify,
        )
        mark_linkedin_enrichment_failed(
            claimed_job["id"],
            error_message,
            enrichment_status=get_failure_enrichment_status(error_code, ui_verify=ui_verify),
            next_enrichment_retry_at=next_retry_timestamp,
            **failure_update_kwargs,
        )
        elapsed_seconds = time.monotonic() - started_at
        print("[enrich] Failed")
        print(f"  id: {claimed_job['id']}")
        print(f"  error: {error_message}")
        if next_retry_timestamp:
            print(f"  next_retry_at: {next_retry_timestamp}")
        if failure_update_kwargs:
            print(f"  partial_apply_type: {failure_update_kwargs.get('apply_type')}")
            print(f"  partial_apply_url: {failure_update_kwargs.get('apply_url')}")
        print(f"  elapsed_seconds: {elapsed_seconds:.1f}")
        return {
            "status": "failed",
            "job_id": claimed_job["id"],
            "error": error_message,
            "error_code": error_code,
            "duration_seconds": elapsed_seconds,
        }


def process_one_job(job_id=None, *, storage_state_path=None, headless=True, slow_mo=0, timeout_ms=45000, browser_channel=None, force=False, ui_verify=False):
    claimed_job = claim_linkedin_job_for_enrichment(job_id=job_id, force=force)
    if not claimed_job:
        if job_id is None:
            print("No pending LinkedIn rows are ready for enrichment.")
        else:
            print(f"Could not claim LinkedIn job id={job_id} for enrichment.")
        return 1

    result = process_claimed_job(
        claimed_job,
        storage_state_path=storage_state_path,
        headless=headless,
        slow_mo=slow_mo,
        timeout_ms=timeout_ms,
        browser_channel=browser_channel,
        ui_verify=ui_verify,
    )
    return 0 if result["status"] == "success" else 1


def process_batch(
    *,
    limit,
    storage_state_path=None,
    headless=True,
    slow_mo=0,
    timeout_ms=45000,
    browser_channel=None,
    ui_verify_blocked=False,
    return_summary=False,
):
    started_at = time.monotonic()
    results = []
    final_results_by_job_id = {}
    blocked_job_ids = []

    with open_linkedin_context(
        storage_state_path=storage_state_path,
        headless=headless,
        slow_mo=slow_mo,
        browser_channel=browser_channel,
    ) as context:
        for index in range(limit):
            claimed_job = claim_linkedin_job_for_enrichment()
            if not claimed_job:
                print(f"[batch] No more pending LinkedIn rows after {index} job(s).")
                break

            print(f"\n[batch] Processing job {index + 1}/{limit}")
            result = process_claimed_job(
                claimed_job,
                context=context,
                timeout_ms=timeout_ms,
            )
            results.append(result)
            final_results_by_job_id[result["job_id"]] = result

            if result["status"] == "failed":
                error_code = result.get("error_code")
                if ui_verify_blocked and is_ui_verifiable_error_code(error_code):
                    blocked_job_ids.append(result["job_id"])
                    print(f"[batch] Queued blocked job id={result['job_id']} for interactive verification after the first pass.")
                    continue

                if should_stop_batch_after_failure(error_code, ui_verify_blocked=ui_verify_blocked):
                    print(f"[batch] Stopping early because of blocking error: {error_code}")
                    break

    ui_verify_results = []
    if ui_verify_blocked and blocked_job_ids:
        print(f"\n[batch] Starting interactive verification for {len(blocked_job_ids)} blocked job(s).")
        with open_linkedin_context(
            storage_state_path=storage_state_path,
            headless=False,
            slow_mo=slow_mo,
            browser_channel=browser_channel,
        ) as ui_context:
            for index, job_id in enumerate(blocked_job_ids, start=1):
                claimed_job = claim_linkedin_job_for_enrichment(job_id=job_id, force=True)
                if not claimed_job:
                    print(f"[batch-ui] Could not reclaim blocked LinkedIn job id={job_id} for UI verification.")
                    result = {
                        "status": "failed",
                        "job_id": job_id,
                        "error": "claim_failed: could not reclaim blocked job for UI verification",
                        "error_code": "claim_failed",
                        "duration_seconds": 0.0,
                    }
                else:
                    print(f"\n[batch-ui] Verifying blocked job {index}/{len(blocked_job_ids)}")
                    result = process_claimed_job(
                        claimed_job,
                        context=ui_context,
                        timeout_ms=timeout_ms,
                        ui_verify=True,
                    )

                ui_verify_results.append(result)
                final_results_by_job_id[result["job_id"]] = result

                if result["status"] == "failed" and should_stop_batch_after_failure(result.get("error_code"), ui_verify_blocked=False):
                    print(f"[batch-ui] Stopping early because of blocking error: {result['error_code']}")
                    break

    total_elapsed = time.monotonic() - started_at
    final_results = list(final_results_by_job_id.values())
    successes = [result for result in final_results if result["status"] == "success"]
    failures = [result for result in final_results if result["status"] == "failed"]
    actionable_failures = [
        result for result in failures if not is_non_actionable_failure_code(result.get("error_code"))
    ]

    print("\n[batch] Summary")
    print(f"  attempted: {len(results)}")
    if ui_verify_results:
        print(f"  ui_verified: {len(ui_verify_results)}")
    print(f"  succeeded: {len(successes)}")
    print(f"  failed: {len(failures)}")
    print(f"  total_elapsed_seconds: {total_elapsed:.1f}")
    all_timed_results = results + ui_verify_results
    if all_timed_results:
        avg_seconds = sum(result["duration_seconds"] for result in all_timed_results) / len(all_timed_results)
        print(f"  average_seconds_per_job: {avg_seconds:.1f}")

    counts_by_error = {}
    if failures:
        for failure in failures:
            counts_by_error[failure["error_code"]] = counts_by_error.get(failure["error_code"], 0) + 1
        print("  failure_breakdown:")
        for error_code, count in sorted(counts_by_error.items()):
            print(f"    {error_code}: {count}")

    stop_error_code = None
    for failure in failures:
        error_code = failure.get("error_code")
        if is_hard_stop_error_code(error_code):
            stop_error_code = error_code
            break

    exit_code = 0 if not actionable_failures else 1
    if return_summary:
        return {
            "exit_code": exit_code,
            "attempted": len(results),
            "ui_verified": len(ui_verify_results),
            "succeeded": len(successes),
            "failed": len(failures),
            "actionable_failed": len(actionable_failures),
            "failure_breakdown": counts_by_error,
            "total_elapsed_seconds": total_elapsed,
            "average_seconds_per_job": (
                sum(result["duration_seconds"] for result in all_timed_results) / len(all_timed_results)
                if all_timed_results
                else 0.0
            ),
            "stop_error_code": stop_error_code,
        }

    return exit_code


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
    parser.add_argument(
        "--ui-verify",
        action="store_true",
        help="Re-run one specific LinkedIn row in a visible browser and mark the result as an interactive verification outcome.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=1,
        help="Number of pending LinkedIn jobs to enrich sequentially (default: 1).",
    )
    parser.add_argument(
        "--ui-verify-blocked",
        action="store_true",
        help="For batch runs, rerun rows blocked by CAPTCHA/security challenges in a visible browser after the first pass.",
    )
    args = parser.parse_args()

    if args.force and args.job_id is None:
        parser.error("--force requires --job-id")
    if args.ui_verify and args.job_id is None:
        parser.error("--ui-verify requires --job-id")
    if args.job_id is not None and args.limit != 1:
        parser.error("--limit cannot be used with --job-id")
    if args.limit < 1:
        parser.error("--limit must be at least 1")
    if args.ui_verify and args.limit != 1:
        parser.error("--ui-verify cannot be used with --limit")
    if args.ui_verify and not args.headful:
        print("[enrich] --ui-verify implies a visible browser window; running headful.")
    if args.ui_verify_blocked and args.limit == 1:
        parser.error("--ui-verify-blocked requires --limit greater than 1")
    if args.ui_verify_blocked and args.job_id is not None:
        parser.error("--ui-verify-blocked cannot be used with --job-id")

    if args.limit > 1:
        return process_batch(
            limit=args.limit,
            storage_state_path=args.storage_state,
            headless=not args.headful,
            slow_mo=args.slow_mo,
            timeout_ms=args.timeout_ms,
            browser_channel=args.channel,
            ui_verify_blocked=args.ui_verify_blocked,
        )

    return process_one_job(
        job_id=args.job_id,
        storage_state_path=args.storage_state,
        headless=not (args.headful or args.ui_verify),
        slow_mo=args.slow_mo,
        timeout_ms=args.timeout_ms,
        browser_channel=args.channel,
        force=(args.force or args.ui_verify),
        ui_verify=args.ui_verify,
    )


if __name__ == "__main__":
    sys.exit(main())
