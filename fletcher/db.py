from __future__ import annotations

import hashlib
import json
import sqlite3
import uuid
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
    "latest_resume_jd_usable": "INTEGER",
    "latest_resume_jd_usable_reason": "TEXT",
}

# Added to existing resume_attempts via ALTER (older DBs).
RESUME_ATTEMPT_EXTRA_COLUMNS = {
    "jd_usable": "INTEGER",
    "jd_usable_reason": "TEXT",
    "job_description_hash": "TEXT",
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

FLETCHER_JOBS_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS fletcher_jobs (
    queue_item_id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    position INTEGER NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    started_at TEXT,
    finished_at TEXT,
    input_json TEXT NOT NULL,
    progress_json TEXT DEFAULT '{}',
    result_json TEXT DEFAULT '{}',
    error TEXT,
    log_path TEXT,
    review_id TEXT
)
"""


def job_description_fingerprint(description: str | None) -> str:
    """SHA-256 hex of normalized job description (for skip-regeneration checks)."""
    return hashlib.sha256((description or "").strip().encode("utf-8")).hexdigest()


def should_skip_resume_regeneration(
    conn: sqlite3.Connection, *, job_id: int, description: str | None
) -> bool:
    """True when the model already marked this exact JD text as unusable (do not auto-regenerate)."""
    h = job_description_fingerprint(description)
    row = conn.execute(
        """
        SELECT 1 FROM resume_attempts
        WHERE job_id = ? AND jd_usable = 0 AND job_description_hash = ?
        ORDER BY id DESC
        LIMIT 1
        """,
        (job_id, h),
    ).fetchone()
    return row is not None


def get_connection(db_path: str | Path | None = None):
    from hunter.db_compat import get_connection as _get_connection

    return _get_connection(db_path or get_db_path())


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
        cursor.execute(FLETCHER_JOBS_TABLE_SQL)
        ra_existing = {row[1] for row in cursor.execute("PRAGMA table_info(resume_attempts)")}
        for column_name, column_def in RESUME_ATTEMPT_EXTRA_COLUMNS.items():
            if column_name not in ra_existing:
                cursor.execute(f"ALTER TABLE resume_attempts ADD COLUMN {column_name} {column_def}")
        conn.commit()
    finally:
        conn.close()


def init_fletcher_queue_db(db_path: str | Path | None = None) -> None:
    conn = get_connection(db_path)
    try:
        conn.execute(FLETCHER_JOBS_TABLE_SQL)
        conn.commit()
    finally:
        conn.close()


def _decode_json(value: str | None, default):
    if not value:
        return default
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return default


def _job_row(row) -> dict:
    data = dict(row)
    data["input"] = _decode_json(data.pop("input_json", None), {})
    data["progress"] = _decode_json(data.pop("progress_json", None), {})
    data["result"] = _decode_json(data.pop("result_json", None), {})
    return data


def enqueue_fletcher_job(payload: dict, db_path: str | Path | None = None) -> dict:
    init_fletcher_queue_db(db_path)
    conn = get_connection(db_path)
    try:
        row = conn.execute(
            "SELECT COALESCE(MAX(position), 0) AS max_position FROM fletcher_jobs WHERE status = ?",
            ("queued",),
        ).fetchone()
        position = int(row["max_position"] if row else 0) + 1
        queue_item_id = uuid.uuid4().hex
        conn.execute(
            """
            INSERT INTO fletcher_jobs (
                queue_item_id, status, position, input_json, progress_json, result_json
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                queue_item_id,
                "queued",
                position,
                json.dumps(payload),
                json.dumps({"current_step": "queued", "event_id": 0, "log_tail": []}),
                json.dumps({"review_id": None, "pdf_url": None, "log_url": None}),
            ),
        )
        conn.commit()
        return get_fletcher_job(queue_item_id, db_path=db_path)
    finally:
        conn.close()


def list_fletcher_jobs(db_path: str | Path | None = None, limit: int = 50) -> list[dict]:
    init_fletcher_queue_db(db_path)
    conn = get_connection(db_path)
    try:
        rows = conn.execute(
            """
            SELECT * FROM fletcher_jobs
            ORDER BY
              CASE
                WHEN status = 'running' THEN 0
                WHEN status = 'queued' THEN 1
                WHEN status = 'cancel_requested' THEN 2
                ELSE 3
              END,
              CASE
                WHEN status IN ('running', 'queued', 'cancel_requested') THEN position
                ELSE 0
              END ASC,
              CASE
                WHEN status IN ('running', 'queued', 'cancel_requested') THEN created_at
                ELSE finished_at
              END DESC
            LIMIT ?
            """,
            (max(1, limit),),
        ).fetchall()
        return [_job_row(row) for row in rows]
    finally:
        conn.close()


