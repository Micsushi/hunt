from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from .config import get_db_path


JOB_COLUMNS = {
    "resume_status": "TEXT",
    "latest_resume_attempt_id": "INTEGER",
    "latest_resume_version_id": "TEXT",
    "latest_resume_pdf_path": "TEXT",
    "latest_resume_tex_path": "TEXT",
    "latest_resume_keywords_path": "TEXT",
    "latest_resume_job_description_path": "TEXT",
    "latest_resume_family": "TEXT",
    "latest_resume_job_level": "TEXT",
    "latest_resume_model": "TEXT",
    "latest_resume_generated_at": "TEXT",
    "latest_resume_fallback_used": "BOOLEAN",
    "latest_resume_flags": "TEXT",
    "selected_resume_version_id": "TEXT",
    "selected_resume_pdf_path": "TEXT",
    "selected_resume_tex_path": "TEXT",
    "selected_resume_selected_at": "TEXT",
    "selected_resume_ready_for_c3": "BOOLEAN",
}

RESUME_ATTEMPTS_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS resume_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER,
    attempt_type TEXT,
    status TEXT,
    latest_result_kind TEXT,
    role_family TEXT,
    job_level TEXT,
    base_resume_name TEXT,
    source_resume_type TEXT,
    source_resume_path TEXT,
    fallback_used BOOLEAN,
    model_backend TEXT,
    model_name TEXT,
    prompt_version TEXT,
    concern_flags TEXT,
    job_description_path TEXT,
    keywords_path TEXT,
    structured_output_path TEXT,
    tex_path TEXT,
    pdf_path TEXT,
    compile_log_path TEXT,
    metadata_path TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
)
"""

RESUME_VERSIONS_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS resume_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER,
    resume_attempt_id INTEGER NOT NULL,
    source_type TEXT,
    label TEXT,
    pdf_path TEXT,
    tex_path TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    is_latest_generated BOOLEAN DEFAULT 0,
    is_latest_useful BOOLEAN DEFAULT 0,
    is_selected_for_c3 BOOLEAN DEFAULT 0
)
"""


def get_connection(db_path: str | Path | None = None) -> sqlite3.Connection:
    path = Path(db_path or get_db_path())
    conn = sqlite3.connect(path, timeout=30.0)
    conn.row_factory = sqlite3.Row
    return conn


def init_resume_db(db_path: str | Path | None = None) -> None:
    conn = get_connection(db_path)
    try:
        cursor = conn.cursor()
        cursor.execute("CREATE TABLE IF NOT EXISTS jobs (id INTEGER PRIMARY KEY AUTOINCREMENT)")
        existing = {row[1] for row in cursor.execute("PRAGMA table_info(jobs)")}
        for column_name, column_def in JOB_COLUMNS.items():
            if column_name not in existing:
                cursor.execute(f"ALTER TABLE jobs ADD COLUMN {column_name} {column_def}")
        cursor.execute(RESUME_ATTEMPTS_TABLE_SQL)
        cursor.execute(RESUME_VERSIONS_TABLE_SQL)
        conn.commit()
    finally:
        conn.close()


