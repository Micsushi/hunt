"""Isolated C1 record -> real heuristic C2 PDF -> real local C3 queue smoke.

Requires the Python app dependencies, LaTeX, Node >=22.18 and executioner npm
dependencies. Never connects a browser or uses the production database.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
from contextlib import closing
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main():
    if len(sys.argv) > 1:
        raise SystemExit("This smoke always creates isolated data; no existing-stack mode.")
    with tempfile.TemporaryDirectory(prefix="hunt-c1-c3-") as directory:
        root = Path(directory)
        (root / "jobs.db").touch()
        (root / "absent.json").write_text("{}", encoding="utf-8")
        master = root / "master.yaml"
        master.write_text(
            """header:
  name: "Fixture Applicant"
  contact: "fixture@example.invalid"
education:
  institution_and_degree: "Fixture University, BSc Computer Science"
  date_text: "2026"
experience:
  - id: lab
    title: Developer
    company: Fictional Lab
    location: Toronto
    dates: "2025"
    bullets:
      - text: "Built Python automation and SQL reports."
      - text: "Tested REST APIs and documented software defects."
projects:
  - id: app
    name: Fixture Application
    url: "2026"
    bullets:
      - text: "Created a React interface with accessible form controls."
skills:
  Languages: [Python, SQL, JavaScript]
  Frameworks: [React]
  Developer Tools: [Git]
""",
            encoding="utf-8",
        )
        for name in ("profile.md", "bullets.md"):
            (root / name).write_text(
                "Fictional software developer. Python, SQL, React.", encoding="utf-8"
            )
        os.environ.update(
            {
                "HUNT_DB_PATH": str(root / "jobs.db"),
                "HUNT_DB_URL": "",
                "HUNT_STATE_ROOT": str(root),
                "HUNT_RESUME_ARTIFACTS_DIR": str(root / "resumes"),
                "HUNT_MASTER_RESUME_PATH": str(master),
                "HUNT_OG_RESUME_PATH": str(ROOT / "main.tex"),
                "HUNT_CANDIDATE_PROFILE_PATH": str(root / "profile.md"),
                "HUNT_BULLET_LIBRARY_PATH": str(root / "bullets.md"),
                "HUNT_BASE_RESUMES_ROOT": str(root / "empty"),
                "HUNT_USER_CONFIG_PATH": str(root / "absent.json"),
                "HUNT_RESUME_MODEL_BACKEND": "heuristic",
                "HUNT_C2_LLM_PROVIDER": "heuristic",
                "HUNT_RESUME_LLM_PROVIDER": "heuristic",
                "HUNT_LLM_PROVIDER": "heuristic",
                "HUNT_RAG_ENABLED": "0",
                "HUNT_C3_TOKEN_FILE": str(root / "c3" / "service-token"),
            }
        )
        # Enforce local-only Python traffic even if developer settings contain a provider URL.
        original_connect = socket.socket.connect

        def local_connect(sock, address):
            if isinstance(address, tuple) and address[0] not in ("127.0.0.1", "localhost", "::1"):
                raise RuntimeError("External traffic forbidden in pipeline smoke")
            return original_connect(sock, address)

        socket.socket.connect = local_connect
        sys.path.insert(0, str(ROOT))
        import httpx
        from fastapi import FastAPI
        from fastapi.testclient import TestClient

        from backend import c3
        from backend.auth_session import (
            SESSION_COOKIE_NAME,
            create_session,
            delete_session,
            init_sessions_table,
        )
        from fletcher.pipeline import generate_resume_for_job
        from fletcher.resume.master import render_selected_master_resume
        from hunter import db

        db.init_db(maintenance=False, refresh_discovery=False)
        urls = [
            ("greenhouse", "https://job-boards.greenhouse.io/fixture/jobs/1"),
            ("lever", "https://jobs.lever.co/fixture/11111111-1111-4111-8111-111111111111"),
            ("ashby", "https://jobs.ashbyhq.com/fixture/11111111-1111-4111-8111-111111111111"),
            ("workable", "https://apply.workable.com/fixture/j/ABC123/"),
            ("workday", "https://fixture.wd1.myworkdayjobs.com/Test/job/City/Job_R1"),
        ]
        with closing(db.get_connection()) as connection:
            for job_id, (ats, url) in enumerate(urls, 1):
                connection.execute(
                    "INSERT INTO jobs (id,title,company,description,apply_url,job_url,apply_type,ats_type,enrichment_status,status,auto_apply_eligible) VALUES (?,?,?,?,?,?,'external_apply',?,'done_verified','new',1)",
                    (
                        job_id,
                        "Junior Software Developer",
                        "Fictional Lab",
                        "Build Python REST APIs, SQL reports and React interfaces. Junior software developer with Git and testing skills.",
                        url,
                        url,
                        ats,
                    ),
                )
            connection.commit()
        source_resume = root / "fixture.tex"
        source_resume.write_text(
            render_selected_master_resume(
                title="Software Developer", keywords=[], master_path=master
            )[0],
            encoding="utf-8",
        )
        for job_id in range(1, 6):
            result = generate_resume_for_job(
                job_id, db_path=root / "jobs.db", resume_path=source_resume
            )
            if result["compile_status"] != "ok":
                raise RuntimeError(
                    Path(result["tex_path"])
                    .with_name("compile.log")
                    .read_text(encoding="utf-8", errors="replace")
                    if Path(result["tex_path"]).with_name("compile.log").exists()
                    else json.dumps(result)
                )
        app = FastAPI()
        app.include_router(c3.router)
        init_sessions_table()
        node_source = f"""import {{startProductServer}} from {json.dumps((ROOT / "executioner/src/product/server.ts").as_uri())};