def get_fletcher_job(queue_item_id: str, db_path: str | Path | None = None) -> dict:
    init_fletcher_queue_db(db_path)
    conn = get_connection(db_path)
    try:
        row = conn.execute(
            "SELECT * FROM fletcher_jobs WHERE queue_item_id = ?",
            (queue_item_id,),
        ).fetchone()
        if not row:
            raise KeyError(queue_item_id)
        return _job_row(row)
    finally:
        conn.close()


def patch_fletcher_job_input(
    queue_item_id: str, payload: dict, db_path: str | Path | None = None
) -> dict:
    job = get_fletcher_job(queue_item_id, db_path=db_path)
    if job["status"] != "queued":
        raise ValueError("Only queued Fletcher jobs can be edited.")
    merged = dict(job["input"])
    merged.update(payload)
    conn = get_connection(db_path)
    try:
        conn.execute(
            "UPDATE fletcher_jobs SET input_json = ?, revision = revision + 1 WHERE queue_item_id = ?",
            (json.dumps(merged), queue_item_id),
        )
        conn.commit()
        return get_fletcher_job(queue_item_id, db_path=db_path)
    finally:
        conn.close()


def move_fletcher_job(
    queue_item_id: str, direction: str, db_path: str | Path | None = None
) -> dict:
    job = get_fletcher_job(queue_item_id, db_path=db_path)
    if job["status"] != "queued":
        raise ValueError("Only queued Fletcher jobs can be reordered.")
    op = "<" if direction == "up" else ">"
    order = "DESC" if direction == "up" else "ASC"
    conn = get_connection(db_path)
    try:
        other = conn.execute(
            f"""
            SELECT queue_item_id, position FROM fletcher_jobs
            WHERE status = ? AND position {op} ?
            ORDER BY position {order}
            LIMIT 1
            """,
            ("queued", job["position"]),
        ).fetchone()
        if other:
            conn.execute(
                "UPDATE fletcher_jobs SET position = ? WHERE queue_item_id = ?",
                (other["position"], queue_item_id),
            )
            conn.execute(
                "UPDATE fletcher_jobs SET position = ? WHERE queue_item_id = ?",
                (job["position"], other["queue_item_id"]),
            )
            conn.commit()
        return get_fletcher_job(queue_item_id, db_path=db_path)
    finally:
        conn.close()


def cancel_fletcher_job(queue_item_id: str, db_path: str | Path | None = None) -> dict:
    job = get_fletcher_job(queue_item_id, db_path=db_path)
    if job["status"] not in {"queued", "running"}:
        return job
    status = "cancelled" if job["status"] == "queued" else "cancel_requested"
    conn = get_connection(db_path)
    try:
        conn.execute(
            "UPDATE fletcher_jobs SET status = ?, finished_at = CURRENT_TIMESTAMP, revision = revision + 1 WHERE queue_item_id = ?",
            (status, queue_item_id),
        )
        conn.commit()
        return get_fletcher_job(queue_item_id, db_path=db_path)
    finally:
        conn.close()


def update_fletcher_job_progress(
    queue_item_id: str,
    progress: dict,
    db_path: str | Path | None = None,
) -> dict:
    job = get_fletcher_job(queue_item_id, db_path=db_path)
    merged = dict(job.get("progress") or {})
    current_percent = merged.get("percent")
    next_percent = progress.get("percent")
    if isinstance(current_percent, int | float) and isinstance(next_percent, int | float):
        progress = dict(progress)
        progress["percent"] = max(current_percent, next_percent)
    merged.update(progress)
    conn = get_connection(db_path)
    try:
        conn.execute(
            """
            UPDATE fletcher_jobs
            SET progress_json = ?, revision = revision + 1
            WHERE queue_item_id = ?
            """,
            (json.dumps(merged), queue_item_id),
        )
        conn.commit()
        return get_fletcher_job(queue_item_id, db_path=db_path)
    finally:
        conn.close()


