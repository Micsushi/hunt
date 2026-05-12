#!/usr/bin/env python3
"""Summarize C3 extension debug logs into a standardized gap report."""

from __future__ import annotations

import argparse
import json
import re
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_LOG_PATH = ROOT / "logs" / "c3_extension_debug.jsonl"
SUPPORT_MATRIX_PATH = ROOT / "executioner" / "src" / "ats" / "support-matrix.js"
REPORT_SCHEMA_VERSION = "hunt.c3.gap_report.v1"

ANSWERABLE_LLM_REASONS = {
    "no_known_choice",
    "no_matching_option",
    "no_known_match",
    "no_known_fields_filled",
}

SAFE_SKIP_REASONS = {
    "excluded_phrase",
    "unsafe_generated_answer_context",
    "unsafe_profile_context",
}

OPTIONAL_SKIP_REASONS = {
    "not_required",
}

UNSUPPORTED_REASONS = {
    "unsupported_checkbox",
    "unsupported_widget",
    "not_resume_input",
}

COMMIT_FAILURE_REASONS = {
    "checkbox_commit_failed",
    "clear_failed",
    "clear_failed_commit_not_verified",
    "clear_failed_no_matching_option",
    "commit_lost",
    "commit_not_verified",
    "decision_not_committed_to_page",
    "commit_failed",
    "option_not_committed",
    "typed_not_committed",
}

STANDARD_FIELD_STATUSES = (
    "filled",
    "needs_llm",
    "unsupported_widget",
    "missing_profile_fact",
    "safe_skip",
    "optional_blank",
    "resume_issue",
    "commit_failed",
    "stale_options",
    "menu_open",
    "missing_descriptor",
    "manual_required",
    "unknown_unfilled",
)


def _utc_now() -> str:
    return datetime.now(UTC).isoformat()


def _count(counter: Counter[str]) -> dict[str, int]:
    return dict(sorted(counter.items()))


def _text(value: Any) -> str:
    if value is None:
        return ""
    return str(value)


def _host_from_url(value: str) -> str:
    try:
        return urlparse(value).hostname or ""
    except Exception:
        return ""


def load_support_levels(path: Path = SUPPORT_MATRIX_PATH) -> dict[str, str]:
    """Load ATS support levels from the JS support matrix without duplicating it."""

    if not path.exists():
        return {}
    text = path.read_text(encoding="utf-8")
    levels: dict[str, str] = {}
    for block in re.findall(r"\{(.*?)\}", text, flags=re.DOTALL):
        name_match = re.search(r'name:\s*"([^"]+)"', block)
        level_match = re.search(r'supportLevel:\s*"([^"]+)"', block)
        if name_match and level_match:
            levels[name_match.group(1)] = level_match.group(1)
    return levels


def _standard_field_status(field: dict[str, Any]) -> str:
    if bool(field.get("filled")):
        return "filled"

    reason = _text(field.get("skippedReason")).strip()
    required = bool(field.get("required"))
    has_options = bool(field.get("options"))

    if reason in ANSWERABLE_LLM_REASONS and required and has_options:
        return "needs_llm"
    if reason in UNSUPPORTED_REASONS:
        return "unsupported_widget"
    if reason in SAFE_SKIP_REASONS:
        return "safe_skip"
    if reason.startswith("resume_upload:") or reason == "resume_not_ready_for_c3":
        return "resume_issue"
    if reason in COMMIT_FAILURE_REASONS:
        return "commit_failed"
    if "stale" in reason:
        return "stale_options"
    if "menu" in reason and ("open" in reason or "close" in reason):
        return "menu_open"
    if reason == "missing_descriptor":
        return "missing_descriptor"
    if reason in OPTIONAL_SKIP_REASONS or (not required and reason):
        return "optional_blank"
    if reason in {"no_known_match", "no_matching_option", "no_known_choice"}:
        return "missing_profile_fact"
    if required:
        return "manual_required"
    return "unknown_unfilled"


