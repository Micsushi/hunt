from __future__ import annotations

from scripts.option_b_smoke import (
    SmokeJob,
    _slug,
    build_quality_notes,
    choose_jobs,
    summarize_pipeline_log,
)


def test_slug_compacts_values():
    assert _slug("Acme Corp / Software Engineer!") == "acme_corp_software_engineer"


def test_choose_jobs_is_seeded():
    jobs = [
        SmokeJob(
            id=i,
            title=f"Job {i}",
            company="Acme",
            source="indeed",
            enrichment_status="done",
            description="x" * 600,
        )
        for i in range(5)
    ]

    first = choose_jobs(jobs, count=3, seed=7)
    second = choose_jobs(jobs, count=3, seed=7)

    assert [job.id for job in first] == [job.id for job in second]
    assert len(first) == 3


def test_summarize_pipeline_log_flags_common_failures():
    summary = summarize_pipeline_log(
        "\n".join(
            [
                "[STEP +0.001s] config",
                "[STEP +1.234s] bullet_rewrite_done",
                "  error: claimed_keyword_missing",
                "[STEP +2.345s] done",
            ]
        )
    )

    assert summary["has_done"] is True
    assert summary["claimed_keyword_missing_count"] == 1
    assert any("config" in line for line in summary["interesting"])


def test_build_quality_notes_extracts_policy_and_drop_signals():
    notes = build_quality_notes(
        "\n".join(
            [
                "[STEP +0.001s] keyword_policy_partition",
                "  rewrite: ['React']",
                "  summary_only: ['Product Manager']",
                "  ignored: ['CEO']",
                "[STEP +1.000s] bullet_rewrite_done",
                "  success: False",
                "  error: rewrite_validation_failed",
                "[STEP +1.100s] summary_keyword_filter",
                "  included: ['user experience']",
                "[STEP +1.200s] bullet_drop",
                "  bullet_id: exp_1",
            ]
        )
    )

    assert notes["has_keyword_policy_partition"] is True
    assert notes["rewrite_validation_failed_count"] == 1
    assert notes["bullet_drop_count"] == 1
    assert any("keyword_policy_partition" in line for line in notes["policy_lines"])
