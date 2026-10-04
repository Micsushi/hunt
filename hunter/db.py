import json
import os
import re
import sqlite3
from contextlib import closing
from datetime import UTC, datetime, timedelta

from hunter import config
from hunter.config import (
    ENRICHMENT_MAX_ATTEMPTS,
    ENRICHMENT_STALE_PROCESSING_MINUTES,
)
from hunter.discovery_policy import (
    DISCOVERY_POLICY_VERSION,
    annotate_job,
    canonical_job_key,
    normalize_company,
    normalize_text,
)
from hunter.discovery_sources import DEFAULT_PUBLIC_FEEDS
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
    priority BOOLEAN DEFAULT FALSE,
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

COMPONENT_SETTINGS_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS component_settings (
    component   TEXT NOT NULL,
    key         TEXT NOT NULL,
    value       TEXT,
    value_type  TEXT NOT NULL DEFAULT 'string',
    secret      BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by  TEXT,
    PRIMARY KEY (component, key)
)
"""

LINKEDIN_ACCOUNTS_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS linkedin_accounts (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    username            TEXT NOT NULL UNIQUE,
    password_encrypted  TEXT,
    display_name        TEXT,
    active              BOOLEAN NOT NULL DEFAULT TRUE,
    auth_state          TEXT NOT NULL DEFAULT 'unknown',
    last_auth_check     TEXT,
    last_auth_error     TEXT,
    created_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)
"""

JOB_SOURCE_OBSERVATIONS_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS job_source_observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL,
    source TEXT NOT NULL,
    source_url TEXT NOT NULL,
    first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(job_id, source, source_url),
    FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE CASCADE
)
"""

DISCOVERY_SOURCE_HEALTH_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS discovery_source_health (
    source TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    lead_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    checked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)
"""

COMPANY_FETCH_QUEUE_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS company_fetch_queue (
    normalized_company TEXT PRIMARY KEY,
    company TEXT NOT NULL,
    career_site TEXT NOT NULL,
    fetch_method TEXT NOT NULL,
    resolved_url TEXT,
    coverage TEXT,
    state TEXT NOT NULL DEFAULT 'pending',
    lead_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    last_checked_at TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)