def _failure_bucket(reason: str, *, field_status: str | None = None) -> str:
    reason = _text(reason).strip()
    if field_status in STANDARD_FIELD_STATUSES:
        return field_status
    if reason.startswith("required_field_unresolved:"):
        inner_reason = reason.split(":", 1)[1]
        return _failure_bucket(inner_reason) if inner_reason else "manual_required"
    if reason.startswith("resume_upload:"):
        return "resume_issue"
    if reason in SAFE_SKIP_REASONS:
        return "safe_skip"
    if reason in UNSUPPORTED_REASONS:
        return "unsupported_widget"
    if reason in COMMIT_FAILURE_REASONS:
        return "commit_failed"
    if reason in ANSWERABLE_LLM_REASONS:
        return "needs_llm"
    if reason in OPTIONAL_SKIP_REASONS:
        return "optional_blank"
    if "stale" in reason:
        return "stale_options"
    if "menu" in reason and ("open" in reason or "close" in reason):
        return "menu_open"
    if reason:
        return reason
    return "unknown"


def _field_widget_key(field: dict[str, Any]) -> str:
    kind = _text(field.get("kind")).strip()
    tag = _text(field.get("tagName")).strip().lower()
    typ = _text(field.get("type")).strip().lower()
    if kind:
        return kind
    if tag and typ:
        return f"{tag}:{typ}"
    return tag or "unknown"


def _summarize_field(field: dict[str, Any]) -> dict[str, Any]:
    status = _standard_field_status(field)
    reason = _text(field.get("skippedReason")).strip()
    return {
        "status": status,
        "failureBucket": _failure_bucket(reason, field_status=status),
        "required": bool(field.get("required")),
        "filled": bool(field.get("filled")),
        "reason": reason,
        "kind": _text(field.get("kind")),
        "tagName": _text(field.get("tagName")),
        "type": _text(field.get("type")),
        "id": _text(field.get("id")),
        "name": _text(field.get("name")),
        "questionHash": _text(field.get("questionHash")),
        "descriptor": _text(field.get("descriptor"))[:240],
        "optionCount": len(field.get("options") or []),
        "valueSource": _text(field.get("valueSource")),
    }


def _extract_c3_event(raw: dict[str, Any]) -> dict[str, Any] | None:
    payload = raw.get("payload")
    if not isinstance(payload, dict):
        return None
    event_type = _text(payload.get("eventType"))
    event_payload = payload.get("payload")
    if not isinstance(event_payload, dict):
        event_payload = {}
    return {
        "receivedAt": _text(raw.get("received_at")),
        "eventType": event_type,
        "extensionTime": _text(payload.get("extensionTime")),
        "activeApplyContext": payload.get("activeApplyContext") or {},
        "payload": event_payload,
    }


