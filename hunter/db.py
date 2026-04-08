import json
import os
import sqlite3
from datetime import timedelta

from hunter import config
from hunter.config import (
    ENRICHMENT_MAX_ATTEMPTS,
    ENRICHMENT_STALE_PROCESSING_MINUTES,
    TITLE_BLACKLIST,
)
from hunter.enrichment_policy import (
    compute_retry_after,
    format_sqlite_timestamp,
    get_error_code,
    utc_now,
)
from hunter.url_utils import (
    detect_ats_type,
    get_apply_host,
    looks_like_linkedin_url,
    normalize_apply_url,
)

JOBS_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    company TEXT,
    location TEXT,
    job_url TEXT UNIQUE NOT NULL,
    apply_url TEXT,
    description TEXT,
    source TEXT,
    date_posted TEXT,
    is_remote BOOLEAN,
    status TEXT DEFAULT 'new',
    date_scraped TEXT DEFAULT CURRENT_TIMESTAMP,
    level TEXT,
    priority BOOLEAN DEFAULT 0,
    category TEXT,
    apply_type TEXT,
    auto_apply_eligible BOOLEAN,
    enrichment_status TEXT,
    enrichment_attempts INTEGER DEFAULT 0,
    enriched_at TEXT,
    last_enrichment_error TEXT,
    apply_host TEXT,
    ats_type TEXT,
    last_enrichment_started_at TEXT,
    next_enrichment_retry_at TEXT,
    last_artifact_dir TEXT,
    last_artifact_screenshot_path TEXT,
    last_artifact_html_path TEXT,
    last_artifact_text_path TEXT,
    latest_resume_job_description_path TEXT,
    latest_resume_flags TEXT,
    selected_resume_version_id TEXT,
    selected_resume_pdf_path TEXT,
    selected_resume_tex_path TEXT,
    selected_resume_selected_at TEXT,
    selected_resume_ready_for_c3 BOOLEAN
)
"""

RUNTIME_STATE_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS runtime_state (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
)
"""

MIGRATION_COLUMNS = {
    "operator_notes": "TEXT",
    "operator_tag": "TEXT",
    "apply_type": "TEXT",
    "auto_apply_eligible": "BOOLEAN",
    "enrichment_status": "TEXT",
    "enrichment_attempts": "INTEGER DEFAULT 0",
    "enriched_at": "TEXT",
    "last_enrichment_error": "TEXT",
    "apply_host": "TEXT",
    "ats_type": "TEXT",
    "last_enrichment_started_at": "TEXT",
    "next_enrichment_retry_at": "TEXT",
    "last_artifact_dir": "TEXT",
    "last_artifact_screenshot_path": "TEXT",
    "last_artifact_html_path": "TEXT",
    "last_artifact_text_path": "TEXT",
    "latest_resume_job_description_path": "TEXT",
    "latest_resume_flags": "TEXT",
    "selected_resume_version_id": "TEXT",
    "selected_resume_pdf_path": "TEXT",
    "selected_resume_tex_path": "TEXT",
    "selected_resume_selected_at": "TEXT",
    "selected_resume_ready_for_c3": "BOOLEAN",
}

INSERT_COLUMNS = (
    "title",
    "company",
    "location",
    "job_url",
    "apply_url",
    "description",
    "source",
    "date_posted",
    "is_remote",
    "level",
    "priority",
    "category",
    "apply_type",
    "auto_apply_eligible",
    "enrichment_status",
    "enrichment_attempts",
    "apply_host",
    "ats_type",
)

_UNSET = object()
ENRICHMENT_SOURCE_PRIORITY = ("linkedin", "indeed")
LINKEDIN_AUTH_STATE_KEY = "linkedin_auth_state"
LINKEDIN_AUTH_ERROR_KEY = "linkedin_auth_error"
LINKEDIN_AUTH_STATE_OK = "ok"
LINKEDIN_AUTH_STATE_EXPIRED = "expired"
LINKEDIN_AUTH_STATE_UNKNOWN = "unknown"
REVIEW_AUDIT_LOG_KEY = "review_audit_log"

# Backwards compatible: tests and older scripts may patch `db.DB_PATH` directly.
# Prefer setting `HUNT_DB_PATH` in the environment for normal runtime use.
DB_PATH = config.get_db_path()


def _get_column_names(cursor):
    return {row[1] for row in cursor.execute("PRAGMA table_info(jobs)")}


def _normalize_enrichment_sources(sources=None):
    if sources is None:
        return ENRICHMENT_SOURCE_PRIORITY
    if isinstance(sources, str):
        sources = (sources,)
    normalized = tuple(source for source in sources if source in ENRICHMENT_SOURCE_PRIORITY)
    return normalized or ENRICHMENT_SOURCE_PRIORITY


def _upsert_runtime_state(cursor, key, value):
    cursor.execute(
        """
        INSERT INTO runtime_state (key, value, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET
            value = excluded.value,
            updated_at = CURRENT_TIMESTAMP
        """,
        (key, value),
    )


def _delete_runtime_state(cursor, key):
    cursor.execute("DELETE FROM runtime_state WHERE key = ?", (key,))


def _get_runtime_state_values(cursor, keys):
    if not keys:
        return {}
    placeholders = ", ".join(["?"] * len(keys))
    rows = cursor.execute(
        f"""
        SELECT key, value, updated_at
        FROM runtime_state
        WHERE key IN ({placeholders})
        """,
        tuple(keys),
    ).fetchall()
    return {row["key"]: {"value": row["value"], "updated_at": row["updated_at"]} for row in rows}


