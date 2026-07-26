import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = (ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8")


class GitHubActionsWorkflowSecurityTest(unittest.TestCase):
    def test_public_pull_requests_remain_hosted(self) -> None:
        for job in ("pull-request-linux-smoke", "ci"):
            pattern = re.compile(
                rf"(?ms)^  {re.escape(job)}:\s+"
                r".*?if: github\.event_name == 'pull_request'"
                r".*?runs-on: ubuntu-latest"
            )
            self.assertRegex(WORKFLOW, pattern)

    def test_trusted_main_jobs_use_server1(self) -> None:
        for job in ("trusted-linux-smoke", "ci-trusted"):
            pattern = re.compile(
                rf"(?ms)^  {re.escape(job)}:\s+"
                r".*?if: github\.event_name == 'push' && "
                r"github\.ref == 'refs/heads/main'"
                r".*?runs-on: \[self-hosted, Linux, X64, server1, hunt\]"
            )
            self.assertRegex(WORKFLOW, pattern)

    def test_windows_jobs_remain_hosted(self) -> None:
        self.assertEqual(WORKFLOW.count("runs-on: windows-latest"), 3)
        self.assertNotIn("pull_request_target", WORKFLOW)

    def test_self_hosted_actions_are_commit_pinned(self) -> None:
        for job in ("trusted-linux-smoke", "ci-trusted"):
            match = re.search(
                rf"(?ms)^  {re.escape(job)}:\s+(.*?)(?=^  [a-zA-Z0-9_-]+:|\Z)",
                WORKFLOW,
            )
            self.assertIsNotNone(match)
            self.assertNotRegex(match.group(1), r"uses:\s+[^#\s]+@v\d+")


if __name__ == "__main__":
    unittest.main()
