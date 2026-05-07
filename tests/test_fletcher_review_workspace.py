from __future__ import annotations

from fletcher.config import resolve_base_resume_path
from fletcher.db import (
    cancel_fletcher_job,
    claim_next_fletcher_job,
    delete_fletcher_job,
    enqueue_fletcher_job,
    finish_fletcher_job,
    get_connection,
    get_fletcher_job,
    init_fletcher_queue_db,
    list_fletcher_jobs,
    move_fletcher_job,
    patch_fletcher_job_input,
    update_fletcher_job_progress,
)
from fletcher.llm.client import configured_provider_name, get_provider
from fletcher.resume.models import (
    EducationEntry,
    EducationSection,
    ExperienceEntry,
    ProjectEntry,
    ResumeDocument,
    ResumeHeader,
    SkillsSection,
)
from fletcher.resume.renderer import render_resume_tex
from fletcher.resume.review_from_attempt import create_review_package_from_attempt
from fletcher.resume.review_models import (
    ResumeReviewVersionName,
    build_review_id,
    document_to_review_blocks,
)
from fletcher.resume.review_store import register_review
from fletcher.storage import build_attempt_dir


def _doc() -> ResumeDocument:
    return ResumeDocument(
        source_path="<test>",
        preamble="",
        header=ResumeHeader(name="Michael Shi", contact_line="email | github"),
        summary="Backend developer.",
        education=EducationSection(
            entry=EducationEntry(
                entry_id="edu_primary",
                institution_and_degree="University",
                date_text="2026",
            ),
            bullets=[],
        ),
        experience=[
            ExperienceEntry(
                entry_id="exp_acme",
                title_company_location="Developer, Acme",
                date_text="2024 - 2025",
                bullets=["Built APIs."],
            )
        ],
        projects=[
            ProjectEntry(
                entry_id="proj_demo",
                project_title="Demo",
                date_or_link_text="github",
                bullets=["Built a demo."],
            )
        ],
        skills=SkillsSection(languages=["Python"], frameworks=["FastAPI"], developer_tools=["Git"]),
    )


def test_document_to_review_blocks_has_stable_ids():
    ids = [block.block_id for block in document_to_review_blocks(_doc())]
    assert "header.name" in ids
    assert "summary" in ids
    assert "experience.exp_acme.bullet.0" in ids
    assert "skills.languages" in ids
    assert ResumeReviewVersionName.NO_SUMMARY.value == "no_summary"


def test_build_review_id_is_stable(tmp_path):
    assert build_review_id(tmp_path) == build_review_id(tmp_path)


def test_review_store_rejects_outside_runtime(tmp_path, monkeypatch):
    runtime = tmp_path / "runtime"
    monkeypatch.setenv("HUNT_RESUME_ARTIFACTS_DIR", str(runtime))
    outside = tmp_path / "outside"
    outside.mkdir()
    try:
        register_review(outside)
    except ValueError as exc:
        assert "outside" in str(exc)
    else:
        raise AssertionError("outside review path was accepted")


def test_fletcher_queue_lifecycle(tmp_path, monkeypatch):
    db = tmp_path / "hunt.db"
    monkeypatch.setenv("HUNT_DB_PATH", str(db))
    init_fletcher_queue_db(db)
    first = enqueue_fletcher_job({"description": "one"}, db_path=db)
    second = enqueue_fletcher_job({"description": "two"}, db_path=db)
    assert [job["queue_item_id"] for job in list_fletcher_jobs(db_path=db, limit=10)][:2] == [
        first["queue_item_id"],
        second["queue_item_id"],
    ]
    edited = patch_fletcher_job_input(second["queue_item_id"], {"title": "SWE"}, db_path=db)
    assert edited["input"]["title"] == "SWE"
    moved = move_fletcher_job(second["queue_item_id"], "up", db_path=db)
    assert moved["position"] == first["position"]
    cancelled = cancel_fletcher_job(second["queue_item_id"], db_path=db)
    assert cancelled["status"] == "cancelled"
    deleted = delete_fletcher_job(second["queue_item_id"], db_path=db)
    assert deleted["queue_item_id"] == second["queue_item_id"]
    try:
        get_fletcher_job(second["queue_item_id"], db_path=db)
    except KeyError:
        pass
    else:
        raise AssertionError("deleted Fletcher job still exists")
    assert get_fletcher_job(first["queue_item_id"], db_path=db)["status"] == "queued"


