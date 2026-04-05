import sqlite3

from config import DB_PATH, TITLE_BLACKLIST
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
    ats_type TEXT
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


def _get_column_names(cursor):
    return {row[1] for row in cursor.execute("PRAGMA table_info(jobs)")}


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
        WHERE source = 'linkedin'
          AND apply_type IS NULL
        """
    )

    cursor.execute(
        """
        UPDATE jobs
        SET enrichment_status = 'pending'
        WHERE source = 'linkedin'
          AND enrichment_status IS NULL
          AND (
                apply_url IS NULL
             OR apply_type IS NULL
             OR apply_type = 'unknown'
             OR description IS NULL
             OR trim(description) = ''
          )
        """
    )

    cursor.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_jobs_linkedin_enrichment
        ON jobs(source, enrichment_status, date_scraped DESC)
        """
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


def init_db():
    conn = get_connection()
    try:
        cursor = conn.cursor()
        cursor.execute(JOBS_TABLE_SQL)
        _migrate_jobs_table(cursor)
        _backfill_enrichment_metadata(cursor)
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
                last_enrichment_error = NULL
            WHERE id IN ({placeholders})
              AND source = 'linkedin'
            """,
            tuple(job_ids),
        )
        conn.commit()
        return job_ids
    finally:
        conn.close()


def claim_linkedin_job_for_enrichment(job_id=None, force=False):
    conn = get_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("BEGIN IMMEDIATE")

        if job_id is None:
            cursor.execute(
                """
                SELECT * FROM jobs
                WHERE source = 'linkedin'
                  AND enrichment_status = 'pending'
                ORDER BY date_scraped DESC, id DESC
                LIMIT 1
                """
            )
        elif force:
            cursor.execute(
                """
                SELECT * FROM jobs
                WHERE id = ?
                  AND source = 'linkedin'
                """,
                (job_id,),
            )
        else:
            cursor.execute(
                """
                SELECT * FROM jobs
                WHERE id = ?
                  AND source = 'linkedin'
                  AND enrichment_status = 'pending'
                """,
                (job_id,),
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
                    last_enrichment_error = NULL
                WHERE id = ?
                  AND source = 'linkedin'
                """
                if force
                else
                """
                UPDATE jobs
                SET enrichment_status = 'processing',
                    enrichment_attempts = coalesce(enrichment_attempts, 0) + 1,
                    last_enrichment_error = NULL
                WHERE id = ?
                  AND source = 'linkedin'
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
    conn = get_connection()
    try:
        cursor = conn.cursor()
        cursor.execute(
            """
            UPDATE jobs
            SET description = ?,
                apply_url = ?,
                apply_type = ?,
                auto_apply_eligible = ?,
                enrichment_status = ?,
                enriched_at = CURRENT_TIMESTAMP,
                last_enrichment_error = NULL,
                apply_host = ?,
                ats_type = ?
            WHERE id = ?
              AND source = 'linkedin'
            """,
            (
                description,
                apply_url,
                apply_type,
                auto_apply_eligible,
                enrichment_status,
                apply_host,
                ats_type,
                job_id,
            ),
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
    description=_UNSET,
    apply_type=_UNSET,
    auto_apply_eligible=_UNSET,
    apply_url=_UNSET,
    apply_host=_UNSET,
    ats_type=_UNSET,
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
            ("description", description),
            ("apply_type", apply_type),
            ("auto_apply_eligible", auto_apply_eligible),
            ("apply_url", apply_url),
            ("apply_host", apply_host),
            ("ats_type", ats_type),
        )
        for column_name, value in optional_updates:
            if value is _UNSET:
                continue
            updates.append(f"{column_name} = ?")
            params.append(value)

        params.append(job_id)
        cursor.execute(
            f"""
            UPDATE jobs
            SET {", ".join(updates)}
            WHERE id = ?
              AND source = 'linkedin'
            """,
            tuple(params),
        )
        conn.commit()
        return cursor.rowcount
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
