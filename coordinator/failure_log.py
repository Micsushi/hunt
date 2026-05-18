"""Structured failure report writer and append-only perma-log for C4."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

INVESTIGATION_TRIGGER_CODES = frozenset(
    {
        "unknown_widget",
        "captcha_hcaptcha",
        "captcha_recaptcha",
        "captcha_cloudflare",
        "captcha_unknown",
    }
)

CAPTCHA_CODES = frozenset(
    {
        "captcha_hcaptcha",
        "captcha_recaptcha",
        "captcha_cloudflare",
        "captcha_unknown",
    }
)


def derive_failure_code(fill_result: dict[str, Any], review_flags: list[str]) -> str:
    """Derive a structured failure code from a C3 fill result + review flags."""
    explicit = str(fill_result.get("failure_code") or fill_result.get("failureCode") or "").strip()
    if explicit:
        return explicit

    # Map structured C3 captcha detection to typed codes
    captcha_type = str(fill_result.get("captcha_type") or fill_result.get("captchaType") or "")
    if captcha_type:
        ct = captcha_type.lower().strip()
        if "hcaptcha" in ct:
            return "captcha_hcaptcha"
        if "recaptcha" in ct:
            return "captcha_recaptcha"
        if "cloudflare" in ct:
            return "captcha_cloudflare"
        return "captcha_unknown"

    # Map review flags to codes
    flag_to_code = {
        "unknown_widget": "unknown_widget",
        "captcha_challenge": "captcha_unknown",
        "login_required": "login_required",
        "auth_required": "auth_required",
        "otp_required": "otp_required",
        "verification_required": "verification_required",
        "security_challenge": "security_challenge",
        "missing_required_fields": "missing_required_field",
        "resume_upload_failure": "resume_upload_failure",
        "unsupported_ats_step": "unsupported_ats_step",
    }
    for flag in review_flags:
        code = flag_to_code.get(flag)
        if code:
            return code

    status = str(fill_result.get("status") or "").lower()
    if status in {"failed", "error"}:
        return "fill_failed"
    if status == "manual_review":
        return "manual_review"
    return "unknown"


def write_failure_report(
    run_dir: Path,
    *,
    run_id: str,
    job_id: int,
    ats_type: str | None,
    apply_url: str | None,
    failure_code: str,
    fill_result: dict[str, Any],
    investigation_status: str = "pending",
) -> tuple[Path, dict[str, Any]]:
    """Write failure_report.json to run_dir. Returns (path, report_dict)."""
    raw_widget = fill_result.get("unknown_widget") or fill_result.get("unknownWidget") or {}
    report: dict[str, Any] = {
        "run_id": run_id,
        "job_id": job_id,
        "ats_type": ats_type or "unknown",
        "apply_url": apply_url or "",
        "failure_code": failure_code,
        "unknown_widget": {
            "selector": raw_widget.get("selector", ""),
            "role": raw_widget.get("role", ""),
            "label": raw_widget.get("label", ""),
            "html_excerpt": raw_widget.get("html_excerpt") or raw_widget.get("htmlExcerpt", ""),
        },
        "agent_findings": "",
        "suggested_fix_area": "",
        "screenshots": [],
        "html_snapshot": "",
        "investigation_status": investigation_status,
        "timestamp": datetime.now(UTC).replace(microsecond=0).isoformat(),
    }
    run_dir.mkdir(parents=True, exist_ok=True)
    report_path = run_dir / "failure_report.json"
    report_path.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    return report_path, report


def append_perma_log(logs_dir: Path, report: dict[str, Any]) -> None:
    """Append one failure report entry to logs/failures.jsonl (append-only)."""
    logs_dir.mkdir(parents=True, exist_ok=True)
    log_path = logs_dir / "failures.jsonl"
    with log_path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(report, ensure_ascii=False) + "\n")


def merge_investigation_result(
    report_path: Path, investigation_result: dict[str, Any]
) -> dict[str, Any]:
    """Merge an agent investigation result into an existing failure_report.json."""
    try:
        report: dict[str, Any] = json.loads(report_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        report = {}

    report["agent_findings"] = investigation_result.get("agent_findings", "")
    report["suggested_fix_area"] = investigation_result.get("suggested_fix_area", "")
    report["screenshots"] = investigation_result.get("screenshots") or []
    report["html_snapshot"] = investigation_result.get("html_snapshot") or ""

    widget = investigation_result.get("widget_details") or {}
    if widget:
        report["unknown_widget"] = {
            "selector": widget.get("selector", ""),
            "role": widget.get("role", ""),
            "label": widget.get("label", ""),
            "html_excerpt": widget.get("html_excerpt", ""),
        }

    confirmed = investigation_result.get("failure_code_confirmed")
    if confirmed:
        report["failure_code"] = confirmed

    agent_status = str(investigation_result.get("status") or "complete").lower()
    if "captcha" in agent_status:
        report["investigation_status"] = "captcha_escalated"
    else:
        report["investigation_status"] = "complete"

    report_path.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    return report


def read_failure_log(logs_dir: Path, *, limit: int = 100) -> list[dict[str, Any]]:
    """Read the last `limit` entries from failures.jsonl."""
    log_path = logs_dir / "failures.jsonl"
    if not log_path.exists():
        return []
    lines = log_path.read_text(encoding="utf-8").splitlines()
    entries: list[dict[str, Any]] = []
    for line in lines[-limit:]:
        line = line.strip()
        if not line:
            continue
        try:
            entries.append(json.loads(line))
        except json.JSONDecodeError:
            pass
    return entries