def delete_fletcher_job(queue_item_id: str, db_path: str | Path | None = None) -> dict:
    job = get_fletcher_job(queue_item_id, db_path=db_path)
    if job["status"] in {"queued", "running", "cancel_requested"}:
        raise ValueError("Only finished Fletcher jobs can be deleted.")
    conn = get_connection(db_path)
    try:
        conn.execute("DELETE FROM fletcher_jobs WHERE queue_item_id = ?", (queue_item_id,))
        conn.commit()
        return job
    finally:
        conn.close()


def claim_next_fletcher_job(db_path: str | Path | None = None) -> dict | None:
    init_fletcher_queue_db(db_path)
    conn = get_connection(db_path)
    try:
        row = conn.execute(
            """
            SELECT * FROM fletcher_jobs
            WHERE status = ?
            ORDER BY position ASC, created_at ASC
            LIMIT 1
            """,
            ("queued",),
        ).fetchone()
        if not row:
            return None
        qid = row["queue_item_id"]
        conn.execute(
            """
            UPDATE fletcher_jobs
            SET status = ?, started_at = CURRENT_TIMESTAMP,
                progress_json = ?, revision = revision + 1
            WHERE queue_item_id = ? AND status = ?
            """,
            (
                "running",
                json.dumps({"current_step": "running", "event_id": 1, "log_tail": []}),
                qid,
                "queued",
            ),
        )
        conn.commit()
        return get_fletcher_job(qid, db_path=db_path)
    finally:
        conn.close()


def finish_fletcher_job(
    queue_item_id: str,
    *,
    status: str,
    result: dict | None = None,
    error: str | None = None,
    log_path: str | None = None,
    review_id: str | None = None,
    db_path: str | Path | None = None,
) -> dict:
    conn = get_connection(db_path)
    try:
        conn.execute(
            """
            UPDATE fletcher_jobs
            SET status = ?, finished_at = CURRENT_TIMESTAMP, result_json = ?,
                error = ?, log_path = ?, review_id = ?, revision = revision + 1
            WHERE queue_item_id = ?
            """,
            (
                status,
                json.dumps(result or {}),
                error,
                log_path,
                review_id,
                queue_item_id,
            ),
        )
        conn.commit()
        return get_fletcher_job(queue_item_id, db_path=db_path)
    finally:
        conn.close()


def set_fletcher_job_log_path(
    queue_item_id: str, log_path: str, db_path: str | Path | None = None
) -> dict:
    conn = get_connection(db_path)
    try:
        conn.execute(
            """
            UPDATE fletcher_jobs
            SET log_path = ?, revision = revision + 1
            WHERE queue_item_id = ?
            """,
            (log_path, queue_item_id),
        )
        conn.commit()
        return get_fletcher_job(queue_item_id, db_path=db_path)
    finally:
        conn.close()