const service = await startProductServer({{root:process.argv[1],port:47831}});
process.stdin.resume(); process.stdin.on('end',async()=>{{await service.close();process.exit(0);}});
console.log('ready');"""
        with (root / "c3.log").open("w+", encoding="utf-8") as log:
            child = subprocess.Popen(
                ["node", "--input-type=module", "-e", node_source, str(root / "c3")],
                stdin=subprocess.PIPE,
                stdout=log,
                stderr=log,
            )
            try:
                for _ in range(100):
                    if child.poll() is not None:
                        log.seek(0)
                        raise RuntimeError(log.read())
                    if (root / "c3/service-token").exists():
                        try:
                            if httpx.get("http://127.0.0.1:47831/state").status_code == 401:
                                break
                        except httpx.HTTPError:
                            pass
                    time.sleep(0.1)
                else:
                    raise RuntimeError("C3 did not start")
                token = (root / "c3/service-token").read_text().strip()
                headers = {"Authorization": "Bearer " + token}
                pdf = Path(db.get_job_by_id(1)["selected_resume_pdf_path"]).read_bytes()
                response = httpx.post(
                    "http://127.0.0.1:47831/settings",
                    headers=headers,
                    json={
                        "applicant": {
                            "given_name": "Fixture",
                            "family_name": "Applicant",
                            "email_address": "fixture@example.invalid",
                            "answer_policy": "real",
                        },
                        "resumeBase64": base64.b64encode(pdf).decode(),
                    },
                )
                response.raise_for_status()
                with TestClient(app) as client:
                    for cookie in (None, "invalid-smoke-session"):
                        if cookie:
                            client.cookies.set(SESSION_COOKIE_NAME, cookie)
                        assert (
                            client.post("/api/c3/handoff", json={"job_ids": [1]}).status_code == 401
                        )
                    session = create_session("smoke-owner")
                    client.cookies.set(SESSION_COOKIE_NAME, session)
                    assert (
                        client.post(
                            "/api/c3/handoff",
                            json={"job_ids": [1]},
                            headers={"Origin": "https://other.example.invalid"},
                        ).status_code
                        == 403
                    )
                    assert (
                        httpx.get("http://127.0.0.1:47831/state", headers=headers).json()["jobs"]
                        == []
                    )
                    exported = client.post(
                        "/api/c3/handoff/export", json={"job_ids": [1, 2, 3, 4, 5]}
                    )
                    assert exported.status_code == 200, exported.text
                    bundle_file = root / "applications.hunt.json"
                    bundle_file.write_bytes(exported.content)
                    bundle = json.loads(bundle_file.read_text(encoding="utf-8"))
                    preview = httpx.post(
                        "http://127.0.0.1:47831/handoff/preview", headers=headers, json=bundle
                    )
                    assert preview.status_code == 200, preview.text
                    assert [job["status"] for job in preview.json()["jobs"]] == ["new"] * 5
                    assert (
                        httpx.get("http://127.0.0.1:47831/state", headers=headers).json()["jobs"]
                        == []
                    )
                    imported = httpx.post(
                        "http://127.0.0.1:47831/handoff/import", headers=headers, json=bundle
                    )
                    assert imported.status_code == 200, imported.text
                    state = httpx.get("http://127.0.0.1:47831/state", headers=headers).json()
                    assert not state["connected"] and len(state["jobs"]) == 5
                    for job in state["jobs"]:
                        expected = Path(
                            db.get_job_by_id(job["sourceJobId"])["selected_resume_pdf_path"]
                        ).read_bytes()
                        assert expected.startswith(b"%PDF-")
                        assert job["resumeSha256"] == hashlib.sha256(expected).hexdigest()
                        assert job["status"] == "queued"
                    replay = client.post("/api/c3/handoff", json={"job_ids": [1, 2, 3, 4, 5]})
                    assert replay.status_code == 200, replay.text
                    assert (
                        httpx.get("http://127.0.0.1:47831/state", headers=headers).json() == state
                    )
                    for column, value in [
                        ("apply_type", "easy_apply"),
                        ("enrichment_status", "pending"),
                        ("status", "applied"),
                        ("selected_resume_ready_for_c3", 0),
                    ]:
                        with closing(db.get_connection()) as connection:
                            old = connection.execute(
                                f"SELECT {column} FROM jobs WHERE id=1"
                            ).fetchone()[0]
                            connection.execute(f"UPDATE jobs SET {column}=? WHERE id=1", (value,))
                            connection.commit()
                        rejected = client.post("/api/c3/handoff", json={"job_ids": [1, 2]})
                        assert rejected.status_code == 409, rejected.text
                        assert all(x["status"] == "not_sent" for x in rejected.json()["outcomes"])
                        with closing(db.get_connection()) as connection:
                            connection.execute(f"UPDATE jobs SET {column}=? WHERE id=1", (old,))
                            connection.commit()
                    selected = Path(db.get_job_by_id(1)["selected_resume_pdf_path"])
                    selected.unlink()
                    assert client.post("/api/c3/handoff", json={"job_ids": [1]}).status_code == 409
                    delete_session(session)
                    assert client.post("/api/c3/handoff", json={"job_ids": [2]}).status_code == 401
                    assert (
                        httpx.get("http://127.0.0.1:47831/state", headers=headers).json() == state
                    )
                print(
                    json.dumps(
                        {
                            "status": "passed",
                            "jobs": 5,
                            "exact_pdf_handoffs": 5,
                            "portable_bundle_imports": 5,
                            "rejected_cases": 5,
                            "auth_rejected_cases": 4,
                            "replay_preserved_jobs": 5,
                            "browser_connected": False,
                            "provider": "heuristic",
                            "scope": "isolated SQLite, real C2 compilation and C3 HTTP queue; no discovery crawl or employer interaction",
                        }
                    )
                )
            finally:
                child.stdin.close()
                try:
                    child.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    child.terminate()
                    child.wait(timeout=10)


if __name__ == "__main__":
    main()
