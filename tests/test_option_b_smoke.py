from __future__ import annotations

from scripts.option_b_smoke import SmokeJob, _slug, choose_jobs, summarize_pipeline_log


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
