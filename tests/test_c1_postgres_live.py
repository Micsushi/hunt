"""Opt-in PostgreSQL integration, isolated in a new schema owned by this test."""

import os
import unittest
import uuid
from unittest.mock import patch


@unittest.skipUnless(
    os.getenv("HUNT_TEST_POSTGRES_URL"), "set HUNT_TEST_POSTGRES_URL for PostgreSQL"
)
class PublicDiscoveryPostgresTest(unittest.TestCase):
    def test_discovery_queue_claim_verification_and_url_history(self):
        from hunter import db
        from hunter.discovery_sources import _job

        schema = "c1_test_" + uuid.uuid4().hex
        with patch.dict(
            os.environ, {"HUNT_DB_URL": os.environ["HUNT_TEST_POSTGRES_URL"], "PGOPTIONS": ""}
        ):
            bootstrap = db.get_connection()
            bootstrap.execute(f'CREATE SCHEMA "{schema}"')
            bootstrap.commit()
            try:
                with patch.dict(os.environ, {"PGOPTIONS": f"-c search_path={schema}"}):
                    from concurrent.futures import ThreadPoolExecutor
                    from threading import Barrier

                    barrier = Barrier(3)

                    def initialize(_):
                        barrier.wait(timeout=10)
                        db.init_db(maintenance=False)

                    with ThreadPoolExecutor(max_workers=3) as workers:
                        list(workers.map(initialize, range(3)))
                    from hunter.discovery_run import ScanBusy, ScanRun, scan_is_running

                    with ScanRun({"isolated": schema}) as scan:
                        self.assertTrue(scan_is_running())
                        with self.assertRaises(ScanBusy):
                            with ScanRun({"isolated": schema}):
                                pass
                        scan.saved("test:catalog", 1)
                    self.assertFalse(scan_is_running())
                    original = (
                        "https://job-boards.greenhouse.io/embed/job_app?for=example&token=1234"
                    )
                    candidate = _job(
                        title="IT Support",
                        company="C1 isolated test",
                        location="Canada",
                        url=original,
                        source="jobright",
                    )
                    state, job_id, *_ = db.add_job(candidate)
                    self.assertEqual(state, "inserted")
                    self.assertEqual(db.count_ready_public_employer_jobs(), 1)
                    claimed = db.claim_public_employer_job()
                    self.assertEqual(claimed["id"], job_id)
                    self.assertEqual(db.count_ready_public_employer_jobs(), 0)
                    self.assertEqual(
                        db.mark_job_enrichment_succeeded(
                            job_id,
                            description="Public employer's verified IT support description.",
                            apply_type="external_apply",
                            auto_apply_eligible=True,
                            apply_url="https://example.com/jobs?gh_jid=1234",
                            apply_host="example.com",
                            ats_type="greenhouse",
                            location="Austin, United States",
                            source="jobright",
                            expected_started_at=claimed["last_enrichment_started_at"],
                        ),
                        1,
                    )
                    self.assertEqual(
                        db.get_job_by_id(job_id)["discovery_suppressed_reason"], "outside_canada"
                    )
                    standard = {
                        **candidate,
                        "job_url": "https://boards.greenhouse.io/example/jobs/1234",
                        "apply_url": "https://boards.greenhouse.io/example/jobs/1234",
                        "source": "employer_greenhouse",
                    }
                    self.assertEqual(db.add_job(standard)[1], job_id)
                    self.assertEqual(db.get_job_by_id(job_id)["source_count"], 2)
                    self.assertEqual(db.requeue_job(job_id), 1)
                    db.update_job_status(job_id, "applied")
                    self.assertEqual(db.requeue_job(job_id), 0)
                    self.assertEqual(db.count_ready_public_employer_jobs(), 0)
                    db.upsert_company_fetch_queue(
                        "C1 isolated test", "https://example.com/careers", "manual"
                    )
                    db.record_company_fetch_result(
                        "C1 isolated test",
                        state="ok",
                        lead_count=1,
                        fetch_method="greenhouse",
                        resolved_url="https://boards-api.greenhouse.io/v1/boards/example/jobs",
                    )
                    db.upsert_company_fetch_queue(
                        "C1 isolated test", "https://example.com/careers", "manual"
                    )
                    queue = db.list_company_fetch_queue()
                    self.assertEqual(
                        queue[0]["resolved_url"],
                        "https://boards-api.greenhouse.io/v1/boards/example/jobs",
                    )
                    self.assertEqual(
                        (queue[0]["state"], queue[0]["fetch_method"]), ("ok", "greenhouse")
                    )
                    db.record_discovery_source_health(
                        "company:C1 isolated test", status="ok", lead_count=1
                    )
                    self.assertEqual(db.list_discovery_source_health()[0]["lead_count"], 1)
                    with db.get_connection() as conn:
                        conn.execute(
                            """INSERT INTO company_fetch_queue
                               (normalized_company, company, career_site, fetch_method, state)
                               VALUES (?, ?, ?, ?, ?)""",
                            (
                                "rbc",
                                "Royal Bank of Canada",
                                "https://example.com/early",
                                "workday",
                                "ok",
                            ),
                        )
                    db.upsert_company_fetch_queue("RBC", "https://example.com/main", "workday")
                    db.upsert_company_fetch_queue(
                        "Royal Bank of Canada", "https://example.com/early", "workday"
                    )
                    queues = {row["company"]: row for row in db.list_company_fetch_queue()}
                    self.assertEqual(len(queues), 3)
                    self.assertEqual(queues["Royal Bank of Canada"]["state"], "ok")
                    self.assertEqual(queues["RBC"]["career_site"], "https://example.com/main")
                    # Updating canonical identities must retain existing application history.
                    ukg = "https://recruiting.ultipro.ca/MAC5000MCDW/JobBoard/664818ff-3594-4bec-9f30-3394e59e19f3/OpportunityDetail?opportunityId=9cc6dbba-8ba9-4ed1-b20f-a228d8a2999c"
                    student = ukg.replace(
                        "664818ff-3594-4bec-9f30-3394e59e19f3",
                        "7667adcc-47ae-477a-9183-0d8ef8bc0748",
                    )
                    old_id = db.add_job(
                        {
                            **candidate,
                            "company": "MDA Space",
                            "job_url": "https://example.test/old",
                            "apply_url": None,
                        }
                    )[1]
                    copy_id = db.add_job(
                        {
                            **candidate,
                            "company": "MDA Space (students)",
                            "job_url": "https://example.test/copy",
                            "apply_url": None,
                        }
                    )[1]
                    with db.get_connection() as conn:
                        conn.execute(
                            "UPDATE jobs SET job_url=?,apply_url=?,status='applied',enrichment_attempts=7,discovery_policy_version=6 WHERE id=?",
                            (ukg, ukg, old_id),
                        )
                        conn.execute(
                            "UPDATE jobs SET job_url=?,apply_url=?,discovery_policy_version=6 WHERE id=?",
                            (student, student, copy_id),
                        )
                    db.init_db(maintenance=False)
                    from hunter.discovery_run import ScanBusy, ScanRun, scan_is_running

                    with ScanRun({"isolated": schema}) as scan:
                        self.assertTrue(scan_is_running())
                        with self.assertRaises(ScanBusy):
                            with ScanRun({"isolated": schema}):
                                pass
                        scan.saved("test:catalog", 1)
                    self.assertFalse(scan_is_running())
                    old, duplicate = db.get_job_by_id(old_id), db.get_job_by_id(copy_id)
                    self.assertEqual((old["status"], old["enrichment_attempts"]), ("applied", 7))
                    self.assertEqual(old["job_url"], ukg)
                    self.assertEqual(old["canonical_job_key"], duplicate["canonical_job_key"])
                    self.assertEqual(
                        duplicate["discovery_suppressed_reason"], "duplicate_canonical_job"
                    )
                    # The shared board claim path must work on PostgreSQL, preserve the
                    # previous state for restoration, and prevent an ordinary second claim.
                    board_id = db.add_job(
                        {
                            **candidate,
                            "source": "indeed",
                            "job_url": "https://ca.indeed.com/viewjob?jk=claimtest",
                            "apply_url": None,
                        }
                    )[1]
                    before = db.get_job_by_id(board_id)
                    claim = db.claim_job_for_enrichment(board_id, force=True, sources=("indeed",))
                    self.assertEqual(
                        claim["_previous_enrichment_status"], before["enrichment_status"]
                    )
                    self.assertIsNone(db.claim_job_for_enrichment(board_id, sources=("indeed",)))
                    self.assertIsNone(
                        db.claim_linkedin_job_for_hiring_cafe_fallback(board_id, force=True)
                    )
                    db.restore_job_enrichment_claim(claim, source="indeed")
                    self.assertEqual(
                        db.get_job_by_id(board_id)["enrichment_status"], before["enrichment_status"]
                    )
            finally:
                bootstrap.execute(f'DROP SCHEMA "{schema}" CASCADE')
                bootstrap.commit()
                bootstrap.close()


if __name__ == "__main__":
    unittest.main()
