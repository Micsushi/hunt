from __future__ import annotations

import os
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from threading import Event

import pytest

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
    ResumeReviewJobInfo,
    ResumeReviewPackage,
    ResumeReviewVersion,
    ResumeReviewVersionName,
    build_review_id,
    document_to_review_blocks,
)
from fletcher.resume.review_store import (
    RevisionConflictError,
    artifact_download_filename,
    artifact_path_for_review,
    compile_current_document,
    load_review_package,
    register_review,
    save_current_document,
    write_review_package,
)
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
    assert ResumeReviewVersionName.STARTING.value == "starting"
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
    assert ResumeReviewVersionName.STARTING in package.versions
    assert ResumeReviewVersionName.NO_SUMMARY in package.versions
    assert package.versions[ResumeReviewVersionName.STARTING].current.header.name == "Michael Shi"
    assert package.versions[ResumeReviewVersionName.NO_SUMMARY].current.header.name == "Michael Shi"
    assert artifact_path_for_review(package.review_id, "starting", "tex").name == "starting.tex"


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


def test_compile_failure_does_not_promote_missing_revision(tmp_path, monkeypatch):
    from fletcher.resume import review_store

    runtime = tmp_path / "runtime"
    monkeypatch.setenv("HUNT_RESUME_ARTIFACTS_DIR", str(runtime))
    attempt_dir = runtime / "ad_hoc" / "compile-failure"
    attempt_dir.mkdir(parents=True)
    doc = _doc()
    (attempt_dir / "output.tex").write_text(render_resume_tex(doc), encoding="utf-8")
    (attempt_dir / "output.pdf").write_bytes(b"%PDF previous")
    review_id = build_review_id(attempt_dir)
    package = ResumeReviewPackage(
        review_id=review_id,
        log_url=f"/api/fletcher/reviews/{review_id}/log",
        versions={
            ResumeReviewVersionName.NO_SUMMARY: ResumeReviewVersion(
                original=doc,
                generated=doc,
                current=doc,
                pdf_url=f"/api/fletcher/reviews/{review_id}/versions/no_summary/pdf",
                tex_url=f"/api/fletcher/reviews/{review_id}/versions/no_summary/tex",
                compile_status="ok",
            )
        },
    )
    write_review_package(attempt_dir, package)

    monkeypatch.setattr(
        review_store,
        "compile_tex",
        lambda _tex_path: {"compile_status": "failed", "pdf_path": None},
    )

    updated = compile_current_document(review_id, "no_summary")
    version = updated.versions[ResumeReviewVersionName.NO_SUMMARY]

    assert version.compiled_revision == 0
    assert version.compile_status == "failed"
    assert artifact_path_for_review(review_id, "no_summary", "pdf") == attempt_dir / "output.pdf"


def test_review_mutations_are_serialized_per_review(tmp_path, monkeypatch):
    runtime = tmp_path / "runtime"
    monkeypatch.setenv("HUNT_RESUME_ARTIFACTS_DIR", str(runtime))
    attempt_dir = runtime / "ad_hoc" / "serialized"
    attempt_dir.mkdir(parents=True)
    doc = _doc()
    write_review_package(
        attempt_dir,
        ResumeReviewPackage(
            review_id=build_review_id(attempt_dir),
            log_url="/log",
            versions={
                ResumeReviewVersionName.NO_SUMMARY: ResumeReviewVersion(
                    original=doc,
                    generated=doc,
                    current=doc,
                    pdf_url="/pdf",
                    tex_url="/tex",
                )
            },
        ),
    )
    review_id = build_review_id(attempt_dir)
    compile_started = Event()
    release_compile = Event()
    save_started = Event()
    save_finished = Event()

    def fake_compile(tex_path):
        compile_started.set()
        assert release_compile.wait(30)
        tex_path.with_suffix(".pdf").write_bytes(b"%PDF compiled")
        return {"compile_status": "ok", "pdf_path": str(tex_path.with_suffix(".pdf"))}

    monkeypatch.setattr("fletcher.resume.review_store.compile_tex", fake_compile)
    saved_doc = _doc()
    saved_doc.header.name = "Saved after compile"

    def save_after_compile():
        save_started.set()
        try:
            return save_current_document(review_id, "no_summary", saved_doc, expected_revision=0)
        finally:
            save_finished.set()

    with ThreadPoolExecutor(max_workers=2) as executor:
        compile_future = executor.submit(
            compile_current_document, review_id, "no_summary", expected_revision=0
        )
        assert compile_started.wait(2)
        save_future = executor.submit(save_after_compile)
        assert save_started.wait(2)
        assert not save_finished.wait(0.05)
        release_compile.set()
        compiled = compile_future.result(timeout=2)
        saved = save_future.result(timeout=2)

    assert compiled.versions[ResumeReviewVersionName.NO_SUMMARY].compiled_revision == 1
    assert saved.versions[ResumeReviewVersionName.NO_SUMMARY].document_revision == 1
    final = load_review_package(review_id)
    final_version = final.versions[ResumeReviewVersionName.NO_SUMMARY]
    assert final_version.current.header.name == "Saved after compile"
    assert final_version.dirty is True