"""

MIGRATION_COLUMNS = {
    "employment_type": "TEXT",
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
    "latest_resume_jd_usable": "INTEGER",
    "latest_resume_jd_usable_reason": "TEXT",
    "canonical_job_key": "TEXT",
    "normalized_company": "TEXT",
    "career_stage": "TEXT",
    "priority_tier": "TEXT",
    "fit_score": "INTEGER",
    "viability_score": "INTEGER",
    "discovery_suppressed_reason": "TEXT",
    "source_count": "INTEGER DEFAULT 1",
    "c3_outcome": "TEXT",
    "c3_outcome_reason": "TEXT",
    "c3_observed_at": "TEXT",
    "discovery_policy_version": "INTEGER",
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
    "employment_type",
    "level",
    "priority",
    "category",
    "apply_type",
    "auto_apply_eligible",
    "enrichment_status",
    "enrichment_attempts",
    "apply_host",
    "ats_type",
    "canonical_job_key",
    "normalized_company",
    "career_stage",
    "priority_tier",
    "fit_score",
    "viability_score",
    "discovery_suppressed_reason",
    "last_enrichment_error",
)

_UNSET = object()
ENRICHMENT_SOURCE_PRIORITY = ("linkedin", "indeed")
PUBLIC_EMPLOYER_SCOPE_SQL = """source NOT IN ('linkedin', 'indeed')
    AND ats_type IN ('workday', 'greenhouse', 'lever', 'ashby', 'smartrecruiters', 'bamboohr', 'workable')
    AND status = 'new' AND coalesce(apply_type, '') != 'easy_apply'"""
REQUEUEABLE_JOB_SQL = f"(source IN ('linkedin', 'indeed') OR ({PUBLIC_EMPLOYER_SCOPE_SQL}))"
LINKEDIN_AUTH_STATE_KEY = "linkedin_auth_state"
LINKEDIN_AUTH_ERROR_KEY = "linkedin_auth_error"
LINKEDIN_AUTH_STATE_OK = "ok"
LINKEDIN_AUTH_STATE_EXPIRED = "expired"
LINKEDIN_AUTH_STATE_UNKNOWN = "unknown"
HIRING_CAFE_COOLDOWN_UNTIL_KEY = "hiring_cafe_cooldown_until"
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


def _refresh_discovery_metadata(cursor, current):
    annotated = annotate_job(current)
    fields = (
        "category",
        "canonical_job_key",
        "normalized_company",
        "career_stage",
        "priority_tier",
        "fit_score",
        "viability_score",
        "discovery_suppressed_reason",
        "priority",
    )
    cursor.execute(
        "UPDATE jobs SET "
        + ", ".join(f"{key} = ?" for key in fields)
        + ", discovery_policy_version = ? WHERE id = ?",
        tuple(annotated.get(key) for key in fields) + (DISCOVERY_POLICY_VERSION, current["id"]),
    )
    return annotated


def _backfill_discovery_metadata(cursor):
    policy_key = "discovery_policy_configuration"
    policy = json.dumps(
        {
            name: getattr(config, name)
            for name in (
                "SEARCH_TERMS",
                "TARGET_JOB_TITLES",
                "EXPERIENCE_LEVELS",
                "TARGETING_CONFIGURED",
                "CAREER_STAGES",
                "INCLUDE_EXPERIENCED_ROLES",
                "DISCOVERY_COUNTRIES",
                "EMPLOYMENT_TYPES",
                "REMOTE_ONLY",
                "WATCHLIST",
                "TITLE_BLACKLIST",
                "COMPANY_BLOCKLIST",
            )
        },
        sort_keys=True,
    )
    previous = _get_runtime_state_values(cursor, [policy_key]).get(policy_key, {})
    changed = previous.get("value") != policy
    rows = cursor.execute(
        """
        SELECT * FROM jobs WHERE ? OR discovery_policy_version IS NULL OR discovery_policy_version < ?
        """,
        (changed, DISCOVERY_POLICY_VERSION),
    ).fetchall()
    employers = set()
    for row in rows:
        current = dict(row)
        if (
            current.get("discovery_policy_version") is None
            and (
                current.get("source") in DEFAULT_PUBLIC_FEEDS
                or str(current.get("source") or "").startswith("employer_")
            )
            and not current.get("enriched_at")
        ):
            cursor.execute(
                """UPDATE jobs SET enrichment_status = 'blocked', apply_type = 'unknown',
                   auto_apply_eligible = FALSE, last_enrichment_error = 'public_apply_flow_unverified'
                   WHERE id = ?""",
                (current["id"],),
            )
            current.update(
                enrichment_status="blocked", apply_type="unknown", auto_apply_eligible=False
            )
        annotated = _refresh_discovery_metadata(cursor, current)
        _record_source_observation(cursor, current["id"], current)
        employers.add(annotated.get("normalized_company"))
    for company in employers:
        _enforce_employer_month_cap(cursor, company)
    _upsert_runtime_state(cursor, policy_key, policy)


POSTGRES_CASCADE_FK_MIGRATIONS = (
    (
        "orchestration_runs",
        "orchestration_runs_job_id_fkey",
        "job_id",
        "jobs",
        "id",
    ),
    (
        "submit_approvals",
        "submit_approvals_job_id_fkey",
        "job_id",
        "jobs",
        "id",
    ),
    (
        "orchestration_events",
        "orchestration_events_orchestration_run_id_fkey",
        "orchestration_run_id",
        "orchestration_runs",
        "id",
    ),
    (
        "submit_approvals",
        "submit_approvals_orchestration_run_id_fkey",
        "orchestration_run_id",
        "orchestration_runs",
        "id",
    ),
    (
        "orchestration_worker_leases",
        "orchestration_worker_leases_orchestration_run_id_fkey",
        "orchestration_run_id",
        "orchestration_runs",
        "id",
    ),
)


def _ensure_postgres_delete_cascade_constraints(cursor):
    if not (os.environ.get("HUNT_DB_URL") or "").strip():
        return
    for (
        table_name,
        constraint_name,
        column_name,
        parent_table,
        parent_column,
    ) in POSTGRES_CASCADE_FK_MIGRATIONS:
        cursor.execute(
            """
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1
                    FROM information_schema.table_constraints
                    WHERE constraint_schema = current_schema()
                      AND table_name = %s
                      AND constraint_name = %s
                ) THEN
                    EXECUTE format('ALTER TABLE %%I DROP CONSTRAINT %%I', %s, %s);
                    EXECUTE format(
                        'ALTER TABLE %%I ADD CONSTRAINT %%I FOREIGN KEY (%%I) REFERENCES %%I(%%I) ON DELETE CASCADE',
                        %s, %s, %s, %s, %s
                    );
                END IF;
            END $$;
            """,
            (
                table_name,
                constraint_name,
                table_name,
                constraint_name,
                table_name,
                constraint_name,
                column_name,
                parent_table,
                parent_column,
            ),
        )


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
                     OR auto_apply_eligible IS TRUE
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
    with closing(get_connection()) as conn:
        cursor = conn.cursor()
        updated = _requeue_stale_processing_rows(cursor)
        conn.commit()
        return int(updated or 0)


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
    from hunter.db_compat import get_connection as _get_connection

    # Pass DB_PATH explicitly so tests that mutate `db.DB_PATH` are respected.
    return _get_connection(DB_PATH)


def init_db(*, maintenance=True, refresh_discovery=True):
    with closing(get_connection()) as conn:
        cursor = conn.cursor()
        if (os.environ.get("HUNT_DB_URL") or "").strip():
            # C0, C1, and the scheduler can start together. Hold through commit/rollback.
            cursor.execute("SELECT pg_advisory_xact_lock(?)", (0x48554E54,))
        cursor.execute(JOBS_TABLE_SQL)
        cursor.execute(RUNTIME_STATE_TABLE_SQL)
        cursor.execute(COMPONENT_SETTINGS_TABLE_SQL)
        cursor.execute(LINKEDIN_ACCOUNTS_TABLE_SQL)
        cursor.execute(JOB_SOURCE_OBSERVATIONS_TABLE_SQL)
        cursor.execute(DISCOVERY_SOURCE_HEALTH_TABLE_SQL)
        cursor.execute(COMPANY_FETCH_QUEUE_TABLE_SQL)
        company_columns = {
            row[1] for row in cursor.execute("PRAGMA table_info(company_fetch_queue)")
        }
        if "resolved_url" not in company_columns:
            cursor.execute("ALTER TABLE company_fetch_queue ADD COLUMN resolved_url TEXT")
        if "coverage" not in company_columns:
            cursor.execute("ALTER TABLE company_fetch_queue ADD COLUMN coverage TEXT")
        _migrate_jobs_table(cursor)
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_jobs_canonical ON jobs(canonical_job_key)")
        cursor.execute(
            "CREATE INDEX IF NOT EXISTS idx_jobs_employer_month ON jobs(normalized_company, date_posted)"
        )
        cursor.execute(
            "CREATE INDEX IF NOT EXISTS idx_jobs_discovery_version ON jobs(discovery_policy_version)"
        )
        if refresh_discovery:
            _backfill_discovery_metadata(cursor)
        # Expiring the rolling window must release old caps even without new jobs.
        capped_companies = cursor.execute(
            "SELECT DISTINCT normalized_company FROM jobs "
            "WHERE discovery_suppressed_reason = 'employer_month_cap'"
        ).fetchall()
        for company in capped_companies:
            _enforce_employer_month_cap(cursor, company["normalized_company"])
        _ensure_postgres_delete_cascade_constraints(cursor)
        if maintenance:
            _backfill_enrichment_metadata(cursor)
            _backfill_retry_schedule(cursor)
            _requeue_stale_processing_rows(cursor)
            _backfill_linkedin_derived_fields(conn)
        conn.commit()


def requeue_linkedin_rows_for_refresh(*, limit=None):
    with closing(get_connection()) as conn:
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


READY_ENRICHMENT_SQL = """(enrichment_status = 'pending' OR (
    enrichment_status = 'failed' AND next_enrichment_retry_at IS NOT NULL
    AND next_enrichment_retry_at <= CURRENT_TIMESTAMP
    AND coalesce(enrichment_attempts, 0) < ?)) """


def _count_jobs(conditions, params):
    with closing(get_connection()) as conn:
        return int(
            conn.execute("SELECT COUNT(*) FROM jobs WHERE " + conditions, tuple(params)).fetchone()[
                0
            ]
        )


def count_pending_jobs_for_enrichment(*, sources=None):
    source_filter, params = _build_source_filter_sql(sources)
    return _count_jobs("enrichment_status = 'pending' " + source_filter, params)


def count_ready_jobs_for_enrichment(*, sources=None):
    sources = _get_claimable_enrichment_sources(sources)
    if not sources:
        return 0
    source_filter, params = _build_source_filter_sql(sources)
    return _count_jobs(READY_ENRICHMENT_SQL + source_filter, [ENRICHMENT_MAX_ATTEMPTS, *params])


def count_ready_linkedin_jobs_for_enrichment():
    return count_ready_jobs_for_enrichment(sources=("linkedin",))


def _hiring_cafe_fallback_needed_sql():
    return """
      AND source = 'linkedin'
      AND (
            description IS NULL
         OR trim(description) = ''
         OR apply_url IS NULL
         OR trim(apply_url) = ''
         OR coalesce(apply_type, 'unknown') = 'unknown'
      )
    """


def count_ready_linkedin_jobs_for_hiring_cafe_fallback():
    if is_hiring_cafe_in_cooldown():
        return 0
    return _count_jobs(
        READY_ENRICHMENT_SQL + _hiring_cafe_fallback_needed_sql(), [ENRICHMENT_MAX_ATTEMPTS]
    )


def count_stale_processing_jobs(*, sources=None):
    source_filter, params = _build_source_filter_sql(sources)
    cutoff = format_sqlite_timestamp(
        utc_now() - timedelta(minutes=ENRICHMENT_STALE_PROCESSING_MINUTES)
    )
    return _count_jobs(
        "enrichment_status = 'processing' AND (last_enrichment_started_at IS NULL OR last_enrichment_started_at <= ?) "
        + source_filter,
        [cutoff, *params],
    )


def _claim_enrichment(job_id, force, source_filter, params, priority=""):
    # Both public-board workers claim and restore the same enrichment fields.
    conditions = ["1=1", source_filter]
    params = list(params)
    if job_id is not None:
        conditions.append("AND id = ?")
        params.append(job_id)
    if job_id is None or not force:
        conditions.append("AND " + READY_ENRICHMENT_SQL)
        params.append(ENRICHMENT_MAX_ATTEMPTS)
    with closing(get_connection()) as conn:
        cursor = conn.cursor()
        cursor.execute("BEGIN IMMEDIATE")
        cursor.execute(
            f"""SELECT * FROM jobs WHERE {" ".join(conditions)}
                ORDER BY {priority}
                    CASE enrichment_status WHEN 'pending' THEN 0 ELSE 1 END,
                    CASE WHEN enrichment_status = 'pending' THEN date_scraped END DESC,
                    CASE WHEN enrichment_status != 'pending' THEN next_enrichment_retry_at END ASC,
                    date_scraped DESC, id DESC
                LIMIT 1""",
            tuple(params),
        )
        row = cursor.fetchone()
        if not row:
            conn.rollback()
            return None
        guard = "" if force else "AND coalesce(enrichment_status, '') != 'processing'"
        cursor.execute(
            f"""UPDATE jobs SET
                enrichment_status = 'processing',
                enrichment_attempts = coalesce(enrichment_attempts, 0) + 1,
                last_enrichment_error = NULL,
                last_enrichment_started_at = CURRENT_TIMESTAMP,
                next_enrichment_retry_at = NULL,
                last_artifact_dir = NULL,
                last_artifact_screenshot_path = NULL,
                last_artifact_html_path = NULL,
                last_artifact_text_path = NULL
                WHERE id = ? {guard}""",
            (row["id"],),
        )
        if cursor.rowcount != 1:
            conn.rollback()
            return None
        original = dict(row)
        cursor.execute("SELECT * FROM jobs WHERE id = ?", (row["id"],))
        claimed_row = cursor.fetchone()
        conn.commit()
        if not claimed_row:
            return None
        return {
            **dict(claimed_row),
            **{
                "_previous_" + field: original.get(field)
                for field in (
                    "enrichment_status",
                    "enrichment_attempts",
                    "last_enrichment_error",
                    "last_enrichment_started_at",
                    "next_enrichment_retry_at",
                    "last_artifact_dir",
                    "last_artifact_screenshot_path",
                    "last_artifact_html_path",
                    "last_artifact_text_path",
                )
            },
        }


def claim_job_for_enrichment(job_id=None, force=False, *, sources=None):
    sources = _get_claimable_enrichment_sources(sources)
    if not sources:
        return None
    source_filter, params = _build_source_filter_sql(sources)
    return _claim_enrichment(
        job_id, force, source_filter, params, _build_source_priority_sql(sources) + ","
    )


def claim_linkedin_job_for_enrichment(job_id=None, force=False):
    return claim_job_for_enrichment(job_id=job_id, force=force, sources=("linkedin",))


def claim_linkedin_job_for_hiring_cafe_fallback(job_id=None, force=False):
    if not force and is_hiring_cafe_in_cooldown():
        return None
    source_filter = (
        "AND source = 'linkedin'"
        if job_id is not None and force
        else _hiring_cafe_fallback_needed_sql()
    )
    return _claim_enrichment(job_id, force, source_filter, [])


def _public_employer_ready_conditions():
    stale_before = format_sqlite_timestamp(
        utc_now() - timedelta(minutes=ENRICHMENT_STALE_PROCESSING_MINUTES)
    )
    conditions = f"""({PUBLIC_EMPLOYER_SCOPE_SQL})
        AND (discovery_suppressed_reason IS NULL OR discovery_suppressed_reason IN
             ('', 'employer_month_cap', 'geography_unverified'))
        AND (enrichment_status = 'pending'
             OR (enrichment_status = 'blocked'
              AND (coalesce(enrichment_attempts, 0) < ? OR
                   last_enrichment_error IN ('http_429', 'http_500', 'http_502', 'http_503',
                       'http_504', 'TimeoutError', 'URLError', 'ConnectionError',
                       'dns_resolution_failed'))
              AND (next_enrichment_retry_at IS NULL OR next_enrichment_retry_at <= CURRENT_TIMESTAMP))
             OR (enrichment_status = 'processing' AND last_enrichment_started_at < ?)
             OR (enrichment_status IN ('done', 'done_verified') AND enriched_at < ?))"""
    return conditions, (
        ENRICHMENT_MAX_ATTEMPTS,
        stale_before,
        format_sqlite_timestamp(utc_now() - timedelta(days=1)),
    )


def count_ready_public_employer_jobs():
    return _count_jobs(*_public_employer_ready_conditions())


def public_verification_health():
    """Report actual ready work separately from excluded rows and delayed retries."""
    conditions, args = _public_employer_ready_conditions()
    with closing(get_connection()) as conn:
        rows = conn.execute(
            f"SELECT discovery_suppressed_reason, enrichment_status, count(*) AS count, "
            f"min(date_scraped) AS oldest_discovered_at, min(enriched_at) AS oldest_verified_at "
            f"FROM jobs WHERE {conditions} GROUP BY discovery_suppressed_reason, enrichment_status",
            args,
        ).fetchall()
    return {"checked_at": utc_now().isoformat(), "ready_groups": [dict(row) for row in rows]}


def claim_public_employer_job():
    """Claim an unverified public lead, independently of authenticated board workers."""
    with closing(get_connection()) as conn:
        cursor = conn.cursor()
        conditions, args = _public_employer_ready_conditions()
        row = cursor.execute(
            f"SELECT * FROM jobs WHERE {conditions} ORDER BY CASE WHEN discovery_suppressed_reason IS NULL THEN 0 ELSE 1 END, CASE WHEN enrichment_status IN ('done', 'done_verified') THEN 1 ELSE 0 END, coalesce(next_enrichment_retry_at, date_scraped), id LIMIT 1",
            args,
        ).fetchone()
        if row is None:
            return None
        cursor.execute(
            f"""UPDATE jobs SET enrichment_status = 'processing',
                enrichment_attempts = CASE WHEN enrichment_status IN ('done', 'done_verified')
                    THEN 1 ELSE coalesce(enrichment_attempts, 0) + 1 END,
                last_enrichment_started_at = CURRENT_TIMESTAMP
                WHERE id = ? AND {conditions}""",
            (row["id"], *args),
        )
        if cursor.rowcount != 1:
            conn.rollback()
            return None
        claimed = cursor.execute("SELECT * FROM jobs WHERE id = ?", (row["id"],)).fetchone()
        result = dict(claimed)
        result["source_urls"] = [
            observation["source_url"]
            for observation in cursor.execute(
                "SELECT source_url FROM job_source_observations WHERE job_id = ?",
                (row["id"],),
            ).fetchall()
        ]
        conn.commit()
        return result


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
    expected_started_at=None,
    location=_UNSET,
    title=_UNSET,
):
    with closing(get_connection()) as conn:
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
        ]
        metadata_sql = ""
        for field, value in (("location", location), ("title", title)):
            if value is not _UNSET:
                metadata_sql += f", {field} = ?"
                params.append(value)
        params.append(job_id)
        if source:
            source_sql = " AND source = ?"
            params.append(source)
        if expected_started_at is not None:
            source_sql += " AND enrichment_status = 'processing' AND last_enrichment_started_at = ? AND status = 'new'"
            params.append(expected_started_at)
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
                {metadata_sql}
            WHERE id = ?
              {source_sql}
            """,
            tuple(params),
        )
        updated = cursor.rowcount
        if updated:
            current = dict(cursor.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone())
            annotated = _refresh_discovery_metadata(cursor, current)
            _enforce_employer_month_cap(cursor, annotated.get("normalized_company"))
        conn.commit()
        return updated


