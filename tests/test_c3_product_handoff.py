import base64
import hashlib
import json
import sqlite3

import pytest
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

from backend import c3
from backend.gateway import _require_auth
from hunter import db


def client(authenticated=True):
    app = FastAPI()
    app.include_router(c3.router)
    if authenticated:
        app.dependency_overrides[_require_auth] = lambda: "fixture-owner"
    return TestClient(app)


@pytest.mark.parametrize(
    "ats",
    [
        "workday",
        "greenhouse",
        "lever",
        "ashby",
        "workable",
        "bamboohr",
        "rippling",
        "jobvite",
        "recruitee",
        "canonical",
        "canada",
        "amazon",
        "applytojob",
        "greenhouse_anz",
        "smartrecruiters",
    ],
)
def test_handoff_preserves_each_selected_resume_and_validates_whole_selection(
    tmp_path, monkeypatch, ats
):
    records = {}
    for job_id in (1, 2):
        resume = tmp_path / f"resume-{job_id}.pdf"
        resume.write_bytes(f"%PDF-1.4 selected resume {job_id}".encode())
        urls = {
            "workable": f"https://apply.workable.com/fixture/j/ABC{job_id}/apply/",
            "workday": f"https://fixture.wd1.myworkdayjobs.com/en-US/Test/job/City/Job_R{job_id}",
            "greenhouse": f"https://job-boards.greenhouse.io/fixture/jobs/{job_id}",
            "lever": f"https://jobs.lever.co/fixture/11111111-1111-4111-8111-11111111111{job_id}",
            "ashby": f"https://jobs.ashbyhq.com/fixture/11111111-1111-4111-8111-11111111111{job_id}",
            "bamboohr": f"https://solace.bamboohr.com/careers/{job_id}",
            "rippling": f"https://ats.rippling.com/exacare/jobs/11111111-1111-4111-8111-11111111111{job_id}/apply",
            "jobvite": f"https://jobs.jobvite.com/parkland/job/obDXAfw{job_id}/apply",
            "recruitee": f"https://guarana.recruitee.com/o/developer-{job_id}/c/new",
            "canonical": f"https://canonical.com/careers/{job_id}/developer/application",
            "canada": f"https://forms-formulaires.alpha.canada.ca/en/id/application{job_id}",
            "amazon": f"https://www.amazon.jobs/applicant/jobs/{job_id}/apply",
            "applytojob": f"https://techinsights.applytojob.com/apply/ycOBoo1em{job_id}",
            "greenhouse_anz": f"https://job-boards.anz.greenhouse.io/sirion/jobs/{job_id}",
            "smartrecruiters": f"https://jobs.smartrecruiters.com/GIRO/{job_id}-developer",
        }
        records[job_id] = dict(
            apply_type="external_apply",
            ats_type=ats,
            enrichment_status="done_verified",
            selected_resume_ready_for_c3=1,
            selected_resume_pdf_path=str(resume),
            apply_url=urls[ats],
        )
    database = tmp_path / "c1.db"
    monkeypatch.setattr(db, "DB_PATH", str(database))
    with sqlite3.connect(database) as connection:
        connection.execute(
            "CREATE TABLE jobs (id INTEGER PRIMARY KEY, apply_type TEXT, ats_type TEXT, enrichment_status TEXT, selected_resume_ready_for_c3 INTEGER, selected_resume_pdf_path TEXT, apply_url TEXT, selected_resume_version_id TEXT)"
        )
        connection.executemany(
            "INSERT INTO jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [(job_id, *record.values(), str(job_id)) for job_id, record in records.items()],
        )
        connection.execute(
            "CREATE TABLE resume_versions (id INTEGER PRIMARY KEY, job_id INTEGER, resume_attempt_id INTEGER, pdf_path TEXT, is_selected_for_c3 INTEGER)"
        )
        connection.execute(
            "CREATE TABLE resume_attempts (id INTEGER PRIMARY KEY, job_id INTEGER, pdf_path TEXT, status TEXT, latest_result_kind TEXT)"
        )
        for job_id, record in records.items():
            connection.execute(
                "INSERT INTO resume_versions VALUES (?, ?, ?, ?, 1)",
                (job_id, job_id, job_id, record["selected_resume_pdf_path"]),
            )
            connection.execute(
                "INSERT INTO resume_attempts VALUES (?, ?, ?, 'done', 'latest_useful')",
                (job_id, job_id, record["selected_resume_pdf_path"]),
            )
    calls = []

    async def forward(method, path, content=b""):
        body = json.loads(content)
        calls.extend(body["jobs"])
        return JSONResponse(body["jobs"])

    monkeypatch.setattr(c3, "forward", forward)
    browser = client()
    if ats not in ("workday", "greenhouse", "lever", "ashby", "workable"):
        for route in ("/api/c3/handoff", "/api/c3/handoff/export"):
            declined = browser.post(route, json={"job_ids": [1, 2]})
            assert declined.status_code == 409
            assert "Fill current page" in declined.json()["detail"]
        with sqlite3.connect(database) as connection:
            connection.execute(
                "UPDATE jobs SET ats_type='greenhouse',apply_url=? WHERE id=2",
                (urls["greenhouse"],),
            )
        mixed = browser.post("/api/c3/handoff/export", json={"job_ids": [1, 2]})
        assert mixed.status_code == 200
        assert [j["sourceJobId"] for j in mixed.json()["jobs"]] == [2]
        assert (
            base64.b64decode(mixed.json()["jobs"][0]["resumeBase64"])
            == b"%PDF-1.4 selected resume 2"
        )
        assert not calls
        return
    response = browser.post("/api/c3/handoff", json={"job_ids": [1, 2]})
    assert response.status_code == 200
    assert [base64.b64decode(j["resumeBase64"]) for j in calls] == [
        b"%PDF-1.4 selected resume 1",
        b"%PDF-1.4 selected resume 2",
    ]
    assert [j["resumeName"] for j in calls] == ["resume-1.pdf", "resume-2.pdf"]
    calls.clear()
    exported = browser.post("/api/c3/handoff/export", json={"job_ids": [1, 2]})
    assert exported.status_code == 200
    assert exported.headers["cache-control"] == "no-store"
    assert "attachment" in exported.headers["content-disposition"]
    bundle = exported.json()
    assert bundle["format"] == "hunt-c3-handoff" and bundle["version"] == 1
    assert [job["sourceJobId"] for job in bundle["jobs"]] == [1, 2]
    for job in bundle["jobs"]:
        assert (
            job["resumeSha256"] == hashlib.sha256(base64.b64decode(job["resumeBase64"])).hexdigest()
        )
    assert calls == [], "export must not queue anything or require a local C3 service"
    for field, value in [
        ("enrichment_status", "pending"),
        ("apply_url", "https://untrusted.example/apply"),
        ("apply_url", "https://user:password@solace.bamboohr.com/careers/823"),
        ("apply_url", "https://solace.bamboohr.com:444/careers/823"),
        ("apply_url", "https://solace.bamboohr.com.evil.example/careers/823"),
        ("apply_url", "https://solace.bamboohr.com/careers/823%2fapply"),
        ("apply_url", "https://[malformed/careers/823"),
    ]:
        with sqlite3.connect(database) as connection:
            connection.execute(f"UPDATE jobs SET {field}=? WHERE id=1", (value,))
        assert browser.post("/api/c3/handoff/export", json={"job_ids": [1, 2]}).status_code == 409
        assert calls == []
        with sqlite3.connect(database) as connection:
            connection.execute(f"UPDATE jobs SET {field}=? WHERE id=1", (records[1][field],))
    for statement, parameters in [
        ("UPDATE jobs SET selected_resume_version_id='2' WHERE id=1", ()),
        (
            "UPDATE jobs SET selected_resume_pdf_path=? WHERE id=1",
            (records[2]["selected_resume_pdf_path"],),
        ),
        ("UPDATE resume_attempts SET job_id=2 WHERE id=1", ()),
        ("UPDATE resume_attempts SET status='failed' WHERE id=1", ()),
        ("UPDATE resume_versions SET is_selected_for_c3=0 WHERE id=1", ()),
    ]:
        with sqlite3.connect(database) as connection:
            connection.execute(statement, parameters)
        assert browser.post("/api/c3/handoff", json={"job_ids": [1, 2]}).status_code == 409
        assert browser.post("/api/c3/handoff/export", json={"job_ids": [1, 2]}).status_code == 409
        assert calls == []
        with sqlite3.connect(database) as connection:
            connection.execute(
                "UPDATE jobs SET selected_resume_version_id='1', selected_resume_pdf_path=? WHERE id=1",
                (records[1]["selected_resume_pdf_path"],),
            )
            connection.execute("UPDATE resume_attempts SET job_id=1, status='done' WHERE id=1")
            connection.execute("UPDATE resume_versions SET is_selected_for_c3=1 WHERE id=1")
    with sqlite3.connect(database) as connection:
        connection.execute("UPDATE jobs SET apply_type='easy_apply' WHERE id=2")
    assert browser.post("/api/c3/handoff", json={"job_ids": [1, 2]}).status_code == 409
    assert calls == []
    with sqlite3.connect(database) as connection:
        connection.execute(
            "UPDATE jobs SET apply_type='external_apply', selected_resume_ready_for_c3=0 WHERE id=2"
        )
    assert browser.post("/api/c3/handoff", json={"job_ids": [2]}).status_code == 409
    assert calls == []


