from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

import pytest

from fletcher.db import (
    cancel_fletcher_job,
    delete_fletcher_job,
    enqueue_fletcher_job,
    get_fletcher_job,
    init_fletcher_queue_db,
    list_fletcher_jobs,
    move_fletcher_job,
    patch_fletcher_job_input,
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
)
from fletcher.resume.review_store import (
    RevisionConflictError,
    artifact_path_for_review,
    compile_current_document,
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
    from fletcher.db import claim_next_fletcher_job, recover_interrupted_fletcher_jobs

    ident = first["queue_item_id"]
    assert get_fletcher_job(ident, db_path=db)["status"] == "queued"
    claimed = claim_next_fletcher_job(db_path=db)
    assert (
        claimed is not None and claimed["queue_item_id"] == ident and claimed["status"] == "running"
    )
    recovered = recover_interrupted_fletcher_jobs(db_path=db)
    assert [row["queue_item_id"] for row in recovered] == [ident]
    assert recovered[0]["status"] == "queued" and recovered[0]["started_at"] is None
    assert recovered[0]["progress"]["current_step"] == "requeued_after_worker_restart"
    assert recovered[0]["progress"]["previous_step"] == "running"
    reclaimed = claim_next_fletcher_job(db_path=db)
    assert (
        reclaimed is not None
        and reclaimed["queue_item_id"] == ident
        and reclaimed["status"] == "running"
    )


def test_create_review_package_uses_attempt_source_resume(tmp_path, monkeypatch):
    runtime = tmp_path / "runtime"
    monkeypatch.setenv("HUNT_RESUME_ARTIFACTS_DIR", str(runtime))
    attempt_dir = build_attempt_dir(job_id=None, role_family="ad_hoc", ad_hoc_label="same")
    other = build_attempt_dir(job_id=None, role_family="ad_hoc", ad_hoc_label="same")
    assert attempt_dir != other and attempt_dir.parent == other.parent
    attempt_dir.mkdir(parents=True, exist_ok=True)
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


def test_successful_recompile_refreshes_the_selected_revision(tmp_path, monkeypatch):
    import sqlite3

    from fletcher.db import RESUME_ATTEMPTS_TABLE_SQL, RESUME_VERSIONS_TABLE_SQL
    from fletcher.resume import review_store

    runtime = tmp_path / "runtime"
    monkeypatch.setenv("HUNT_RESUME_ARTIFACTS_DIR", str(runtime))
    attempt = runtime / "synthetic-recompile"
    previous = attempt / "versions" / "no_summary" / "revisions" / "0001"
    previous.mkdir(parents=True)
    for suffix in ("pdf", "tex"):
        (previous / f"output.{suffix}").write_text("previous", encoding="utf-8")
    doc = _doc()
    doc.header.name = "Synthetic Candidate"
    rid = build_review_id(attempt)
    write_review_package(
        attempt,
        ResumeReviewPackage(
            review_id=rid,
            job=ResumeReviewJobInfo(job_id=7),
            log_url="/synthetic-log",
            versions={
                ResumeReviewVersionName.NO_SUMMARY: ResumeReviewVersion(
                    original=doc,
                    generated=doc,
                    current=doc,
                    compiled_revision=1,
                    pdf_url="/synthetic.pdf",
                    tex_url="/synthetic.tex",
                )
            },
        ),
    )
    db = tmp_path / "selection.db"
    with sqlite3.connect(db) as conn:
        conn.execute(
            "CREATE TABLE jobs (id INTEGER PRIMARY KEY, selected_resume_pdf_path TEXT, "
            "selected_resume_tex_path TEXT, selected_resume_selected_at TEXT, "
            "selected_resume_ready_for_c3 INTEGER, selected_resume_version_id TEXT, "
            "enrichment_status TEXT, status TEXT, apply_type TEXT, auto_apply_eligible INTEGER, "
            "priority INTEGER, apply_url TEXT)"
        )
        conn.execute(RESUME_ATTEMPTS_TABLE_SQL)
        conn.execute(RESUME_VERSIONS_TABLE_SQL)
        paths = (str(previous / "output.pdf"), str(previous / "output.tex"))
        conn.execute(
            "INSERT INTO jobs VALUES (7, ?, ?, 'explicit-choice', 1, '1', "
            "'done', 'new', 'external_apply', 1, 0, 'https://example.invalid/apply')",
            paths,
        )
        conn.execute(
            "INSERT INTO resume_attempts (id, job_id, status, latest_result_kind, pdf_path, tex_path) "
            "VALUES (1, 7, 'done', 'latest_useful', ?, ?)",
            paths,
        )
        conn.execute(
            "INSERT INTO resume_versions "
            "(id, job_id, resume_attempt_id, pdf_path, tex_path, content_hash, is_selected_for_c3) "
            "VALUES (1, 7, 1, ?, ?, 'previous', TRUE)",
            paths,
        )
    conn.close()

    def connect(_):
        connection = sqlite3.connect(db)
        connection.row_factory = sqlite3.Row
        return connection

    monkeypatch.setattr(review_store, "get_connection", connect)

    def compile_fixture(path):
        path.with_suffix(".pdf").write_bytes(b"%PDF synthetic new revision")
        return {"compile_status": "ok", "fits_one_page": True}

    monkeypatch.setattr(review_store, "compile_tex", compile_fixture)
    result = compile_current_document(rid, "no_summary")
    assert result.versions[ResumeReviewVersionName.NO_SUMMARY].compiled_revision == 2
    with sqlite3.connect(db) as conn:
        selected = conn.execute(
            "SELECT selected_resume_pdf_path, selected_resume_tex_path, "
            "selected_resume_ready_for_c3 FROM jobs WHERE id = 7"
        ).fetchone()
    expected = attempt / "versions" / "no_summary" / "revisions" / "0002"
    assert selected == (str(expected / "output.pdf"), str(expected / "output.tex"), 1)
    conn.close()
    # Losing the selected file must never serve the older revision that still exists.
    (expected / "output.pdf").unlink()
    assert (previous / "output.pdf").is_file()
    with pytest.raises(FileNotFoundError, match="revision 2"):
        artifact_path_for_review(rid, "no_summary", "pdf")


@pytest.mark.parametrize("revert", [False, True])
def test_compile_completion_preserves_newer_saved_edit(tmp_path, monkeypatch, revert):
    import pytest

    from fletcher.resume import review_store

    monkeypatch.setenv("HUNT_RESUME_ARTIFACTS_DIR", str(tmp_path))
    attempt = tmp_path / "synthetic-stale"
    doc = _doc()
    doc.header.name = "Synthetic Candidate"
    rid = build_review_id(attempt)
    write_review_package(
        attempt,
        ResumeReviewPackage(
            review_id=rid,
            log_url="/synthetic",
            versions={
                ResumeReviewVersionName.NO_SUMMARY: ResumeReviewVersion(
                    original=doc,
                    generated=doc,
                    current=doc,
                    pdf_url="/old.pdf",
                    tex_url="/old.tex",
                )
            },
        ),
    )
    promoted = []
    monkeypatch.setattr(
        review_store, "_update_job_selected_resume", lambda *args: promoted.append(args)
    )

    def compile_with_interleaved_save(path):
        edited = _doc()
        edited.summary = "Newer saved edit"
        review_store.save_current_document(rid, "no_summary", edited)
        if revert:
            review_store.save_current_document(rid, "no_summary", doc)
        path.with_suffix(".pdf").write_bytes(b"%PDF obsolete")
        return {"compile_status": "ok"}

    monkeypatch.setattr(review_store, "compile_tex", compile_with_interleaved_save)
    with pytest.raises(ValueError, match="changed during compilation"):
        compile_current_document(rid, "no_summary")
    saved = review_store.load_review_package(rid).versions[ResumeReviewVersionName.NO_SUMMARY]
    assert saved.current.summary == (doc.summary if revert else "Newer saved edit")
    assert saved.edit_revision == (2 if revert else 1)
    assert saved.dirty and saved.compiled_revision == 0
    assert not promoted


def test_overlapping_compiles_publish_only_one_isolated_revision(tmp_path, monkeypatch):
    from threading import Barrier

    from fletcher.resume import review_store

    monkeypatch.setenv("HUNT_RESUME_ARTIFACTS_DIR", str(tmp_path))
    attempt = tmp_path / "synthetic-overlap"
    doc = _doc()
    rid = build_review_id(attempt)
    write_review_package(
        attempt,
        ResumeReviewPackage(
            review_id=rid,
            log_url="/synthetic",
            versions={
                ResumeReviewVersionName.NO_SUMMARY: ResumeReviewVersion(
                    original=doc,
                    generated=doc,
                    current=doc,
                    pdf_url="/old.pdf",
                    tex_url="/old.tex",
                )
            },
        ),
    )
    barrier = Barrier(2)
    paths = []

    def compile_fixture(path):
        paths.append(path)
        path.with_suffix(".pdf").write_bytes(b"%PDF synthetic")
        barrier.wait(timeout=5)
        return {"compile_status": "ok"}

    def run():
        try:
            compile_current_document(rid, "no_summary")
            return "published"
        except ValueError as exc:
            assert "changed during compilation" in str(exc)
            return "stale"

    monkeypatch.setattr(review_store, "compile_tex", compile_fixture)
    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(lambda _: run(), range(2))) == ["published", "stale"]
    assert paths[0] != paths[1]
    assert (
        review_store.load_review_package(rid)
        .versions[ResumeReviewVersionName.NO_SUMMARY]
        .compiled_revision
        == 1
    )
    assert not list(attempt.rglob(".compile-*"))