def _extract_attempt(
    event: dict[str, Any],
    *,
    support_levels: dict[str, str],
    max_unresolved_fields: int,
) -> dict[str, Any] | None:
    if event["eventType"] not in {"fill_result", "llm_fill_result"}:
        return None

    payload = event["payload"]
    attempt = payload.get("attempt") if isinstance(payload.get("attempt"), dict) else {}
    result = payload.get("result") if isinstance(payload.get("result"), dict) else {}
    route = payload.get("route") if isinstance(payload.get("route"), dict) else {}
    active_context = event.get("activeApplyContext") or {}

    apply_url = (
        _text(attempt.get("applyUrl"))
        or _text(active_context.get("applyUrl"))
        or _text(result.get("finalUrl"))
        or _text(result.get("frameUrl"))
    )
    host = _host_from_url(apply_url) or _host_from_url(_text(result.get("frameUrl")))
    ats_type = (
        _text(result.get("atsType"))
        or _text(attempt.get("atsType"))
        or _text(route.get("adapterName"))
        or "unknown"
    )
    support_level = support_levels.get(ats_type, "unknown")
    if ats_type == "generic" and support_level == "unknown":
        support_level = "generic_fallback"

    fields = result.get("fieldInventory") or attempt.get("fieldInventory") or []
    if not isinstance(fields, list):
        fields = []

    field_summaries = [_summarize_field(field) for field in fields if isinstance(field, dict)]
    field_status_counts = Counter(field["status"] for field in field_summaries)
    failure_bucket_counts = Counter(
        field["failureBucket"] for field in field_summaries if field["status"] != "filled"
    )
    skipped_reason_counts = Counter(field["reason"] for field in field_summaries if field["reason"])
    widget_counts = Counter(_field_widget_key(field) for field in fields if isinstance(field, dict))

    manual_reasons = attempt.get("manualReviewReasons") or result.get("manualReviewReasons") or []
    if not isinstance(manual_reasons, list):
        manual_reasons = []
    for reason in manual_reasons:
        failure_bucket_counts[_failure_bucket(_text(reason))] += 1

    diagnostics = result.get("answerDecisionDiagnostics") or result.get("diagnostics") or []
    if not isinstance(diagnostics, list):
        diagnostics = []
    for diagnostic in diagnostics:
        if isinstance(diagnostic, dict):
            reason = _text(diagnostic.get("reason"))
            failure_bucket_counts[_failure_bucket(reason)] += 1

    unresolved_fields = [
        field for field in field_summaries if field["required"] and not field["filled"]
    ]
    trace_truncated = bool(result.get("traceTruncated") or attempt.get("traceTruncated"))

    inventory_total = len(field_summaries)
    required_total = sum(1 for field in field_summaries if field["required"])
    filled_inventory_total = sum(1 for field in field_summaries if field["filled"])
    filled_count = int(result.get("filledFieldCount") or attempt.get("filledFieldCount") or 0)

    return {
        "attemptId": _text(attempt.get("id")),
        "receivedAt": event["receivedAt"],
        "extensionTime": event["extensionTime"],
        "eventType": event["eventType"],
        "stage": "llm" if event["eventType"] == "llm_fill_result" else "deterministic",
        "status": _text(attempt.get("status")) or ("ok" if payload.get("ok") else "failed"),
        "ok": bool(payload.get("ok", result.get("ok", False))),
        "message": _text(payload.get("message")),
        "host": host or "unknown",
        "applyUrl": apply_url,
        "frameUrl": _text(result.get("frameUrl")),
        "frameId": result.get("frameId"),
        "atsType": ats_type,
        "supportLevel": support_level,
        "fillRoute": _text(attempt.get("fillRoute")) or _text(route.get("routeName")),
        "route": {
            "fillSource": _text(route.get("fillSource")),
            "strategy": _text(route.get("strategy")),
            "adapterName": _text(route.get("adapterName")),
            "requestedAtsType": _text(route.get("requestedAtsType")),
            "detectedAtsType": _text(route.get("detectedAtsType")),
            "usedGenericFallback": bool(route.get("usedGenericFallback")),
            "adapterBackedByGeneric": bool(route.get("adapterBackedByGeneric"))
            or bool(result.get("adapterBackedByGeneric")),
        },
        "counts": {
            "inventoryTotal": inventory_total,
            "requiredTotal": required_total,
            "filledInventoryTotal": filled_inventory_total,
            "filledFieldCount": filled_count,
            "unresolvedRequiredTotal": len(unresolved_fields),
            "pendingLlmFieldCount": int(result.get("pendingLlmFieldCount") or 0),
            "generatedAnswerCount": int(
                result.get("generatedAnswerCount") or attempt.get("generatedAnswerCount") or 0
            ),
            "manualReviewReasonCount": len(manual_reasons),
            "diagnosticCount": len(diagnostics),
        },
        "fieldStatusCounts": _count(field_status_counts),
        "failureBucketCounts": _count(failure_bucket_counts),
        "skippedReasonCounts": _count(skipped_reason_counts),
        "widgetCounts": _count(widget_counts),
        "manualReviewReasons": [_text(reason) for reason in manual_reasons],
        "traceTruncated": trace_truncated,
        "frameResults": result.get("frameResults") or [],
        "unresolvedFields": unresolved_fields[:max_unresolved_fields],
    }


def _extract_clear_event(event: dict[str, Any]) -> dict[str, Any] | None:
    if event["eventType"] != "activity":
        return None
    activity = event["payload"].get("activity")
    if not isinstance(activity, dict) or activity.get("action") != "page.clear":
        return None
    details = activity.get("details") if isinstance(activity.get("details"), dict) else {}
    return {
        "activityId": _text(activity.get("id")),
        "receivedAt": event["receivedAt"],
        "extensionTime": event["extensionTime"],
        "status": _text(activity.get("status")) or "unknown",
        "summary": _text(activity.get("summary")),
        "tabId": details.get("tabId"),
        "counts": {
            "cleared": int(details.get("cleared") or 0),
            "closedDropdowns": int(details.get("closedDropdowns") or 0),
            "hiddenDropdownMenus": int(details.get("hiddenDropdownMenus") or 0),
            "openDropdownsBefore": int(details.get("openDropdownsBefore") or 0),
            "remainingOpenDropdowns": int(details.get("remainingOpenDropdowns") or 0),
            "remainingFilledControls": int(details.get("remainingFilledControls") or 0),
            "clearIndicatorClicks": int(details.get("clearIndicatorClicks") or 0),
            "frameCount": int(details.get("frameCount") or 0),
        },
    }