def get_job_context(job_id: int, db_path: str | Path | None = None) -> dict | None:
    conn = get_connection(db_path)
    try:
        row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def record_resume_attempt(job_id: int | None, payload: dict, db_path: str | Path | None = None) -> tuple[int, int]:
    conn = get_connection(db_path)
    try:
        cursor = conn.cursor()
        cursor.execute(
            """
            INSERT INTO resume_attempts (
                job_id, attempt_type, status, latest_result_kind, role_family, job_level,
                base_resume_name, source_resume_type, source_resume_path, fallback_used,
                model_backend, model_name, prompt_version, concern_flags,
                job_description_path, keywords_path, structured_output_path, tex_path,
                pdf_path, compile_log_path, metadata_path
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                job_id,
                payload["attempt_type"],
                payload["status"],
                payload["latest_result_kind"],
                payload["role_family"],
                payload["job_level"],
                payload["base_resume_name"],
                payload["source_resume_type"],
                payload["source_resume_path"],
                int(payload["fallback_used"]),
                payload["model_backend"],
                payload["model_name"],
                payload["prompt_version"],
                json.dumps(payload["concern_flags"]),
                payload["job_description_path"],
                payload["keywords_path"],
                payload["structured_output_path"],
                payload["tex_path"],
                payload["pdf_path"],
                payload["compile_log_path"],
                payload["metadata_path"],
            ),
        )
        attempt_id = int(cursor.lastrowid)

        cursor.execute(
            """
            UPDATE resume_versions
            SET is_latest_generated = 0
            WHERE job_id IS ?
            """,
            (job_id,),
        )
        if payload["is_latest_useful"]:
            cursor.execute(
                """
                UPDATE resume_versions
                SET is_latest_useful = 0
                WHERE job_id IS ?
                """,
                (job_id,),
            )
        if payload["is_selected_for_c3"]:
            cursor.execute(
                """
                UPDATE resume_versions
                SET is_selected_for_c3 = 0
                WHERE job_id IS ?
                """,
                (job_id,),
            )
        elif payload.get("clear_existing_selection"):
            cursor.execute(
                """
                UPDATE resume_versions
                SET is_selected_for_c3 = 0
                WHERE job_id IS ?
                """,
                (job_id,),
            )
        cursor.execute(
            """
            INSERT INTO resume_versions (
                job_id, resume_attempt_id, source_type, label, pdf_path, tex_path,
                content_hash, is_latest_generated, is_latest_useful, is_selected_for_c3
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                job_id,
                attempt_id,
                payload["source_resume_type"],
                payload["base_resume_name"],
                payload["pdf_path"],
                payload["tex_path"],
                payload["content_hash"],
                1,
                int(payload["is_latest_useful"]),
                int(payload["is_selected_for_c3"]),
            ),
        )
        version_id = int(cursor.lastrowid)

        if job_id is not None:
            if payload["is_selected_for_c3"]:
                cursor.execute(
                    """
                    UPDATE jobs
                    SET resume_status = ?,
                        latest_resume_attempt_id = ?,
                        latest_resume_version_id = ?,
                        latest_resume_pdf_path = ?,
                        latest_resume_tex_path = ?,
                        latest_resume_keywords_path = ?,
                        latest_resume_job_description_path = ?,
                        latest_resume_family = ?,
                        latest_resume_job_level = ?,
                        latest_resume_model = ?,
                        latest_resume_generated_at = CURRENT_TIMESTAMP,
                        latest_resume_fallback_used = ?,
                        latest_resume_flags = ?,
                        selected_resume_version_id = ?,
                        selected_resume_pdf_path = ?,
                        selected_resume_tex_path = ?,
                        selected_resume_selected_at = CURRENT_TIMESTAMP,
                        selected_resume_ready_for_c3 = ?
                    WHERE id = ?
                    """,
                    (
                        payload["status"],
                        attempt_id,
                        version_id,
                        payload["pdf_path"],
                        payload["tex_path"],
                        payload["keywords_path"],
                        payload["job_description_path"],
                        payload["role_family"],
                        payload["job_level"],
                        payload["model_name"],
                        int(payload["fallback_used"]),
                        json.dumps(payload["concern_flags"]),
                        version_id,
                        payload["pdf_path"],
                        payload["tex_path"],
                        1,
                        job_id,
                    ),
                )
            elif payload.get("clear_existing_selection"):
                cursor.execute(
                    """
                    UPDATE jobs
                    SET resume_status = ?,
                        latest_resume_attempt_id = ?,
                        latest_resume_version_id = ?,
                        latest_resume_pdf_path = ?,
                        latest_resume_tex_path = ?,
                        latest_resume_keywords_path = ?,
                        latest_resume_job_description_path = ?,
                        latest_resume_family = ?,
                        latest_resume_job_level = ?,
                        latest_resume_model = ?,
                        latest_resume_generated_at = CURRENT_TIMESTAMP,
                        latest_resume_fallback_used = ?,
                        latest_resume_flags = ?,
                        selected_resume_version_id = NULL,
                        selected_resume_pdf_path = NULL,
                        selected_resume_tex_path = NULL,
                        selected_resume_selected_at = NULL,
                        selected_resume_ready_for_c3 = 0
                    WHERE id = ?
                    """,
                    (
                        payload["status"],
                        attempt_id,
                        version_id,
                        payload["pdf_path"],
                        payload["tex_path"],
                        payload["keywords_path"],
                        payload["job_description_path"],
                        payload["role_family"],
                        payload["job_level"],
                        payload["model_name"],
                        int(payload["fallback_used"]),
                        json.dumps(payload["concern_flags"]),
                        job_id,
                    ),
                )
            else:
                cursor.execute(
                    """
                    UPDATE jobs
                    SET resume_status = ?,
                        latest_resume_attempt_id = ?,
                        latest_resume_version_id = ?,
                        latest_resume_pdf_path = ?,
                        latest_resume_tex_path = ?,
                        latest_resume_keywords_path = ?,
                        latest_resume_job_description_path = ?,
                        latest_resume_family = ?,
                        latest_resume_job_level = ?,
                        latest_resume_model = ?,
                        latest_resume_generated_at = CURRENT_TIMESTAMP,
                        latest_resume_fallback_used = ?,
                        latest_resume_flags = ?
                    WHERE id = ?
                    """,
                    (
                        payload["status"],
                        attempt_id,
                        version_id,
                        payload["pdf_path"],
                        payload["tex_path"],
                        payload["keywords_path"],
                        payload["job_description_path"],
                        payload["role_family"],
                        payload["job_level"],
                        payload["model_name"],
                        int(payload["fallback_used"]),
                        json.dumps(payload["concern_flags"]),
                        job_id,
                    ),
                )

        conn.commit()
        return attempt_id, version_id
    finally:
        conn.close()


