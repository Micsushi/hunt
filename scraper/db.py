import sqlite3
from datetime import timedelta

from config import (
    DB_PATH,
    ENRICHMENT_MAX_ATTEMPTS,
    ENRICHMENT_STALE_PROCESSING_MINUTES,
    TITLE_BLACKLIST,
)
from enrichment_policy import compute_retry_after, format_sqlite_timestamp, get_error_code, utc_now
from url_utils import detect_ats_type, get_apply_host, looks_like_linkedin_url, normalize_apply_url


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
    last_artifact_text_path TEXT
)
"""

MIGRATION_COLUMNS = {
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


def _get_column_names(cursor):
    return {row[1] for row in cursor.execute("PRAGMA table_info(jobs)")}


def _normalize_enrichment_sources(sources=None):
    if sources is None:
        return ENRICHMENT_SOURCE_PRIORITY
    if isinstance(sources, str):
        sources = (sources,)
    normalized = tuple(source for source in sources if source in ENRICHMENT_SOURCE_PRIORITY)
    return normalized or ENRICHMENT_SOURCE_PRIORITY


def _build_source_filter_sql(sources):
    normalized_sources = _normalize_enrichment_sources(sources)
    placeholders = ", ".join(["?"] * len(normalized_sources))
    return f" AND source IN ({placeholders})", list(normalized_sources)


def _build_source_priority_sql(sources):
    normalized_sources = _normalize_enrichment_sources(sources)
    cases = " ".join(
        f"WHEN '{source}' THEN {index}"
        for index, source in enumerate(normalized_sources)
    )
    return f"CASE source {cases} ELSE 999 END"


def _is_blank(value):
    return value is None or (isinstance(value, str) and not value.strip())


def _should_upgrade_text(current_value, new_value):
    return _is_blank(current_value) and not _is_blank(new_value)


def _should_upgrade_unknown(current_value, new_value):
    return (current_value is None or current_value == "unknown") and new_value not in (None, "", "unknown")


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
    conn = sqlite3.connect(DB_PATH, timeout=30.0)
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
    conn = get_connection()
    try:
        cursor = conn.cursor()
        source_filter_sql, source_params = _build_source_filter_sql(sources)
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
    conn = get_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("BEGIN IMMEDIATE")
        source_filter_sql, source_params = _build_source_filter_sql(sources)
        source_priority_sql = _build_source_priority_sql(sources)

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
                else
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
                  AND coalesce(enrichment_status, '') != 'processing'
                """
            ),
            (row["id"],),
        )

        if cursor.rowcount != 1:
            conn.rollback()
            return None

        cursor.execute("SELECT * FROM jobs WHERE id = ?", (row["id"],))
        claimed_row = cursor.fetchone()
        conn.commit()
        return dict(claimed_row) if claimed_row else None
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
            status for status in (statuses or ("failed", "blocked", "blocked_verified")) if status in allowed_statuses
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


def requeue_linkedin_job(job_id):
    return requeue_job(job_id, source="linkedin")


def get_linkedin_queue_summary():
    return get_review_queue_summary(source="linkedin")


def get_review_queue_summary(*, source=None):
    conn = get_connection()
    try:
        cursor = conn.cursor()
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

        ready_count = cursor.execute(
            f"""
            SELECT COUNT(*)
            FROM jobs
            WHERE 1=1 {source_filter_sql}
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

        return {
            "total": sum(counts.values()),
            "counts_by_status": counts,
            "ready_count": int(ready_count or 0),
            "pending_count": counts.get("pending", 0),
            "blocked_count": counts.get("blocked", 0) + counts.get("blocked_verified", 0),
            "stale_processing_count": int(stale_processing_count or 0),
            "oldest_processing_started_at": oldest_processing,
            "failure_counts": failure_counts,
            "source_counts": source_counts,
        }
    finally:
        conn.close()


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
):
    conn = get_connection()
    try:
        cursor = conn.cursor()
        base_select = """
            SELECT id, title, company, source, job_url, apply_url, description,
                   status, apply_type, auto_apply_eligible, enrichment_status,
                   enrichment_attempts, enriched_at, last_enrichment_error,
                   apply_host, ats_type, last_enrichment_started_at, next_enrichment_retry_at,
                   last_artifact_dir, last_artifact_screenshot_path, last_artifact_html_path, last_artifact_text_path,
                   date_scraped
            FROM jobs
            WHERE 1=1
        """

        params = []
        query_value = (query or "").strip()
        if source:
            base_select += " AND source = ?"
            params.append(source)

        if status == "ready":
            base_select += """
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
            params.append(ENRICHMENT_MAX_ATTEMPTS)
        elif status != "all":
            if status == "pending":
                base_select += """
                  AND (
                        enrichment_status = 'pending'
                     OR (source != 'linkedin' AND (enrichment_status IS NULL OR trim(enrichment_status) = ''))
                  )
                """
            else:
                base_select += " AND enrichment_status = ?"
                params.append(status)

        if query_value:
            like_query = f"%{query_value.lower()}%"
            base_select += """
              AND (
                    lower(coalesce(company, '')) LIKE ?
                 OR lower(coalesce(title, '')) LIKE ?
                 OR lower(coalesce(description, '')) LIKE ?
                 OR lower(coalesce(apply_url, '')) LIKE ?
                 OR lower(coalesce(job_url, '')) LIKE ?
              )
            """
            params.extend([like_query, like_query, like_query, like_query, like_query])

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


def count_jobs_for_review(*, status="all", query=None, source=None):
    conn = get_connection()
    try:
        cursor = conn.cursor()
        sql = """
            SELECT COUNT(*)
            FROM jobs
            WHERE 1=1
        """
        params = []
        query_value = (query or "").strip()
        if source:
            sql += " AND source = ?"
            params.append(source)

        if status == "ready":
            sql += """
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
            params.append(ENRICHMENT_MAX_ATTEMPTS)
        elif status != "all":
            if status == "pending":
                sql += """
                  AND (
                        enrichment_status = 'pending'
                     OR (source != 'linkedin' AND (enrichment_status IS NULL OR trim(enrichment_status) = ''))
                  )
                """
            else:
                sql += " AND enrichment_status = ?"
                params.append(status)

        if query_value:
            like_query = f"%{query_value.lower()}%"
            sql += """
              AND (
                    lower(coalesce(company, '')) LIKE ?
                 OR lower(coalesce(title, '')) LIKE ?
                 OR lower(coalesce(description, '')) LIKE ?
                 OR lower(coalesce(apply_url, '')) LIKE ?
                 OR lower(coalesce(job_url, '')) LIKE ?
              )
            """
            params.extend([like_query, like_query, like_query, like_query, like_query])

        return int(cursor.execute(sql, tuple(params)).fetchone()[0])
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
            return "inserted"

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

        if existing.get("auto_apply_eligible") is None and job_data.get("auto_apply_eligible") is not None:
            updates["auto_apply_eligible"] = job_data.get("auto_apply_eligible")

        if existing.get("enrichment_status") is None and job_data.get("enrichment_status") is not None:
            updates["enrichment_status"] = job_data.get("enrichment_status")

        if existing.get("enrichment_attempts") is None and job_data.get("enrichment_attempts") is not None:
            updates["enrichment_attempts"] = job_data.get("enrichment_attempts")

        if not updates:
            conn.commit()
            return "skipped"

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
        return "updated"
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
        cursor.execute("""
            SELECT * FROM jobs
            WHERE title LIKE ?
               OR company LIKE ?
               OR location LIKE ?
               OR description LIKE ?
        """, (wildcard, wildcard, wildcard, wildcard))
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