def mark_linkedin_enrichment_succeeded(job_id, **kwargs):
    return mark_job_enrichment_succeeded(job_id, source="linkedin", **kwargs)


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
    expected_started_at=None,
):
    with closing(get_connection()) as conn:
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
        if expected_started_at is not None:
            source_sql += " AND enrichment_status = 'processing' AND last_enrichment_started_at = ? AND status = 'new'"
            params.append(expected_started_at)
        cursor.execute(
            f"""
            UPDATE jobs
            SET {", ".join(updates)}
            WHERE id = ?
              {source_sql}
            """,
            tuple(params),
        )
        updated = cursor.rowcount
        if updated and error_message == "job_removed":
            row = cursor.execute(
                "SELECT normalized_company FROM jobs WHERE id = ?", (job_id,)
            ).fetchone()
            _enforce_employer_month_cap(cursor, row["normalized_company"])
        conn.commit()
        return updated


def mark_linkedin_enrichment_failed(job_id, error_message, **kwargs):
    return mark_job_enrichment_failed(job_id, error_message, source="linkedin", **kwargs)


def get_hiring_cafe_cooldown_until():
    state = get_runtime_state([HIRING_CAFE_COOLDOWN_UNTIL_KEY]).get(HIRING_CAFE_COOLDOWN_UNTIL_KEY)
    return (state or {}).get("value")