def test_review_mutations_reject_stale_revision(tmp_path, monkeypatch):
    runtime = tmp_path / "runtime"
    monkeypatch.setenv("HUNT_RESUME_ARTIFACTS_DIR", str(runtime))
    attempt_dir = runtime / "ad_hoc" / "revision-conflict"
    attempt_dir.mkdir(parents=True)
    doc = _doc()
    review_id = build_review_id(attempt_dir)
    write_review_package(
        attempt_dir,
        ResumeReviewPackage(
            review_id=review_id,
            log_url="/log",
            versions={
                ResumeReviewVersionName.NO_SUMMARY: ResumeReviewVersion(
                    original=doc,
                    generated=doc,
                    current=doc,
                    pdf_url="/pdf",
                    tex_url="/tex",
                )
            },
        ),
    )
    edited = _doc()
    edited.header.name = "Revision one"
    saved = save_current_document(review_id, "no_summary", edited, expected_revision=0)
    assert saved.versions[ResumeReviewVersionName.NO_SUMMARY].document_revision == 1

    with pytest.raises(RevisionConflictError, match="current revision is 1"):
        save_current_document(review_id, "no_summary", doc, expected_revision=0)
    with pytest.raises(RevisionConflictError, match="current revision is 1"):
        compile_current_document(review_id, "no_summary", expected_revision=0)


def test_review_http_mutations_require_revision_precondition(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    runtime = tmp_path / "runtime"
    db_path = tmp_path / "hunt.db"
    home = tmp_path / "home"
    config = tmp_path / "config"
    runtime.mkdir()
    home.mkdir()
    config.mkdir()
    monkeypatch.setenv("HUNT_RESUME_ARTIFACTS_DIR", str(runtime))
    monkeypatch.setenv("HUNT_DB_PATH", str(db_path))
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))
    monkeypatch.setenv("APPDATA", str(config))
    monkeypatch.setenv("LOCALAPPDATA", str(config))
    monkeypatch.setenv("XDG_CONFIG_HOME", str(config))

    from backend.app import app, require_auth

    app.dependency_overrides[require_auth] = lambda: "synthetic"
    try:
        client = TestClient(app, raise_server_exceptions=False)
        path = "/api/fletcher/reviews/synthetic/versions/no_summary/compile"
        missing = client.post(path, json={})
        assert missing.status_code == 428
        invalid = client.post(path, json={"expected_revision": None})
        assert invalid.status_code == 400
    finally:
        app.dependency_overrides.pop(require_auth, None)


def test_failed_compile_keeps_last_good_exact_artifact(tmp_path, monkeypatch):
    from fletcher.resume import review_store

    runtime = tmp_path / "runtime"
    monkeypatch.setenv("HUNT_RESUME_ARTIFACTS_DIR", str(runtime))
    attempt_dir = runtime / "ad_hoc" / "last-good"
    attempt_dir.mkdir(parents=True)
    doc = _doc()
    review_id = build_review_id(attempt_dir)
    write_review_package(
        attempt_dir,
        ResumeReviewPackage(
            review_id=review_id,
            log_url="/log",
            versions={
                ResumeReviewVersionName.NO_SUMMARY: ResumeReviewVersion(
                    original=doc,
                    generated=doc,
                    current=doc,
                    pdf_url="/pdf",
                    tex_url="/tex",
                )
            },
        ),
    )

    def successful_compile(tex_path):
        pdf_path = tex_path.with_suffix(".pdf")
        pdf_path.write_bytes(b"%PDF last good")
        return {"compile_status": "ok", "pdf_path": str(pdf_path)}

    monkeypatch.setattr(review_store, "compile_tex", successful_compile)
    first = compile_current_document(review_id, "no_summary", expected_revision=0)
    first_version = first.versions[ResumeReviewVersionName.NO_SUMMARY]
    assert first_version.compiled_revision == 1
    assert first_version.compiled_document_revision == 0
    last_good = artifact_path_for_review(review_id, "no_summary", "pdf")
    assert last_good.name == "output.pdf"

    edited = _doc()
    edited.header.name = "Edited"
    saved = save_current_document(review_id, "no_summary", edited, expected_revision=0)
    assert saved.versions[ResumeReviewVersionName.NO_SUMMARY].document_revision == 1
    monkeypatch.setattr(
        review_store,
        "compile_tex",
        lambda _tex_path: {"compile_status": "failed", "pdf_path": None},
    )
    failed = compile_current_document(review_id, "no_summary", expected_revision=1)
    failed_version = failed.versions[ResumeReviewVersionName.NO_SUMMARY]
    assert failed_version.compiled_revision == 1
    assert failed_version.compiled_document_revision == 0
    assert failed_version.dirty is True
    assert artifact_path_for_review(review_id, "no_summary", "pdf") == last_good