def get_apply_context(job_id: int, db_path: str | Path | None = None) -> dict | None:
    job = get_job_context(job_id, db_path)
    if not job:
        return None
    return {
        "job_id": job["id"],
        "title": job.get("title"),
        "company": job.get("company"),
        "apply_url": job.get("apply_url"),
        "ats_type": job.get("ats_type"),
        "selected_resume_version_id": job.get("selected_resume_version_id"),
        "selected_resume_pdf_path": job.get("selected_resume_pdf_path"),
        "selected_resume_tex_path": job.get("selected_resume_tex_path"),
        "latest_resume_attempt_id": job.get("latest_resume_attempt_id"),
        "latest_resume_job_description_path": job.get("latest_resume_job_description_path"),
        "latest_resume_flags": json.loads(job["latest_resume_flags"]) if job.get("latest_resume_flags") else [],
        "selected_resume_ready_for_c3": bool(job.get("selected_resume_ready_for_c3")),
    }


def list_jobs_ready_for_resume(
    *,
    db_path: str | Path | None = None,
    limit: int = 25,
    only_missing: bool = False,
) -> list[dict]:
    conn = get_connection(db_path)
    try:
        cursor = conn.cursor()
        sql = """
            SELECT *
            FROM jobs
            WHERE enrichment_status IN ('done', 'done_verified')
        """
        params: list[object] = []
        if only_missing:
            sql += """
              AND (
                    latest_resume_generated_at IS NULL
                 OR trim(coalesce(latest_resume_generated_at, '')) = ''
              )
            """
        sql += """
            ORDER BY
                CASE
                    WHEN latest_resume_generated_at IS NULL OR trim(coalesce(latest_resume_generated_at, '')) = '' THEN 0
                    ELSE 1
                END,
                coalesce(enriched_at, date_scraped, CURRENT_TIMESTAMP) DESC,
                id DESC
            LIMIT ?
        """
        params.append(max(1, limit))
        return [dict(row) for row in cursor.execute(sql, tuple(params)).fetchall()]
    finally:
        conn.close()


def list_resume_attempts(job_id: int, db_path: str | Path | None = None, *, limit: int = 10) -> list[dict]:
    conn = get_connection(db_path)
    try:
        try:
            rows = conn.execute(
                """
                SELECT *
                FROM resume_attempts
                WHERE job_id = ?
                ORDER BY created_at DESC, id DESC
                LIMIT ?
                """,
                (job_id, max(1, limit)),
            ).fetchall()
        except sqlite3.OperationalError:
            return []
        return [dict(row) for row in rows]
    finally:
        conn.close()
