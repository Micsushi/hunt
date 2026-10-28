from __future__ import annotations

import hashlib
import json
import re
import tempfile
from datetime import UTC, datetime
from pathlib import Path

from ..config import resolve_runtime_root
from ..db import _job_is_ready_for_c3, get_connection
from .compiler import compile_tex
from .models import ResumeDocument
from .renderer import render_resume_tex
from .review_io import atomic_json, publication_lock
from .review_models import (
    ResumeReviewPackage,
    ResumeReviewVersionName,
    build_review_id,
    model_to_dict,
    model_validate,
)

INDEX_NAME = "review_index.json"
VERSION_FILENAME_PARTS = {
    ResumeReviewVersionName.STARTING: "starting",
    ResumeReviewVersionName.NO_SUMMARY: "no_summary",
    ResumeReviewVersionName.WITH_SUMMARY: "summary",
}


def _runtime_root() -> Path:
    root = resolve_runtime_root().resolve()
    root.mkdir(parents=True, exist_ok=True)
    return root


def _index_path() -> Path:
    return _runtime_root() / INDEX_NAME


def _read_index() -> dict[str, str]:
    path = _index_path()
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def _write_index(index: dict[str, str]) -> None:
    atomic_json(_index_path(), index)


def _safe_attempt_dir(attempt_dir: str | Path) -> Path:
    root = _runtime_root()
    path = Path(attempt_dir).resolve()
    if path != root and root not in path.parents:
        raise ValueError("Review path is outside the Fletcher runtime root.")
    return path


def _safe_review_id(review_id: str) -> str:
    if not review_id or not all(ch.isalnum() or ch in {"-", "_"} for ch in review_id):
        raise ValueError("Invalid review id.")
    return review_id


def register_review(attempt_dir: str | Path, review_id: str | None = None) -> str:
    attempt = _safe_attempt_dir(attempt_dir)
    rid = _safe_review_id(review_id or build_review_id(attempt))
    with publication_lock(_runtime_root()):
        index = _read_index()
        index[rid] = str(attempt)
        _write_index(index)
    return rid


def attempt_dir_for_review(review_id: str) -> Path:
    rid = _safe_review_id(review_id)
    raw = _read_index().get(rid)
    if not raw:
        raise FileNotFoundError(f"Unknown review id: {rid}")
    return _safe_attempt_dir(raw)


def write_review_package(attempt_dir: str | Path, package: ResumeReviewPackage) -> str:
    attempt = _safe_attempt_dir(attempt_dir)
    attempt.mkdir(parents=True, exist_ok=True)
    register_review(attempt, package.review_id)
    path = attempt / "review_package.json"
    with publication_lock(attempt):
        atomic_json(path, model_to_dict(package))
    return str(path)


def load_review_package(review_id: str) -> ResumeReviewPackage:
    attempt = attempt_dir_for_review(review_id)
    path = attempt / "review_package.json"
    if not path.exists():
        raise FileNotFoundError(f"Review package missing: {review_id}")
    return model_validate(ResumeReviewPackage, json.loads(path.read_text(encoding="utf-8")))


def _version_name(version: str | ResumeReviewVersionName) -> ResumeReviewVersionName:
    if isinstance(version, ResumeReviewVersionName):
        return version
    return ResumeReviewVersionName(version)


def _version_dir(review_id: str, version: str | ResumeReviewVersionName) -> Path:
    return attempt_dir_for_review(review_id) / "versions" / _version_name(version).value


class ReviewConflictError(ValueError):
    pass


RevisionConflictError = ReviewConflictError


def save_current_document(
    review_id: str,
    version: str | ResumeReviewVersionName,
    doc: ResumeDocument,
    *,
    expected_revision: int | None = None,
) -> ResumeReviewPackage:
    attempt = attempt_dir_for_review(review_id)
    with publication_lock(attempt):
        package = load_review_package(review_id)
        state = package.versions[_version_name(version)]
        if expected_revision is not None and state.document_revision != expected_revision:
            if model_to_dict(state.current) == model_to_dict(doc):
                return package
            raise ReviewConflictError(
                f"This resume changed elsewhere; current revision is {state.document_revision}. Your draft is preserved; review the saved version before retrying."
            )
        state.current = doc
        state.dirty = True
        state.document_revision += 1
        atomic_json(attempt / "review_package.json", model_to_dict(package))
        return package


def load_current_document(review_id: str, version: str | ResumeReviewVersionName) -> ResumeDocument:
    return load_review_package(review_id).versions[_version_name(version)].current