def get_job_context(job_id: int, db_path: str | Path | None = None) -> dict | None:
    conn = get_connection(db_path)
    try:
        row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def record_resume_attempt(
    job_id: int | None, payload: dict, db_path: str | Path | None = None
) -> tuple[int, int]:
    conn = get_connection(db_path)
    try:
        cursor = conn.cursor()
        fallback_used = bool(payload["fallback_used"])
        is_latest_useful = bool(payload["is_latest_useful"])
        is_selected_for_c3 = bool(payload["is_selected_for_c3"])
        jd_sql = payload.get("jd_usable")
        if jd_sql is not None:
            jd_sql = 1 if jd_sql else 0
        cursor.execute(
            """
            INSERT INTO resume_attempts (
                job_id, attempt_type, status, latest_result_kind, role_family, job_level,
                base_resume_name, source_resume_type, source_resume_path, fallback_used,
                model_backend, model_name, prompt_version, concern_flags,
                job_description_path, keywords_path, structured_output_path, tex_path,
                pdf_path, compile_log_path, metadata_path,
                jd_usable, jd_usable_reason, job_description_hash
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                fallback_used,
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
                jd_sql,
                (payload.get("jd_usable_reason") or None),
                (payload.get("job_description_hash") or None),
            ),
        )
        attempt_id = int(cursor.lastrowid)

        job_filter_sql = "job_id IS NULL" if job_id is None else "job_id = ?"
        job_filter_params: tuple[object, ...] = () if job_id is None else (job_id,)

        cursor.execute(
            f"""
            UPDATE resume_versions
            SET is_latest_generated = FALSE
            WHERE {job_filter_sql}
            """,
            job_filter_params,
        )
        if is_latest_useful:
            cursor.execute(
                f"""
                UPDATE resume_versions
                SET is_latest_useful = FALSE
                WHERE {job_filter_sql}
                """,
                job_filter_params,
            )
        if is_selected_for_c3:
            cursor.execute(
                f"""
                UPDATE resume_versions
                SET is_selected_for_c3 = FALSE
                WHERE {job_filter_sql}
                """,
                job_filter_params,
            )
        elif payload.get("clear_existing_selection"):
            cursor.execute(
                f"""
                UPDATE resume_versions
                SET is_selected_for_c3 = FALSE
                WHERE {job_filter_sql}
                """,
                job_filter_params,
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
                True,
                is_latest_useful,
                is_selected_for_c3,
            ),
        )
        version_id = int(cursor.lastrowid)

        jdu_job = payload.get("jd_usable")
        if jdu_job is not None:
            jdu_job = 1 if jdu_job else 0

        if job_id is not None:
            if is_selected_for_c3:
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
                        latest_resume_jd_usable = ?,
                        latest_resume_jd_usable_reason = ?,
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
                        fallback_used,
                        json.dumps(payload["concern_flags"]),
                        jdu_job,
                        (payload.get("jd_usable_reason") or None),
                        version_id,
                        payload["pdf_path"],
                        payload["tex_path"],
                        True,
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
                        latest_resume_jd_usable = ?,
                        latest_resume_jd_usable_reason = ?,
                        selected_resume_version_id = NULL,
                        selected_resume_pdf_path = NULL,
                        selected_resume_tex_path = NULL,
                        selected_resume_selected_at = NULL,
                        selected_resume_ready_for_c3 = FALSE
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
                        fallback_used,
                        json.dumps(payload["concern_flags"]),
                        jdu_job,
                        (payload.get("jd_usable_reason") or None),
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
                        latest_resume_flags = ?,
                        latest_resume_jd_usable = ?,
                        latest_resume_jd_usable_reason = ?
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
                        fallback_used,
                        json.dumps(payload["concern_flags"]),
                        jdu_job,
                        (payload.get("jd_usable_reason") or None),
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
        "latest_resume_flags": json.loads(job["latest_resume_flags"])
        if job.get("latest_resume_flags")
        else [],
        "selected_resume_ready_for_c3": bool(job.get("selected_resume_ready_for_c3")),
    }


def list_jobs_ready_for_resume(
    *,
    db_path: str | Path | None = None,
    limit: int = 25,
    only_missing: bool = False,
) -> list[dict]:
    """Jobs eligible for queue-driven resume generation.

    Skips jobs where the model already recorded **jd_usable=0** for the **same**
    description text (SHA-256 fingerprint), so the timer does not keep
    regenerating when the JD scrape is still useless. If the description changes,
    the job becomes eligible again. Manual ``generate-job <id>`` still works.
    """
    conn = get_connection(db_path)
    try:
        cursor = conn.cursor()
        base_sql = """
            SELECT *
            FROM jobs
            WHERE enrichment_status IN ('done', 'done_verified')
        """
        params: list[object] = []
        if only_missing:
            base_sql += """
              AND (
                    latest_resume_generated_at IS NULL
                 OR trim(coalesce(latest_resume_generated_at, '')) = ''
              )
            """
        base_sql += """
            ORDER BY
                CASE
                    WHEN latest_resume_generated_at IS NULL OR trim(coalesce(latest_resume_generated_at, '')) = '' THEN 0
                    ELSE 1
                END,
                coalesce(enriched_at, date_scraped, CURRENT_TIMESTAMP) DESC,
                id DESC
        """
        want = max(1, limit)
        batch_size = max(50, want * 5)
        max_scan = 5000
        out: list[dict] = []
        offset = 0
        scanned = 0
        while len(out) < want and scanned < max_scan:
            rows = cursor.execute(
                base_sql + " LIMIT ? OFFSET ?",
                tuple(params) + (batch_size, offset),
            ).fetchall()
            if not rows:
                break
            for row in rows:
                scanned += 1
                r = dict(row)
                if should_skip_resume_regeneration(
                    conn, job_id=int(r["id"]), description=r.get("description")
                ):
                    continue
                out.append(r)
                if len(out) >= want:
                    break
            offset += batch_size
        return out
    finally:
        conn.close()


def list_resume_attempts(
    job_id: int, db_path: str | Path | None = None, *, limit: int = 10
) -> list[dict]:
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
