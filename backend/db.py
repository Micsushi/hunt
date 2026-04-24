"""C0 control-plane data access helpers.

These are the canonical query helpers for the UI/backend surface.
Compatibility wrappers remain in `hunter.db` because some older scripts still
import the historical names from there.
"""

from __future__ import annotations

import json
from datetime import timedelta

from hunter import config
from hunter.config import ENRICHMENT_MAX_ATTEMPTS, ENRICHMENT_STALE_PROCESSING_MINUTES
from hunter.enrichment_policy import format_sqlite_timestamp, utc_now
from hunter import db as hunter_db


def get_review_queue_summary(*, source=None):
    conn = hunter_db.get_connection()
    try:
        cursor = conn.cursor()
        linkedin_auth = hunter_db._get_linkedin_auth_state_from_cursor(cursor)
        stale_cutoff = format_sqlite_timestamp(
            utc_now() - timedelta(minutes=ENRICHMENT_STALE_PROCESSING_MINUTES)
        )
        source_filter_sql = ""
        params = []
        if source:
            source_filter_sql = " AND source = ?"
            params.append(source)

        counts = {
            row["enrichment_status"] or "unknown": row["count"]
            for row in cursor.execute(
                f"""
                SELECT
                    CASE
                        WHEN source != 'linkedin' AND (enrichment_status IS NULL OR trim(enrichment_status) = '') THEN 'pending'
                        WHEN enrichment_status IS NULL OR trim(enrichment_status) = '' THEN 'unknown'
                        ELSE enrichment_status
                    END AS enrichment_status,
                    COUNT(*) AS count
                FROM jobs
                WHERE 1=1 {source_filter_sql}
                GROUP BY 1
                """,
                tuple(params),
            ).fetchall()
        }
        failure_counts = {
            row["error_code"]: row["count"]
            for row in cursor.execute(
                f"""
                SELECT
                    CASE
                        WHEN last_enrichment_error IS NULL OR trim(last_enrichment_error) = '' THEN 'unknown'
                        WHEN instr(last_enrichment_error, ':') > 0 THEN substr(last_enrichment_error, 1, instr(last_enrichment_error, ':') - 1)
                        ELSE last_enrichment_error
                    END AS error_code,
                    COUNT(*) AS count
                FROM jobs
                WHERE 1=1 {source_filter_sql}
                  AND (
                        enrichment_status IN ('failed', 'blocked', 'blocked_verified')
                     OR (source != 'linkedin' AND last_enrichment_error IS NOT NULL AND trim(last_enrichment_error) != '')
                  )
                GROUP BY error_code
                ORDER BY count DESC, error_code ASC
                """,
                tuple(params),
            ).fetchall()
        }
        source_counts = {
            row["source"] or "unknown": row["count"]
            for row in cursor.execute(
                f"""
                SELECT coalesce(source, 'unknown') AS source, COUNT(*) AS count
                FROM jobs
                WHERE 1=1 {source_filter_sql}
                GROUP BY 1
                ORDER BY 1
                """,
                tuple(params),
            ).fetchall()
        }

        oldest_processing = cursor.execute(
            f"""
            SELECT MIN(last_enrichment_started_at)
            FROM jobs
            WHERE 1=1 {source_filter_sql}
              AND enrichment_status = 'processing'
            """,
            tuple(params),
        ).fetchone()[0]

        ready_extra_sql = ""
        if not linkedin_auth["available"] and source != "linkedin":
            ready_extra_sql = " AND source != 'linkedin'"

        if source == "linkedin" and not linkedin_auth["available"]:
            ready_count = 0
            retry_ready_count = 0
        else:
            ready_count = cursor.execute(
                f"""
                SELECT COUNT(*)
                FROM jobs
                WHERE 1=1 {source_filter_sql}
                  {ready_extra_sql}
                  AND (
                        enrichment_status = 'pending'
                     OR (
                            source != 'linkedin'
                        AND (enrichment_status IS NULL OR trim(enrichment_status) = '')
                     )
                     OR (
                            source = 'linkedin'
                        AND
                        (
                            enrichment_status = 'failed'
                        AND next_enrichment_retry_at IS NOT NULL
                        AND next_enrichment_retry_at <= CURRENT_TIMESTAMP
                        AND coalesce(enrichment_attempts, 0) < ?
                        )
                     )
                  )
                """,
                tuple(params + [ENRICHMENT_MAX_ATTEMPTS]),
            ).fetchone()[0]

            retry_ready_count = cursor.execute(
                f"""
                SELECT COUNT(*)
                FROM jobs
                WHERE 1=1 {source_filter_sql}
                  AND source = 'linkedin'
                  AND enrichment_status = 'failed'
                  AND next_enrichment_retry_at IS NOT NULL
                  AND next_enrichment_retry_at <= CURRENT_TIMESTAMP
                  AND coalesce(enrichment_attempts, 0) < ?
                """,
                tuple(params + [ENRICHMENT_MAX_ATTEMPTS]),
            ).fetchone()[0]

        stale_processing_count = cursor.execute(
            f"""
            SELECT COUNT(*)
            FROM jobs
            WHERE 1=1 {source_filter_sql}
              AND enrichment_status = 'processing'
              AND (
                    last_enrichment_started_at IS NULL
                 OR last_enrichment_started_at <= ?
              )
            """,
            tuple(params + [stale_cutoff]),
        ).fetchone()[0]

        runtime_events = hunter_db._get_runtime_state_values(
            cursor,
            keys=(
                "linkedin_last_rate_limited",
                "linkedin_last_automation_flagged",
                "discord_last_priority_notify_error",
                "hunt_last_priority_job",
            ),
        )

        return {
            "total": sum(counts.values()),
            "counts_by_status": counts,
            "ready_count": int(ready_count or 0),
            "pending_count": counts.get("pending", 0),
            "retry_ready_count": int(retry_ready_count or 0),
            "processing_count": counts.get("processing", 0),
            "blocked_count": counts.get("blocked", 0) + counts.get("blocked_verified", 0),
            "stale_processing_count": int(stale_processing_count or 0),
            "oldest_processing_started_at": oldest_processing,
            "failure_counts": failure_counts,
            "source_counts": source_counts,
            "auth": {
                "linkedin": linkedin_auth,
            },
            "events": runtime_events,
        }
    finally:
        conn.close()


