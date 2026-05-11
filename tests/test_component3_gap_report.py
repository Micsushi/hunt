import json
from pathlib import Path

from scripts.c3_gap_report import build_report, format_text_report, load_support_levels


def _write_jsonl(path: Path, entries: list[dict]) -> None:
    path.write_text(
        "\n".join(json.dumps(entry) for entry in entries) + "\n",
        encoding="utf-8",
    )


def _fill_event(field_inventory: list[dict], *, event_type: str = "fill_result") -> dict:
    return {
        "received_at": "2026-05-11T08:00:00+00:00",
        "source": "c3_extension",
        "payload": {
            "eventType": event_type,
            "extensionTime": "2026-05-11T08:00:00.000Z",
            "activeApplyContext": {
                "jobId": "",
                "applyUrl": "https://careers.hootsuite.com/job/apply",
                "sourceMode": "manual",
            },
            "payload": {
                "ok": True,
                "message": "Filled 1 deterministic fields. 1 unanswered required question can use LLM help.",
                "route": {
                    "routeName": "ats_filler",
                    "fillSource": "standalone",
                    "strategy": "ats_specific",
                    "adapterName": "greenhouse",
                    "requestedAtsType": "greenhouse",
                    "detectedAtsType": "greenhouse",
                    "adapterBackedByGeneric": True,
                },
                "attempt": {
                    "id": "attempt-1",
                    "status": "manual_review",
                    "applyUrl": "https://careers.hootsuite.com/job/apply",
                    "atsType": "greenhouse",
                    "fillRoute": "ats_filler",
                    "filledFieldCount": 1,
                    "manualReviewRequired": True,
                    "manualReviewReasons": ["resume_upload:missing_resume_data"],
                },
                "result": {
                    "ok": True,
                    "atsType": "greenhouse",
                    "adapterBackedByGeneric": True,
                    "frameUrl": "https://job-boards.greenhouse.io/embed/job_app",
                    "filledFieldCount": 1,
                    "pendingLlmFieldCount": 1,
                    "manualReviewReasons": ["resume_upload:missing_resume_data"],
                    "answerDecisionDiagnostics": [{"reason": "decision_not_committed_to_page"}],
                    "fieldInventory": field_inventory,
                },
            },
        },
    }


def _clear_event() -> dict:
    return {
        "received_at": "2026-05-11T08:05:00+00:00",
        "source": "c3_extension",
        "payload": {
            "eventType": "activity",
            "extensionTime": "2026-05-11T08:05:00.000Z",
            "payload": {
                "activity": {
                    "id": "clear-1",
                    "action": "page.clear",
                    "status": "warn",
                    "summary": "Current page clear needs review.",
                    "details": {
                        "tabId": 123,
                        "cleared": 20,
                        "closedDropdowns": 4,
                        "hiddenDropdownMenus": 30,
                        "openDropdownsBefore": 5,
                        "remainingOpenDropdowns": 2,
                        "remainingFilledControls": 3,
                        "clearIndicatorClicks": 6,
                        "frameCount": 9,
                    },
                },
            },
        },
    }


def test_load_support_levels_reads_js_support_matrix():
    levels = load_support_levels()

    assert levels["workday"] == "dedicated_adapter"
    assert levels["greenhouse"] == "generic_backed_adapter"
    assert levels["icims"] == "detected_only"


