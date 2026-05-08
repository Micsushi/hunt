from __future__ import annotations

import json
from pathlib import Path

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
    review_id: str, version: str | ResumeReviewVersionName, doc: ResumeDocument
) -> ResumeReviewPackage:
    package = load_review_package(review_id)
    vname = _version_name(version)
    vdir = _version_dir(review_id, vname)
    vdir.mkdir(parents=True, exist_ok=True)
    (vdir / "current.json").write_text(json.dumps(model_to_dict(doc), indent=2), encoding="utf-8")
    package.versions[vname].current = doc
    package.versions[vname].dirty = True
    write_review_package(attempt_dir_for_review(review_id), package)
    return package


def load_current_document(review_id: str, version: str | ResumeReviewVersionName) -> ResumeDocument:
    path = _version_dir(review_id, version) / "current.json"
    if not path.exists():
        raise FileNotFoundError("Current resume document missing.")
    return model_validate(ResumeDocument, json.loads(path.read_text(encoding="utf-8")))


def compile_current_document(
    review_id: str, version: str | ResumeReviewVersionName
) -> ResumeReviewPackage:
    package = load_review_package(review_id)
    vname = _version_name(version)
    doc = load_current_document(review_id, vname)
    version_state = package.versions[vname]
    next_revision = int(version_state.compiled_revision or 0) + 1
    vdir = _version_dir(review_id, vname)
    rev_dir = vdir / "revisions" / f"{next_revision:04d}"
    rev_dir.mkdir(parents=True, exist_ok=True)
    tex_path = rev_dir / "output.tex"
    tex_path.write_text(render_resume_tex(doc), encoding="utf-8")
    result = compile_tex(tex_path)
    version_state.compiled_revision = next_revision
    version_state.compile_status = str(result.get("compile_status") or "")
    if result.get("compile_status") == "ok":
        version_state.dirty = False
        version_state.pdf_url = f"/api/fletcher/reviews/{review_id}/versions/{vname.value}/pdf"
        version_state.tex_url = f"/api/fletcher/reviews/{review_id}/versions/{vname.value}/tex"
        _update_job_selected_resume(package, review_id, vname)
    write_review_package(attempt_dir_for_review(review_id), package)
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
    review_id: str, version: str | ResumeReviewVersionName, target: str
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
    return save_current_document(review_id, vname, doc)


def artifact_path_for_review(
    review_id: str, version: str | ResumeReviewVersionName, artifact_kind: str
) -> Path:
    vname = _version_name(version)
    package = load_review_package(review_id)
    state = package.versions[vname]
    vdir = _version_dir(review_id, vname)
    rev = int(state.compiled_revision or 0)
    if rev > 0:
        candidate = vdir / "revisions" / f"{rev:04d}" / f"output.{artifact_kind}"
        if candidate.exists():
            return candidate
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