def set_hiring_cafe_cooldown_until(value):
    with closing(get_connection()) as conn:
        cursor = conn.cursor()
        _upsert_runtime_state(cursor, HIRING_CAFE_COOLDOWN_UNTIL_KEY, value)
        conn.commit()


def clear_hiring_cafe_cooldown():
    with closing(get_connection()) as conn:
        cursor = conn.cursor()
        _delete_runtime_state(cursor, HIRING_CAFE_COOLDOWN_UNTIL_KEY)
        conn.commit()


def is_hiring_cafe_in_cooldown(*, now=None):
    value = get_hiring_cafe_cooldown_until()
    if not value:
        return False
    try:
        cooldown_until = datetime.strptime(value, "%Y-%m-%d %H:%M:%S").replace(tzinfo=UTC)
    except ValueError:
        return False
    if now is None:
        now = utc_now()
    return now < cooldown_until


def restore_job_enrichment_claim(claimed_job, *, source=None):
    with closing(get_connection()) as conn:
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


def restore_linkedin_enrichment_claim(claimed_job):
    return restore_job_enrichment_claim(claimed_job, source="linkedin")


def _requeue_where(conditions, params, *, source=None):
    if source and source != "all":
        conditions += " AND source = ?"
        params = [*params, source]
    with closing(get_connection()) as conn:
        cursor = conn.execute(
            f"""UPDATE jobs SET enrichment_status = 'pending',
                last_enrichment_error = NULL, last_enrichment_started_at = NULL,
                next_enrichment_retry_at = NULL, last_artifact_dir = NULL,
                last_artifact_screenshot_path = NULL, last_artifact_html_path = NULL,
                last_artifact_text_path = NULL
                WHERE {conditions} AND {REQUEUEABLE_JOB_SQL}""",
            tuple(params),
        )
        conn.commit()
        return cursor.rowcount