def test_fletcher_queue_claim_and_finish(tmp_path, monkeypatch):
    db = tmp_path / "hunt.db"
    monkeypatch.setenv("HUNT_DB_PATH", str(db))
    init_fletcher_queue_db(db)
    queued = enqueue_fletcher_job({"description": "one"}, db_path=db)
    claimed = claim_next_fletcher_job(db_path=db)
    assert claimed is not None
    assert claimed["queue_item_id"] == queued["queue_item_id"]
    assert claimed["status"] == "running"
    finished = finish_fletcher_job(
        claimed["queue_item_id"],
        status="succeeded",
        result={"review_id": "abc"},
        review_id="abc",
        db_path=db,
    )
    assert finished["status"] == "succeeded"
    assert finished["result"]["review_id"] == "abc"


def test_fletcher_queue_progress_updates_merge_existing_state(tmp_path, monkeypatch):
    db = tmp_path / "hunt.db"
    monkeypatch.setenv("HUNT_DB_PATH", str(db))
    init_fletcher_queue_db(db)
    queued = enqueue_fletcher_job({"description": "one"}, db_path=db)

    updated = update_fletcher_job_progress(
        queued["queue_item_id"],
        {"current_step": "keywords_extracted", "percent": 42, "event_id": 7},
        db_path=db,
    )

    assert updated["progress"]["current_step"] == "keywords_extracted"
    assert updated["progress"]["percent"] == 42
    assert updated["progress"]["event_id"] == 7
    assert updated["progress"]["log_tail"] == []

    late_low_update = update_fletcher_job_progress(
        queued["queue_item_id"],
        {"current_step": "pipeline_debug_summary", "percent": 5, "event_id": 8},
        db_path=db,
    )

    assert late_low_update["progress"]["current_step"] == "pipeline_debug_summary"
    assert late_low_update["progress"]["percent"] == 42
    assert late_low_update["progress"]["event_id"] == 8


def test_fletcher_history_orders_by_latest_finish_time(tmp_path, monkeypatch):
    db = tmp_path / "hunt.db"
    monkeypatch.setenv("HUNT_DB_PATH", str(db))
    init_fletcher_queue_db(db)
    older = enqueue_fletcher_job({"description": "older"}, db_path=db)
    newer = enqueue_fletcher_job({"description": "newer"}, db_path=db)
    finish_fletcher_job(older["queue_item_id"], status="succeeded", db_path=db)
    finish_fletcher_job(newer["queue_item_id"], status="failed", db_path=db)

    conn = get_connection(db)
    try:
        conn.execute(
            "UPDATE fletcher_jobs SET finished_at = ? WHERE queue_item_id = ?",
            ("2026-05-07 10:00:00", older["queue_item_id"]),
        )
        conn.execute(
            "UPDATE fletcher_jobs SET finished_at = ? WHERE queue_item_id = ?",
            ("2026-05-07 11:00:00", newer["queue_item_id"]),
        )
        conn.commit()
    finally:
        conn.close()

    history = [
        job
        for job in list_fletcher_jobs(db_path=db, limit=10)
        if job["status"] not in {"queued", "running", "cancel_requested"}
    ]
    assert [job["queue_item_id"] for job in history] == [
        newer["queue_item_id"],
        older["queue_item_id"],
    ]


def test_create_review_package_from_attempt_reuses_shared_contract(tmp_path, monkeypatch):
    runtime = tmp_path / "runtime"
    monkeypatch.setenv("HUNT_RESUME_ARTIFACTS_DIR", str(runtime))
    attempt_dir = runtime / "attempts" / "1" / "demo"
    attempt_dir.mkdir(parents=True)
    output_tex = attempt_dir / "output.tex"
    output_tex.write_text(render_resume_tex(_doc()), encoding="utf-8")
    original_tex = tmp_path / "main.tex"
    original_tex.write_text(render_resume_tex(_doc()), encoding="utf-8")

    package = create_review_package_from_attempt(
        attempt={
            "id": 42,
            "job_id": 7,
            "tex_path": str(output_tex),
            "pdf_path": str(attempt_dir / "output.pdf"),
            "source_resume_type": "tex",
            "source_resume_path": str(original_tex),
            "model_backend": "heuristic",
            "model_name": "deterministic",
            "status": "done",
        },
        job={"id": 7, "title": "SWE", "company": "Acme", "description": "Build APIs"},
        original_resume_path=original_tex,
    )
    assert package.job.job_id == 7
    assert package.job.attempt_id == 42
    assert ResumeReviewVersionName.NO_SUMMARY in package.versions
    assert package.versions[ResumeReviewVersionName.NO_SUMMARY].current.header.name == "Michael Shi"