def iter_jsonl(path: Path) -> tuple[list[dict[str, Any]], int, int]:
    entries: list[dict[str, Any]] = []
    invalid_lines = 0
    total_lines = 0
    if not path.exists():
        return entries, total_lines, invalid_lines

    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            total_lines += 1
            line = line.strip()
            if not line:
                continue
            try:
                raw = json.loads(line)
            except json.JSONDecodeError:
                invalid_lines += 1
                continue
            if isinstance(raw, dict):
                entries.append(raw)
    return entries, total_lines, invalid_lines


def build_report(
    log_path: Path = DEFAULT_LOG_PATH,
    *,
    limit: int | None = None,
    include_fields: bool = False,
    max_unresolved_fields: int = 12,
    support_matrix_path: Path = SUPPORT_MATRIX_PATH,
) -> dict[str, Any]:
    raw_entries, total_lines, invalid_lines = iter_jsonl(log_path)
    support_levels = load_support_levels(support_matrix_path)
    event_type_counts: Counter[str] = Counter()
    attempts: list[dict[str, Any]] = []
    clear_events: list[dict[str, Any]] = []

    for raw in raw_entries:
        event = _extract_c3_event(raw)
        if not event:
            continue
        event_type_counts[event["eventType"]] += 1
        clear_event = _extract_clear_event(event)
        if clear_event:
            clear_events.append(clear_event)
        attempt = _extract_attempt(
            event,
            support_levels=support_levels,
            max_unresolved_fields=max_unresolved_fields,
        )
        if attempt:
            attempts.append(attempt)

    if limit is not None and limit >= 0:
        attempts = attempts[-limit:]
        clear_events = clear_events[-limit:]

    totals: dict[str, Any] = {
        "attemptCount": len(attempts),
        "clearEventCount": len(clear_events),
        "lineCount": total_lines,
        "invalidLineCount": invalid_lines,
        "eventTypeCounts": _count(event_type_counts),
    }
    aggregate_counters = {
        "byHost": Counter(),
        "byAts": Counter(),
        "bySupportLevel": Counter(),
        "byStatus": Counter(),
        "fieldStatusCounts": Counter(),
        "failureBucketCounts": Counter(),
        "skippedReasonCounts": Counter(),
        "widgetCounts": Counter(),
    }
    count_totals = Counter()
    trace_truncated_count = 0
    clear_status_counts: Counter[str] = Counter()
    clear_count_totals: Counter[str] = Counter()

    for attempt in attempts:
        if attempt.get("traceTruncated"):
            trace_truncated_count += 1
        aggregate_counters["byHost"][attempt["host"]] += 1
        aggregate_counters["byAts"][attempt["atsType"]] += 1
        aggregate_counters["bySupportLevel"][attempt["supportLevel"]] += 1
        aggregate_counters["byStatus"][attempt["status"]] += 1
        for key in (
            "inventoryTotal",
            "requiredTotal",
            "filledInventoryTotal",
            "filledFieldCount",
            "unresolvedRequiredTotal",
            "pendingLlmFieldCount",
            "generatedAnswerCount",
            "manualReviewReasonCount",
            "diagnosticCount",
        ):
            count_totals[key] += int(attempt["counts"].get(key) or 0)
        for counter_name in (
            "fieldStatusCounts",
            "failureBucketCounts",
            "skippedReasonCounts",
            "widgetCounts",
        ):
            aggregate_counters[counter_name].update(attempt.get(counter_name) or {})

    for event in clear_events:
        clear_status_counts[event["status"]] += 1
        for key, value in event["counts"].items():
            clear_count_totals[key] += int(value or 0)

    totals.update({name: _count(counter) for name, counter in aggregate_counters.items()})
    totals["countTotals"] = _count(count_totals)
    totals["traceTruncatedCount"] = trace_truncated_count
    totals["clearStatusCounts"] = _count(clear_status_counts)
    totals["clearCountTotals"] = _count(clear_count_totals)

    latest = attempts[-1] if attempts else None
    latest_clear = clear_events[-1] if clear_events else None
    if not include_fields:
        for attempt in attempts:
            attempt.pop("unresolvedFields", None)

    return {
        "schemaVersion": REPORT_SCHEMA_VERSION,
        "generatedAt": _utc_now(),
        "source": {
            "logPath": str(log_path),
            "supportMatrixPath": str(support_matrix_path),
        },
        "totals": totals,
        "latestAttempt": latest,
        "latestClear": latest_clear,
        "attempts": attempts,
        "clearEvents": clear_events,
    }