def requeue_job(job_id, *, source=None):
    return _requeue_where(
        "id = ?" + (" AND source = ?" if source else ""), [job_id, source] if source else [job_id]
    )


def _normalize_int_job_ids(job_ids, *, max_count):
    if max_count <= 0:
        return []
    normalized = []
    seen = set()
    for raw in job_ids or ():
        try:
            i = int(raw)
        except (TypeError, ValueError):
            continue
        if i < 1 or i in seen:
            continue
        seen.add(i)
        normalized.append(i)
        if len(normalized) >= max_count:
            break
    return normalized


def bulk_requeue_jobs_by_ids(job_ids):
    normalized = _normalize_int_job_ids(
        job_ids, max_count=max(0, int(config.REVIEW_BULK_SELECTED_MAX))
    )
    if not normalized:
        return 0
    return _requeue_where("id IN (" + ",".join("?" for _ in normalized) + ")", normalized)


def set_enrichment_status_for_job_ids(job_ids, *, enrichment_status):
    """Set enrichment_status for the given job IDs (operator override)."""
    allowed = {
        "pending",
        "processing",
        "done",
        "done_verified",
        "failed",
        "blocked",
        "blocked_verified",
    }
    if enrichment_status not in allowed:
        raise ValueError(f"enrichment_status must be one of {sorted(allowed)}")
    cap = max(0, int(config.REVIEW_BULK_SELECTED_MAX))
    normalized = _normalize_int_job_ids(job_ids, max_count=cap)
    if not normalized:
        return 0
    placeholders = ", ".join(["?"] * len(normalized))
    with closing(get_connection()) as conn:
        cursor = conn.cursor()
        cursor.execute(
            f"""
            UPDATE jobs
            SET enrichment_status = ?
            WHERE id IN ({placeholders})
            """,
            tuple([enrichment_status] + normalized),
        )
        conn.commit()
        return cursor.rowcount


def delete_jobs_by_ids(job_ids):
    cap = max(0, int(config.REVIEW_BULK_DELETE_MAX))
    normalized = _normalize_int_job_ids(job_ids, max_count=cap)
    if not normalized:
        return 0
    placeholders = ", ".join(["?"] * len(normalized))
    with closing(get_connection()) as conn:
        cursor = conn.cursor()
        cursor.execute(
            f"DELETE FROM jobs WHERE id IN ({placeholders})",
            tuple(normalized),
        )
        conn.commit()
        return cursor.rowcount


def requeue_enrichment_rows(*, source=None, statuses=None):
    allowed = {"failed", "blocked", "blocked_verified", "processing", "pending"}
    statuses = [s for s in (statuses or ("failed", "blocked", "blocked_verified")) if s in allowed]
    if not statuses:
        return 0
    return _requeue_where(
        "enrichment_status IN (" + ",".join("?" for _ in statuses) + ")", statuses, source=source
    )


def requeue_enrichment_rows_by_error_codes(*, source=None, error_codes=None):
    codes = [code for code in (error_codes or ()) if code in {"auth_expired", "rate_limited"}]
    if not codes:
        return 0
    return _requeue_where(
        "(" + " OR ".join("last_enrichment_error LIKE ?" for _ in codes) + ")",
        [f"{code}:%" for code in codes],
        source=source,
    )


def get_linkedin_queue_summary():
    return get_review_queue_summary(source="linkedin")


def get_linkedin_auth_state():
    with closing(get_connection()) as conn:
        cursor = conn.cursor()
        return _get_linkedin_auth_state_from_cursor(cursor)


def is_linkedin_auth_available():
    return bool(get_linkedin_auth_state().get("available"))


def mark_linkedin_auth_unavailable(error_message):
    with closing(get_connection()) as conn:
        cursor = conn.cursor()
        cursor.execute(RUNTIME_STATE_TABLE_SQL)
        _upsert_runtime_state(cursor, LINKEDIN_AUTH_STATE_KEY, LINKEDIN_AUTH_STATE_EXPIRED)
        _upsert_runtime_state(cursor, LINKEDIN_AUTH_ERROR_KEY, error_message)
        conn.commit()
        return 1


