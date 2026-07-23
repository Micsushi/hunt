from __future__ import annotations

import hashlib
import html
import json
import re
import uuid
from datetime import UTC, datetime
from html.parser import HTMLParser
from itertools import islice
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from backend.ledger.redaction import REDACTED, redact_payload

SAFE_ID = re.compile(r"^[A-Za-z0-9_.-]+$")
SENSITIVE_ARTIFACT_KEY = re.compile(
    r"(password|passwd|pwd|street[_-]?address|address[_-]?line|resume(?:_body|_text)?|cover[_-]?letter)",
    re.IGNORECASE,
)
CONTEXT_VALUE_KEYS = {
    "answer",
    "backing_value",
    "content",
    "raw_value",
    "text",
    "value",
}
URL_KEYS = {"url", "request_url", "document_url", "page_url"}
REQUIRED_ARTIFACT_FILES = {
    "dom.html",
    "fields.json",
    "validation.json",
    "progress.json",
    "console.json",
    "network.json",
    "health.json",
    "events.json",
    "checkpoints.json",
}
MAX_DOM_BYTES = 500_000
MAX_JSON_SECTION_BYTES = 256_000
MAX_ARTIFACT_FILE_BYTES = 1_000_000
MAX_ARTIFACT_BUNDLE_BYTES = 4_000_000
MAX_MANIFEST_BYTES = 64 * 1024
HASH_CHUNK_BYTES = 64 * 1024
STRUCTURAL_LABEL_BYTES = 240
STRUCTURAL_ATTRIBUTE_BYTES = 160
MAX_SECTION_ITEMS = 200
MAX_SECTION_MAPPING_KEYS = 128
MAX_SECTION_DEPTH = 8
MAX_SECTION_NODES = 2_000
MAX_SECTION_STRING_BYTES = 20_000
STRUCTURAL_ALLOWED_ATTRIBUTES = {
    "id",
    "name",
    "role",
    "type",
    "required",
    "disabled",
    "readonly",
    "multiple",
    "checked",
    "selected",
    "aria-label",
    "aria-controls",
    "aria-owns",
    "aria-expanded",
    "aria-selected",
    "aria-invalid",
    "data-automation-id",
    "autocomplete",
    "href",
}
STRUCTURAL_BOOLEAN_ATTRIBUTES = {
    "required",
    "disabled",
    "readonly",
    "multiple",
    "checked",
    "selected",
}
STRUCTURAL_SENSITIVE_LABEL_ATTRIBUTES = {"aria-label"}
STRUCTURAL_URL_ATTRIBUTES = {"href"}