def _format_counter(title: str, values: dict[str, int], *, limit: int = 8) -> list[str]:
    if not values:
        return [f"{title}: none"]
    pairs = sorted(values.items(), key=lambda item: (-item[1], item[0]))[:limit]
    return [f"{title}: " + ", ".join(f"{key}={value}" for key, value in pairs)]


def format_text_report(report: dict[str, Any]) -> str:
    totals = report["totals"]
    latest = report.get("latestAttempt") or {}
    latest_clear = report.get("latestClear") or {}
    lines = [
        "C3 Gap Report",
        f"schema: {report['schemaVersion']}",
        f"source: {report['source']['logPath']}",
        f"attempts: {totals['attemptCount']}",
        f"lines: {totals['lineCount']} read, {totals['invalidLineCount']} invalid",
    ]

    if latest:
        counts = latest["counts"]
        lines.extend(
            [
                "",
                "Latest Attempt",
                f"time: {latest.get('receivedAt') or latest.get('extensionTime')}",
                f"host: {latest['host']}",
                f"ats: {latest['atsType']}",
                f"support: {latest['supportLevel']}",
                f"route: {latest['fillRoute']}",
                f"status: {latest['status']}",
                (
                    "counts: "
                    f"filled={counts['filledFieldCount']}, "
                    f"required={counts['requiredTotal']}, "
                    f"unresolved_required={counts['unresolvedRequiredTotal']}, "
                    f"pending_llm={counts['pendingLlmFieldCount']}, "
                    f"manual_reasons={counts['manualReviewReasonCount']}"
                ),
                f"trace_truncated: {'yes' if latest.get('traceTruncated') else 'no'}",
            ]
        )
        if latest.get("manualReviewReasons"):
            lines.append("manual_review: " + ", ".join(latest["manualReviewReasons"][:8]))
        unresolved = latest.get("unresolvedFields") or []
        if unresolved:
            lines.append("unresolved_fields:")
            for field in unresolved[:8]:
                label = field["descriptor"] or field["id"] or field["name"] or "unknown"
                lines.append(f"- {field['status']}: {label} ({field['reason'] or 'no_reason'})")

    if latest_clear:
        counts = latest_clear["counts"]
        lines.extend(
            [
                "",
                "Latest Clear",
                f"time: {latest_clear.get('receivedAt') or latest_clear.get('extensionTime')}",
                f"status: {latest_clear['status']}",
                f"summary: {latest_clear['summary']}",
                (
                    "counts: "
                    f"cleared={counts['cleared']}, "
                    f"closed_dropdowns={counts['closedDropdowns']}, "
                    f"hidden_menus={counts['hiddenDropdownMenus']}, "
                    f"open_before={counts['openDropdownsBefore']}, "
                    f"remaining_open={counts['remainingOpenDropdowns']}, "
                    f"remaining_filled={counts['remainingFilledControls']}, "
                    f"clear_clicks={counts['clearIndicatorClicks']}"
                ),
            ]
        )

    lines.extend(
        [
            "",
            "Totals",
            f"clear_events: {totals['clearEventCount']}",
            *(_format_counter("by_ats", totals["byAts"])),
            *(_format_counter("by_support", totals["bySupportLevel"])),
            *(_format_counter("field_status", totals["fieldStatusCounts"])),
            *(_format_counter("failures", totals["failureBucketCounts"])),
            *(_format_counter("skip_reasons", totals["skippedReasonCounts"])),
            *(_format_counter("clear_status", totals["clearStatusCounts"])),
        ]
    )
    return "\n".join(lines) + "\n"


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--log",
        type=Path,
        default=DEFAULT_LOG_PATH,
        help="Path to C3 extension JSONL debug log.",
    )
    parser.add_argument(
        "--format",
        choices=["text", "json"],
        default="text",
        help="Report output format.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=20,
        help="Only summarize the latest N fill attempts. Use -1 for all attempts.",
    )
    parser.add_argument(
        "--include-fields",
        action="store_true",
        help="Include unresolved field details in the output.",
    )
    parser.add_argument(
        "--max-unresolved-fields",
        type=int,
        default=12,
        help="Maximum unresolved fields to keep per attempt.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    limit = None if args.limit < 0 else args.limit
    report = build_report(
        args.log,
        limit=limit,
        include_fields=args.include_fields,
        max_unresolved_fields=max(0, args.max_unresolved_fields),
    )
    if args.format == "json":
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        print(format_text_report(report), end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