def mark_linkedin_auth_available():
    with closing(get_connection()) as conn:
        cursor = conn.cursor()
        cursor.execute(RUNTIME_STATE_TABLE_SQL)
        _upsert_runtime_state(cursor, LINKEDIN_AUTH_STATE_KEY, LINKEDIN_AUTH_STATE_OK)
        _delete_runtime_state(cursor, LINKEDIN_AUTH_ERROR_KEY)
        conn.commit()
        return 1


def set_runtime_state(key, value):
    with closing(get_connection()) as conn:
        cursor = conn.cursor()
        cursor.execute(RUNTIME_STATE_TABLE_SQL)
        _upsert_runtime_state(cursor, key, value)
        conn.commit()
        return 1


def get_runtime_state(keys):
    with closing(get_connection()) as conn:
        cursor = conn.cursor()
        cursor.execute(RUNTIME_STATE_TABLE_SQL)
        return _get_runtime_state_values(cursor, keys)


def get_review_queue_summary(*, source=None):
    from backend import db as backend_db  # noqa: PLC0415

    return backend_db.get_review_queue_summary(source=source)


def list_jobs_for_review(**kwargs):
    from backend import db as backend_db

    return backend_db.list_jobs_for_review(**kwargs)


def count_jobs_for_review(**kwargs):
    from backend import db as backend_db

    return backend_db.count_jobs_for_review(**kwargs)


def _record_source_observation(cursor, job_id, job_data):
    source = str(job_data.get("source") or "unknown")
    source_url = str(job_data.get("job_url") or job_data.get("apply_url") or "")
    if not source_url:
        return
    cursor.execute(
        """
        INSERT INTO job_source_observations (job_id, source, source_url)
        VALUES (?, ?, ?)
        ON CONFLICT(job_id, source, source_url) DO UPDATE SET
            last_seen_at = CURRENT_TIMESTAMP
        """,
        (job_id, source, source_url),
    )
    cursor.execute(
        """
        UPDATE jobs
        SET source_count = (
            SELECT COUNT(*) FROM job_source_observations WHERE job_id = ?
        )
        WHERE id = ?
        """,
        (job_id, job_id),
    )


def _enforce_employer_month_cap(cursor, normalized_company):
    if not normalized_company:
        return
    rows = cursor.execute(
        """
        SELECT id, status, priority_tier, fit_score, viability_score, date_posted,
               discovery_suppressed_reason, canonical_job_key, enrichment_status,
               auto_apply_eligible, last_enrichment_error
        FROM jobs
        WHERE normalized_company = ?
        """,
        (normalized_company,),
    ).fetchall()
    history_statuses = {"applied", "canceled", "cancelled"}
    managed_reasons = (None, "", "employer_month_cap", "duplicate_canonical_job")
    identities = {}
    for row in rows:
        key = row["canonical_job_key"] or f"row:{row['id']}"
        identities.setdefault(key, []).append(dict(row))
    representatives = []
    for copies in identities.values():
        # Retain every row and its observations. Only one active representative
        # may consume a slot; history outranks a newly rediscovered copy.
        representative = max(
            copies,
            key=lambda row: (
                str(row["status"] or "").strip().lower() in history_statuses,
                row["last_enrichment_error"] != "job_removed",
                row["discovery_suppressed_reason"] in managed_reasons,
                row["enrichment_status"] in {"done", "done_verified"}
                and bool(row["auto_apply_eligible"]),
                row["enrichment_status"] in {"done", "done_verified"},
                -int(row["id"]),
            ),
        )
        representatives.append(representative)
        for row in copies:
            if row["id"] == representative["id"]:
                if row["discovery_suppressed_reason"] == "duplicate_canonical_job":
                    row["discovery_suppressed_reason"] = None
                    cursor.execute(
                        "UPDATE jobs SET discovery_suppressed_reason = NULL WHERE id = ?",
                        (row["id"],),
                    )
            elif (
                str(row["status"] or "").strip().lower() not in history_statuses
                and row["discovery_suppressed_reason"] in managed_reasons
            ):
                cursor.execute(
                    "UPDATE jobs SET discovery_suppressed_reason = 'duplicate_canonical_job' WHERE id = ?",
                    (row["id"],),
                )

    months = {}
    today = utc_now().date()
    cutoff = today - timedelta(days=30)
    for row in representatives:
        try:
            posted = datetime.fromisoformat(str(row["date_posted"])).date()
        except (TypeError, ValueError):
            posted = None
        if posted is not None and cutoff <= posted <= today:
            months.setdefault(posted.strftime("%Y-%m"), []).append(row)
        elif row["discovery_suppressed_reason"] == "employer_month_cap":
            cursor.execute(
                "UPDATE jobs SET discovery_suppressed_reason = NULL WHERE id = ?",
                (row["id"],),
            )
    tier_score = {"P1": 3, "P2": 2, "P3": 1}
    for monthly_rows in months.values():
        history = [
            row
            for row in monthly_rows
            if str(row["status"] or "").strip().lower() in history_statuses
        ]
        history_ids = {row["id"] for row in history}
        candidates = [
            row
            for row in monthly_rows
            if row["id"] not in history_ids
            and row["discovery_suppressed_reason"] in managed_reasons
            and row["last_enrichment_error"] != "job_removed"
        ]
        slots = max(0, 2 - len(history))
        candidates.sort(
            key=lambda row: (
                tier_score.get(row["priority_tier"], 0),
                int(row["fit_score"] or 0) + int(row["viability_score"] or 0),
                str(row["date_posted"] or ""),
                int(row["id"]),
            ),
            reverse=True,
        )
        for index, row in enumerate(candidates):
            cursor.execute(
                "UPDATE jobs SET discovery_suppressed_reason = ? WHERE id = ?",
                (None if index < slots else "employer_month_cap", row["id"]),
            )


def record_discovery_source_health(source, *, status, lead_count=0, error=None):
    with closing(get_connection()) as conn:
        conn.execute(DISCOVERY_SOURCE_HEALTH_TABLE_SQL)
        conn.execute(
            """
            INSERT INTO discovery_source_health (source, status, lead_count, last_error, checked_at)
            VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(source) DO UPDATE SET
                status = excluded.status,
                lead_count = excluded.lead_count,
                last_error = excluded.last_error,
                checked_at = CURRENT_TIMESTAMP
            """,
            (source, status, int(lead_count or 0), error),
        )
        conn.commit()