def test_handoff_blocks_existing_outcomes_and_discovery_exclusions(tmp_path, monkeypatch):
    resume = tmp_path / "selected.pdf"
    resume.write_bytes(b"%PDF-fixture")
    row = dict(
        apply_type="external_apply",
        ats_type="workday",
        enrichment_status="done_verified",
        selected_resume_ready_for_c3=1,
        selected_resume_pdf_path=str(resume),
        apply_url="https://fixture.wd1.myworkdayjobs.com/en-US/Test/job/City/Job_R1",
    )
    monkeypatch.setattr(db, "get_job_by_id", lambda _: row)
    browser = client()
    for status in ("applied", "cancelled", "canceled"):
        row["status"] = status
        assert browser.post("/api/c3/handoff", json={"job_ids": [1]}).status_code == 409
    row["status"] = "new"
    row["discovery_suppressed_reason"] = "duplicate_canonical_job"
    assert browser.post("/api/c3/handoff", json={"job_ids": [1]}).status_code == 409


def test_c3_gateway_requires_session_and_blocks_cross_site_mutations():
    assert client(False).get("/api/c3/state").status_code == 401
    assert client(False).post("/api/c3/handoff/export", json={"job_ids": [1]}).status_code == 401
    browser = client()
    assert (
        browser.post(
            "/api/c3/jobs/abc/action",
            json={"action": "submit"},
            headers={"Origin": "https://other.example"},
        ).status_code
        == 403
    )
    assert (
        browser.post(
            "/api/c3/account",
            content='{"password":"fixture"}',
            headers={"Content-Type": "text/plain"},
        ).status_code
        == 415
    )
    assert browser.get("/api/c3/arbitrary-private-file").status_code == 404
    assert browser.post("/api/c3/handoff", json=[]).status_code == 400
    assert browser.post("/api/c3/handoff/export", json=[]).status_code == 400
    assert (
        browser.post(
            "/api/c3/handoff/export",
            json={"job_ids": [1]},
            headers={"Origin": "https://other.example"},
        ).status_code
        == 403
    )