def _review_jobs_filter_sql_and_params(
    *,
    status,
    source,
    query,
    linkedin_auth_available,
    operator_tag=None,
):
    """Shared AND-fragment for control-plane list, counts, exports, and bulk requeue."""
    parts = []
    params = []
    if source:
        parts.append(" AND source = ?")
        params.append(source)
    if status == "ready":
        if source == "linkedin" and not linkedin_auth_available:
            return None, None
        parts.append(
            """
              AND (
                    enrichment_status = 'pending'
                 OR (
                        source != 'linkedin'
                    AND (enrichment_status IS NULL OR trim(enrichment_status) = '')
                 )
                 OR (
                        source = 'linkedin'
                    AND
                    (
                        enrichment_status = 'failed'
                    AND next_enrichment_retry_at IS NOT NULL
                    AND next_enrichment_retry_at <= CURRENT_TIMESTAMP
                    AND coalesce(enrichment_attempts, 0) < ?
                    )
                  )
              )
            """
        )
        params.append(ENRICHMENT_MAX_ATTEMPTS)
        if not linkedin_auth_available:
            parts.append(" AND source != 'linkedin'")
    elif status != "all":
        if status == "pending":
            parts.append(
                """
                  AND (
                        enrichment_status = 'pending'
                     OR (source != 'linkedin' AND (enrichment_status IS NULL OR trim(enrichment_status) = ''))
                  )
                """
            )
        else:
            parts.append(" AND enrichment_status = ?")
            params.append(status)
    query_value = (query or "").strip()
    if query_value:
        like_query = f"%{query_value.lower()}%"
        parts.append(
            """
              AND (
                    lower(coalesce(company, '')) LIKE ?
                 OR lower(coalesce(title, '')) LIKE ?
                 OR lower(coalesce(description, '')) LIKE ?
                 OR lower(coalesce(apply_url, '')) LIKE ?
                 OR lower(coalesce(job_url, '')) LIKE ?
              )
            """
        )
        params.extend([like_query, like_query, like_query, like_query, like_query])
    tag = (operator_tag or "").strip()
    if tag:
        parts.append(" AND lower(trim(coalesce(operator_tag, ''))) = lower(?)")
        params.append(tag)
    return "".join(parts), params