def test_artifact_lookup_does_not_fall_back_to_older_revision(tmp_path, monkeypatch):
    runtime = tmp_path / "runtime"
    monkeypatch.setenv("HUNT_RESUME_ARTIFACTS_DIR", str(runtime))
    attempt_dir = runtime / "ad_hoc" / "missing-latest"
    attempt_dir.mkdir(parents=True)
    doc = _doc()
    review_id = build_review_id(attempt_dir)
    revision_one = attempt_dir / "versions" / "no_summary" / "revisions" / "0001"
    revision_one.mkdir(parents=True)
    (revision_one / "output.pdf").write_bytes(b"%PDF old")
    write_review_package(
        attempt_dir,
        ResumeReviewPackage(
            review_id=review_id,
            log_url="/log",
            versions={
                ResumeReviewVersionName.NO_SUMMARY: ResumeReviewVersion(
                    original=doc,
                    generated=doc,
                    current=doc,
                    pdf_url="/pdf",
                    tex_url="/tex",
                    compiled_revision=2,
                    compiled_document_revision=2,
                )
            },
        ),
    )

    with pytest.raises(FileNotFoundError, match="revision 2"):
        artifact_path_for_review(review_id, "no_summary", "pdf")


def test_artifact_download_filename_uses_version_family_and_timestamp(tmp_path, monkeypatch):
    runtime = tmp_path / "runtime"
    monkeypatch.setenv("HUNT_RESUME_ARTIFACTS_DIR", str(runtime))
    attempt_dir = runtime / "ad_hoc" / "download-name"
    attempt_dir.mkdir(parents=True)
    doc = _doc()
    pdf_path = attempt_dir / "output_summary.pdf"
    pdf_path.write_bytes(b"%PDF summary")
    stamp = datetime(2026, 5, 8, 3, 4, 5, tzinfo=UTC).timestamp()
    os.utime(pdf_path, (stamp, stamp))
    review_id = build_review_id(attempt_dir)
    package = ResumeReviewPackage(
        review_id=review_id,
        job=ResumeReviewJobInfo(role_family="Software Engineering"),
        log_url=f"/api/fletcher/reviews/{review_id}/log",
        versions={
            ResumeReviewVersionName.WITH_SUMMARY: ResumeReviewVersion(
                original=doc,
                generated=doc,
                current=doc,
                pdf_url=f"/api/fletcher/reviews/{review_id}/versions/with_summary/pdf",
                tex_url=f"/api/fletcher/reviews/{review_id}/versions/with_summary/tex",
                compile_status="ok",
            )
        },
    )
    write_review_package(attempt_dir, package)

    assert (
        artifact_download_filename(review_id, "with_summary", "pdf", path=pdf_path)
        == "resume_summary_software_engineering_20260508_030405.pdf"
    )

    package.job.role_family = ""
    package.job.title = "Software Engineer"
    write_review_package(attempt_dir, package)

    assert (
        artifact_download_filename(review_id, "with_summary", "pdf", path=pdf_path)
        == "resume_summary_software_20260508_030405.pdf"
    )


def test_general_base_resume_fallback_exists():
    name, path = resolve_base_resume_path("unknown")

    assert name == "general"
    assert path.name == "main.tex"
    assert path.exists()


def test_attempt_dirs_are_unique_for_same_label(monkeypatch, tmp_path):
    monkeypatch.setenv("HUNT_RESUME_ARTIFACTS_DIR", str(tmp_path / "runtime"))
    first = build_attempt_dir(job_id=None, role_family="ad_hoc", ad_hoc_label="same")
    second = build_attempt_dir(job_id=None, role_family="ad_hoc", ad_hoc_label="same")
    assert first != second
    assert first.parent == second.parent
