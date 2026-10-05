from __future__ import annotations

import json
import re
from datetime import UTC, datetime
from pathlib import Path
from threading import Lock, RLock

from ..config import resolve_runtime_root
from ..db import get_connection
from .compiler import compile_tex
from .models import ResumeDocument
from .renderer import render_resume_tex
from .review_models import (
    ResumeReviewPackage,
    ResumeReviewVersionName,
    build_review_id,
    model_to_dict,
    model_validate,
)

INDEX_NAME = "review_index.json"
_REVIEW_LOCKS: dict[str, RLock] = {}
_REVIEW_LOCKS_GUARD = Lock()
VERSION_FILENAME_PARTS = {
    ResumeReviewVersionName.STARTING: "starting",
    ResumeReviewVersionName.NO_SUMMARY: "no_summary",
    ResumeReviewVersionName.WITH_SUMMARY: "summary",
}


class RevisionConflictError(ValueError):
    """The caller attempted to mutate a review from an obsolete revision."""


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
    _index_path().write_text(json.dumps(index, indent=2, sort_keys=True), encoding="utf-8")


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


def _review_lock(review_id: str) -> RLock:
    rid = _safe_review_id(review_id)
    with _REVIEW_LOCKS_GUARD:
        return _REVIEW_LOCKS.setdefault(rid, RLock())


def _check_expected_revision(version_state, expected_revision: int | None) -> None:
    if expected_revision is None:
        return
    if (
        isinstance(expected_revision, bool)
        or not isinstance(expected_revision, int)
        or expected_revision < 0
    ):
        raise ValueError("expected_revision must be a non-negative integer.")
    current_revision = int(version_state.document_revision or 0)
    if expected_revision != current_revision:
        raise RevisionConflictError(
            f"Review changed since revision {expected_revision}; current revision is "
            f"{current_revision}. Reload before saving or compiling."
        )


def register_review(attempt_dir: str | Path, review_id: str | None = None) -> str:
    attempt = _safe_attempt_dir(attempt_dir)
    rid = _safe_review_id(review_id or build_review_id(attempt))
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
    path.write_text(json.dumps(model_to_dict(package), indent=2), encoding="utf-8")
    for name, version in package.versions.items():
        vdir = attempt / "versions" / str(name.value if hasattr(name, "value") else name)
        vdir.mkdir(parents=True, exist_ok=True)
        (vdir / "original.json").write_text(
            json.dumps(model_to_dict(version.original), indent=2), encoding="utf-8"
        )
        (vdir / "generated.json").write_text(
            json.dumps(model_to_dict(version.generated), indent=2), encoding="utf-8"
        )
        (vdir / "current.json").write_text(
            json.dumps(model_to_dict(version.current), indent=2), encoding="utf-8"
        )
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


def save_current_document(
    review_id: str,
    version: str | ResumeReviewVersionName,
    doc: ResumeDocument,
    *,
    expected_revision: int | None = None,
) -> ResumeReviewPackage:
    vname = _version_name(version)
    with _review_lock(review_id):
        return _save_current_document_locked(
            review_id,
            vname,
            doc,
            expected_revision=expected_revision,
        )


def _save_current_document_locked(
    review_id: str,
    version: ResumeReviewVersionName,
    doc: ResumeDocument,
    *,
    expected_revision: int | None,
    package: ResumeReviewPackage | None = None,
) -> ResumeReviewPackage:
    package = package or load_review_package(review_id)
    version_state = package.versions[version]
    _check_expected_revision(version_state, expected_revision)
    vdir = _version_dir(review_id, version)
    vdir.mkdir(parents=True, exist_ok=True)
    (vdir / "current.json").write_text(json.dumps(model_to_dict(doc), indent=2), encoding="utf-8")
    version_state.current = doc
    version_state.document_revision = int(version_state.document_revision or 0) + 1
    version_state.dirty = True
    write_review_package(attempt_dir_for_review(review_id), package)
    return package


def load_current_document(review_id: str, version: str | ResumeReviewVersionName) -> ResumeDocument:
    path = _version_dir(review_id, version) / "current.json"
    if not path.exists():
        raise FileNotFoundError("Current resume document missing.")
    return model_validate(ResumeDocument, json.loads(path.read_text(encoding="utf-8")))


def compile_current_document(
    review_id: str,
    version: str | ResumeReviewVersionName,
    *,
    expected_revision: int | None = None,
) -> ResumeReviewPackage:
    vname = _version_name(version)
    with _review_lock(review_id):
        package = load_review_package(review_id)
        version_state = package.versions[vname]
        _check_expected_revision(version_state, expected_revision)
        source_revision = int(version_state.document_revision or 0)
        doc = load_current_document(review_id, vname)
        next_revision = int(version_state.compiled_revision or 0) + 1
        vdir = _version_dir(review_id, vname)
        rev_dir = vdir / "revisions" / f"{next_revision:04d}"
        rev_dir.mkdir(parents=True, exist_ok=True)
        tex_path = rev_dir / "output.tex"
        tex_path.write_text(render_resume_tex(doc), encoding="utf-8")
        result = compile_tex(tex_path)
        version_state.compile_status = str(result.get("compile_status") or "")
        if result.get("compile_status") == "ok":
            version_state.compiled_revision = next_revision
            version_state.compiled_document_revision = source_revision
            version_state.dirty = False
            version_state.pdf_url = f"/api/fletcher/reviews/{review_id}/versions/{vname.value}/pdf"
            version_state.tex_url = f"/api/fletcher/reviews/{review_id}/versions/{vname.value}/tex"
        write_review_package(attempt_dir_for_review(review_id), package)
        if result.get("compile_status") == "ok":
            _update_job_selected_resume(package, review_id, vname)
        return package


def _update_job_selected_resume(
    package: ResumeReviewPackage, review_id: str, version: ResumeReviewVersionName
) -> None:
    if version == ResumeReviewVersionName.STARTING:
        return
    job_id = package.job.job_id
    if job_id is None:
        return
    try:
        pdf_path = artifact_path_for_review(review_id, version, "pdf")
        tex_path = artifact_path_for_review(review_id, version, "tex")
        conn = get_connection(None)
        try:
            conn.execute(
                """
                UPDATE jobs
                SET selected_resume_pdf_path = ?,
                    selected_resume_tex_path = ?,
                    selected_resume_selected_at = CURRENT_TIMESTAMP,
                    selected_resume_ready_for_c3 = 1
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
    vname = _version_name(version)
    with _review_lock(review_id):
        package = load_review_package(review_id)
        version_state = package.versions[vname]
        if target == "original":
            doc = version_state.original
        elif target == "generated":
            doc = version_state.generated
        else:
            raise ValueError("target must be original or generated")
        return _save_current_document_locked(
            review_id,
            vname,
            doc,
            expected_revision=expected_revision,
            package=package,
        )


def artifact_path_for_review(
    review_id: str, version: str | ResumeReviewVersionName, artifact_kind: str
) -> Path:
    vname = _version_name(version)
    with _review_lock(review_id):
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