def test_handoff_export_rejects_oversize_bundle_before_returning_file(monkeypatch):
    monkeypatch.setattr(c3, "HANDOFF_MAX_BYTES", 1)
    monkeypatch.setattr(
        c3,
        "prepared_jobs",
        lambda ids, **options: [
            {
                "title": "Fixture",
                "resumeName": "resume.pdf",
                "resumeVersion": "1",
                "resumeBase64": base64.b64encode(b"%PDF-fixture").decode(),
            }
        ],
    )
    result = client().post("/api/c3/handoff/export", json={"job_ids": [1]})
    assert result.status_code == 413
    assert "fewer jobs" in result.json()["detail"]


def test_upstream_pairing_failure_does_not_expire_hunt_session(monkeypatch):
    import httpx

    original = httpx.AsyncClient
    monkeypatch.setattr(c3, "service_token", lambda: "a" * 64)
    monkeypatch.setattr(
        c3.httpx,
        "AsyncClient",
        lambda **kwargs: original(
            transport=httpx.MockTransport(
                lambda request: httpx.Response(401, json={"error": "pairing"})
            ),
            **kwargs,
        ),
    )
    response = client().get("/api/c3/state")
    assert response.status_code == 503
    assert "pairing key" in response.json()["detail"]


@pytest.mark.parametrize(
    "failure,expected_http,expected_outcome",
    [
        ("rejected", 409, "rejected"),
        ("server_error", 500, "unconfirmed"),
        ("connection_lost", 503, "unconfirmed"),
        ("pairing", 503, "rejected"),
        ("wrong_confirmation", 502, "unconfirmed"),
    ],
)
def test_partial_handoff_preserves_confirmed_jobs_and_never_retries(
    monkeypatch, failure, expected_http, expected_outcome
):
    from fastapi import HTTPException

    monkeypatch.setattr(c3, "prepared_jobs", lambda ids: [{"sourceJobId": i} for i in ids])
    sent = []

    async def forward(method, path, content=b""):
        job = json.loads(content)["jobs"][0]
        sent.append(job["sourceJobId"])
        if job["sourceJobId"] == 1:
            return JSONResponse([job])
        if failure == "connection_lost":
            raise HTTPException(503, "connection lost")
        if failure == "pairing":
            raise c3.C3Rejected(503, "pairing key mismatch")
        if failure == "wrong_confirmation":
            return JSONResponse([{"sourceJobId": 99}])
        return JSONResponse({"error": "fixture failure"}, status_code=expected_http)

    monkeypatch.setattr(c3, "forward", forward)
    response = client().post("/api/c3/handoff", json={"job_ids": [1, 2, 3]})
    assert response.status_code == expected_http
    assert sent == [1, 2]
    assert response.json()["queued"] == [{"sourceJobId": 1}]
    assert response.json()["outcomes"] == [
        {"sourceJobId": 1, "status": "confirmed"},
        {"sourceJobId": 2, "status": expected_outcome},
        {"sourceJobId": 3, "status": "not_sent"},
    ]
