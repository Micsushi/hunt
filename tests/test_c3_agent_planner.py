import csv
from pathlib import Path
from urllib.parse import urlsplit

import pytest

from tools.c3_agent_testing.availability import (
    AvailabilityResult,
    classify_http_status,
    workday_cxs_url,
)
from tools.c3_agent_testing.planner import (
    canonical_job_url,
    discover_live_replacements,
    plan_lanes,
    read_job_csv,
    select_live_jobs,
)


def _write_csv(path: Path, rows: list[dict[str, str]]) -> None:
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=["company name", "job name", "country", "link"])
        writer.writeheader()
        writer.writerows(rows)


def test_workday_cxs_url_handles_locale_and_plain_site_paths():
    assert (
        workday_cxs_url(
            "https://acme.wd3.myworkdayjobs.com/en-US/External/job/Denver/Engineer_R123?source=LinkedIn"
        )
        == "https://acme.wd3.myworkdayjobs.com/wday/cxs/acme/External/job/Denver/Engineer_R123"
    )
    assert (
        workday_cxs_url("https://acme.wd3.myworkdayjobs.com/External/job/Denver/Engineer_R124")
        == "https://acme.wd3.myworkdayjobs.com/wday/cxs/acme/External/job/Denver/Engineer_R124"
    )


def test_http_status_does_not_call_protected_jobs_expired():
    assert classify_http_status(200) == "live"
    assert classify_http_status(404) == "expired"
    assert classify_http_status(410) == "expired"
    assert classify_http_status(401) == "unknown_browser_check"
    assert classify_http_status(403) == "unknown_browser_check"
    assert classify_http_status(500) == "unknown"


def test_csv_reader_normalizes_and_deduplicates_source_query(tmp_path: Path):
    csv_path = tmp_path / "jobs.csv"
    _write_csv(
        csv_path,
        [
            {
                "company name": "Acme",
                "job name": "Engineer",
                "country": "US",
                "link": "https://acme.wd3.myworkdayjobs.com/External/job/X/Engineer_R1?source=A",
            },
            {
                "company name": "Acme duplicate",
                "job name": "Engineer duplicate",
                "country": "US",
                "link": "https://acme.wd3.myworkdayjobs.com/External/job/X/Engineer_R1?source=B",
            },
            {"company name": "Broken", "job name": "No URL", "country": "US", "link": ""},
        ],
    )

    rows = read_job_csv(csv_path)

    assert len(rows) == 1
    assert rows[0].company == "Acme"
    assert rows[0].job_id == "R1"


def test_select_live_jobs_uses_browser_check_only_for_protected_result():
    jobs = read_job_csv(Path("wd_test_jobs.csv"))[:4]
    results = iter(
        [
            AvailabilityResult("expired", "http_404"),
            AvailabilityResult("unknown_browser_check", "http_403"),
            AvailabilityResult("live", "cxs_can_apply"),
        ]
    )
    browser_calls: list[str] = []

    selected, decisions = select_live_jobs(
        jobs,
        count=2,
        check=lambda _job: next(results),
        browser_check=lambda job: (
            browser_calls.append(job.url) or AvailabilityResult("live", "browser_apply_visible")
        ),
    )

    assert len(selected) == 2
    assert len(browser_calls) == 1
    assert [entry.status for entry in decisions] == ["expired", "live", "live"]


def test_lane_plan_is_deterministic_isolated_and_submit_safe():
    jobs = read_job_csv(Path("wd_test_jobs.csv"))[:2]

    lanes = plan_lanes(
        jobs,
        batch_id="batch-1",
        ports=[9801, 9802],
        artifact_root=Path("logs/batch-1"),
        deadline_seconds=120,
    )

    assert [lane.port for lane in lanes] == [9801, 9802]
    assert len({lane.profile for lane in lanes}) == 2
    assert len({lane.session_id for lane in lanes}) == 2
    assert len({lane.browser_target_id for lane in lanes}) == 2
    assert all(lane.browser_target_id == lane.session_id for lane in lanes)
    assert all(lane.allow_submit is False for lane in lanes)
    assert all(lane.allow_foreground is False for lane in lanes)
    assert all(lane.deadline_seconds == 120 for lane in lanes)


@pytest.mark.parametrize("batch_id", ["nightly west", "nightly@west", "nightly/west"])
def test_lane_plan_rejects_batch_ids_that_would_sanitize_to_colliding_identity(batch_id):
    jobs = read_job_csv(Path("wd_test_jobs.csv"))[:1]

    with pytest.raises(ValueError, match="batch_id_must_be_safe"):
        plan_lanes(
            jobs,
            batch_id=batch_id,
            ports=[9803],
            artifact_root=Path("logs/collision-test"),
        )


def test_old_csv_tenants_can_supply_diverse_current_replacements():
    jobs = read_job_csv(Path("wd_test_jobs.csv"))[:3]

    replacements = discover_live_replacements(
        jobs,
        count=2,
        fetch=lambda job: [
            {
                "title": f"Current {job.company} role",
                "externalPath": f"/job/Remote/Current-role_{job.job_id}-NEW",
                "locationsText": "Remote",
            }
        ],
    )

    assert len(replacements) == 2
    assert replacements[0].company == jobs[0].company
    assert replacements[1].company == jobs[1].company
    assert "/job/Remote/" in replacements[0].url
    assert replacements[0].job_id.endswith("NEW")


def test_replacement_discovery_skips_already_selected_url_and_keeps_searching():
    jobs = read_job_csv(Path("wd_test_jobs.csv"))[:1]
    parsed = urlsplit(jobs[0].url)
    public_prefix = parsed.path.split("/job/", 1)[0].rstrip("/")
    selected_url = canonical_job_url(
        f"{parsed.scheme}://{parsed.netloc}{public_prefix}/job/Remote/Already-selected_OLD"
    )

    replacements = discover_live_replacements(
        jobs,
        count=1,
        exclude_urls=[selected_url],
        fetch=lambda _job: [
            {
                "title": "Duplicate",
                "externalPath": "/job/Remote/Already-selected_OLD",
                "locationsText": "Remote",
            },
            {
                "title": "Fresh role",
                "externalPath": "/job/Remote/Fresh-role_NEW",
                "locationsText": "Remote",
            },
        ],
    )

    assert [item.job_id for item in replacements] == ["NEW"]
    assert replacements[0].canonical_url != selected_url


def test_replacement_discovery_keeps_scanning_same_tenant_until_live_unique_job():
    jobs = read_job_csv(Path("wd_test_jobs.csv"))[:1]
    checked: list[str] = []

    replacements = discover_live_replacements(
        jobs,
        count=1,
        fetch=lambda _job: [
            {
                "title": "Expired first result",
                "externalPath": "/job/Remote/Expired-role_OLD",
                "locationsText": "Remote",
            },
            {
                "title": "Live later result",
                "externalPath": "/job/Remote/Live-role_NEW",
                "locationsText": "Remote",
            },
        ],
        check=lambda job: (
            checked.append(job.job_id)
            or AvailabilityResult(
                "live" if job.job_id == "NEW" else "expired",
                "fixture",
            )
        ),
    )

    assert checked == ["OLD", "NEW"]
    assert [item.job_id for item in replacements] == ["NEW"]
