import json
import os
import re
from pathlib import Path

from enrichment_policy import utc_now


def get_artifacts_root():
    configured = os.getenv("HUNT_ARTIFACTS_DIR")
    if configured and configured.strip():
        return Path(os.path.abspath(os.path.expanduser(configured.strip())))

    db_path = os.getenv("HUNT_DB_PATH")
    if db_path and db_path.strip():
        return Path(os.path.abspath(os.path.expanduser(db_path.strip()))).parent / "artifacts"

    repo_root = Path(__file__).resolve().parent.parent
    return repo_root / "artifacts"


def resolve_artifact_path(relative_path):
    if not relative_path:
        return None

    root = get_artifacts_root().resolve()
    candidate = (root / relative_path).resolve()
    try:
        candidate.relative_to(root)
    except ValueError:
        return None
    return candidate


def _safe_slug(value, fallback):
    normalized = re.sub(r"[^A-Za-z0-9._-]+", "-", (value or "").strip()).strip("-._")
    return normalized or fallback


def _build_artifact_dir(job, error_code, source):
    root = get_artifacts_root()
    timestamp = utc_now().strftime("%Y%m%dT%H%M%SZ")
    job_id = job.get("id") or "unknown"
    source_slug = _safe_slug(source or job.get("source"), "unknown")
    error_slug = _safe_slug(error_code, "unknown")
    return root / source_slug / f"job_{job_id}" / f"{timestamp}_{error_slug}"


def _write_text(path, content):
    path.write_text(content or "", encoding="utf-8")


def _write_json(path, payload):
    path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")


def _relative(path):
    root = get_artifacts_root().resolve()
    return str(path.resolve().relative_to(root)).replace("\\", "/")


def capture_text_artifacts(job, error_code, *, source=None, page_url=None, html_content=None, text_content=None, metadata=None):
    artifact_dir = _build_artifact_dir(job, error_code, source)
    artifact_dir.mkdir(parents=True, exist_ok=True)

    html_path = artifact_dir / "page.html" if html_content is not None else None
    text_path = artifact_dir / "page.txt" if text_content is not None else None

    if html_path is not None:
        _write_text(html_path, html_content)
    if text_path is not None:
        _write_text(text_path, text_content)

    metadata_path = artifact_dir / "metadata.json"
    payload = {
        "job_id": job.get("id"),
        "source": source or job.get("source"),
        "company": job.get("company"),
        "title": job.get("title"),
        "job_url": job.get("job_url"),
        "apply_url": job.get("apply_url"),
        "captured_page_url": page_url,
        "error_code": error_code,
        "captured_at": utc_now().isoformat(),
    }
    if metadata:
        payload.update(metadata)
    _write_json(metadata_path, payload)

    return {
        "artifact_dir": _relative(artifact_dir),
        "artifact_screenshot_path": None,
        "artifact_html_path": _relative(html_path) if html_path else None,
        "artifact_text_path": _relative(text_path) if text_path else None,
    }


def capture_page_artifacts(job, error_code, *, page, source=None, metadata=None):
    html_content = None
    text_content = None
    screenshot_path = None
    page_url = None
    artifact_dir = _build_artifact_dir(job, error_code, source)
    artifact_dir.mkdir(parents=True, exist_ok=True)

    try:
        page_url = page.url
    except Exception:
        page_url = None

    try:
        screenshot_path = artifact_dir / "page.png"
        page.screenshot(path=str(screenshot_path), full_page=True)
    except Exception:
        screenshot_path = None

    try:
        html_content = page.content()
    except Exception:
        html_content = None

    try:
        text_content = page.locator("body").inner_text(timeout=1500)
    except Exception:
        text_content = None

    result = capture_text_artifacts(
        job,
        error_code,
        source=source,
        page_url=page_url,
        html_content=html_content,
        text_content=text_content,
        metadata=metadata,
    )
    if screenshot_path is not None:
        result["artifact_screenshot_path"] = _relative(screenshot_path)
    return result