class C3ArtifactStore:
    def __init__(self, root: str | Path) -> None:
        self.root = Path(root).resolve()

    def capture_failure_bundle(
        self,
        *,
        session_id: str,
        operation_id: str,
        reason_code: str,
        diagnostics: dict[str, Any],
        screenshot: bytes | None = None,
        operation_directory: str | Path | None = None,
    ) -> dict[str, Any]:
        _safe_identity(session_id)
        _safe_identity(operation_id)
        artifact_id = f"artifact_{uuid.uuid4().hex}"
        if operation_directory is None:
            operation_root = (
                self.root
                / "c3"
                / "sessions"
                / datetime.now(UTC).date().isoformat()
                / session_id
                / "operations"
                / operation_id
            )
        else:
            operation_root = Path(operation_directory).resolve()
            _require_contained(self.root, operation_root)
        directory = (operation_root / "artifacts" / artifact_id).resolve()
        _require_contained(self.root, directory)
        directory.mkdir(parents=True, exist_ok=False)

        files: list[dict[str, Any]] = []
        redaction_rules: set[str] = set()
        if screenshot is not None:
            redaction_rules.add("screenshot:omitted_unmasked")

        dom, dom_truncated = sanitize_structural_dom(
            str(diagnostics.get("dom") or ""), max_bytes=MAX_DOM_BYTES
        )
        safe_dom, dom_info = redact_payload(dom)
        redaction_rules.update(dom_info["rules"])
        if dom_truncated:
            redaction_rules.add("artifact_limit:dom")
        files.append(
            _write_text(directory / "dom.html", str(safe_dom), max_bytes=MAX_ARTIFACT_FILE_BYTES)
        )

        sections = {
            "fields": diagnostics.get("fields", []),
            "validation": diagnostics.get("validation", []),
            "progress": diagnostics.get("progress", {}),
            "console": diagnostics.get("console", []),
            "network": diagnostics.get("network", []),
            "health": diagnostics.get("health", {}),
            "events": list(islice(iter(diagnostics.get("events", []) or []), 100)),
            "checkpoints": diagnostics.get("checkpoints", []),
        }
        for name, value in sections.items():
            value, input_truncated = _bounded_artifact_value(value)
            artifact_safe, artifact_rules = _artifact_redact(value, name)
            safe_value, redaction_info = redact_payload(artifact_safe)
            redaction_rules.update(artifact_rules)
            redaction_rules.update(redaction_info["rules"])
            entry, section_truncated = _write_json(
                directory / f"{name}.json",
                safe_value,
                max_bytes=MAX_JSON_SECTION_BYTES,
            )
            files.append(entry)
            if input_truncated or section_truncated:
                redaction_rules.add(f"artifact_limit:{name}")

        if sum(int(entry["bytes"]) for entry in files) > MAX_ARTIFACT_BUNDLE_BYTES:
            raise ValueError("artifact_bundle_too_large")

        manifest = {
            "artifact_id": artifact_id,
            "session_id": session_id,
            "operation_id": operation_id,
            "reason_code": str(reason_code or "failure"),
            "created_at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
            "redaction": {
                "applied": bool(redaction_rules),
                "rules": sorted(redaction_rules),
            },
            "files": files,
        }
        manifest_path = directory / "manifest.json"
        manifest_data = (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode("utf-8")
        if len(manifest_data) > MAX_MANIFEST_BYTES:
            raise ValueError("artifact_manifest_too_large")
        _atomic_bytes(manifest_path, manifest_data)
        return {
            "artifact_id": artifact_id,
            "manifest_path": str(manifest_path),
            "files": files,
        }

    def validate_failure_bundle(
        self,
        *,
        session_id: str,
        operation_id: str,
        artifact_id: str,
        operation_directory: str | Path,
    ) -> dict[str, Any]:
        _safe_identity(session_id)
        _safe_identity(operation_id)
        _safe_identity(artifact_id)
        operation_root = Path(operation_directory).resolve()
        _require_contained(self.root, operation_root)
        directory = (operation_root / "artifacts" / artifact_id).resolve()
        _require_contained(operation_root, directory)
        manifest_path = (directory / "manifest.json").resolve()
        _require_contained(directory, manifest_path)
        try:
            if manifest_path.stat().st_size > MAX_MANIFEST_BYTES:
                raise ValueError("artifact_manifest_too_large")
            with manifest_path.open("rb") as stream:
                raw_manifest = stream.read(MAX_MANIFEST_BYTES + 1)
            if len(raw_manifest) > MAX_MANIFEST_BYTES:
                raise ValueError("artifact_manifest_too_large")
            manifest = json.loads(raw_manifest)
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError("artifact_manifest_invalid") from exc
        if not isinstance(manifest, dict):
            raise ValueError("artifact_manifest_invalid")
        expected_identity = {
            "artifact_id": artifact_id,
            "session_id": session_id,
            "operation_id": operation_id,
        }
        if any(manifest.get(key) != value for key, value in expected_identity.items()):
            raise ValueError("artifact_manifest_identity_mismatch")
        files = manifest.get("files")
        if not isinstance(files, list) or len(files) > 64:
            raise ValueError("artifact_manifest_files_invalid")
        manifest_names = {
            str(entry.get("name") or "") for entry in files if isinstance(entry, dict)
        }
        if len(manifest_names) != len(files) or manifest_names != REQUIRED_ARTIFACT_FILES:
            raise ValueError("artifact_manifest_files_invalid")
        bundle_bytes = 0
        for entry in files:
            if not isinstance(entry, dict):
                raise ValueError("artifact_manifest_files_invalid")
            name = str(entry.get("name") or "")
            if not name or not SAFE_ID.fullmatch(name):
                raise ValueError("artifact_manifest_file_name_invalid")
            path = (directory / name).resolve()
            _require_contained(directory, path)
            try:
                actual_bytes = path.stat().st_size
            except OSError as exc:
                raise ValueError("artifact_file_missing") from exc
            expected_bytes = entry.get("bytes")
            if actual_bytes > MAX_ARTIFACT_FILE_BYTES:
                raise ValueError("artifact_file_too_large")
            if not isinstance(expected_bytes, int) or expected_bytes < 0:
                raise ValueError("artifact_file_size_mismatch")
            if expected_bytes > MAX_ARTIFACT_FILE_BYTES:
                raise ValueError("artifact_file_too_large")
            if actual_bytes != expected_bytes:
                raise ValueError("artifact_file_size_mismatch")
            bundle_bytes += actual_bytes
            if bundle_bytes > MAX_ARTIFACT_BUNDLE_BYTES:
                raise ValueError("artifact_bundle_too_large")
            if _stream_sha256(path) != str(entry.get("sha256") or ""):
                raise ValueError("artifact_file_hash_mismatch")
        return manifest


def _artifact_redact(value: Any, key: str = "") -> tuple[Any, set[str]]:
    rules: set[str] = set()
    if key and SENSITIVE_ARTIFACT_KEY.search(key):
        return REDACTED, {f"artifact_key:{key}"}
    if isinstance(value, dict):
        output = {}
        for child_key, child_value in value.items():
            normalized_key = _normalized_key(child_key)
            value_like = normalized_key in CONTEXT_VALUE_KEYS or normalized_key.endswith(
                ("_answer", "_content", "_raw_value", "_text", "_value")
            )
            if value_like:
                safe = REDACTED
                child_rules = {f"artifact_context:{normalized_key}"}
            elif normalized_key in URL_KEYS and isinstance(child_value, str):
                safe = _sanitize_url(child_value)
                child_rules = {f"artifact_url:{normalized_key}"} if safe != child_value else set()
            else:
                safe, child_rules = _artifact_redact(child_value, str(child_key))
            output[str(child_key)] = safe
            rules.update(child_rules)
        return output, rules
    if isinstance(value, (list, tuple)):
        output = []
        for child in value:
            safe, child_rules = _artifact_redact(child, key)
            output.append(safe)
            rules.update(child_rules)
        return output, rules
    return value, rules


def _bounded_artifact_value(
    value: Any,
    *,
    _depth: int = 0,
    _budget: dict[str, int] | None = None,
    _ancestors: frozenset[int] = frozenset(),
) -> tuple[Any, bool]:
    budget = _budget if _budget is not None else {"nodes": 0}
    budget["nodes"] += 1
    if budget["nodes"] > MAX_SECTION_NODES or _depth > MAX_SECTION_DEPTH:
        return {"truncated": True, "reason": "artifact_section_structure_limit"}, True
    if isinstance(value, str):
        retained = _truncate_utf8(value, MAX_SECTION_STRING_BYTES)
        return retained, retained != value
    if isinstance(value, dict):
        object_id = id(value)
        if object_id in _ancestors:
            return {"truncated": True, "reason": "artifact_section_cycle"}, True
        output: dict[str, Any] = {}
        truncated = len(value) > MAX_SECTION_MAPPING_KEYS
        ancestors = _ancestors | {object_id}
        for child_key in islice(value, MAX_SECTION_MAPPING_KEYS):
            child, child_truncated = _bounded_artifact_value(
                value[child_key],
                _depth=_depth + 1,
                _budget=budget,
                _ancestors=ancestors,
            )
            output[str(child_key)[:160]] = child
            truncated = truncated or child_truncated
        return output, truncated
    if isinstance(value, (list, tuple)):
        object_id = id(value)
        if object_id in _ancestors:
            return [{"truncated": True, "reason": "artifact_section_cycle"}], True
        ancestors = _ancestors | {object_id}
        output = []
        truncated = len(value) > MAX_SECTION_ITEMS
        for child in islice(value, MAX_SECTION_ITEMS):
            safe, child_truncated = _bounded_artifact_value(
                child,
                _depth=_depth + 1,
                _budget=budget,
                _ancestors=ancestors,
            )
            output.append(safe)
            truncated = truncated or child_truncated
        return output, truncated
    if value is None or isinstance(value, (bool, int, float)):
        return value, False
    return _truncate_utf8(str(value), MAX_SECTION_STRING_BYTES), True


def _normalized_key(value: Any) -> str:
    key = re.sub(r"(?<!^)(?=[A-Z])", "_", str(value))
    return key.lower().replace("-", "_")


class _StructureOnlyHTMLParser(HTMLParser):
    _SAFE_TEXT_TAGS = {"label", "legend", "th", "caption"}

    def __init__(self, *, max_bytes: int) -> None:
        super().__init__(convert_charrefs=True)
        self.output: list[str] = []
        self.stack: list[dict[str, Any]] = []
        self.max_bytes = max(1, int(max_bytes))
        self.output_bytes = 0
        self.truncated = False

    def _append(self, value: str) -> None:
        if not value or self.output_bytes >= self.max_bytes:
            if value:
                self.truncated = True
            return
        encoded = value.encode("utf-8")
        remaining = self.max_bytes - self.output_bytes
        if len(encoded) > remaining:
            value = encoded[:remaining].decode("utf-8", errors="ignore")
            encoded = value.encode("utf-8")
            self.truncated = True
        self.output.append(value)
        self.output_bytes += len(encoded)

    def _safe_start_tag(self, tag: str, attrs: list[tuple[str, str | None]]) -> str:
        safe_attrs: list[str] = []
        for raw_name, raw_value in attrs:
            name = str(raw_name or "").lower()
            if name not in STRUCTURAL_ALLOWED_ATTRIBUTES:
                continue
            if name in STRUCTURAL_BOOLEAN_ATTRIBUTES:
                safe_attrs.append(name)
                continue
            value = str(raw_value or "")
            if name in STRUCTURAL_SENSITIVE_LABEL_ATTRIBUTES:
                value = REDACTED
            elif name in STRUCTURAL_URL_ATTRIBUTES:
                value = _sanitize_url(value)
            else:
                safe_value, _info = redact_payload(value)
                value = str(safe_value)
            value = _truncate_utf8(value, STRUCTURAL_ATTRIBUTE_BYTES)
            safe_attrs.append(f'{name}="{html.escape(value, quote=True)}"')
        suffix = f" {' '.join(safe_attrs)}" if safe_attrs else ""
        return f"<{tag.lower()}{suffix}>"

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        normalized = tag.lower()
        self.stack.append(
            {
                "tag": normalized,
                "label_remaining": STRUCTURAL_LABEL_BYTES
                if normalized in self._SAFE_TEXT_TAGS
                else None,
            }
        )
        self._append(self._safe_start_tag(normalized, attrs))

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        value = self._safe_start_tag(tag, attrs)
        self._append(value[:-1] + "/>")

    def handle_endtag(self, tag: str) -> None:
        self._append(f"</{tag.lower()}>")
        if self.stack:
            self.stack.pop()

    def handle_data(self, data: str) -> None:
        if not data.strip():
            self._append(data)
            return
        label_frame = next(
            (frame for frame in reversed(self.stack) if frame["label_remaining"] is not None),
            None,
        )
        if label_frame is None:
            self._append(REDACTED)
            return
        safe_data, _info = redact_payload(data)
        retained = _truncate_utf8(str(safe_data), int(label_frame["label_remaining"]))
        label_frame["label_remaining"] -= len(retained.encode("utf-8"))
        if retained != data:
            self.truncated = True
        self._append(html.escape(retained, quote=False))

    def handle_comment(self, data: str) -> None:
        del data
        self._append("<!--[REDACTED]-->")


def sanitize_structural_dom(value: str, *, max_bytes: int = MAX_DOM_BYTES) -> tuple[str, bool]:
    """Return bounded DOM structure with only non-answer-bearing attributes and labels."""

    parser = _StructureOnlyHTMLParser(max_bytes=max_bytes)
    try:
        parser.feed(value)
        parser.close()
    except Exception:
        return REDACTED, True
    return "".join(parser.output), parser.truncated


def _sanitize_url(value: str) -> str:
    try:
        parsed = urlsplit(value)
    except ValueError:
        return REDACTED
    if not parsed.scheme or not parsed.netloc:
        return value.split("?", 1)[0].split("#", 1)[0]
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, "", ""))