def test_build_report_standardizes_c3_attempt_metrics(tmp_path):
    log_path = tmp_path / "c3_extension_debug.jsonl"
    fields = [
        {
            "kind": "input",
            "tagName": "INPUT",
            "type": "email",
            "id": "email",
            "descriptor": "Email",
            "required": True,
            "filled": True,
            "valueSource": "profile.email",
        },
        {
            "kind": "combobox",
            "tagName": "INPUT",
            "type": "text",
            "id": "coop",
            "descriptor": "How many co-op terms have you completed?",
            "required": True,
            "filled": False,
            "skippedReason": "no_known_choice",
            "options": ["0 terms", "1 term"],
        },
        {
            "kind": "checkbox",
            "tagName": "INPUT",
            "type": "checkbox",
            "id": "sms",
            "descriptor": "I agree to SMS",
            "required": True,
            "filled": False,
            "skippedReason": "unsupported_checkbox",
        },
        {
            "kind": "input",
            "tagName": "INPUT",
            "type": "text",
            "id": "nickname",
            "descriptor": "Preferred name",
            "required": False,
            "filled": False,
            "skippedReason": "not_required",
        },
    ]
    _write_jsonl(
        log_path,
        [
            {"not": "a c3 event"},
            _fill_event(fields),
        ],
    )

    report = build_report(log_path, include_fields=True)

    assert report["schemaVersion"] == "hunt.c3.gap_report.v1"
    assert report["totals"]["attemptCount"] == 1
    assert report["totals"]["byAts"] == {"greenhouse": 1}
    assert report["totals"]["bySupportLevel"] == {"generic_backed_adapter": 1}
    latest = report["latestAttempt"]
    assert latest["counts"]["inventoryTotal"] == 4
    assert latest["counts"]["requiredTotal"] == 3
    assert latest["counts"]["unresolvedRequiredTotal"] == 2
    assert latest["counts"]["pendingLlmFieldCount"] == 1
    assert latest["fieldStatusCounts"] == {
        "filled": 1,
        "needs_llm": 1,
        "optional_blank": 1,
        "unsupported_widget": 1,
    }
    assert latest["failureBucketCounts"]["needs_llm"] == 1
    assert latest["failureBucketCounts"]["unsupported_widget"] == 1
    assert latest["failureBucketCounts"]["resume_issue"] == 1
    assert latest["failureBucketCounts"]["commit_failed"] == 1
    assert latest["unresolvedFields"][0]["status"] == "needs_llm"


def test_report_skips_invalid_lines_and_omits_fields_by_default(tmp_path):
    log_path = tmp_path / "c3_extension_debug.jsonl"
    log_path.write_text(
        "{bad-json\n" + json.dumps(_fill_event([])) + "\n",
        encoding="utf-8",
    )

    report = build_report(log_path)

    assert report["totals"]["lineCount"] == 2
    assert report["totals"]["invalidLineCount"] == 1
    assert report["totals"]["attemptCount"] == 1
    assert "unresolvedFields" not in report["attempts"][0]


def test_text_report_includes_latest_standard_counts(tmp_path):
    log_path = tmp_path / "c3_extension_debug.jsonl"
    _write_jsonl(log_path, [_fill_event([]), _clear_event()])

    text = format_text_report(build_report(log_path, include_fields=True))

    assert "C3 Gap Report" in text
    assert "schema: hunt.c3.gap_report.v1" in text
    assert "ats: greenhouse" in text
    assert "support: generic_backed_adapter" in text
    assert "pending_llm=1" in text
    assert "Latest Clear" in text
    assert "hidden_menus=30" in text
    assert "remaining_open=2" in text
    assert "remaining_filled=3" in text


def test_build_report_summarizes_clear_page_activity(tmp_path):
    log_path = tmp_path / "c3_extension_debug.jsonl"
    _write_jsonl(log_path, [_clear_event()])

    report = build_report(log_path)

    assert report["totals"]["attemptCount"] == 0
    assert report["totals"]["clearEventCount"] == 1
    assert report["totals"]["clearStatusCounts"] == {"warn": 1}
    assert report["totals"]["clearCountTotals"]["remainingOpenDropdowns"] == 2
    assert report["totals"]["clearCountTotals"]["remainingFilledControls"] == 3
    assert report["totals"]["clearCountTotals"]["hiddenDropdownMenus"] == 30
    assert report["latestClear"]["counts"]["clearIndicatorClicks"] == 6