def list_jobs_for_review(
    *,
    status="all",
    limit=50,
    offset=0,
    include_description=False,
    query=None,
    sort="date_scraped",
    direction="desc",
    source=None,
    operator_tag=None,
):
    linkedin_auth_available = hunter_db.is_linkedin_auth_available()
    frag, filter_params = _review_jobs_filter_sql_and_params(
        status=status,
        source=source,
        query=query,
        linkedin_auth_available=linkedin_auth_available,
        operator_tag=operator_tag,
    )
    if frag is None:
        return []
    conn = hunter_db.get_connection()
    try:
        cursor = conn.cursor()
        base_select = """
            SELECT id, title, company, source, job_url, apply_url, description,
                   status, apply_type, auto_apply_eligible, enrichment_status,
                   enrichment_attempts, enriched_at, last_enrichment_error,
                   apply_host, ats_type, last_enrichment_started_at, next_enrichment_retry_at,
                   last_artifact_dir, last_artifact_screenshot_path, last_artifact_html_path, last_artifact_text_path,
                   date_scraped, priority, operator_notes, operator_tag
            FROM jobs
            WHERE 1=1
        """ + frag

        params = list(filter_params)

        safe_direction = "ASC" if str(direction).lower() == "asc" else "DESC"
        sortable_columns = {
            "id": "id",
            "source": "source",
            "company": "company",
            "title": "title",
            "enrichment_status": "enrichment_status",
            "apply_type": "apply_type",
            "enrichment_attempts": "coalesce(enrichment_attempts, 0)",
            "next_enrichment_retry_at": "coalesce(next_enrichment_retry_at, '')",
            "last_enrichment_error": "coalesce(last_enrichment_error, '')",
            "date_scraped": "date_scraped",
            "enriched_at": "coalesce(enriched_at, '')",
        }
        safe_sort_sql = sortable_columns.get(sort, "date_scraped")

        if status == "ready":
            base_select += f"""
            ORDER BY CASE enrichment_status WHEN 'pending' THEN 0 ELSE 1 END,
                     CASE
                       WHEN enrichment_status = 'pending' AND {safe_sort_sql} IS NOT NULL THEN {safe_sort_sql}
                     END {safe_direction},
                     CASE
                       WHEN enrichment_status != 'pending' AND {safe_sort_sql} IS NOT NULL THEN {safe_sort_sql}
                     END {safe_direction},
                     CASE WHEN enrichment_status = 'pending' THEN date_scraped END DESC,
                     CASE WHEN enrichment_status != 'pending' THEN next_enrichment_retry_at END ASC,
                     id DESC
            """
        else:
            base_select += f" ORDER BY {safe_sort_sql} {safe_direction}, id DESC"

        base_select += " LIMIT ? OFFSET ?"
        params.extend([limit, max(0, offset)])

        rows = [dict(row) for row in cursor.execute(base_select, tuple(params)).fetchall()]
        if not include_description:
            for row in rows:
                row["description"] = None
        return rows
    finally:
        conn.close()


def count_jobs_for_review(*, status="all", query=None, source=None, operator_tag=None):
    linkedin_auth_available = hunter_db.is_linkedin_auth_available()
    frag, filter_params = _review_jobs_filter_sql_and_params(
        status=status,
        source=source,
        query=query,
        linkedin_auth_available=linkedin_auth_available,
        operator_tag=operator_tag,
    )
    if frag is None:
        return 0
    conn = hunter_db.get_connection()
    try:
        cursor = conn.cursor()
        sql = "SELECT COUNT(*) FROM jobs WHERE 1=1" + frag
        return int(cursor.execute(sql, tuple(filter_params)).fetchone()[0])
    finally:
        conn.close()


def bulk_requeue_jobs_matching_review_filters(
    *,
    status="all",
    source=None,
    query=None,
    operator_tag=None,
    target_statuses=None,
    limit_cap=None,
    dry_run=False,
):
    cap = limit_cap if limit_cap is not None else config.REVIEW_BULK_REQUEUE_MAX
    cap = max(0, int(cap))
    allowed = {"failed", "blocked", "blocked_verified", "processing", "pending"}
    targets = tuple(s for s in (target_statuses or ()) if s in allowed)
    if not targets or cap == 0:
        return 0

    linkedin_auth_available = hunter_db.is_linkedin_auth_available()
    frag, filter_params = _review_jobs_filter_sql_and_params(
        status=status,
        source=source,
        query=query,
        linkedin_auth_available=linkedin_auth_available,
        operator_tag=operator_tag,
    )
    if frag is None:
        return 0

    placeholders = ", ".join(["?"] * len(targets))
    where_status = f" AND enrichment_status IN ({placeholders})"
    count_sql = f"SELECT COUNT(*) FROM jobs WHERE 1=1 {frag}{where_status}"
    count_params = tuple(filter_params + list(targets))

    conn = hunter_db.get_connection()
    try:
        cursor = conn.cursor()
        total_match = int(cursor.execute(count_sql, count_params).fetchone()[0])
        would_touch = min(cap, total_match)
        if dry_run:
            return would_touch
        if would_touch == 0:
            return 0
        subq = f"SELECT id FROM jobs WHERE 1=1 {frag}{where_status} ORDER BY id ASC LIMIT ?"
        subq_params = tuple(filter_params + list(targets) + [cap])
        update_sql = f"""
            UPDATE jobs
            SET enrichment_status = 'pending',
                last_enrichment_error = NULL,
                last_enrichment_started_at = NULL,
                next_enrichment_retry_at = NULL,
                last_artifact_dir = NULL,
                last_artifact_screenshot_path = NULL,
                last_artifact_html_path = NULL,
                last_artifact_text_path = NULL
            WHERE id IN ({subq})
        """
        cursor.execute(update_sql, subq_params)
        conn.commit()
        return cursor.rowcount
    finally:
        conn.close()