def list_discovery_source_health():
    with closing(get_connection()) as conn:
        conn.execute(DISCOVERY_SOURCE_HEALTH_TABLE_SQL)
        rows = conn.execute("SELECT * FROM discovery_source_health ORDER BY source").fetchall()
        return [dict(row) for row in rows]


def upsert_company_fetch_queue(company, career_site, fetch_method):
    # Each configured search label owns a board; job aliases still share employer limits.
    normalized = normalize_text(company)
    if not normalized or not career_site:
        return
    with closing(get_connection()) as conn:
        legacy_key = normalize_company(company)
        legacy_row = conn.execute(
            "SELECT company FROM company_fetch_queue WHERE normalized_company = ?", (legacy_key,)
        ).fetchone()
        legacy_label = normalize_text(legacy_row["company"]) if legacy_row else legacy_key
        if legacy_key != legacy_label:
            conn.execute(
                """UPDATE company_fetch_queue SET normalized_company = ?
                   WHERE normalized_company = ? AND company = ?
                     AND NOT EXISTS (SELECT 1 FROM company_fetch_queue WHERE normalized_company = ?)""",
                (legacy_label, legacy_key, legacy_row["company"], legacy_label),
            )
        conn.execute(
            """
            INSERT INTO company_fetch_queue (
                normalized_company, company, career_site, fetch_method, state
            ) VALUES (?, ?, ?, ?, 'pending')
            ON CONFLICT(normalized_company) DO UPDATE SET
                company = excluded.company,
                career_site = excluded.career_site,
                resolved_url = CASE WHEN company_fetch_queue.career_site = excluded.career_site
                    THEN company_fetch_queue.resolved_url ELSE NULL END,
                fetch_method = CASE
                    WHEN (excluded.fetch_method = 'manual' OR company_fetch_queue.resolved_url IS NOT NULL)
                     AND company_fetch_queue.career_site = excluded.career_site
                    THEN company_fetch_queue.fetch_method ELSE excluded.fetch_method END,
                state = CASE WHEN company_fetch_queue.career_site = excluded.career_site
                    THEN company_fetch_queue.state ELSE 'pending' END,
                lead_count = CASE WHEN company_fetch_queue.career_site = excluded.career_site
                    THEN company_fetch_queue.lead_count ELSE 0 END,
                last_error = CASE WHEN company_fetch_queue.career_site = excluded.career_site
                    THEN company_fetch_queue.last_error ELSE NULL END,
                last_checked_at = CASE WHEN company_fetch_queue.career_site = excluded.career_site
                    THEN company_fetch_queue.last_checked_at ELSE NULL END,
                updated_at = CURRENT_TIMESTAMP
            """,
            (normalized, company, career_site, fetch_method),
        )
        conn.commit()
        return dict(
            conn.execute(
                "SELECT * FROM company_fetch_queue WHERE normalized_company = ?", (normalized,)
            ).fetchone()
        )


def record_company_fetch_result(
    company, *, state, lead_count=0, error=None, fetch_method=None, resolved_url=None, coverage=None
):
    with closing(get_connection()) as conn:
        conn.execute(
            """
            UPDATE company_fetch_queue
            SET state = ?, lead_count = ?, last_error = ?, coverage = ?,
                fetch_method = coalesce(?, fetch_method),
                resolved_url = CASE WHEN ? = 'manual' THEN NULL ELSE coalesce(?, resolved_url) END,
                last_checked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
            WHERE normalized_company = ?
            """,
            (
                state,
                int(lead_count or 0),
                error,
                json.dumps(coverage) if coverage is not None else None,
                fetch_method,
                fetch_method,
                resolved_url,
                normalize_text(company),
            ),
        )
        conn.commit()


def list_company_fetch_queue():
    with closing(get_connection()) as conn:
        rows = conn.execute(
            """
            SELECT * FROM company_fetch_queue
            ORDER BY CASE state WHEN 'pending' THEN 0 WHEN 'failed' THEN 1 ELSE 2 END,
                     coalesce(last_checked_at, ''), normalized_company
            """
        ).fetchall()
        return [
            {**dict(row), "coverage": json.loads(row["coverage"]) if row["coverage"] else None}
            for row in rows
        ]