def _get_linkedin_auth_state_from_cursor(cursor):
    try:
        rows = cursor.execute(
            """
            SELECT key, value, updated_at
            FROM runtime_state
            WHERE key IN (?, ?)
            """,
            (LINKEDIN_AUTH_STATE_KEY, LINKEDIN_AUTH_ERROR_KEY),
        ).fetchall()
    except sqlite3.OperationalError:
        rows = []
    payload = {row["key"]: dict(row) for row in rows}
    status_row = payload.get(LINKEDIN_AUTH_STATE_KEY)
    error_row = payload.get(LINKEDIN_AUTH_ERROR_KEY)
    status = (status_row or {}).get("value") or LINKEDIN_AUTH_STATE_UNKNOWN
    return {
        "status": status,
        "available": status != LINKEDIN_AUTH_STATE_EXPIRED,
        "last_error": (error_row or {}).get("value"),
        "updated_at": (status_row or {}).get("updated_at"),
    }


def _get_claimable_enrichment_sources(sources=None):
    normalized_sources = _normalize_enrichment_sources(sources)
    if "linkedin" not in normalized_sources:
        return normalized_sources
    if is_linkedin_auth_available():
        return normalized_sources
    return tuple(source for source in normalized_sources if source != "linkedin")


def _build_source_filter_sql(sources):
    normalized_sources = _normalize_enrichment_sources(sources)
    placeholders = ", ".join(["?"] * len(normalized_sources))
    return f" AND source IN ({placeholders})", list(normalized_sources)


def _build_source_priority_sql(sources):
    normalized_sources = _normalize_enrichment_sources(sources)
    cases = " ".join(
        f"WHEN '{source}' THEN {index}" for index, source in enumerate(normalized_sources)
    )
    return f"CASE source {cases} ELSE 999 END"


def _is_blank(value):
    return value is None or (isinstance(value, str) and not value.strip())


def _should_upgrade_text(current_value, new_value):
    return _is_blank(current_value) and not _is_blank(new_value)


def _should_upgrade_unknown(current_value, new_value):
    return (current_value is None or current_value == "unknown") and new_value not in (
        None,
        "",
        "unknown",
    )


def _migrate_jobs_table(cursor):
    existing_columns = _get_column_names(cursor)
    for column_name, column_def in MIGRATION_COLUMNS.items():
        if column_name not in existing_columns:
            cursor.execute(f"ALTER TABLE jobs ADD COLUMN {column_name} {column_def}")


def _backfill_enrichment_metadata(cursor):
    cursor.execute(
        """
        UPDATE jobs
        SET enrichment_attempts = 0
        WHERE enrichment_attempts IS NULL
        """
    )

    cursor.execute(
        """
        UPDATE jobs
        SET last_enrichment_started_at = NULL
        WHERE last_enrichment_started_at IS NOT NULL
          AND trim(last_enrichment_started_at) = ''
        """
    )

    cursor.execute(
        """
        UPDATE jobs
        SET next_enrichment_retry_at = NULL
        WHERE next_enrichment_retry_at IS NOT NULL
          AND trim(next_enrichment_retry_at) = ''
        """
    )

    # Historical LinkedIn rows copied the listing URL into apply_url.
    # Clear that mirrored value so later automation does not mistake it for
    # a real off-platform application link.
    cursor.execute(
        """
        UPDATE jobs
        SET apply_url = NULL
        WHERE source = 'linkedin'
          AND apply_url = job_url
          AND job_url LIKE 'https://www.linkedin.com/%'
        """
    )

    # LinkedIn discovery may learn a best-known outbound URL hint, but rows are
    # not truly enriched until a browser worker verifies the apply flow.
    cursor.execute(
        """
        UPDATE jobs
        SET apply_type = 'unknown',
            auto_apply_eligible = NULL,
            enrichment_status = 'pending'
        WHERE source = 'linkedin'
          AND enriched_at IS NULL
          AND (
                enrichment_status = 'done'
             OR (
                    enrichment_status IS NULL
                AND (
                        apply_type = 'external_apply'
                     OR auto_apply_eligible = 1
                    )
                )
          )
        """
    )

    cursor.execute(
        """
        UPDATE jobs
        SET apply_type = 'unknown'
        WHERE source IN ('linkedin', 'indeed')
          AND apply_type IS NULL
        """
    )

    cursor.execute(
        """
        UPDATE jobs
        SET enrichment_status = 'pending'
        WHERE source IN ('linkedin', 'indeed')
          AND enrichment_status IS NULL
        """
    )

    cursor.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_jobs_enrichment_queue
        ON jobs(source, enrichment_status, date_scraped DESC)
        """
    )

    cursor.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_jobs_enrichment_retry_queue
        ON jobs(source, enrichment_status, next_enrichment_retry_at, date_scraped DESC)
        """
    )


def _backfill_retry_schedule(cursor):
    source_filter_sql, source_params = _build_source_filter_sql(None)
    rows = cursor.execute(
        f"""
        SELECT id, enrichment_attempts, last_enrichment_error
        FROM jobs
        WHERE 1=1 {source_filter_sql}
          AND enrichment_status = 'failed'
          AND next_enrichment_retry_at IS NULL
          AND last_enrichment_error IS NOT NULL
          AND trim(last_enrichment_error) != ''
          AND coalesce(enrichment_attempts, 0) < ?
        """,
        tuple(source_params + [ENRICHMENT_MAX_ATTEMPTS]),
    ).fetchall()

    for row in rows:
        error_code = get_error_code(row["last_enrichment_error"])
        retry_after = compute_retry_after(
            error_code,
            row["enrichment_attempts"],
        )
        if retry_after is None:
            continue
        cursor.execute(
            """
            UPDATE jobs
            SET next_enrichment_retry_at = ?
            WHERE id = ?
            """,
            (
                format_sqlite_timestamp(retry_after),
                row["id"],
            ),
        )


