import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = (ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8")
JOBS = re.findall(r"(?m)^  ([a-zA-Z0-9_-]+):\s*$", WORKFLOW.split("jobs:\n", 1)[1])


def _job_block(workflow: str, job: str) -> str:
    match = re.search(
        rf"(?ms)^  {re.escape(job)}:\s*\n(.*?)(?=^  [a-zA-Z0-9_-]+:\s*\n|\Z)",
        workflow,
    )
    if match is None:
        raise AssertionError(f"workflow job is missing: {job}")
    return match.group(1)


def _assert_exact_job_target(workflow: str, job: str, condition: str, runner: str) -> None:
    block = _job_block(workflow, job)
    if re.search(rf"(?m)^    if: {re.escape(condition)}\s*$", block) is None:
        raise AssertionError(f"{job} has the wrong condition")
    if re.search(rf"(?m)^    runs-on: {re.escape(runner)}\s*$", block) is None:
        raise AssertionError(f"{job} has the wrong runner")


def _assert_actions_commit_pinned(workflow: str, job: str) -> None:
    uses = re.findall(r"(?m)^\s*uses:\s+([^#\s]+)", _job_block(workflow, job))
    if not uses:
        raise AssertionError(f"{job} has no actions")
    if any(re.fullmatch(r"[^@]+@[0-9a-f]{40}", value) is None for value in uses):
        raise AssertionError(f"{job} contains an action that is not pinned to a commit")


class GitHubActionsWorkflowSecurityTest(unittest.TestCase):
    def test_ci_jobs_use_pinned_actions_on_the_authorized_runner(self):
        for jobs, condition, runner in [
            (
                ("pull-request-linux-smoke", "ci"),
                "github.event_name == 'pull_request'",
                "ubuntu-latest",
            ),
            (
                ("trusted-linux-smoke", "ci-trusted"),
                "github.event_name == 'push' && github.ref == 'refs/heads/main'",
                "[self-hosted, Linux, X64, hunt]",
            ),
        ]:
            for job in jobs:
                _assert_exact_job_target(WORKFLOW, job, condition, runner)
        for job in JOBS:
            _assert_actions_commit_pinned(WORKFLOW, job)
        for job in ("c3-windows", "ui-cli-smoke", "hunter-cli-smoke", "fletch-cli-smoke"):
            self.assertIn("runs-on: windows-latest", _job_block(WORKFLOW, job))


if __name__ == "__main__":
    unittest.main()
