import os
import tempfile
import unittest
from unittest import mock

from hunter.db import (  # type: ignore
    get_connection,
    init_db,
    requeue_enrichment_rows_by_error_codes,
)


class HunterRequeueErrorsTests(unittest.TestCase):
    def test_requeue_by_error_code_clears_error_and_sets_pending(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = os.path.join(tmp, "hunt.db")
            with mock.patch.dict(os.environ, {"HUNT_DB_PATH": db_path}, clear=False):
                init_db()
                conn = get_connection()
                cur = conn.cursor()
                cur.execute("DELETE FROM jobs")
                cur.execute(
                    "INSERT INTO jobs (title, job_url, source, enrichment_status, last_enrichment_error) VALUES (?,?,?,?,?)",
                    ("T1", "http://t/auth", "linkedin", "failed", "auth_expired: test"),
                )
                cur.execute(
                    "INSERT INTO jobs (title, job_url, source, enrichment_status, last_enrichment_error) VALUES (?,?,?,?,?)",
                    ("T2", "http://t/rate", "linkedin", "failed", "rate_limited: test"),
                )
                conn.commit()
                conn.close()

                updated = requeue_enrichment_rows_by_error_codes(
                    source="all", error_codes=["auth_expired", "rate_limited"]
                )
                self.assertEqual(updated, 2)

                conn = get_connection()
                rows = (
                    conn.cursor()
                    .execute(
                        "SELECT job_url, enrichment_status, last_enrichment_error FROM jobs ORDER BY job_url"
                    )
                    .fetchall()
                )
                conn.close()

                rendered = [dict(r) for r in rows]
                self.assertEqual(rendered[0]["enrichment_status"], "pending")
                self.assertIsNone(rendered[0]["last_enrichment_error"])
                self.assertEqual(rendered[1]["enrichment_status"], "pending")
                self.assertIsNone(rendered[1]["last_enrichment_error"])
