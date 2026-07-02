from __future__ import annotations

import hashlib
import os
import re
from collections.abc import Mapping
from typing import Any

REDACTED = "[REDACTED]"
MAX_SAFE_TEXT_PREVIEW = 240

SENSITIVE_KEY_RE = re.compile(
    r"(password|passwd|pwd|token|access[_-]?token|refresh[_-]?token|api[_-]?key|secret|cookie|authorization|auth[_-]?header|set[_-]?cookie)",
    re.IGNORECASE,
)
CODE_KEY_RE = re.compile(
    r"(verification|otp|mfa|2fa|one[_-]?time).*code|code.*(verification|otp|mfa|2fa)", re.IGNORECASE
)
TEXT_KEY_RE = re.compile(r"(resume|cover[_-]?letter|page[_-]?text|field[_-]?text)", re.IGNORECASE)
EMAIL_RE = re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.IGNORECASE)
PHONE_RE = re.compile(r"(?<!\d)(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}(?!\d)")
EMAIL_CODE_RE = re.compile(
    r"\b(?:code|verification code|otp)[:\s-]*([A-Z0-9]{4,8})\b", re.IGNORECASE
)


def _rule(rules: set[str], name: str) -> None:
    rules.add(name)


def _redact_string(value: str, rules: set[str]) -> str:
    redacted = value
    if EMAIL_RE.search(redacted):
        redacted = EMAIL_RE.sub(REDACTED, redacted)
        _rule(rules, "email")
    if PHONE_RE.search(redacted):
        redacted = PHONE_RE.sub(REDACTED, redacted)
        _rule(rules, "phone")
    if EMAIL_CODE_RE.search(redacted):
        redacted = EMAIL_CODE_RE.sub(
            lambda match: match.group(0).replace(match.group(1), REDACTED), redacted
        )
        _rule(rules, "email_code")
    return redacted


def _redact_value(value: Any, rules: set[str], key: str | None = None) -> Any:
    key_name = key or ""
    if key_name and SENSITIVE_KEY_RE.search(key_name):
        _rule(rules, f"key:{key_name}")
        return REDACTED
    if key_name and CODE_KEY_RE.search(key_name):
        _rule(rules, f"key:{key_name}")
        return REDACTED

    if isinstance(value, Mapping):
        return {str(k): _redact_value(v, rules, str(k)) for k, v in value.items()}
    if isinstance(value, list):
        return [_redact_value(item, rules, key_name) for item in value]
    if isinstance(value, tuple):
        return [_redact_value(item, rules, key_name) for item in value]
    if isinstance(value, str):
        if key_name and TEXT_KEY_RE.search(key_name) and len(value) > MAX_SAFE_TEXT_PREVIEW:
            _rule(rules, f"preview:{key_name}")
            value = f"{value[:MAX_SAFE_TEXT_PREVIEW]}...[TRUNCATED]"
        return _redact_string(value, rules)
    return value


def redact_payload(payload: Any) -> tuple[Any, dict[str, Any]]:
    rules: set[str] = set()
    redacted = _redact_value(payload, rules)
    return redacted, {"applied": bool(rules), "rules": sorted(rules)}


def redact_event(event: Mapping[str, Any]) -> dict[str, Any]:
    safe = dict(event)
    payload, info = redact_payload(safe.get("payload", {}))
    safe["payload"] = payload
    existing = safe.get("redaction") if isinstance(safe.get("redaction"), Mapping) else {}
    existing_rules = existing.get("rules", []) if isinstance(existing, Mapping) else []
    rules = sorted({str(rule) for rule in existing_rules} | set(info["rules"]))
    safe["redaction"] = {"applied": bool(rules) or bool(existing.get("applied")), "rules": rules}
    return safe


def env_check(name: str, expected_value: str | None = None) -> dict[str, Any]:
    value = os.getenv(name)
    present = value is not None
    payload: dict[str, Any] = {"name": name, "present": present}
    if present:
        encoded = value.encode("utf-8")
        payload["length"] = len(value)
        payload["sha256_prefix"] = hashlib.sha256(encoded).hexdigest()[:12]
    if expected_value is not None:
        payload["matches_expected"] = value == expected_value
    return payload
