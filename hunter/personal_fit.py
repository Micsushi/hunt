"""Personal fit decisions, independent of discovery and application history."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from contextlib import closing
from datetime import UTC, date, datetime, timedelta
from uuid import uuid4
from zoneinfo import ZoneInfo

from hunter.config import PRIORITY_COMPANIES, REFERRAL_COMPANIES
from hunter.db import _get_runtime_state_values, _upsert_runtime_state, get_connection
from hunter.discovery_policy import normalize_company
from hunter.job_posting import html_text, normalize_description_text

OWNER_TIMEZONE = ZoneInfo("America/Guatemala")
DECISIONS = {"yes", "no", "deferred"}
RECEIPT_KEY = "daily_personal_fit_receipt"
RUN_KEY = "personal_fit_run"
DAILY_RECEIPT_KEY = "personal_fit_digest_receipt"
DIGEST_SENT_KEY = "personal_fit_last_sent_digest"
HISTORY = "lower(trim(coalesce(status, ''))) IN ('applied', 'canceled', 'cancelled')"
EMPLOYER_KEY = """coalesce(nullif(normalized_company, ''), nullif(lower(trim(company)), ''),
                            ':' || cast(id AS TEXT))"""
POSTED_DATE = "substr(coalesce(nullif(date_posted, ''), date_scraped), 1, 10)"
ADVANCEABLE = """coalesce(apply_type, '') != 'easy_apply'
    AND coalesce(last_enrichment_error, '') != 'job_removed'
    AND coalesce(discovery_suppressed_reason, '')
        IN ('', 'employer_month_cap', 'geography_unverified')"""
VERIFIED_APPLY = """coalesce(apply_type, '') = 'external_apply'
    AND auto_apply_eligible IS TRUE
    AND coalesce(enrichment_status, '') IN ('done', 'done_verified')
    AND trim(coalesce(apply_url, '')) != ''"""
VISIBLE = f"""{ADVANCEABLE}
    AND coalesce(discovery_suppressed_reason, '') != 'geography_unverified'
    AND {VERIFIED_APPLY}"""
FIT = """
coalesce(CASE WHEN personal_fit IN ('yes', 'no') THEN personal_fit END, (
    SELECT previous.personal_fit FROM jobs AS previous
    WHERE previous.canonical_job_key = jobs.canonical_job_key
      AND nullif(previous.canonical_job_key, '') IS NOT NULL
      AND previous.personal_fit IN ('yes', 'no')
    ORDER BY previous.personal_fit_reviewed_at DESC, previous.id DESC LIMIT 1
), personal_fit)
"""


def owner_day() -> date:
    return datetime.now(OWNER_TIMEZONE).date()


def date_window(day: date):
    return (day - timedelta(days=13)).isoformat(), day.isoformat()


def view_filter(
    view, day=None, *, match_days=None, company_limit=2, match_status="all", details="all"
):
    day = day or owner_day()
    cutoff, today = date_window(day)
    match_days = (14 if view == "matches" else 0) if match_days is None else match_days
    date_sql, date_params = "", []
    if match_days:
        posted_from = (day - timedelta(days=match_days - 1)).isoformat()
        date_sql = " AND substr(nullif(trim(date_posted), ''), 1, 10) BETWEEN ? AND ?"
        date_params = [posted_from, today]
    if details != "all":
        has_description = "trim(coalesce(description, '')) != ''"
        description_ok = details in {"complete", "link"}
        link_ok = details in {"complete", "description"}
        date_sql += f" AND ({has_description}) = ? AND ({VERIFIED_APPLY}) = ?"
        date_params.extend([description_ok, link_ok])
    if view != "matches":
        return (f" AND {HISTORY}" if view == "history" else "") + date_sql, date_params
    readiness = {
        "ready": f"AND ({VERIFIED_APPLY})",
        "needs_verification": f"AND NOT ({VERIFIED_APPLY})",
    }.get(match_status, "")
    return (
        f"""
        AND id IN (
            WITH history AS (
                SELECT {EMPLOYER_KEY} AS employer,
                       count(DISTINCT coalesce(nullif(canonical_job_key, ''), ':' || cast(id AS TEXT)))
                           AS slots
                FROM jobs
                WHERE lower(trim(coalesce(status, ''))) = 'applied'
                  AND (coalesce(nullif(application_date, ''), nullif(substr(date_posted, 1, 10), ''))
                         IS NULL
                    OR coalesce(nullif(application_date, ''), substr(date_posted, 1, 10))
                         BETWEEN ? AND ?)
                GROUP BY {EMPLOYER_KEY}
            ),
            ranked AS (
                SELECT id, {EMPLOYER_KEY} AS employer,
                       row_number() OVER (
                           PARTITION BY {EMPLOYER_KEY} ORDER BY {POSTED_DATE} DESC, id DESC
                       ) AS job_rank
                FROM jobs
                WHERE {ADVANCEABLE} AND NOT ({HISTORY}) {readiness}
                  {date_sql} AND ({FIT}) = 'yes'
            )
            SELECT ranked.id FROM ranked LEFT JOIN history ON ranked.employer = history.employer
            WHERE ? = 0 OR ranked.job_rank + coalesce(history.slots, 0) <= ?
        )
    """,
        [cutoff, today, *date_params, company_limit, company_limit],
    )


def visible_job_ids(conn, day=None):
    clause, params = view_filter("matches", day)
    return {row["id"] for row in conn.execute(f"SELECT id FROM jobs WHERE 1=1 {clause}", params)}


def review_candidates(limit, day=None, *, include_deferred=False, run_id=None):
    cutoff, today = date_window(day or owner_day())
    referrals = {normalize_company(name) for name in REFERRAL_COMPANIES}
    priority = {normalize_company(name) for name in PRIORITY_COMPANIES} | referrals
    names = sorted(priority)
    priority_order = (
        f"CASE WHEN normalized_company IN ({', '.join('?' for _ in names)}) THEN 0 ELSE 1 END,"
        if names
        else ""
    )
    with closing(get_connection()) as conn:
        publication_window = f"AND {POSTED_DATE} BETWEEN ? AND ?"
        window_params = (cutoff, today)
        snapshot, snapshot_params = "", ()
        if run_id:
            run = _run_state(conn)
            if run.get("id") != run_id or run["status"] != "running":
                raise ValueError("This review is no longer running.")
            started = datetime.fromisoformat(run["started_at"]).astimezone(OWNER_TIMEZONE)
            snapshot = """AND id <= ?
                AND (personal_fit_reviewed_at IS NULL OR personal_fit_reviewed_at < ?)"""
            snapshot_params = (run["through_job_id"], started.isoformat())
            if run["trigger"] == "backfill":
                publication_window, window_params = "", ()
        rows = conn.execute(
            f"""
            SELECT id, title, company, location, description,
                   normalized_company
            FROM jobs
            WHERE {ADVANCEABLE} AND NOT ({HISTORY}) {publication_window}
              {snapshot}
              AND (personal_fit IS NULL OR (
                  personal_fit = 'deferred' AND (? OR coalesce(personal_fit_input, '') !=
                      CASE WHEN length(trim(coalesce(description, ''))) > 0 THEN 'description'
                           ELSE 'title' END)
              ))
              AND NOT EXISTS (
                  SELECT 1 FROM jobs AS reviewed
                  WHERE reviewed.canonical_job_key = jobs.canonical_job_key
                    AND nullif(reviewed.canonical_job_key, '') IS NOT NULL
                    AND reviewed.personal_fit IN ('yes', 'no')
              )
            ORDER BY CASE WHEN personal_fit IS NULL THEN 0 ELSE 1 END,
                     {POSTED_DATE} DESC, {priority_order} id DESC
            LIMIT ?
            """,
            (*window_params, *snapshot_params, include_deferred, *names, limit),
        )
        results = []
        for row in rows:
            item = _review_posting(row)
            item["referral"] = row["normalized_company"] in referrals
            item["revision"] = _revision(item)
            results.append(item)
        return results


def _review_posting(row):
    item = {key: row[key] for key in ("id", "title", "company", "location")}
    description = row["description"] or ""
    if "<" in description and ">" in description:
        description = html_text(description)
    description = normalize_description_text(description)
    if description and len(description) > 7000:
        description = description[:4200] + "\n[Posting excerpt continues]\n" + description[-2750:]
    item["description"] = description
    return item


def _revision(row):
    return hashlib.sha256(
        json.dumps([row[key] for key in ("title", "company", "location", "description")]).encode()
    ).hexdigest()


def _state(conn, key):
    state = _get_runtime_state_values(conn.cursor(), [key]).get(key, {})
    return json.loads(state["value"]) if state.get("value") else {}


def _save_state(conn, key, state):
    _upsert_runtime_state(conn.cursor(), key, json.dumps(state))


def _locked_run(conn):
    cursor = conn.cursor()
    cursor.execute(
        "INSERT INTO runtime_state (key, value) VALUES (?, '{}') ON CONFLICT(key) DO NOTHING",
        (RUN_KEY,),
    )
    cursor.execute("UPDATE runtime_state SET value = value WHERE key = ?", (RUN_KEY,))
    return _run_state(conn)


def _run_state(conn):
    run = _state(conn, RUN_KEY)
    if run.get("status") == "running" and datetime.fromisoformat(
        run["lease_until"]
    ) <= datetime.now(UTC):
        return {**run, "status": "unconfirmed"}
    return run or {"status": "idle"}


def review_status():
    with closing(get_connection()) as conn:
        return _run_state(conn)


def request_review(trigger, *, through_job_id=None):
    if trigger not in ("manual", "scheduled", "backfill"):
        raise ValueError("Invalid review trigger.")
    now = datetime.now(OWNER_TIMEZONE)
    slot = now.replace(hour=now.hour // 6 * 6, minute=0, second=0, microsecond=0)
    slot_key = slot.isoformat()
    with closing(get_connection()) as conn:
        current = _locked_run(conn)
        last_slot = current.get("last_scheduled_request")
        if current["status"] in ("queued", "running") or (
            trigger == "scheduled" and last_slot == slot_key
        ):
            return None if trigger == "backfill" else current
        run = {
            "id": uuid4().hex,
            "status": "queued",
            "trigger": trigger,
            "queued_at": datetime.now(UTC).isoformat(),
            "last_scheduled_request": slot_key if trigger == "scheduled" else last_slot,
        }
        if trigger == "backfill":
            _start_review(conn, run)
            if through_job_id is not None:
                run["through_job_id"] = min(run["through_job_id"], through_job_id)
        _save_state(conn, RUN_KEY, run)
        conn.commit()
        return run


def claim_review():
    with closing(get_connection()) as conn:
        if _run_state(conn)["status"] != "queued":
            return None
        run = _locked_run(conn)
        if run["status"] != "queued":
            return None
        _start_review(conn, run)
        _save_state(conn, RUN_KEY, run)
        conn.commit()
        return run


def _start_review(conn, run):
    started = datetime.now(UTC)
    newest = conn.execute("SELECT coalesce(max(id), 0) AS id FROM jobs").fetchone()["id"]
    run.update(
        status="running",
        started_at=started.isoformat(),
        lease_until=(started + timedelta(minutes=25)).isoformat(),
        through_job_id=newest,
        reviewed=0,
    )


def fail_review(run_id, reason):
    with closing(get_connection()) as conn:
        run = _locked_run(conn)
        if run["status"] == "running" and run["id"] == run_id:
            run.update(status="failed", reason=reason, finished_at=datetime.now(UTC).isoformat())
            _save_state(conn, RUN_KEY, run)
            conn.commit()
        return run


def review_stages(job_ids, day=None, *, current_matches=False):
    if not job_ids:
        return {}
    cutoff, today = date_window(day or owner_day())
    with closing(get_connection()) as conn:
        rows = conn.execute(
            f"""
            SELECT id, ({FIT}) AS decision, ({ADVANCEABLE}) AS can_review,
                   ({VISIBLE}) AS can_show, ({HISTORY}) AS history,
                   CASE WHEN {POSTED_DATE} BETWEEN ? AND ? THEN 1 ELSE 0 END AS recent,
                   discovery_suppressed_reason, last_enrichment_error, apply_type, status, date_posted
            FROM jobs WHERE id IN ({",".join("?" for _ in job_ids)})
            """,
            (cutoff, today, *job_ids),
        ).fetchall()
        visible = (
            visible_job_ids(conn, day)
            if not current_matches
            and any(
                row["decision"] == "yes" and row["can_review"] and row["recent"] for row in rows
            )
            else set()
        )
    result = {}
    for row in rows:
        decision = row["decision"]
        reason = row["discovery_suppressed_reason"]
        if row["history"] and decision == "yes":
            status = str(row["status"] or "").strip().lower()
            stage = "approved_applied" if status == "applied" else "approved_canceled"
        elif row["history"]:
            stage = "application_history"
        elif decision == "no":
            stage = "ai_rejected"
        elif not row["can_review"]:
            if row["last_enrichment_error"] == "job_removed":
                reason = "posting_closed"
            if row["apply_type"] == "easy_apply":
                reason = "easy_apply_ineligible"
            stage = "approved_filtered" if decision == "yes" else "filtered_before_ai"
        elif decision == "deferred":
            stage = "needs_information"
        elif decision != "yes":
            stage = "awaiting_review"
        elif not current_matches and not (row["date_posted"] or "").strip():
            stage, reason = "approved_filtered", "posting_date_unknown"
        elif not current_matches and not row["recent"]:
            stage = "approved_outside_window"
        elif not current_matches and row["id"] not in visible:
            stage = "approved_company_limit"
        elif not row["can_show"]:
            stage = "approved_waiting_for_verification"
            reason = reason or row["last_enrichment_error"]
        else:
            stage = "approved_visible"
        result[row["id"]] = {"stage": stage, "reason": reason}
    return result


def record_decisions(entries, *, day=None, run_id=None, partial=False):
    day = day or owner_day()
    if not isinstance(entries, list) or len(entries) > 100:
        raise ValueError("Expected a list of at most 100 decisions.")
    for entry in entries:
        if (
            not isinstance(entry, dict)
            or type(entry.get("id")) is not int
            or not isinstance(entry.get("decision"), str)
            or entry["decision"] not in DECISIONS
            or not isinstance(entry.get("revision"), str)
        ):
            raise ValueError("Every decision needs an integer id, revision, and yes/no/deferred.")
    if len({entry["id"] for entry in entries}) != len(entries):
        raise ValueError("Decision IDs must be unique.")

    with closing(get_connection()) as conn:
        run = _locked_run(conn) if run_id else {}
        if run_id and (run["status"] != "running" or run["id"] != run_id):
            raise ValueError("This review is no longer running. No decisions were saved.")
        if partial and not run_id:
            raise ValueError("A partial batch must belong to a running review.")
        slot_key = run.get("last_scheduled_request")
        noon = (
            run.get("trigger") == "scheduled"
            and slot_key
            and datetime.fromisoformat(slot_key).hour == 12
            and slot_key[:10] == day.isoformat()
        )
        previous = _state(conn, RECEIPT_KEY)
        before = set(previous.get("visible_ids", []))
        saved = 0
        for entry in entries:
            row = conn.execute(
                f"""SELECT id, title, company, location, description
                    FROM jobs WHERE id = ? AND {ADVANCEABLE}
                    AND NOT ({HISTORY}) AND (personal_fit IS NULL OR personal_fit = 'deferred')""",
                (entry["id"],),
            ).fetchone()
            if row is None or _revision(_review_posting(row)) != entry["revision"]:
                if run.get("trigger") == "backfill":
                    continue
                raise ValueError(
                    f"Job {entry['id']} changed during review. No decisions were saved."
                )
            result = conn.execute(
                """UPDATE jobs SET personal_fit = ?, personal_fit_input = ?,
                       personal_fit_reviewed_at = ?
                   WHERE id = ? AND (personal_fit IS NULL OR personal_fit = 'deferred')""",
                (
                    entry["decision"],
                    "description" if (row["description"] or "").strip() else "title",
                    datetime.now(OWNER_TIMEZONE).isoformat(),
                    entry["id"],
                ),
            )
            if result.rowcount != 1:
                if run.get("trigger") == "backfill":
                    continue
                raise ValueError(
                    f"Job {entry['id']} was already reviewed. No decisions were saved."
                )
            saved += 1
        reviewed = run.get("reviewed", 0) + saved
        if partial:
            run.update(
                reviewed=reviewed,
                lease_until=(datetime.now(UTC) + timedelta(minutes=25)).isoformat(),
            )
            _save_state(conn, RUN_KEY, run)
            conn.commit()
            return {"reviewed": reviewed}
        visible = visible_job_ids(conn, day)
        receipt = {
            "day": day.isoformat(),
            "reviewed": reviewed,
            "visible_ids": sorted(visible),
            "new_visible_count": len(visible - before),
        }
        _save_state(conn, RECEIPT_KEY, receipt)
        if noon:
            last_sent = _state(conn, DIGEST_SENT_KEY)
            if not last_sent:
                legacy = _state(conn, DAILY_RECEIPT_KEY)
                if legacy.get("discord", {}).get("sent"):
                    last_sent = legacy
                    _save_state(conn, DIGEST_SENT_KEY, last_sent)
            _save_state(
                conn,
                DAILY_RECEIPT_KEY,
                {
                    **receipt,
                    "new_visible_count": len(visible - set(last_sent.get("visible_ids", []))),
                },
            )
        if run_id:
            run.update(
                status="completed",
                finished_at=datetime.now(UTC).isoformat(),
                reviewed=receipt["reviewed"],
                new_visible_count=receipt["new_visible_count"],
            )
            _save_state(conn, RUN_KEY, run)
        conn.commit()
    return receipt


def send_digest(hunt_url):
    from shared.notifications import send_discord_webhook_message

    with closing(get_connection()) as conn:
        _locked_run(conn)
        receipt = _state(conn, DAILY_RECEIPT_KEY)
        now = datetime.now(OWNER_TIMEZONE)
        if now.hour < 12 or receipt.get("day") != now.date().isoformat():
            return {"sent": False, "pending": True}
        if "discord" in receipt:
            return receipt["discord"]
        receipt["discord"] = {"sent": False, "reason": "delivery_unconfirmed"}
        _save_state(conn, DAILY_RECEIPT_KEY, receipt)
        conn.commit()

    count = receipt["new_visible_count"]
    label = "job" if count == 1 else "jobs"
    url = f"{hunt_url.rstrip('/')}/jobs?view=matches"
    response = send_discord_webhook_message(f"{count} {label} found.\n{url}")
    with closing(get_connection()) as conn:
        _locked_run(conn)
        current = _state(conn, DAILY_RECEIPT_KEY)
        if current.get("day") == receipt["day"]:
            current["discord"] = response
            _save_state(conn, DAILY_RECEIPT_KEY, current)
        if response.get("sent"):
            _save_state(conn, DIGEST_SENT_KEY, receipt)
        conn.commit()
    return response


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    queue = sub.add_parser("queue")
    queue.add_argument("--limit", type=int, default=30)
    queue.add_argument("--include-deferred", action="store_true")
    queue.add_argument("--run-id")
    record = sub.add_parser("record")
    record.add_argument("run_id")
    record.add_argument("--partial", action="store_true")
    request = sub.add_parser("request")
    request.add_argument("trigger", choices=("scheduled", "manual", "backfill"))
    request.add_argument("--through-job-id", type=int)
    fail = sub.add_parser("fail")
    fail.add_argument("run_id")
    fail.add_argument("reason")
    sub.add_parser("claim")
    sub.add_parser("status")
    notify = sub.add_parser("notify")
    notify.add_argument("hunt_url")
    args = parser.parse_args()
    if args.command == "queue":
        if not 1 <= args.limit <= 400 or (args.limit > 100 and args.run_id is None):
            parser.error("--limit must be 1 to 100, or up to 400 for an active review")
        result = review_candidates(
            args.limit, include_deferred=args.include_deferred, run_id=args.run_id
        )
    elif args.command == "record":
        result = record_decisions(json.load(sys.stdin), run_id=args.run_id, partial=args.partial)
    elif args.command == "status":
        result = review_status()
    elif args.command == "request":
        result = request_review(args.trigger, through_job_id=args.through_job_id)
    elif args.command == "claim":
        result = claim_review()
    elif args.command == "fail":
        result = fail_review(args.run_id, args.reason)
    else:
        result = send_digest(args.hunt_url)
    print(json.dumps(result, ensure_ascii=True))


if __name__ == "__main__":
    main()
