"""Preview or import the former job tracker into C1 without writing to the sheet."""

from __future__ import annotations

import argparse
import json
import re
from collections import Counter
from contextlib import closing
from datetime import date, datetime
from pathlib import Path
from urllib.parse import urlsplit

from hunter import user_config
from hunter.db import _enforce_employer_month_cap, add_job, get_connection, init_db
from hunter.discovery_policy import (
    canonical_job_key,
    normalize_company,
    normalize_job_url,
    requisition_path,
)
from hunter.discovery_sources import _job, career_fetch_plan, catalog_company_sites
from hunter.personal_fit import owner_day

STATUS = {"not applied": "new", "applied": "applied", "canceled": "canceled"}
HISTORY = {"applied", "canceled", "cancelled"}


def _cell_date(value):
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, str):
        try:
            return date.fromisoformat(value.strip()[:10]).isoformat()
        except ValueError:
            return None
    return None


def _text(cell):
    return str(cell.value or "").strip()


def _url(cell):
    return normalize_job_url(cell.hyperlink.target if cell.hyperlink else cell.value)


def read_tracker(path, ats_map=None):
    from openpyxl import load_workbook

    book = load_workbook(path)
    try:
        referral_tab = "Referral?" if "Referral?" in book else "Referral"
        referrals = {
            normalize_company(_text(row[0])): _text(row[0])
            for row in book[referral_tab].iter_rows(min_row=2, max_col=1)
            if _text(row[0])
        }
        companies, tracked = {}, {}
        for row in book["companies to track"].iter_rows(min_row=2, max_col=5):
            company = _text(row[0])
            if not company:
                continue
            key = normalize_company(company)
            tracked.setdefault(key, company)
            if _text(row[3]).casefold() == "yes":
                referrals.setdefault(key, company)
            url = _url(row[4])
            if url:
                label, sites = companies.setdefault(key, (company, []))
                if url not in sites:
                    sites.append(url)
        for name, url in (ats_map or {}).items():
            if clean := normalize_job_url(url):
                label, sites = companies.setdefault(normalize_company(name), (name, []))
                if clean not in sites:
                    sites.insert(0, clean)

        status_counts = Counter()
        jobs = {}
        tabs = ["All Jobs"]
        if "Job History" in book:
            tabs.append("Job History")
        for tab in tabs:
            for row in book[tab].iter_rows(min_row=2, max_col=13):
                if not _text(row[2]):
                    continue
                company, title, status = (
                    _text(row[1]),
                    _text(row[2]),
                    STATUS.get(_text(row[4]).casefold()),
                )
                url = _url(row[5]) or _url(row[12])
                if not company or not status or not url:
                    status_counts["invalid"] += 1
                    continue
                key = canonical_job_key(url, company)
                host = urlsplit(url).hostname or ""
                board = None
                if host == "linkedin.com" or host.endswith(".linkedin.com"):
                    board = "linkedin"
                elif host in {"indeed.com", "indeed.ca"} or host.endswith(
                    (".indeed.com", ".indeed.ca")
                ):
                    board = "indeed"
                job = _job(
                    company=company,
                    title=title,
                    url=url,
                    location=_text(row[6]),
                    date_posted=_cell_date(row[0].value),
                    source=board or "tracker_import",
                )
                if board:
                    job.update(
                        apply_url=None,
                        apply_host=None,
                        ats_type=None,
                        auto_apply_eligible=None,
                        enrichment_status="pending",
                        last_enrichment_error=None,
                    )
                job.update(
                    tracker_status=status, tracker_application_date=_cell_date(row[10].value)
                )
                previous = jobs.get(key)
                if previous:
                    status_counts["duplicate"] += 1
                    old = previous["tracker_status"]
                    if old in HISTORY and status in HISTORY and old != status:
                        status_counts["history_conflict"] += 1
                        continue
                    if old in HISTORY or status == "new":
                        continue
                jobs[key] = job
        return referrals, tracked, companies, list(jobs.values()), status_counts
    finally:
        book.close()


def build_config(referrals, tracked, companies, base):
    merged = dict(base)
    sites = merged.get("company_career_sites") or {}
    by_name = {normalize_company(name): name for name in sites}
    result = {
        name: list(urls) if isinstance(urls, list) else [urls] for name, urls in sites.items()
    }
    bundled = [(name, [url]) for name, url in catalog_company_sites().items()]
    for name, urls in [*bundled, *companies.values()]:
        label = by_name.setdefault(normalize_company(name), name)
        existing = result.setdefault(label, [])
        normalized = {normalize_job_url(url) for url in existing}
        # Deduplicate aliases that resolve to the same public ATS board.
        boards = {career_fetch_plan(url)["url"] for url in existing}
        for url in urls:
            board = career_fetch_plan(url)["url"]
            if normalize_job_url(url) not in normalized and board not in boards:
                existing.append(url)
                boards.add(board)
                normalized.add(normalize_job_url(url))
    merged["company_career_sites"] = result
    merged["referral_companies"] = list(
        dict.fromkeys([*merged.get("referral_companies", []), *referrals.values()])
    )
    merged["priority_companies"] = list(
        dict.fromkeys([*merged.get("priority_companies", []), *tracked.values()])
    )
    merged["run_interval_seconds"] = 3600
    merged["company_discovery_interval_seconds"] = 3600
    return user_config.validate(merged)