def compile_current_document(
    review_id: str, version: str | ResumeReviewVersionName, *, expected_revision: int | None = None
) -> ResumeReviewPackage:
    package = load_review_package(review_id)
    vname = _version_name(version)
    if (
        expected_revision is not None
        and package.versions[vname].document_revision != expected_revision
    ):
        raise ReviewConflictError(
            f"Resume changed; current revision is {package.versions[vname].document_revision}."
        )
    snapshot = model_to_dict(package.versions[vname])
    doc = package.versions[vname].current
    attempt = attempt_dir_for_review(review_id)
    vdir = _version_dir(review_id, vname)
    vdir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=vdir, prefix=".compile-") as staging:
        tex_path = Path(staging) / "output.tex"
        tex_path.write_text(render_resume_tex(doc), encoding="utf-8")
        result = compile_tex(tex_path)
        with publication_lock(attempt):
            current = load_review_package(review_id)
            state = current.versions[vname]
            if model_to_dict(state) != snapshot:
                raise ValueError(
                    "Resume changed during compilation; compile the saved version again."
                )
            state.compile_status = str(result.get("compile_status") or "")
            if state.compile_status == "ok":
                pdf_path = tex_path.with_suffix(".pdf")
                if not pdf_path.is_file() or pdf_path.stat().st_size == 0:
                    raise ValueError("Compiler did not produce a non-empty PDF.")
                revisions = vdir / "revisions"
                revisions.mkdir(exist_ok=True)
                next_revision = state.compiled_revision + 1
                # Never overwrite a revision left by an interrupted publication.
                while (revisions / f"{next_revision:04d}").exists():
                    next_revision += 1
                published = revisions / f"{next_revision:04d}"
                Path(staging).rename(published)
                state.compiled_revision = next_revision
                state.compiled_document_revision = state.document_revision
                state.dirty = False
                state.pdf_url = f"/api/fletcher/reviews/{review_id}/versions/{vname.value}/pdf"
                state.tex_url = f"/api/fletcher/reviews/{review_id}/versions/{vname.value}/tex"
            atomic_json(attempt / "review_package.json", model_to_dict(current))
            if state.compile_status == "ok" and result.get("fits_one_page"):
                _update_job_selected_resume(
                    current,
                    vname,
                    published / "output.pdf",
                    published / "output.tex",
                )
            return current


def _update_job_selected_resume(
    package: ResumeReviewPackage,
    version: ResumeReviewVersionName,
    pdf_path: Path,
    tex_path: Path,
) -> None:
    if version == ResumeReviewVersionName.STARTING:
        return
    job_id = package.job.job_id
    if job_id is None:
        return
    try:
        conn = get_connection(None)
        try:
            # Match record_resume_attempt's version-before-job lock order.
            conn.execute(
                "UPDATE resume_versions SET is_selected_for_c3 = is_selected_for_c3 WHERE job_id = ?",
                (job_id,),
            )
            conn.execute(
                "UPDATE jobs SET selected_resume_version_id = selected_resume_version_id WHERE id = ?",
                (job_id,),
            )
            job = dict(conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone() or {})
            if not job.get("selected_resume_ready_for_c3") or not _job_is_ready_for_c3(job):
                return
            selected = conn.execute(
                """
                SELECT v.*, a.pdf_path AS attempt_pdf_path, a.tex_path AS attempt_tex_path
                FROM resume_versions v JOIN resume_attempts a ON a.id = v.resume_attempt_id
                WHERE v.id = ? AND v.job_id = ? AND a.job_id = ?
                  AND v.is_selected_for_c3 = TRUE
                  AND a.status IN ('done', 'done_with_flags')
                  AND a.latest_result_kind = 'latest_useful'
                """,
                (job.get("selected_resume_version_id"), job_id, job_id),
            ).fetchone()
            if selected is None:
                return
            if (
                package.job.attempt_id is not None
                and package.job.attempt_id != selected["resume_attempt_id"]
            ):
                return
            attempt = attempt_dir_for_review(package.review_id).resolve()
            stem = "output_summary" if version == ResumeReviewVersionName.WITH_SUMMARY else "output"
            previous_pdf = Path(job.get("selected_resume_pdf_path") or "").resolve()
            initial_pdf = attempt / f"{stem}.pdf"
            if previous_pdf != initial_pdf:
                # A skipped refresh may leave an earlier revision selected in this same variant.
                revision = previous_pdf.parent.name
                if (
                    not revision.isdecimal()
                    or not 0 < int(revision) < package.versions[version].compiled_revision
                ):
                    return
                expected = (
                    attempt
                    / "versions"
                    / version.value
                    / "revisions"
                    / f"{int(revision):04d}"
                    / "output.pdf"
                )
                if previous_pdf != expected:
                    return
            for kind in ("pdf", "tex"):
                previous = previous_pdf.with_suffix(f".{kind}")
                paths = (
                    job.get(f"selected_resume_{kind}_path"),
                    selected[f"{kind}_path"],
                    selected[f"attempt_{kind}_path"],
                )
                if not previous.is_file() or any(
                    not path or Path(path).resolve() != previous for path in paths
                ):
                    return
            # Refresh the existing choice and its provenance, never create a selection.
            conn.execute(
                "UPDATE resume_versions SET pdf_path = ?, tex_path = ?, content_hash = ? WHERE id = ?",
                (
                    str(pdf_path),
                    str(tex_path),
                    hashlib.sha256(tex_path.read_bytes()).hexdigest(),
                    selected["id"],
                ),
            )
            conn.execute(
                "UPDATE resume_attempts SET pdf_path = ?, tex_path = ? WHERE id = ?",
                (str(pdf_path), str(tex_path), selected["resume_attempt_id"]),
            )
            conn.execute(
                """
                UPDATE jobs
                SET selected_resume_pdf_path = ?,
                    selected_resume_tex_path = ?
                WHERE id = ?
                """,
                (str(pdf_path), str(tex_path), job_id),
            )
            conn.commit()
        finally:
            conn.close()
    except Exception:
        return


