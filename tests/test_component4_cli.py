import io
import unittest
from contextlib import redirect_stdout

from orchestration.cli import main


class Component4CliTests(unittest.TestCase):
    def test_ready_command_returns_json(self) -> None:
        stdout = io.StringIO()
        with redirect_stdout(stdout):
            exit_code = main(["ready", "--job-id", "123"])
        self.assertEqual(exit_code, 0)
        self.assertIn('"job_id": 123', stdout.getvalue())
        self.assertIn('"ready": false', stdout.getvalue())

    def test_apply_prep_command_returns_json(self) -> None:
        stdout = io.StringIO()
        with redirect_stdout(stdout):
            exit_code = main(["apply-prep", "--job-id", "123"])
        self.assertEqual(exit_code, 0)
        self.assertIn('"job_id": 123', stdout.getvalue())
        self.assertIn('"manual_review_flags"', stdout.getvalue())

    def test_run_command_returns_json(self) -> None:
        stdout = io.StringIO()
        with redirect_stdout(stdout):
            exit_code = main(["run", "--job-id", "123", "--source-runtime", "openclaw"])
        self.assertEqual(exit_code, 0)
        self.assertIn('"run_id": "stub-123"', stdout.getvalue())
        self.assertIn('"source_runtime": "openclaw"', stdout.getvalue())


if __name__ == "__main__":
    unittest.main()
