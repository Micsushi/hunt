import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = (ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8")


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
    def test_public_pull_requests_remain_hosted(self) -> None:
        for job in ("pull-request-linux-smoke", "ci"):
            _assert_exact_job_target(
                WORKFLOW,
                job,
                "github.event_name == 'pull_request'",
                "ubuntu-latest",
            )

    def test_trusted_main_jobs_use_server1(self) -> None:
        for job in ("trusted-linux-smoke", "ci-trusted"):
            _assert_exact_job_target(
                WORKFLOW,
                job,
                "github.event_name == 'push' && github.ref == 'refs/heads/main'",
                "[self-hosted, Linux, X64, server1, hunt]",
            )

    def test_windows_jobs_remain_hosted(self) -> None:
        self.assertEqual(WORKFLOW.count("runs-on: windows-latest"), 3)
        self.assertNotIn("pull_request_target", WORKFLOW)

    def test_self_hosted_actions_are_commit_pinned(self) -> None:
        for job in ("trusted-linux-smoke", "ci-trusted"):
            _assert_actions_commit_pinned(WORKFLOW, job)

    def test_job_target_check_does_not_borrow_configuration_from_later_job(self) -> None:
        mutated = WORKFLOW.replace(
            "  pull-request-linux-smoke:\n"
            "    if: github.event_name == 'pull_request'\n"
            "    runs-on: ubuntu-latest",
            "  pull-request-linux-smoke:\n"
            "    if: github.event_name == 'pull_request'\n"
            "    runs-on: [self-hosted, Linux, X64, server1, hunt]",
            1,
        )
        with self.assertRaises(AssertionError):
            _assert_exact_job_target(
                mutated,
                "pull-request-linux-smoke",
                "github.event_name == 'pull_request'",
                "ubuntu-latest",
            )

    def test_commit_pin_check_rejects_branch_references(self) -> None:
        mutated = WORKFLOW.replace(
            "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
            "actions/checkout@main",
            1,
        )
        with self.assertRaises(AssertionError):
            _assert_actions_commit_pinned(mutated, "trusted-linux-smoke")


if __name__ == "__main__":
    unittest.main()