def _requeue_stale_processing_rows(cursor):
    stale_cutoff = format_sqlite_timestamp(utc_now().replace(microsecond=0))
    if ENRICHMENT_STALE_PROCESSING_MINUTES:
        stale_cutoff = format_sqlite_timestamp(
            utc_now() - timedelta(minutes=ENRICHMENT_STALE_PROCESSING_MINUTES)
        )

    source_filter_sql, source_params = _build_source_filter_sql(None)
    cursor.execute(
        f"""
        UPDATE jobs
        SET enrichment_status = 'pending',
            last_enrichment_error = 'stale_processing: Requeued automatically after a stale processing claim.',
            last_enrichment_started_at = NULL,
            next_enrichment_retry_at = NULL
        WHERE 1=1 {source_filter_sql}
          AND enrichment_status = 'processing'
          AND (
                last_enrichment_started_at IS NULL
             OR last_enrichment_started_at <= ?
          )
        """,
        tuple(source_params + [stale_cutoff]),
    )
    return cursor.rowcount


def manual_requeue_stale_processing_rows():
    """Requeue processing rows whose claim is stale : same rules as init_db maintenance."""
    conn = get_connection()
    try:
        cursor = conn.cursor()
        updated = _requeue_stale_processing_rows(cursor)
        conn.commit()
        return int(updated or 0)
    finally:
        conn.close()


def _backfill_linkedin_derived_fields(conn):
    cursor = conn.cursor()
    rows = cursor.execute(
        """
        SELECT id, apply_url, apply_type, auto_apply_eligible, enrichment_status, apply_host, ats_type
        FROM jobs
        WHERE source = 'linkedin'
          AND (
                apply_url IS NOT NULL
             OR apply_type IN ('external_apply', 'easy_apply', 'unknown')
          )
        """
    ).fetchall()

    updated_count = 0
    for row in rows:
        current_apply_url = row["apply_url"]
        normalized_apply_url = normalize_apply_url(current_apply_url)
        current_apply_type = row["apply_type"]
        current_status = row["enrichment_status"]

        new_apply_type = current_apply_type
        new_auto_apply_eligible = row["auto_apply_eligible"]
        new_apply_host = row["apply_host"]
        new_ats_type = row["ats_type"]

        if normalized_apply_url:
            normalized_host = get_apply_host(normalized_apply_url)
            normalized_ats_type = detect_ats_type(normalized_apply_url)
            if normalized_host and not new_apply_host:
                new_apply_host = normalized_host
            if normalized_ats_type and not new_ats_type:
                new_ats_type = normalized_ats_type

            if (
                current_status in ("done", "done_verified", "blocked", "blocked_verified")
                and current_apply_type in (None, "unknown")
                and not looks_like_linkedin_url(normalized_apply_url)
            ):
                new_apply_type = "external_apply"

        if new_apply_type == "external_apply" and new_auto_apply_eligible is None:
            new_auto_apply_eligible = 1
        elif new_apply_type == "easy_apply" and new_auto_apply_eligible is None:
            new_auto_apply_eligible = 0

        if (
            normalized_apply_url != current_apply_url
            or new_apply_type != current_apply_type
            or new_auto_apply_eligible != row["auto_apply_eligible"]
            or new_apply_host != row["apply_host"]
            or new_ats_type != row["ats_type"]
        ):
            cursor.execute(
                """
                UPDATE jobs
                SET apply_url = ?,
                    apply_type = ?,
                    auto_apply_eligible = ?,
                    apply_host = ?,
                    ats_type = ?
                WHERE id = ?
                  AND source = 'linkedin'
                """,
                (
                    normalized_apply_url,
                    new_apply_type,
                    new_auto_apply_eligible,
                    new_apply_host,
                    new_ats_type,
                    row["id"],
                ),
            )
            updated_count += cursor.rowcount

    return updated_count