def test_create_review_package_uses_attempt_source_resume(tmp_path, monkeypatch):
    runtime = tmp_path / "runtime"
    monkeypatch.setenv("HUNT_RESUME_ARTIFACTS_DIR", str(runtime))
    attempt_dir = runtime / "attempts" / "1" / "demo"
    attempt_dir.mkdir(parents=True)
    output_tex = attempt_dir / "output.tex"
    generated = _doc()
    generated.header.name = "Generated Resume"
    output_tex.write_text(render_resume_tex(generated), encoding="utf-8")
    source = _doc()
    source.header.name = "Source Resume"
    source_tex = tmp_path / "source.tex"
    source_tex.write_text(render_resume_tex(source), encoding="utf-8")

    package = create_review_package_from_attempt(
        attempt={
            "id": 43,
            "job_id": 7,
            "tex_path": str(output_tex),
            "pdf_path": str(attempt_dir / "output.pdf"),
            "source_resume_type": "family_base",
            "source_resume_path": str(source_tex),
            "model_backend": "heuristic",
            "model_name": "deterministic",
            "status": "done",
        },
        job={"id": 7, "title": "SWE", "company": "Acme", "description": "Build APIs"},
    )

    version = package.versions[ResumeReviewVersionName.NO_SUMMARY]
    assert version.original.header.name == "Source Resume"
    assert version.generated.header.name == "Generated Resume"


def test_provider_defaults_fail_closed(monkeypatch, tmp_path):
    monkeypatch.setenv("HUNT_DB_PATH", str(tmp_path / "isolated.db"))
    monkeypatch.delenv("HUNT_RESUME_LLM_PROVIDER", raising=False)
    monkeypatch.setenv("HUNT_RESUME_MODEL_BACKEND", "heuristic")
    assert configured_provider_name() == "heuristic"
    monkeypatch.setenv("HUNT_RESUME_LLM_PROVIDER", "openai")
    monkeypatch.delenv("HUNT_RESUME_CLOUD_LLM_CONFIRM", raising=False)
    try:
        get_provider()
    except ValueError as exc:
        assert "CLOUD_LLM_CONFIRM" in str(exc)
    else:
        raise AssertionError("cloud provider did not require confirmation")


def test_general_base_resume_fallback_exists():
    name, path = resolve_base_resume_path("unknown")

    assert name == "general"
    assert path.name == "main.tex"
    assert path.exists()


def test_provider_reads_component_settings(monkeypatch, tmp_path):
    monkeypatch.setenv("HUNT_DB_PATH", str(tmp_path / "settings.db"))
    monkeypatch.setenv("HUNT_RESUME_MODEL_BACKEND", "heuristic")
    conn = get_connection()
    try:
        conn.execute(
            """
            CREATE TABLE component_settings (
                component TEXT NOT NULL,
                key TEXT NOT NULL,
                value TEXT,
                value_type TEXT DEFAULT 'text',
                secret BOOLEAN DEFAULT 0,
                updated_at TEXT,
                updated_by TEXT,
                PRIMARY KEY (component, key)
            )
            """
        )
        conn.execute(
            """
            INSERT INTO component_settings (component, key, value, value_type, secret)
            VALUES ('c2', 'llm_provider', 'openrouter', 'text', 0)
            """
        )
        conn.commit()
    finally:
        conn.close()
    assert configured_provider_name() == "openrouter"


def test_attempt_dirs_are_unique_for_same_label(monkeypatch, tmp_path):
    monkeypatch.setenv("HUNT_RESUME_ARTIFACTS_DIR", str(tmp_path / "runtime"))
    first = build_attempt_dir(job_id=None, role_family="ad_hoc", ad_hoc_label="same")
    second = build_attempt_dir(job_id=None, role_family="ad_hoc", ad_hoc_label="same")
    assert first != second
    assert first.parent == second.parent