def set_job_priority(job_id, *, run_next):
    conn = hunter_db.get_connection()
    try:
        cursor = conn.cursor()
        cursor.execute(
            "UPDATE jobs SET priority = ? WHERE id = ?",
            (1 if run_next else 0, job_id),
        )
        conn.commit()
        return cursor.rowcount
    finally:
        conn.close()


def update_job_operator_meta(job_id, *, notes=hunter_db._UNSET, operator_tag=hunter_db._UNSET):
    assignments = []
    params = []
    if notes is not hunter_db._UNSET:
        assignments.append("operator_notes = ?")
        params.append(notes)
    if operator_tag is not hunter_db._UNSET:
        assignments.append("operator_tag = ?")
        params.append(operator_tag)
    if not assignments:
        return 0
    params.append(job_id)
    conn = hunter_db.get_connection()
    try:
        cursor = conn.cursor()
        cursor.execute(
            f"UPDATE jobs SET {', '.join(assignments)} WHERE id = ?",
            tuple(params),
        )
        conn.commit()
        return cursor.rowcount
    finally:
        conn.close()


def list_runtime_state_recent(*, limit=40):
    safe_limit = max(1, min(int(limit), 200))
    conn = hunter_db.get_connection()
    try:
        cursor = conn.cursor()
        rows = cursor.execute(
            """
            SELECT key, value, updated_at
            FROM runtime_state
            ORDER BY datetime(coalesce(updated_at, '')) DESC
            LIMIT ?
            """,
            (safe_limit,),
        ).fetchall()
        return [dict(row) for row in rows]
    finally:
        conn.close()


def get_review_activity_summary(*, hours=24):
    safe_hours = max(1, min(int(hours), 24 * 30))
    mod = f"-{safe_hours} hours"
    conn = hunter_db.get_connection()
    try:
        cursor = conn.cursor()
        done = cursor.execute(
            """
            SELECT COUNT(*) FROM jobs
            WHERE enrichment_status IN ('done', 'done_verified')
              AND enriched_at IS NOT NULL
              AND trim(enriched_at) != ''
              AND datetime(enriched_at) >= datetime('now', ?)
            """,
            (mod,),
        ).fetchone()[0]
        failed = cursor.execute(
            """
            SELECT COUNT(*) FROM jobs
            WHERE enrichment_status = 'failed'
              AND date_scraped IS NOT NULL
              AND datetime(date_scraped) >= datetime('now', ?)
            """,
            (mod,),
        ).fetchone()[0]
        scraped = cursor.execute(
            """
            SELECT COUNT(*) FROM jobs
            WHERE date_scraped IS NOT NULL
              AND datetime(date_scraped) >= datetime('now', ?)
            """,
            (mod,),
        ).fetchone()[0]
        return {
            "hours": safe_hours,
            "done_or_verified": int(done or 0),
            "failed_scraped_window": int(failed or 0),
            "rows_scraped_window": int(scraped or 0),
        }
    finally:
        conn.close()


def get_review_audit_entries(*, limit=80):
    conn = hunter_db.get_connection()
    try:
        cursor = conn.cursor()
        row = cursor.execute(
            "SELECT value FROM runtime_state WHERE key = ?",
            (hunter_db.REVIEW_AUDIT_LOG_KEY,),
        ).fetchone()
        if not row or not row["value"]:
            return []
        try:
            entries = json.loads(row["value"])
        except json.JSONDecodeError:
            return []
        if not isinstance(entries, list):
            return []
        tail = entries[-max(1, min(int(limit), 200)) :]
        return list(reversed(tail))
    finally:
        conn.close()


def append_review_audit_entry(action, detail=None, *, max_entries=100):
    conn = hunter_db.get_connection()
    try:
        cursor = conn.cursor()
        cursor.execute(hunter_db.RUNTIME_STATE_TABLE_SQL)
        row = cursor.execute(
            "SELECT value FROM runtime_state WHERE key = ?",
            (hunter_db.REVIEW_AUDIT_LOG_KEY,),
        ).fetchone()
        entries = []
        if row and row["value"]:
            try:
                entries = json.loads(row["value"])
            except json.JSONDecodeError:
                entries = []
        if not isinstance(entries, list):
            entries = []
        entry = {
            "at": format_sqlite_timestamp(utc_now().replace(microsecond=0)),
            "action": str(action),
            "detail": detail,
        }
        entries.append(entry)
        entries = entries[-max_entries:]
        hunter_db._upsert_runtime_state(cursor, hunter_db.REVIEW_AUDIT_LOG_KEY, json.dumps(entries))
        conn.commit()
        return len(entries)
    finally:
        conn.close()