def add_job(job_data):
    job_data = annotate_job(job_data)
    with closing(get_connection()) as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT * FROM jobs
            WHERE job_url = ?
               OR (? != '' AND canonical_job_key = ?)
            ORDER BY CASE WHEN job_url = ? THEN 0 ELSE 1 END, id
            LIMIT 1
            """,
            (
                job_data.get("job_url"),
                job_data.get("canonical_job_key") or "",
                job_data.get("canonical_job_key") or "",
                job_data.get("job_url"),
            ),
        )
        existing_row = cursor.fetchone()

        if (
            not existing_row
            and job_data.get("normalized_company")
            and job_data.get("canonical_job_key")
        ):
            # ponytail: scan one employer's retained URLs; index aliases only if this becomes costly.
            observed = cursor.execute(
                """SELECT j.id, j.company, j.job_url, o.source_url
                   FROM jobs j LEFT JOIN job_source_observations o ON o.job_id = j.id
                   WHERE j.normalized_company = ? ORDER BY j.id""",
                (job_data["normalized_company"],),
            ).fetchall()
            for row in observed:
                if job_data["canonical_job_key"] in {
                    canonical_job_key(row["job_url"], row["company"]),
                    canonical_job_key(row["source_url"], row["company"]),
                }:
                    existing_row = cursor.execute(
                        "SELECT * FROM jobs WHERE id = ?", (row["id"],)
                    ).fetchone()
                    break

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
            job_id = cursor.lastrowid
            cursor.execute(
                "UPDATE jobs SET discovery_policy_version = ? WHERE id = ?",
                (DISCOVERY_POLICY_VERSION, job_id),
            )
            _record_source_observation(cursor, job_id, job_data)
            _enforce_employer_month_cap(cursor, job_data.get("normalized_company"))
            conn.commit()
            return "inserted", job_id

        existing = dict(existing_row)
        updates = {}

        # A later board observation gives a blocked public lead a supported worker.
        if (
            existing.get("source") not in {"linkedin", "indeed"}
            and job_data.get("source") in {"linkedin", "indeed"}
            and existing.get("enrichment_status") not in {"done", "done_verified"}
        ):
            updates.update(
                source=job_data["source"],
                job_url=job_data["job_url"],
                apply_type="unknown",
                auto_apply_eligible=None,
                enrichment_status="pending",
                enrichment_attempts=0,
                last_enrichment_error=None,
            )

        for field_name in (
            "company",
            "location",
            "description",
            "date_posted",
            "category",
            "employment_type",
        ):
            if _should_upgrade_text(existing.get(field_name), job_data.get(field_name)):
                updates[field_name] = job_data.get(field_name)

        if existing.get("is_remote") is None and job_data.get("is_remote") is not None:
            updates["is_remote"] = job_data.get("is_remote")

        if _should_upgrade_unknown(existing.get("level"), job_data.get("level")):
            updates["level"] = job_data.get("level")

        if int(existing.get("priority") or 0) == 0 and int(job_data.get("priority") or 0) == 1:
            updates["priority"] = True

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

        merged = annotate_job({**existing, **updates})
        for field_name in (
            "category",
            "canonical_job_key",
            "normalized_company",
            "career_stage",
            "priority_tier",
            "fit_score",
            "viability_score",
            "discovery_suppressed_reason",
        ):
            if existing.get(field_name) != merged.get(field_name):
                updates[field_name] = merged.get(field_name)

        _record_source_observation(cursor, existing["id"], job_data)

        if not updates:
            _enforce_employer_month_cap(
                cursor,
                job_data.get("normalized_company") or existing.get("normalized_company"),
            )
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
        _enforce_employer_month_cap(
            cursor,
            job_data.get("normalized_company") or existing.get("normalized_company"),
        )
        conn.commit()
        return "updated", existing["id"], "priority" in updates


def get_all_jobs():
    with closing(get_connection()) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM jobs")
        return [dict(row) for row in cursor.fetchall()]


def get_job_by_id(job_id):
    with closing(get_connection()) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM jobs WHERE id = ?", (job_id,))
        row = cursor.fetchone()
        return dict(row) if row else None


def _job_is_c3_ready(job):
    return bool(
        job
        and str(job.get("status") or "").strip().lower() not in {"applied", "canceled", "cancelled"}
        and job.get("apply_type") == "external_apply"
        and job.get("enrichment_status") in {"done", "done_verified"}
        and int(job.get("priority") or 0) == 0
        and bool(job.get("auto_apply_eligible"))
        and job.get("apply_url")
        and not looks_like_linkedin_url(job.get("apply_url"))
        and job.get("ats_type") == "workday"
        and bool(job.get("selected_resume_ready_for_c3"))
        and job.get("selected_resume_pdf_path")
        and not job.get("discovery_suppressed_reason")
    )


def list_c3_ready_jobs(*, limit=50):
    with closing(get_connection()) as conn:
        rows = conn.execute(
            """
            SELECT * FROM jobs
            WHERE apply_type = 'external_apply'
              AND lower(trim(coalesce(status, ''))) NOT IN ('applied', 'canceled', 'cancelled')
              AND enrichment_status IN ('done', 'done_verified')
              AND coalesce(priority, FALSE) = FALSE
              AND ats_type = 'workday'
              AND auto_apply_eligible IS TRUE
              AND selected_resume_ready_for_c3 IS TRUE
              AND selected_resume_pdf_path IS NOT NULL
              AND trim(selected_resume_pdf_path) != ''
              AND apply_url IS NOT NULL
              AND trim(apply_url) != ''
              AND coalesce(discovery_suppressed_reason, '') = ''
            ORDER BY priority DESC, fit_score DESC, viability_score DESC,
                     date_posted DESC, id DESC
            LIMIT ?
            """,
            (max(1, min(int(limit), 500)),),
        ).fetchall()
        return [dict(row) for row in rows if not looks_like_linkedin_url(row["apply_url"])]


def record_c3_outcome(job_id, *, outcome, reason=None):
    allowed = {"ready_for_review", "blocked", "failed", "cancelled"}
    if outcome not in allowed:
        raise ValueError("unsupported C3 outcome")
    if reason is not None and (len(reason) > 120 or not re.fullmatch(r"[a-z0-9_.:-]+", reason)):
        raise ValueError("reason must be a short factual code")
    with closing(get_connection()) as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            UPDATE jobs
            SET c3_outcome = ?, c3_outcome_reason = ?, c3_observed_at = CURRENT_TIMESTAMP
            WHERE id = ?
            """,
            (outcome, reason, job_id),
        )
        conn.commit()
        return cursor.rowcount


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
        "c3_ready": _job_is_c3_ready(job),
        "c3_outcome": job.get("c3_outcome") or "",
        "c3_outcome_reason": job.get("c3_outcome_reason") or "",
        "c3_observed_at": job.get("c3_observed_at") or "",
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
    with closing(get_connection()) as conn:
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
        updated = cursor.rowcount
        conn.commit()
        return updated


def search_jobs(query):
    with closing(get_connection()) as conn:
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


def update_job_status(job_id, status):
    with closing(get_connection()) as conn:
        cursor = conn.cursor()
        cursor.execute("UPDATE jobs SET status = ? WHERE id = ?", (status, job_id))
        updated = cursor.rowcount
        if updated:
            row = cursor.execute(
                "SELECT normalized_company FROM jobs WHERE id = ?", (job_id,)
            ).fetchone()
            _enforce_employer_month_cap(cursor, row["normalized_company"])
        conn.commit()
        return updated