def import_jobs(jobs):
    init_db(maintenance=False, refresh_discovery=False)
    receipt = Counter()
    with closing(get_connection()) as conn:
        employers = set()
        for job in jobs:
            status = job["tracker_status"]
            applied_on = job["tracker_application_date"]
            _, job_id, *_ = add_job(job, connection=conn)
            existing = conn.execute(
                "SELECT status, application_date, normalized_company FROM jobs WHERE id = ?",
                (job_id,),
            ).fetchone()
            current = str(existing["status"] or "").casefold()
            if current in HISTORY and (
                current.replace("cancelled", "canceled") != status
                or existing["application_date"]
                and applied_on
                and existing["application_date"] != applied_on
            ):
                receipt["existing_history_preserved"] += 1
            elif status in HISTORY:
                conn.execute(
                    "UPDATE jobs SET status = ?, application_date = coalesce(application_date, ?) "
                    "WHERE id = ?",
                    (status, applied_on, job_id),
                )
                employers.add(existing["normalized_company"])
                receipt["history_saved"] += 1
            else:
                conn.execute(
                    "UPDATE jobs SET personal_fit = 'yes', personal_fit_reviewed_at = ? "
                    "WHERE id = ? AND personal_fit IS NULL",
                    (owner_day().isoformat(), job_id),
                )
                receipt["active_linked"] += 1
        for company in sorted(employers - {None}):
            _enforce_employer_month_cap(conn.cursor(), company)
        conn.commit()
    return dict(receipt)


def _exact_removed_keys(path):
    items = json.loads(path.read_text(encoding="utf-8-sig"))["skip_same_requisition"]
    if not isinstance(items, list) or not all(isinstance(item, str) for item in items):
        raise ValueError("Expected a list of removed requisition keys.")
    exact, paths, unresolved = set(), set(), 0
    for item in items:
        if re.fullmatch(r"(?:workday|requisition|ukg|greenhouse):[^/]+:[a-z0-9_-]+", item):
            exact.add(item)
        elif "." in item.partition("/")[0] and "/" in item:
            url = "https://" + item
            key = canonical_job_key(url)
            if key and ":" in key and "/" not in key:
                exact.add(key)
            elif path_key := requisition_path(url):
                paths.add(path_key)
            else:
                unresolved += 1
        else:
            unresolved += 1
    return exact, paths, unresolved


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("workbook", type=Path)
    parser.add_argument("--ats-map", type=Path)
    parser.add_argument("--removed-keys", type=Path)
    parser.add_argument("--base-config", type=Path, help="Preserve an existing C1 configuration.")
    parser.add_argument(
        "--career-site",
        action="append",
        default=[],
        metavar="NAME=URL",
        help="Add a verified career site missing from the tracker.",
    )
    parser.add_argument("--config-output", type=Path, help="Write a new private JSON file.")
    parser.add_argument(
        "--apply", action="store_true", help="Import into the configured C1 database."
    )
    args = parser.parse_args()
    ats_map = json.loads(args.ats_map.read_text(encoding="utf-8-sig")) if args.ats_map else None
    referrals, tracked, companies, jobs, skipped = read_tracker(args.workbook, ats_map)
    for entry in args.career_site:
        name, separator, url = entry.partition("=")
        if not name.strip() or not separator or not (clean := normalize_job_url(url)):
            parser.error("--career-site expects NAME=https://...")
        _, sites = companies.setdefault(normalize_company(name), (name, []))
        if clean not in sites:
            sites.append(clean)
    base = (
        json.loads(args.base_config.read_text(encoding="utf-8-sig"))
        if args.base_config
        else user_config.load()
    )
    config = build_config(referrals, tracked, companies, base)
    removed, removal_paths, unresolved = (
        _exact_removed_keys(args.removed_keys) if args.removed_keys else (set(), set(), 0)
    )
    if removed:
        config["removed_requisition_keys"] = sorted(
            set(config.get("removed_requisition_keys", [])).union(removed)
        )
    if removal_paths:
        config["removed_requisition_paths"] = sorted(
            set(config.get("removed_requisition_paths", [])).union(removal_paths)
        )
    configured = {normalize_company(name) for name in config["company_career_sites"]}
    print(
        json.dumps(
            {
                "referral_companies": len(referrals),
                "referral_companies_with_career_sites": sum(key in configured for key in referrals),
                "priority_companies": len(tracked),
                "priority_companies_with_career_sites": sum(key in configured for key in tracked),
                "companies_in_config": len(configured),
                "removed_keys_mapped": len(removed),
                "removed_paths_held_for_review": len(removal_paths),
                "unresolved_removal_entries": unresolved,
                "jobs_by_status": dict(Counter(job["tracker_status"] for job in jobs)),
                "applied_without_date": sum(
                    job["tracker_status"] == "applied" and not job["tracker_application_date"]
                    for job in jobs
                ),
                "skipped_rows": dict(skipped),
            }
        )
    )
    if args.apply and (skipped["history_conflict"] or skipped["invalid"]):
        raise SystemExit("Resolve invalid or conflicting tracker rows before importing history.")
    if args.config_output:
        with args.config_output.open("x", encoding="utf-8") as stream:
            json.dump(config, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
    if args.apply:
        print(json.dumps(import_jobs(jobs)))


if __name__ == "__main__":
    main()