def _write_json(
    path: Path, value: Any, *, max_bytes: int = MAX_JSON_SECTION_BYTES
) -> tuple[dict[str, Any], bool]:
    data = (json.dumps(value, indent=2, sort_keys=True) + "\n").encode("utf-8")
    truncated = len(data) > max_bytes
    if truncated:
        data = json.dumps(
            {
                "truncated": True,
                "reason": "artifact_section_byte_limit",
                "original_bytes_at_least": len(data),
            },
            sort_keys=True,
        ).encode("utf-8")
    _atomic_bytes(path, data)
    return _file_entry(path, data), truncated


def _write_text(
    path: Path, value: str, *, max_bytes: int = MAX_ARTIFACT_FILE_BYTES
) -> dict[str, Any]:
    data = value.encode("utf-8")
    if len(data) > max_bytes:
        raise ValueError("artifact_file_too_large")
    _atomic_bytes(path, data)
    return _file_entry(path, data)


def _write_bytes(path: Path, data: bytes) -> dict[str, Any]:
    _atomic_bytes(path, data)
    return _file_entry(path, data)


def _atomic_text(path: Path, value: str) -> None:
    _atomic_bytes(path, value.encode("utf-8"))


def _atomic_bytes(path: Path, data: bytes) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_bytes(data)
    temporary.replace(path)


def _file_entry(path: Path, data: bytes) -> dict[str, Any]:
    return {
        "name": path.name,
        "bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
    }


def _stream_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(HASH_CHUNK_BYTES):
            digest.update(chunk)
    return digest.hexdigest()


def _truncate_utf8(value: str, limit: int) -> str:
    return value.encode("utf-8")[: max(0, int(limit))].decode("utf-8", errors="ignore")


def _safe_identity(value: str) -> None:
    if not value or not SAFE_ID.fullmatch(value):
        raise ValueError("unsafe_artifact_identity")


def _require_contained(root: Path, target: Path) -> None:
    try:
        target.relative_to(root)
    except ValueError as exc:
        raise ValueError("unsafe_artifact_path") from exc
