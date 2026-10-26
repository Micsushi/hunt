from copy import deepcopy

import pytest

from hunter import config, db, discovery_policy, workday_intake


def test_workday_intake_requires_live_external_identity_and_preserves_policy(tmp_path, monkeypatch):
    monkeypatch.setenv("HUNT_DB_URL", "")
    monkeypatch.setattr(db, "DB_PATH", str(tmp_path / "intake.db"))
    db.init_db(maintenance=False)
    url = "https://fixture.wd1.myworkdayjobs.com/External/job/Toronto/Software-Intern_R100"
    detail = {"jobPostingInfo": {"id": "posting-id", "jobReqId": "R100", "jobPostingId": "Software-Intern_R100",
        "jobPostingSiteId": "External", "canApply": True, "posted": True, "externalUrl": url,
        "title": "Software Engineering Intern", "location": "Toronto, Canada",
        "jobDescription": "<p>Build and maintain useful software with our engineering team, learning alongside experienced colleagues.</p>"}}
    monkeypatch.setattr(workday_intake, "fetch_detail", lambda _: deepcopy(detail))
    result = workday_intake.intake_job(url, company="Fixture Company")
    job = db.get_job_by_id(result["job_id"])
    assert job["enrichment_status"] == "done"
    assert job["apply_type"] == "external_apply" and job["ats_type"] == "workday"
    assert job["description"].startswith("Build and maintain")
    for field, value in [("canApply", False), ("posted", False), ("externalUrl", url.replace("R100", "R200")), ("jobPostingSiteId", "Internal")]:
        invalid = deepcopy(detail)
        invalid["jobPostingInfo"][field] = value
        with pytest.raises(ValueError):
            workday_intake.verified_job(url, invalid)
    with db.get_connection() as connection:
        connection.execute("UPDATE jobs SET status = 'applied', discovery_suppressed_reason = 'owner_hold' WHERE id = ?", (job["id"],))
        connection.commit()
    assert workday_intake.intake_job(url)["result"] == "preserved"
    preserved = db.get_job_by_id(job["id"])
    assert preserved["status"] == "applied" and preserved["discovery_suppressed_reason"] == "owner_hold"


def test_explicit_discovery_preferences_preserve_nonpreference_gates(monkeypatch):
    monkeypatch.setattr(config, "DISCOVERY_ALLOWED_GEOGRAPHIES", "Canada")
    monkeypatch.setattr(config, "DISCOVERY_ALLOW_EXPERIENCED", False)
    monkeypatch.setattr(config, "DISCOVERY_ALLOW_ALL_LANES", False)
    job = {"title": "Senior Sales Advisor", "location": "London, United Kingdom", "category": "other", "apply_type": "external_apply"}
    assert discovery_policy.score_job(job)[2] == "experienced_title"
    monkeypatch.setattr(config, "DISCOVERY_ALLOW_EXPERIENCED", True)
    assert discovery_policy.score_job(job)[2] == "outside_canada"
    monkeypatch.setattr(config, "DISCOVERY_ALLOWED_GEOGRAPHIES", "Canada, United Kingdom")
    assert discovery_policy.score_job(job)[2] == "outside_search_lanes"
    assert discovery_policy.geography_suppression("London, Ontario, Canada") is None
    assert discovery_policy.geography_suppression("London, Ohio, United States") == "outside_allowed_geographies"
    monkeypatch.setattr(config, "DISCOVERY_ALLOW_ALL_LANES", True)
    assert discovery_policy.score_job(job)[2] is None
    monkeypatch.setattr(config, "DISCOVERY_ALLOWED_GEOGRAPHIES", "*")
    assert discovery_policy.geography_suppression("") is None
    assert discovery_policy.score_job({**job, "apply_type": "easy_apply"})[2] == "easy_apply_ineligible"
    monkeypatch.setattr(discovery_policy, "TITLE_BLACKLIST", ["Sales"])
    assert discovery_policy.score_job(job)[2] == "title_blacklist"
