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


_SKILL_MARKER_START = "<!-- AUTO-UPDATED by: python -m coordinator.cli sync-investigator-skill -->"
_SKILL_MARKER_END = "<!-- END KNOWN PATTERNS -->"

_DEFAULT_SKILL_PATH = (
    Path.home() / ".hermes" / "skills" / "hunt" / "c4-ats-investigator" / "SKILL.md"
)
_REPO_SKILL_PATH = Path(__file__).parent / "agents" / "hermes" / "c4_ats_investigator_skill.md"


def sync_investigator_skill(
    logs_dir: Path,
    *,
    limit: int = 200,
    skill_path: Path | None = None,
) -> dict[str, Any]:
    """Read completed investigation results from failures.jsonl and update
    the Known Patterns section of the Hermes investigator skill file.

    Returns a summary dict with counts and the path written.
    """
    from datetime import UTC, datetime

    entries = read_failure_log(logs_dir, limit=limit)
    completed = [
        e
        for e in entries
        if e.get("investigation_status") == "complete" and e.get("agent_findings")
    ]

    # Group by ATS type
    by_ats: dict[str, list[dict[str, Any]]] = {}
    for entry in completed:
        ats = str(entry.get("ats_type") or "unknown").lower()
        by_ats.setdefault(ats, []).append(entry)

    # Build patterns markdown
    now = datetime.now(UTC).replace(microsecond=0).isoformat()
    lines: list[str] = [
        _SKILL_MARKER_START,
        f"<!-- Last sync: {now} -->",
        f"<!-- Entries read: {len(entries)} | Completed investigations: {len(completed)} -->",
        "",
    ]

    if not completed:
        lines.append("No completed investigations yet.")
    else:
        for ats, items in sorted(by_ats.items()):
            lines.append(f"### {ats.title()} — {len(items)} investigation(s)")
            for item in items[-5:]:  # last 5 per ATS type
                fc = item.get("failure_code", "unknown")
                fix = item.get("suggested_fix_area", "")
                findings = (item.get("agent_findings") or "")[:300]
                widget = item.get("unknown_widget") or {}
                selector = widget.get("selector", "")
                role = widget.get("role", "")
                label = widget.get("label", "")
                lines.append(f"\n**Failure:** `{fc}`")
                if selector or role or label:
                    lines.append(f"**Widget:** selector=`{selector}` role=`{role}` label=`{label}`")
                if findings:
                    lines.append(f"**Findings:** {findings}")
                if fix:
                    lines.append(f"**Suggested fix:** {fix}")
            lines.append("")

    lines.append(_SKILL_MARKER_END)
    patterns_block = "\n".join(lines)

    # Determine target skill files
    targets: list[Path] = []
    if skill_path:
        targets.append(skill_path)
    else:
        targets.append(_DEFAULT_SKILL_PATH)
        if _REPO_SKILL_PATH.exists():
            targets.append(_REPO_SKILL_PATH)

    written: list[str] = []
    for target in targets:
        if not target.exists():
            continue
        text = target.read_text(encoding="utf-8")
        # Replace existing block or append
        if _SKILL_MARKER_START in text:
            start = text.index(_SKILL_MARKER_START)
            if _SKILL_MARKER_END in text:
                end = text.index(_SKILL_MARKER_END) + len(_SKILL_MARKER_END)
                text = text[:start] + patterns_block + text[end:]
            else:
                text = text[:start] + patterns_block
        else:
            text = text.rstrip() + "\n\n" + patterns_block + "\n"
        target.write_text(text, encoding="utf-8")
        written.append(str(target))

    return {
        "entries_read": len(entries),
        "completed_investigations": len(completed),
        "ats_types": sorted(by_ats.keys()),
        "skill_files_updated": written,
        "synced_at": now,
    }


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