def get_connection():
    db_path = (os.getenv("HUNT_DB_PATH") or "").strip() or DB_PATH
    conn = sqlite3.connect(db_path, timeout=30.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 30000")
    try:
        conn.execute("PRAGMA journal_mode = WAL")
    except sqlite3.OperationalError:
        pass
    return conn


def init_db(*, maintenance=True):
    conn = get_connection()
    try:
        cursor = conn.cursor()
        cursor.execute(JOBS_TABLE_SQL)
        cursor.execute(RUNTIME_STATE_TABLE_SQL)
        _migrate_jobs_table(cursor)
        if maintenance:
            _backfill_enrichment_metadata(cursor)
            _backfill_retry_schedule(cursor)
            _requeue_stale_processing_rows(cursor)
            _backfill_linkedin_derived_fields(conn)
        conn.commit()
    finally:
        conn.close()


def requeue_linkedin_rows_for_refresh(*, limit=None):
    conn = get_connection()
    try:
        cursor = conn.cursor()
        params = []
        limit_sql = ""
        if limit is not None:
            limit_sql = "LIMIT ?"
            params.append(limit)

        rows = cursor.execute(
            f"""
            SELECT id
            FROM jobs
            WHERE source = 'linkedin'
              AND enrichment_status = 'failed'
              AND coalesce(apply_type, 'unknown') = 'unknown'
              AND (description IS NULL OR trim(description) = '')
            ORDER BY date_scraped DESC, id DESC
            {limit_sql}
            """,
            tuple(params),
        ).fetchall()

        if not rows:
            return []

        job_ids = [row["id"] for row in rows]
        placeholders = ", ".join(["?"] * len(job_ids))
        cursor.execute(
            f"""
            UPDATE jobs
            SET enrichment_status = 'pending',
                last_enrichment_error = NULL,
                last_enrichment_started_at = NULL,
                next_enrichment_retry_at = NULL
            WHERE id IN ({placeholders})
              AND source = 'linkedin'
            """,
            tuple(job_ids),
        )
        conn.commit()
        return job_ids
    finally:
        conn.close()


def count_pending_jobs_for_enrichment(*, sources=None):
    conn = get_connection()
    try:
        cursor = conn.cursor()
        source_filter_sql, source_params = _build_source_filter_sql(sources)
        row = cursor.execute(
            f"""
            SELECT COUNT(*)
            FROM jobs
            WHERE 1=1 {source_filter_sql}
              AND enrichment_status = 'pending'
            """,
            tuple(source_params),
        ).fetchone()
        return int(row[0] if row else 0)
    finally:
        conn.close()


def count_pending_linkedin_jobs():
    return count_pending_jobs_for_enrichment(sources=("linkedin",))


def count_ready_jobs_for_enrichment(*, sources=None):
    claimable_sources = _get_claimable_enrichment_sources(sources)
    if not claimable_sources:
        return 0

    conn = get_connection()
    try:
        cursor = conn.cursor()
        source_filter_sql, source_params = _build_source_filter_sql(claimable_sources)
        row = cursor.execute(
            f"""
            SELECT COUNT(*)
            FROM jobs
            WHERE 1=1 {source_filter_sql}
              AND (
                    enrichment_status = 'pending'
                 OR (
                        enrichment_status = 'failed'
                    AND next_enrichment_retry_at IS NOT NULL
                    AND next_enrichment_retry_at <= CURRENT_TIMESTAMP
                    AND coalesce(enrichment_attempts, 0) < ?
                 )
              )
            """,
            tuple(source_params + [ENRICHMENT_MAX_ATTEMPTS]),
        ).fetchone()
        return int(row[0] if row else 0)
    finally:
        conn.close()


def count_ready_linkedin_jobs_for_enrichment():
    return count_ready_jobs_for_enrichment(sources=("linkedin",))


def count_stale_processing_jobs(*, sources=None):
    conn = get_connection()
    try:
        cursor = conn.cursor()
        stale_cutoff = format_sqlite_timestamp(
            utc_now() - timedelta(minutes=ENRICHMENT_STALE_PROCESSING_MINUTES)
        )
        source_filter_sql, source_params = _build_source_filter_sql(sources)
        row = cursor.execute(
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
            tuple(source_params + [stale_cutoff]),
        ).fetchone()
        return int(row[0] if row else 0)
    finally:
        conn.close()


def count_stale_processing_linkedin_jobs():
    return count_stale_processing_jobs(sources=("linkedin",))


def claim_job_for_enrichment(job_id=None, force=False, *, sources=None):
    claimable_sources = _get_claimable_enrichment_sources(sources)
    if not claimable_sources:
        return None

    conn = get_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("BEGIN IMMEDIATE")
        source_filter_sql, source_params = _build_source_filter_sql(claimable_sources)
        source_priority_sql = _build_source_priority_sql(claimable_sources)

        if job_id is None:
            cursor.execute(
                f"""
                SELECT * FROM jobs
                WHERE 1=1 {source_filter_sql}
                  AND (
                        enrichment_status = 'pending'
                     OR (
                            enrichment_status = 'failed'
                        AND next_enrichment_retry_at IS NOT NULL
                        AND next_enrichment_retry_at <= CURRENT_TIMESTAMP
                        AND coalesce(enrichment_attempts, 0) < ?
                     )
                  )
                ORDER BY {source_priority_sql},
                         CASE enrichment_status WHEN 'pending' THEN 0 ELSE 1 END,
                         CASE WHEN enrichment_status = 'pending' THEN date_scraped END DESC,
                         CASE WHEN enrichment_status != 'pending' THEN next_enrichment_retry_at END ASC,
                         date_scraped DESC,
                         id DESC
                LIMIT 1
                """,
                tuple(source_params + [ENRICHMENT_MAX_ATTEMPTS]),
            )
        elif force:
            cursor.execute(
                f"""
                SELECT * FROM jobs
                WHERE id = ?
                  {source_filter_sql}
                """,
                tuple([job_id] + source_params),
            )
        else:
            cursor.execute(
                f"""
                SELECT * FROM jobs
                WHERE id = ?
                  {source_filter_sql}
                  AND (
                        enrichment_status = 'pending'
                     OR (
                            enrichment_status = 'failed'
                        AND next_enrichment_retry_at IS NOT NULL
                        AND next_enrichment_retry_at <= CURRENT_TIMESTAMP
                        AND coalesce(enrichment_attempts, 0) < ?
                     )
                  )
                """,
                tuple([job_id] + source_params + [ENRICHMENT_MAX_ATTEMPTS]),
            )

        row = cursor.fetchone()
        if not row:
            conn.rollback()
            return None

        cursor.execute(
            (
                """
                UPDATE jobs
                SET enrichment_status = 'processing',
                    enrichment_attempts = coalesce(enrichment_attempts, 0) + 1,
                    last_enrichment_error = NULL,
                    last_enrichment_started_at = CURRENT_TIMESTAMP,
                    next_enrichment_retry_at = NULL,
                    last_artifact_dir = NULL,
                    last_artifact_screenshot_path = NULL,
                    last_artifact_html_path = NULL,
                    last_artifact_text_path = NULL
                WHERE id = ?
                """
                if force
                else """
                UPDATE jobs
                SET enrichment_status = 'processing',
                    enrichment_attempts = coalesce(enrichment_attempts, 0) + 1,
                    last_enrichment_error = NULL,
                    last_enrichment_started_at = CURRENT_TIMESTAMP,
                    next_enrichment_retry_at = NULL,
                    last_artifact_dir = NULL,
                    last_artifact_screenshot_path = NULL,
                    last_artifact_html_path = NULL,
                    last_artifact_text_path = NULL
                WHERE id = ?
                  AND coalesce(enrichment_status, '') != 'processing'
                """
            ),
            (row["id"],),
        )

        if cursor.rowcount != 1:
            conn.rollback()
            return None

        original_row = dict(row)
        cursor.execute("SELECT * FROM jobs WHERE id = ?", (row["id"],))
        claimed_row = cursor.fetchone()
        conn.commit()
        if not claimed_row:
            return None

        claimed = dict(claimed_row)
        claimed.update(
            {
                "_previous_enrichment_status": original_row.get("enrichment_status"),
                "_previous_enrichment_attempts": original_row.get("enrichment_attempts"),
                "_previous_last_enrichment_error": original_row.get("last_enrichment_error"),
                "_previous_last_enrichment_started_at": original_row.get(
                    "last_enrichment_started_at"
                ),
                "_previous_next_enrichment_retry_at": original_row.get("next_enrichment_retry_at"),
                "_previous_last_artifact_dir": original_row.get("last_artifact_dir"),
                "_previous_last_artifact_screenshot_path": original_row.get(
                    "last_artifact_screenshot_path"
                ),
                "_previous_last_artifact_html_path": original_row.get("last_artifact_html_path"),
                "_previous_last_artifact_text_path": original_row.get("last_artifact_text_path"),
            }
        )
        return claimed
    finally:
        conn.close()


def claim_linkedin_job_for_enrichment(job_id=None, force=False):
    return claim_job_for_enrichment(job_id=job_id, force=force, sources=("linkedin",))


def mark_job_enrichment_succeeded(
    job_id,
    *,
    description,
    apply_type,
    auto_apply_eligible,
    apply_url,
    apply_host,
    ats_type,
    enrichment_status="done",
    source=None,
):
    conn = get_connection()
    try:
        cursor = conn.cursor()
        source_sql = ""
        params = [
            description,
            apply_url,
            apply_type,
            auto_apply_eligible,
            enrichment_status,
            apply_host,
            ats_type,
            job_id,
        ]
        if source:
            source_sql = " AND source = ?"
            params.append(source)
        cursor.execute(
            f"""
            UPDATE jobs
            SET description = ?,
                apply_url = ?,
                apply_type = ?,
                auto_apply_eligible = ?,
                enrichment_status = ?,
                enriched_at = CURRENT_TIMESTAMP,
                last_enrichment_error = NULL,
                apply_host = ?,
                ats_type = ?,
                last_enrichment_started_at = NULL,
                next_enrichment_retry_at = NULL,
                last_artifact_dir = NULL,
                last_artifact_screenshot_path = NULL,
                last_artifact_html_path = NULL,
                last_artifact_text_path = NULL
            WHERE id = ?
              {source_sql}
            """,
            tuple(params),
        )
        conn.commit()
        return cursor.rowcount
    finally:
        conn.close()


def mark_linkedin_enrichment_succeeded(
    job_id,
    *,
    description,
    apply_type,
    auto_apply_eligible,
    apply_url,
    apply_host,
    ats_type,
    enrichment_status="done",
):
    return mark_job_enrichment_succeeded(
        job_id,
        description=description,
        apply_type=apply_type,
        auto_apply_eligible=auto_apply_eligible,
        apply_url=apply_url,
        apply_host=apply_host,
        ats_type=ats_type,
        enrichment_status=enrichment_status,
        source="linkedin",
    )


def mark_job_enrichment_failed(
    job_id,
    error_message,
    *,
    enrichment_status="failed",
    next_enrichment_retry_at=_UNSET,
    description=_UNSET,
    apply_type=_UNSET,
    auto_apply_eligible=_UNSET,
    apply_url=_UNSET,
    apply_host=_UNSET,
    ats_type=_UNSET,
    artifact_dir=_UNSET,
    artifact_screenshot_path=_UNSET,
    artifact_html_path=_UNSET,
    artifact_text_path=_UNSET,
    source=None,
):
    conn = get_connection()
    try:
        cursor = conn.cursor()
        updates = [
            "enrichment_status = ?",
            "last_enrichment_error = ?",
        ]
        params = [enrichment_status, error_message]

        optional_updates = (
            ("next_enrichment_retry_at", next_enrichment_retry_at),
            ("description", description),
            ("apply_type", apply_type),
            ("auto_apply_eligible", auto_apply_eligible),
            ("apply_url", apply_url),
            ("apply_host", apply_host),
            ("ats_type", ats_type),
            ("last_artifact_dir", artifact_dir),
            ("last_artifact_screenshot_path", artifact_screenshot_path),
            ("last_artifact_html_path", artifact_html_path),
            ("last_artifact_text_path", artifact_text_path),
        )
        for column_name, value in optional_updates:
            if value is _UNSET:
                continue
            updates.append(f"{column_name} = ?")
            params.append(value)

        if enrichment_status != "processing":
            updates.append("last_enrichment_started_at = NULL")

        params.append(job_id)
        source_sql = ""
        if source:
            source_sql = " AND source = ?"
            params.append(source)
        cursor.execute(
            f"""
            UPDATE jobs
            SET {", ".join(updates)}
            WHERE id = ?
              {source_sql}
            """,
            tuple(params),
        )
        conn.commit()
        return cursor.rowcount
    finally:
        conn.close()


def mark_linkedin_enrichment_failed(
    job_id,
    error_message,
    *,
    enrichment_status="failed",
    next_enrichment_retry_at=_UNSET,
    description=_UNSET,
    apply_type=_UNSET,
    auto_apply_eligible=_UNSET,
    apply_url=_UNSET,
    apply_host=_UNSET,
    ats_type=_UNSET,
    artifact_dir=_UNSET,
    artifact_screenshot_path=_UNSET,
    artifact_html_path=_UNSET,
    artifact_text_path=_UNSET,
):
    return mark_job_enrichment_failed(
        job_id,
        error_message,
        enrichment_status=enrichment_status,
        next_enrichment_retry_at=next_enrichment_retry_at,
        description=description,
        apply_type=apply_type,
        auto_apply_eligible=auto_apply_eligible,
        apply_url=apply_url,
        apply_host=apply_host,
        ats_type=ats_type,
        artifact_dir=artifact_dir,
        artifact_screenshot_path=artifact_screenshot_path,
        artifact_html_path=artifact_html_path,
        artifact_text_path=artifact_text_path,
        source="linkedin",
    )


def restore_job_enrichment_claim(claimed_job, *, source=None):
    conn = get_connection()
    try:
        cursor = conn.cursor()
        source_sql = ""
        params = [
            claimed_job.get("_previous_enrichment_status") or "pending",
            max(0, int(claimed_job.get("_previous_enrichment_attempts") or 0)),
            claimed_job.get("_previous_last_enrichment_error"),
            claimed_job.get("_previous_last_enrichment_started_at"),
            claimed_job.get("_previous_next_enrichment_retry_at"),
            claimed_job.get("_previous_last_artifact_dir"),
            claimed_job.get("_previous_last_artifact_screenshot_path"),
            claimed_job.get("_previous_last_artifact_html_path"),
            claimed_job.get("_previous_last_artifact_text_path"),
            claimed_job["id"],
        ]
        if source:
            source_sql = " AND source = ?"
            params.append(source)
        cursor.execute(
            f"""
            UPDATE jobs
            SET enrichment_status = ?,
                enrichment_attempts = ?,
                last_enrichment_error = ?,
                last_enrichment_started_at = ?,
                next_enrichment_retry_at = ?,
                last_artifact_dir = ?,
                last_artifact_screenshot_path = ?,
                last_artifact_html_path = ?,
                last_artifact_text_path = ?
            WHERE id = ?
              {source_sql}
            """,
            tuple(params),
        )
        conn.commit()
        return cursor.rowcount
    finally:
        conn.close()


def restore_linkedin_enrichment_claim(claimed_job):
    return restore_job_enrichment_claim(claimed_job, source="linkedin")


def requeue_job(job_id, *, source=None):
    conn = get_connection()
    try:
        cursor = conn.cursor()
        source_sql = ""
        params = [job_id]
        if source:
            source_sql = " AND source = ?"
            params.append(source)
        cursor.execute(
            f"""
            UPDATE jobs
            SET enrichment_status = 'pending',
                last_enrichment_error = NULL,
                last_enrichment_started_at = NULL,
                next_enrichment_retry_at = NULL,
                last_artifact_dir = NULL,
                last_artifact_screenshot_path = NULL,
                last_artifact_html_path = NULL,
                last_artifact_text_path = NULL
            WHERE id = ?
              {source_sql}
            """,
            tuple(params),
        )
        conn.commit()
        return cursor.rowcount
    finally:
        conn.close()


def requeue_enrichment_rows(*, source=None, statuses=None):
    conn = get_connection()
    try:
        cursor = conn.cursor()
        allowed_statuses = {"failed", "blocked", "blocked_verified", "processing", "pending"}
        normalized_statuses = tuple(
            status
            for status in (statuses or ("failed", "blocked", "blocked_verified"))
            if status in allowed_statuses
        )
        if not normalized_statuses:
            return 0

        status_placeholders = ", ".join(["?"] * len(normalized_statuses))
        params = list(normalized_statuses)
        source_sql = ""
        if source and source != "all":
            source_sql = " AND source = ?"
            params.append(source)

        cursor.execute(
            f"""
            UPDATE jobs
            SET enrichment_status = 'pending',
                last_enrichment_error = NULL,
                last_enrichment_started_at = NULL,
                next_enrichment_retry_at = NULL,
                last_artifact_dir = NULL,
                last_artifact_screenshot_path = NULL,
                last_artifact_html_path = NULL,
                last_artifact_text_path = NULL
            WHERE enrichment_status IN ({status_placeholders})
              {source_sql}
            """,
            tuple(params),
        )
        conn.commit()
        return cursor.rowcount
    finally:
        conn.close()


def requeue_enrichment_rows_by_error_codes(*, source=None, error_codes=None):
    conn = get_connection()
    try:
        cursor = conn.cursor()
        allowed_error_codes = {"auth_expired", "rate_limited"}
        normalized_error_codes = tuple(
            code for code in (error_codes or ()) if code in allowed_error_codes
        )
        if not normalized_error_codes:
            return 0

        like_clauses = " OR ".join(["last_enrichment_error LIKE ?"] * len(normalized_error_codes))
        params = [f"{code}:%" for code in normalized_error_codes]

        source_sql = ""
        if source and source != "all":
            source_sql = " AND source = ?"
            params.append(source)

        cursor.execute(
            f"""
            UPDATE jobs
            SET enrichment_status = 'pending',
                last_enrichment_error = NULL,
                last_enrichment_started_at = NULL,
                next_enrichment_retry_at = NULL,
                last_artifact_dir = NULL,
                last_artifact_screenshot_path = NULL,
                last_artifact_html_path = NULL,
                last_artifact_text_path = NULL
            WHERE enrichment_status = 'failed'
              AND ({like_clauses})
              {source_sql}
            """,
            tuple(params),
        )
        conn.commit()
        return cursor.rowcount
    finally:
        conn.close()


def requeue_linkedin_job(job_id):
    return requeue_job(job_id, source="linkedin")


def get_linkedin_queue_summary():
    return get_review_queue_summary(source="linkedin")


def get_linkedin_auth_state():
    conn = get_connection()
    try:
        cursor = conn.cursor()
        return _get_linkedin_auth_state_from_cursor(cursor)
    finally:
        conn.close()


def is_linkedin_auth_available():
    return bool(get_linkedin_auth_state().get("available"))


def mark_linkedin_auth_unavailable(error_message):
    conn = get_connection()
    try:
        cursor = conn.cursor()
        cursor.execute(RUNTIME_STATE_TABLE_SQL)
        _upsert_runtime_state(cursor, LINKEDIN_AUTH_STATE_KEY, LINKEDIN_AUTH_STATE_EXPIRED)
        _upsert_runtime_state(cursor, LINKEDIN_AUTH_ERROR_KEY, error_message)
        conn.commit()
        return 1
    finally:
        conn.close()


def mark_linkedin_auth_available():
    conn = get_connection()
    try:
        cursor = conn.cursor()
        cursor.execute(RUNTIME_STATE_TABLE_SQL)
        _upsert_runtime_state(cursor, LINKEDIN_AUTH_STATE_KEY, LINKEDIN_AUTH_STATE_OK)
        _delete_runtime_state(cursor, LINKEDIN_AUTH_ERROR_KEY)
        conn.commit()
        return 1
    finally:
        conn.close()


def set_runtime_state(key, value):
    conn = get_connection()
    try:
        cursor = conn.cursor()
        cursor.execute(RUNTIME_STATE_TABLE_SQL)
        _upsert_runtime_state(cursor, key, value)
        conn.commit()
        return 1
    finally:
        conn.close()


def get_runtime_state(keys):
    conn = get_connection()
    try:
        cursor = conn.cursor()
        cursor.execute(RUNTIME_STATE_TABLE_SQL)
        return _get_runtime_state_values(cursor, keys)
    finally:
        conn.close()


def get_review_queue_summary(*, source=None):
    conn = get_connection()
    try:
        cursor = conn.cursor()
        linkedin_auth = _get_linkedin_auth_state_from_cursor(cursor)
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

        runtime_events = _get_runtime_state_values(
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
    """Shared AND-fragment for review list, counts, exports, and bulk requeue.

    Returns (None, None) when the LinkedIn ready tab is impossible without auth.
    """
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


def list_linkedin_jobs_for_review(
    *,
    status="all",
    limit=50,
    offset=0,
    include_description=False,
    query=None,
    sort="date_scraped",
    direction="desc",
):
    return list_jobs_for_review(
        status=status,
        limit=limit,
        offset=offset,
        include_description=include_description,
        query=query,
        sort=sort,
        direction=direction,
        source="linkedin",
    )


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
    linkedin_auth_available = is_linkedin_auth_available()
    frag, filter_params = _review_jobs_filter_sql_and_params(
        status=status,
        source=source,
        query=query,
        linkedin_auth_available=linkedin_auth_available,
        operator_tag=operator_tag,
    )
    if frag is None:
        return []
    conn = get_connection()
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


def count_linkedin_jobs_for_review(*, status="all", query=None):
    return count_jobs_for_review(status=status, query=query, source="linkedin")


def count_jobs_for_review(*, status="all", query=None, source=None, operator_tag=None):
    linkedin_auth_available = is_linkedin_auth_available()
    frag, filter_params = _review_jobs_filter_sql_and_params(
        status=status,
        source=source,
        query=query,
        linkedin_auth_available=linkedin_auth_available,
        operator_tag=operator_tag,
    )
    if frag is None:
        return 0
    conn = get_connection()
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
    """Requeue up to limit_cap jobs matching review filters and enrichment_status IN target_statuses."""
    cap = limit_cap if limit_cap is not None else config.REVIEW_BULK_REQUEUE_MAX
    cap = max(0, int(cap))
    allowed = {"failed", "blocked", "blocked_verified", "processing", "pending"}
    targets = tuple(s for s in (target_statuses or ()) if s in allowed)
    if not targets or cap == 0:
        return 0

    linkedin_auth_available = is_linkedin_auth_available()
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

    conn = get_connection()
    try:
        cursor = conn.cursor()
        total_match = int(cursor.execute(count_sql, count_params).fetchone()[0])
        would_touch = min(cap, total_match)
        if dry_run:
            return would_touch
        if would_touch == 0:
            return 0
        subq = (
            f"SELECT id FROM jobs WHERE 1=1 {frag}{where_status} ORDER BY id ASC LIMIT ?"
        )
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
    """Mark a job for worker preference (jobs.priority boolean)."""
    conn = get_connection()
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


def update_job_operator_meta(job_id, *, notes=_UNSET, operator_tag=_UNSET):
    assignments = []
    params = []
    if notes is not _UNSET:
        assignments.append("operator_notes = ?")
        params.append(notes)
    if operator_tag is not _UNSET:
        assignments.append("operator_tag = ?")
        params.append(operator_tag)
    if not assignments:
        return 0
    params.append(job_id)
    conn = get_connection()
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
    conn = get_connection()
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
    conn = get_connection()
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
    conn = get_connection()
    try:
        cursor = conn.cursor()
        row = cursor.execute(
            "SELECT value FROM runtime_state WHERE key = ?",
            (REVIEW_AUDIT_LOG_KEY,),
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
    conn = get_connection()
    try:
        cursor = conn.cursor()
        cursor.execute(RUNTIME_STATE_TABLE_SQL)
        row = cursor.execute(
            "SELECT value FROM runtime_state WHERE key = ?",
            (REVIEW_AUDIT_LOG_KEY,),
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
        _upsert_runtime_state(cursor, REVIEW_AUDIT_LOG_KEY, json.dumps(entries))
        conn.commit()
        return len(entries)
    finally:
        conn.close()


def add_job(job_data):
    conn = get_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM jobs WHERE job_url = ?", (job_data.get("job_url"),))
        existing_row = cursor.fetchone()

        if not existing_row:
            placeholders = ", ".join(["?"] * len(INSERT_COLUMNS))
            columns_sql = ", ".join(INSERT_COLUMNS)
            values = tuple(job_data.get(column) for column in INSERT_COLUMNS)
            cursor.execute(
                f"""
                INSERT INTO jobs ({columns_sql})
                VALUES ({placeholders})
                """,
                values,
            )
            conn.commit()
            return "inserted", cursor.lastrowid

        existing = dict(existing_row)
        updates = {}

        for field_name in ("company", "location", "description", "date_posted", "category"):
            if _should_upgrade_text(existing.get(field_name), job_data.get(field_name)):
                updates[field_name] = job_data.get(field_name)

        if existing.get("is_remote") is None and job_data.get("is_remote") is not None:
            updates["is_remote"] = job_data.get("is_remote")

        if _should_upgrade_unknown(existing.get("level"), job_data.get("level")):
            updates["level"] = job_data.get("level")

        if int(existing.get("priority") or 0) == 0 and int(job_data.get("priority") or 0) == 1:
            updates["priority"] = 1

        if _should_upgrade_text(existing.get("apply_url"), job_data.get("apply_url")):
            updates["apply_url"] = normalize_apply_url(job_data.get("apply_url"))

        if _should_upgrade_text(existing.get("apply_host"), job_data.get("apply_host")):
            updates["apply_host"] = job_data.get("apply_host")

        if _should_upgrade_unknown(existing.get("ats_type"), job_data.get("ats_type")):
            updates["ats_type"] = job_data.get("ats_type")

        if existing.get("apply_type") is None and job_data.get("apply_type") is not None:
            updates["apply_type"] = job_data.get("apply_type")

        if (
            existing.get("auto_apply_eligible") is None
            and job_data.get("auto_apply_eligible") is not None
        ):
            updates["auto_apply_eligible"] = job_data.get("auto_apply_eligible")

        if (
            existing.get("enrichment_status") is None
            and job_data.get("enrichment_status") is not None
        ):
            updates["enrichment_status"] = job_data.get("enrichment_status")

        if (
            existing.get("enrichment_attempts") is None
            and job_data.get("enrichment_attempts") is not None
        ):
            updates["enrichment_attempts"] = job_data.get("enrichment_attempts")

        if not updates:
            conn.commit()
            return "skipped", existing["id"]

        assignments = ", ".join(f"{field_name} = ?" for field_name in updates)
        params = list(updates.values()) + [existing["id"]]
        cursor.execute(
            f"""
            UPDATE jobs
            SET {assignments}
            WHERE id = ?
            """,
            tuple(params),
        )
        conn.commit()
        return "updated", existing["id"], "priority" in updates
    finally:
        conn.close()


def get_all_jobs():
    conn = get_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM jobs")
        return [dict(row) for row in cursor.fetchall()]
    finally:
        conn.close()


def get_job_by_id(job_id):
    conn = get_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM jobs WHERE id = ?", (job_id,))
        row = cursor.fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def get_apply_context_for_job(job_id):
    job = get_job_by_id(job_id)
    if not job:
        return None

    return {
        "job_id": str(job["id"]),
        "title": job.get("title") or "",
        "company": job.get("company") or "",
        "apply_url": job.get("apply_url") or "",
        "job_url": job.get("job_url") or "",
        "source": job.get("source") or "",
        "ats_type": job.get("ats_type") or "unknown",
        "priority": int(job.get("priority") or 0),
        "apply_type": job.get("apply_type") or "unknown",
        "auto_apply_eligible": int(job.get("auto_apply_eligible") or 0),
        "description": job.get("description") or "",
        "latest_resume_job_description_path": job.get("latest_resume_job_description_path") or "",
        "latest_resume_flags": job.get("latest_resume_flags") or "",
        "selected_resume_version_id": job.get("selected_resume_version_id") or "",
        "selected_resume_pdf_path": job.get("selected_resume_pdf_path") or "",
        "selected_resume_tex_path": job.get("selected_resume_tex_path") or "",
        "selected_resume_selected_at": job.get("selected_resume_selected_at") or "",
        "selected_resume_ready_for_c3": bool(job.get("selected_resume_ready_for_c3")),
        "last_enrichment_error": job.get("last_enrichment_error") or "",
        "enrichment_status": job.get("enrichment_status") or "",
    }


def update_selected_resume_for_job(
    job_id,
    *,
    version_id,
    pdf_path,
    tex_path=None,
    ready_for_c3=True,
):
    conn = get_connection()
    try:
        cursor = conn.cursor()
        cursor.execute(
            """
            UPDATE jobs
            SET selected_resume_version_id = ?,
                selected_resume_pdf_path = ?,
                selected_resume_tex_path = ?,
                selected_resume_selected_at = CURRENT_TIMESTAMP,
                selected_resume_ready_for_c3 = ?
            WHERE id = ?
            """,
            (
                version_id,
                pdf_path,
                tex_path,
                1 if ready_for_c3 else 0,
                job_id,
            ),
        )
        conn.commit()
        return cursor.rowcount
    finally:
        conn.close()


def get_job_by_status(status):
    conn = get_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM jobs WHERE status = ?", (status,))
        return [dict(row) for row in cursor.fetchall()]
    finally:
        conn.close()


def get_jobs_grouped():
    conn = get_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("""
            SELECT * FROM jobs
            ORDER BY company ASC, date_posted DESC
        """)
        return [dict(row) for row in cursor.fetchall()]
    finally:
        conn.close()


def search_jobs(query):
    conn = get_connection()
    try:
        cursor = conn.cursor()
        wildcard = f"%{query}%"
        cursor.execute(
            """
            SELECT * FROM jobs
            WHERE title LIKE ?
               OR company LIKE ?
               OR location LIKE ?
               OR description LIKE ?
        """,
            (wildcard, wildcard, wildcard, wildcard),
        )
        return [dict(row) for row in cursor.fetchall()]
    finally:
        conn.close()


def update_job_status(job_id, status):
    conn = get_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("UPDATE jobs SET status = ? WHERE id = ?", (status, job_id))
        conn.commit()
        return cursor.rowcount
    finally:
        conn.close()


def remove_high_level_jobs():
    if not TITLE_BLACKLIST:
        return 0
    conn = get_connection()
    try:
        cursor = conn.cursor()
        patterns = [f"%{word}%".lower() for word in TITLE_BLACKLIST]
        placeholders = " OR ".join(["lower(title) LIKE ?"] * len(patterns))
        cursor.execute(f"DELETE FROM jobs WHERE {placeholders}", patterns)
        conn.commit()
        return cursor.rowcount
    finally:
        conn.close()


def clear_db():
    conn = get_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("DELETE FROM jobs")
        conn.commit()
        return cursor.rowcount
    finally:
        conn.close()
