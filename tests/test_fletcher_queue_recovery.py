from __future__ import annotations

import os
import tempfile
from pathlib import Path


def test_fletcher_recovery_requeues_interrupted_running_job(monkeypatch):
    fd, raw_path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    db_path = Path(raw_path)
    monkeypatch.setenv("HUNT_DB_PATH", str(db_path))

    try:
        from fletcher.db import (
            claim_next_fletcher_job,
            enqueue_fletcher_job,
            recover_interrupted_fletcher_jobs,
        )

        item = enqueue_fletcher_job(
            {"title": "Azure Full Stack Developer", "description": "Build APIs."},
            db_path=db_path,
        )
        claimed = claim_next_fletcher_job(db_path=db_path)
        assert claimed is not None
        assert claimed["queue_item_id"] == item["queue_item_id"]
        assert claimed["status"] == "running"

        recovered = recover_interrupted_fletcher_jobs(db_path=db_path)

        assert [row["queue_item_id"] for row in recovered] == [item["queue_item_id"]]
        assert recovered[0]["status"] == "queued"
        assert recovered[0]["started_at"] is None
        assert recovered[0]["progress"]["current_step"] == "requeued_after_worker_restart"
        assert recovered[0]["progress"]["previous_step"] == "running"

        reclaimed = claim_next_fletcher_job(db_path=db_path)
        assert reclaimed is not None
        assert reclaimed["queue_item_id"] == item["queue_item_id"]
        assert reclaimed["status"] == "running"
    finally:
        db_path.unlink(missing_ok=True)