def revert_current_document(
    review_id: str,
    version: str | ResumeReviewVersionName,
    target: str,
    *,
    expected_revision: int | None = None,
) -> ResumeReviewPackage:
    package = load_review_package(review_id)
    vname = _version_name(version)
    version_state = package.versions[vname]
    if target == "original":
        doc = version_state.original
    elif target == "generated":
        doc = version_state.generated
    else:
        raise ValueError("target must be original or generated")
    return save_current_document(review_id, vname, doc, expected_revision=expected_revision)


def artifact_path_for_review(
    review_id: str, version: str | ResumeReviewVersionName, artifact_kind: str
) -> Path:
    vname = _version_name(version)
    with publication_lock(attempt_dir_for_review(review_id)):
        package = load_review_package(review_id)
        state = package.versions[vname]
        vdir = _version_dir(review_id, vname)
        rev = int(state.compiled_revision or 0)
        if rev > 0:
            candidate = vdir / "revisions" / f"{rev:04d}" / f"output.{artifact_kind}"
            if candidate.exists():
                return candidate
            raise FileNotFoundError(
                f"Latest {artifact_kind} artifact missing for {review_id}/{vname.value} "
                f"revision {rev}."
            )
        url_path = state.pdf_url if artifact_kind == "pdf" else state.tex_url
        # Initial artifacts live outside versions/ and are referenced by URL only,
        # so fall back to conventional output names in the attempt dir.
        attempt = attempt_dir_for_review(review_id)
        if vname == ResumeReviewVersionName.STARTING:
            stem = "starting"
        elif vname == ResumeReviewVersionName.WITH_SUMMARY:
            stem = "output_summary"
        else:
            stem = "output"
        candidate = attempt / f"{stem}.{artifact_kind}"
        if candidate.exists():
            return candidate
        raise FileNotFoundError(
            f"{artifact_kind} artifact missing for {review_id}/{vname.value}: {url_path}"
        )


def artifact_download_filename(
    review_id: str,
    version: str | ResumeReviewVersionName,
    artifact_kind: str,
    *,
    path: Path | None = None,
) -> str:
    vname = _version_name(version)
    package = load_review_package(review_id)
    family = _filename_part(
        package.job.role_family or _family_from_title(package.job.title), default="general"
    )
    variant = VERSION_FILENAME_PARTS.get(vname, _filename_part(vname.value, default="resume"))
    artifact_path = path or artifact_path_for_review(review_id, vname, artifact_kind)
    timestamp = datetime.fromtimestamp(artifact_path.stat().st_mtime, UTC).strftime("%Y%m%d_%H%M%S")
    return f"resume_{variant}_{family}_{timestamp}.{artifact_kind}"


def _filename_part(value: str | None, *, default: str) -> str:
    cleaned = re.sub(r"[^a-z0-9]+", "_", str(value or "").strip().lower()).strip("_")
    return cleaned or default


def _family_from_title(title: str | None) -> str:
    if not str(title or "").strip():
        return ""
    try:
        from fletcher.jobs.classifier import classify_job

        return str(classify_job(title=str(title or ""), description="").get("role_family") or "")
    except Exception:
        return ""
