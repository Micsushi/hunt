import json
import os
import tempfile
import unittest
from unittest import mock

from hunter.c1_logging import C1Logger  # type: ignore
from hunter.db import get_review_queue_summary, init_db  # type: ignore


class HunterLoggingIntegrationTests(unittest.TestCase):
    def test_c1_logger_writes_runtime_state_event_visible_in_summary(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = os.path.join(tmp, "hunt.db")
            artifacts_dir = os.path.join(tmp, "artifacts")
            os.makedirs(artifacts_dir, exist_ok=True)

            with mock.patch.dict(
                os.environ,
                {
                    "HUNT_DB_PATH": db_path,
                    "HUNT_ARTIFACTS_DIR": artifacts_dir,
                },
                clear=False,
            ):
                init_db()
                C1Logger(discord=False).event(
                    key="linkedin_last_rate_limited",
                    level="warn",
                    message="TEST: rate limited",
                    code="rate_limited",
                    details={"account_index": 0, "blocked_days": 1},
                )
                summary = get_review_queue_summary()
                self.assertIn("events", summary)
                payload = summary["events"]["linkedin_last_rate_limited"]["value"]
                parsed = json.loads(payload)
                self.assertEqual(parsed["code"], "rate_limited")
                self.assertEqual(parsed["message"], "TEST: rate limited")
