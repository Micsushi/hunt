import argparse
import sqlite3
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DB_PATH = REPO_ROOT / "hunt.db"
SCRAPER_DIR = REPO_ROOT / "scraper"
sys.path.insert(0, str(SCRAPER_DIR))

from enrich_linkedin import (  # noqa: E402
    DESCRIPTION_SELECTORS,
    LinkedInEnrichmentError,
    detect_apply_result,
    detect_job_removed,
    detect_rate_limited,
    extract_description,
    normalize_description_text,
    raise_if_security_challenged,
    settle_page_after_navigation,
)
from linkedin_session import LinkedInSessionError, assert_logged_in, open_linkedin_context  # noqa: E402


def get_job_row(job_id, db_path):
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        row = conn.execute(
            """
            SELECT id, source, title, company, job_url, apply_url
            FROM jobs
            WHERE id = ?
            """,
            (job_id,),
        ).fetchone()
    finally:
        conn.close()

    if not row:
        raise ValueError(f"Job id={job_id} not found.")
    if row["source"] != "linkedin":
        raise ValueError(f"Job id={job_id} is source={row['source']}, not linkedin.")
    return row


def preview_text(value, limit):
    normalized = normalize_description_text(value)
    if not normalized:
        return None
    if len(normalized) <= limit:
        return normalized
    return normalized[:limit] + "..."


def dump_selector_matches(page, *, preview_chars):
    print("[debug] LinkedIn description selector matches")
    for selector in DESCRIPTION_SELECTORS:
        try:
            locator = page.locator(selector)
            count = locator.count()
            print(f"  selector={selector!r} count={count}")
            if count <= 0:
                continue
            for index, raw_text in enumerate(locator.all_inner_texts()[:3], start=1):
                preview = preview_text(raw_text, preview_chars)
                if preview:
                    print(f"    match={index} chars={len(normalize_description_text(raw_text))} preview={preview!r}")
                else:
                    print(f"    match={index} preview=None")
        except Exception as exc:
            print(f"  selector={selector!r} error={type(exc).__name__}: {exc}")


def maybe_write_output(path, description):
    if not path:
        return

    output_path = Path(path).expanduser().resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(description, encoding="utf-8")
    print(f"[debug] Wrote description to: {output_path}")


def main():
    parser = argparse.ArgumentParser(
        description="Debug LinkedIn-only description extraction without mutating the DB or falling back to the external site."
    )
    target_group = parser.add_mutually_exclusive_group(required=True)
    target_group.add_argument("--job-id", type=int, help="LinkedIn job id from hunt.db.")
    target_group.add_argument("--job-url", help="Direct LinkedIn job URL to inspect.")
    parser.add_argument(
        "--db",
        default=str(DEFAULT_DB_PATH),
        help=f"Path to SQLite DB (default: {DEFAULT_DB_PATH})",
    )
    parser.add_argument("--storage-state", help="Optional Playwright storage state path.")
    parser.add_argument("--channel", help="Optional Playwright browser channel such as chrome.")
    parser.add_argument("--headful", action="store_true", help="Run with a visible browser window.")
    parser.add_argument("--slow-mo", type=int, default=0, help="Optional Playwright slow_mo in milliseconds.")
    parser.add_argument("--timeout-ms", type=int, default=45000, help="Navigation/action timeout in milliseconds.")
    parser.add_argument(
        "--preview-chars",
        type=int,
        default=500,
        help="Preview length to print before the full description (default: 500).",
    )
    parser.add_argument(
        "--output",
        help="Optional file path to write the extracted LinkedIn description.",
    )
    parser.add_argument(
        "--show-selectors",
        action="store_true",
        help="Print the current LinkedIn description selector matches before extraction.",
    )
    parser.add_argument(
        "--skip-apply-check",
        action="store_true",
        help="Skip apply-action detection and only test description extraction.",
    )
    args = parser.parse_args()

    try:
        row = None
        if args.job_id is not None:
            row = get_job_row(args.job_id, args.db)
            job_url = row["job_url"]
            existing_apply_url = row["apply_url"]
        else:
            job_url = args.job_url
            existing_apply_url = None

        with open_linkedin_context(
            storage_state_path=args.storage_state,
            headless=not args.headful,
            slow_mo=args.slow_mo,
            browser_channel=args.channel,
        ) as context:
            page = context.new_page()
            try:
                print(f"[debug] Opening LinkedIn job page: {job_url}")
                page.goto(job_url, wait_until="domcontentloaded", timeout=args.timeout_ms)
                settle_page_after_navigation(page, timeout_ms=args.timeout_ms, fast_ui=False)

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

                if args.show_selectors:
                    dump_selector_matches(page, preview_chars=args.preview_chars)

                apply_result = None
                if not args.skip_apply_check:
                    apply_result = detect_apply_result(
                        page,
                        existing_apply_url=existing_apply_url,
                        timeout_ms=args.timeout_ms,
                        fast_ui=False,
                    )
                    print("[debug] Apply result")
                    print(f"  apply_type: {apply_result['apply_type']}")
                    print(f"  auto_apply_eligible: {apply_result['auto_apply_eligible']}")
                    print(f"  apply_url: {apply_result['apply_url']}")

                description = extract_description(page)
                maybe_write_output(args.output, description)

                print("[debug] LinkedIn description extraction: PASS")
                if row is not None:
                    print(f"  id: {row['id']}")
                    print(f"  company: {row['company']}")
                    print(f"  title: {row['title']}")
                print(f"  chars: {len(description)}")
                print(f"  preview: {preview_text(description, args.preview_chars)!r}")
                print("\n[debug] Full LinkedIn description\n")
                print(description)
                return 0
            finally:
                try:
                    page.close()
                except Exception:
                    pass
    except (LinkedInEnrichmentError, LinkedInSessionError, ValueError) as exc:
        print(f"[debug] LinkedIn description extraction: FAIL")
        print(f"  error: {exc}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
