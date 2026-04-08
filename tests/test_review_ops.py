import json
import os
import sys
import tempfile
import unittest
from unittest.mock import patch

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO_ROOT)


class ReviewOpsApiTests(unittest.TestCase):
    def setUp(self):
        fd, self.path = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        self._env = patch.dict(os.environ, {"HUNT_DB_PATH": self.path}, clear=False)
        self._env.start()
        from hunter import db

        self.db = db
        db.init_db()
        _, job_id = db.add_job(
            {
                "title": "PM",
                "company": "Co",
                "location": "CA",
                "job_url": "https://www.linkedin.com/jobs/view/ops-test-1",
                "apply_url": None,
                "description": None,
                "source": "linkedin",
                "date_posted": "2026-04-08",
                "is_remote": 0,
                "level": "junior",
                "priority": 0,
                "category": "product",
                "apply_type": "unknown",
                "auto_apply_eligible": None,
                "enrichment_status": "pending",
                "enrichment_attempts": 1,
                "apply_host": None,
                "ats_type": None,
            }
        )
        self.job_id = job_id
        conn = db.get_connection()
        conn.execute(
            "UPDATE jobs SET enrichment_status = 'failed', last_enrichment_error = ? WHERE id = ?",
            ("auth_expired: LinkedIn session appears to be logged out or expired.", self.job_id),
        )
        conn.commit()
        conn.close()

    def tearDown(self):
        self._env.stop()
        if os.path.exists(self.path):
            os.remove(self.path)

    def test_api_ops_requeue_errors(self):
        import review_app

        response = review_app.api_ops_requeue_errors(
            {"source": "linkedin", "error_codes": ["auth_expired"]}
        )
        self.assertEqual(response.status_code, 200)
        data = json.loads(response.body.decode())
        self.assertEqual(data["updated"], 1)
        row = self.db.get_job_by_id(self.job_id)
        self.assertEqual(row["enrichment_status"], "pending")
        self.assertIsNone(row["last_enrichment_error"])

    def test_api_ops_requeue_empty_codes(self):
        from fastapi import HTTPException

        import review_app

        with self.assertRaises(HTTPException) as ctx:
            review_app.api_ops_requeue_errors({"source": "linkedin", "error_codes": []})
        self.assertEqual(ctx.exception.status_code, 400)


if __name__ == "__main__":
    unittest.main()