def test_fletcher_queue_result_records_job_resume_attempt(monkeypatch, tmp_path):
    db_path = tmp_path / "hunt.db"
    runtime_root = tmp_path / "runtime"
    monkeypatch.setenv("HUNT_DB_PATH", str(db_path))
    monkeypatch.setenv("HUNT_RESUME_ARTIFACTS_DIR", str(runtime_root))

    from fletcher.db import get_connection, init_resume_db, record_fletcher_queue_resume_attempt

    init_resume_db(db_path=db_path)
    conn = get_connection(db_path)
    try:
        existing = {row[1] for row in conn.execute("PRAGMA table_info(jobs)")}
        for column, definition in {
            "title": "TEXT",
            "company": "TEXT",
            "description": "TEXT",
            "source": "TEXT",
            "enrichment_status": "TEXT",
            "job_url": "TEXT",
            "apply_type": "TEXT",
            "apply_url": "TEXT",
            "auto_apply_eligible": "INTEGER",
            "priority": "INTEGER",
        }.items():
            if column not in existing:
                conn.execute(f"ALTER TABLE jobs ADD COLUMN {column} {definition}")
        conn.execute(
            """
            INSERT INTO jobs (
                id, title, company, description, source, enrichment_status, job_url,
                apply_type, apply_url, auto_apply_eligible, priority
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                14350,
                "Machine Learning Engineer",
                "Jobright.ai",
                "Build ML systems.",
                "linkedin",
                "done",
                "https://example.com/jobs/14350",
                "external_apply",
                "https://jobright.ai/apply",
                1,
                0,
            ),
        )
        conn.commit()
    finally:
        conn.close()

    attempt_dir = runtime_root / "ad_hoc" / "queue-result"
    attempt_dir.mkdir(parents=True)
    source_path = attempt_dir / "selected_master_tmp.tex"
    tex_path = attempt_dir / "output.tex"
    pdf_path = attempt_dir / "output.pdf"
    log_path = attempt_dir / "pipeline_log.txt"
    source_path.write_text("source resume", encoding="utf-8")
    tex_path.write_text("generated resume", encoding="utf-8")
    pdf_path.write_bytes(b"%PDF-1.4 generated")
    log_path.write_text("ok", encoding="utf-8")

    recorded = record_fletcher_queue_resume_attempt(
        job_id=14350,
        result={
            "attempt_dir": str(attempt_dir),
            "tex_path": str(tex_path),
            "pdf_path": str(pdf_path),
            "log_path": str(log_path),
            "compile_status": "ok",
            "fits_one_page": True,
            "role_family": "software",
            "job_level": "junior",
            "review_id": "review-14350",
        },
        source_resume_path=source_path,
        queue_item_id="queue-14350",
        selection_report={"experience": ["exp1"]},
        model_backend="ollama",
        model_name="gemma4:e4b",
        db_path=db_path,
    )

    assert recorded == (1, 1)
    conn = get_connection(db_path)
    try:
        attempt = conn.execute("SELECT * FROM resume_attempts WHERE job_id = ?", (14350,)).fetchone()
        assert attempt is not None
        assert attempt["pdf_path"] == str(pdf_path)
        assert Path(attempt["source_resume_path"]).name == "selected_master_source.tex"
        version = conn.execute(
            "SELECT * FROM resume_versions WHERE resume_attempt_id = ?", (recorded[0],)
        ).fetchone()
        assert version is not None
        assert bool(version["is_selected_for_c3"])
        job = conn.execute("SELECT * FROM jobs WHERE id = ?", (14350,)).fetchone()
        assert job["latest_resume_attempt_id"] == recorded[0]
        assert job["selected_resume_pdf_path"] == str(pdf_path)
        assert bool(job["selected_resume_ready_for_c3"])
    finally:
        conn.close()


def test_backfills_completed_queue_job_without_resume_attempt(monkeypatch, tmp_path):
    db_path = tmp_path / "hunt.db"
    runtime_root = tmp_path / "runtime"
    monkeypatch.setenv("HUNT_DB_PATH", str(db_path))
    monkeypatch.setenv("HUNT_RESUME_ARTIFACTS_DIR", str(runtime_root))

    import fletcher.resume.review_store as review_store
    from fletcher.db import (
        backfill_completed_fletcher_queue_resume_attempts,
        enqueue_fletcher_job,
        finish_fletcher_job,
        get_connection,
        init_resume_db,
    )

    init_resume_db(db_path=db_path)
    conn = get_connection(db_path)
    try:
        existing = {row[1] for row in conn.execute("PRAGMA table_info(jobs)")}
        for column, definition in {
            "title": "TEXT",
            "company": "TEXT",
            "description": "TEXT",
            "source": "TEXT",
            "enrichment_status": "TEXT",
            "job_url": "TEXT",
            "apply_type": "TEXT",
            "apply_url": "TEXT",
            "auto_apply_eligible": "INTEGER",
            "priority": "INTEGER",
        }.items():
            if column not in existing:
                conn.execute(f"ALTER TABLE jobs ADD COLUMN {column} {definition}")
        conn.execute(
            """
            INSERT INTO jobs (
                id, title, company, description, source, enrichment_status, job_url,
                apply_type, apply_url, auto_apply_eligible, priority
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                14351,
                "Backend Engineer",
                "Acme",
                "Build APIs.",
                "linkedin",
                "done",
                "https://example.com/jobs/14351",
                "external_apply",
                "https://example.com/apply",
                1,
                0,
            ),
        )
        conn.commit()
    finally:
        conn.close()

    item = enqueue_fletcher_job({"job_id": 14351}, db_path=db_path)
    attempt_dir = runtime_root / "ad_hoc" / "old-queue-result"
    attempt_dir.mkdir(parents=True)
    tex_path = attempt_dir / "output.tex"
    pdf_path = attempt_dir / "output.pdf"
    tex_path.write_text("generated resume", encoding="utf-8")
    pdf_path.write_bytes(b"%PDF-1.4 generated")
    finish_fletcher_job(
        item["queue_item_id"],
        status="succeeded",
        result={"review_id": "review-old", "compile_status": "ok", "fits_one_page": True},
        log_path=str(attempt_dir / "pipeline_log.txt"),
        review_id="review-old",
        db_path=db_path,
    )
    monkeypatch.setattr(review_store, "attempt_dir_for_review", lambda _review_id: attempt_dir)
    monkeypatch.setattr(
        review_store,
        "artifact_path_for_review",
        lambda _review_id, _version, artifact_kind: pdf_path
        if artifact_kind == "pdf"
        else tex_path,
    )

    backfilled = backfill_completed_fletcher_queue_resume_attempts(db_path=db_path)

    assert [(row[0], row[1], row[2]) for row in backfilled] == [(item["queue_item_id"], 1, 1)]
    conn = get_connection(db_path)
    try:
        queue_row = conn.execute(
            "SELECT result_json FROM fletcher_jobs WHERE queue_item_id = ?",
            (item["queue_item_id"],),
        ).fetchone()
        assert '"attempt_id": 1' in queue_row["result_json"]
        assert conn.execute("SELECT COUNT(*) FROM resume_attempts").fetchone()[0] == 1
        job = conn.execute("SELECT * FROM jobs WHERE id = ?", (14351,)).fetchone()
        assert job["latest_resume_attempt_id"] == 1
        assert job["selected_resume_pdf_path"] == str(pdf_path)
    finally:
        conn.close()
