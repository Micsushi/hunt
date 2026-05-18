from __future__ import annotations

import argparse
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from coordinator.agent_runtime import (  # noqa: E402
    build_result_template,
    build_runtime_command,
    build_worker_prompt,
    normalize_runtime_choice,
    runtime_choices,
)
from coordinator.agent_worker import run_once  # noqa: E402


def _claim(runtime_name="openclaw_isolated"):
    return {
        "claimed": True,
        "lease": {
            "lease_id": "lease-test",
            "run_id": "run-test",
            "runtime_name": runtime_name,
            "browser_lane": "isolated",
            "status": "active",
        },
        "fill": {
            "run_id": "run-test",
            "job_id": 42,
            "ats_type": "workday",
            "apply_url": "https://example.test/apply",
            "c3_payload": {
                "company": "Acme",
                "title": "Software Engineer",
                "selectedResumeVersionId": "resume-v1",
                "selectedResumePdfPath": "C:/tmp/resume.pdf",
            },
        },
    }


class Component4AgentRuntimeTests(unittest.TestCase):
    def test_runtime_choices_include_openclaw_and_hermes(self) -> None:
        choices = runtime_choices()
        self.assertIn("openclaw_isolated", choices)
        self.assertIn("openclaw_attached", choices)
        self.assertIn("hermes_local", choices)
        self.assertIn("hermes_server", choices)
        self.assertEqual(normalize_runtime_choice("openclaw").name, "openclaw_isolated")
        self.assertEqual(normalize_runtime_choice("hermes").name, "hermes_local")

    def test_worker_prompt_is_bounded_and_does_not_embed_service_token(self) -> None:
        prompt = build_worker_prompt(
            base_url="http://127.0.0.1:8003",
            claim=_claim(),
            token_env_var="HUNT_SERVICE_TOKEN",
            claim_path=".runtime/claim.json",
            result_template_path=".runtime/result_template.json",
        )
        self.assertIn("lease-test", prompt)
        self.assertIn("/workers/lease-test/result", prompt)
        self.assertIn("Do not click any submit", prompt)
        self.assertIn("Do not browse unrelated pages", prompt)
        self.assertIn("HUNT_SERVICE_TOKEN", prompt)
        self.assertNotIn("super-secret-token", prompt)

    def test_result_template_has_required_worker_fields(self) -> None:
        template = build_result_template(_claim())
        for key in (
            "status",
            "failure_code_confirmed",
            "page_observed",
            "widget_details",
            "agent_findings",
            "suggested_fix_area",
            "screenshots",
            "html_snapshot",
            "notes",
        ):
            self.assertIn(key, template)
        self.assertIsInstance(template["widget_details"], dict)
        self.assertIsInstance(template["screenshots"], list)

    def test_runtime_commands_match_current_cli_entrypoints(self) -> None:
        openclaw = build_runtime_command(runtime_name="openclaw_isolated", prompt="hello")
        hermes = build_runtime_command(runtime_name="hermes_local", prompt="hello")
        self.assertEqual(openclaw[:2], ["openclaw", "agent"])
        self.assertIn("--local", openclaw)
        self.assertTrue(str(hermes[0]).endswith("hermes") or str(hermes[0]).endswith("hermes.exe"))
        self.assertEqual(hermes[1:3], ["chat", "-q"])
        self.assertIn("--quiet", hermes)
        self.assertIn("--ignore-rules", hermes)
        self.assertIn("--max-turns", hermes)
        self.assertIn("--toolsets", hermes)

    def test_agent_worker_claims_one_lease_and_does_not_execute_by_default(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            args = argparse.Namespace(
                runtime="hermes",
                base_url="http://127.0.0.1:8003",
                service_token="super-secret-token",
                service_token_env="HUNT_SERVICE_TOKEN",
                browser_lane=None,
                lease_seconds=120,
                out_dir=tmp,
                agent_name=None,
                toolsets=None,
                execute_agent=False,
                mock_result=False,
            )
            with patch("coordinator.agent_worker.claim_next_fill_http") as claim_mock:
                with patch(
                    "coordinator.agent_worker.run_external_agent_with_heartbeat"
                ) as run_mock:
                    claim_mock.return_value = _claim(runtime_name="hermes_local")
                    result = run_once(args)
                    prompt_text = Path(result["artifacts"]["prompt_path"]).read_text()
                    prompt_exists = Path(result["artifacts"]["prompt_path"]).exists()
                    claim_exists = Path(result["artifacts"]["claim_path"]).exists()
                    template_exists = Path(result["artifacts"]["result_template_path"]).exists()

            self.assertTrue(result["claimed"])
            self.assertEqual(result["runtime"], "hermes_local")
            self.assertFalse(result["agent_executed"])
            self.assertTrue(prompt_exists)
            self.assertTrue(claim_exists)
            self.assertTrue(template_exists)
            self.assertIn("hermes", result["artifacts"]["command_preview"]["bash"])
            self.assertIn("chat -q", result["artifacts"]["command_preview"]["bash"])
            self.assertNotIn("super-secret-token", prompt_text)
            run_mock.assert_not_called()

    def test_agent_worker_mock_result_posts_without_launching_agent(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            args = argparse.Namespace(
                runtime="openclaw",
                base_url="http://127.0.0.1:8003",
                service_token=None,
                service_token_env="HUNT_SERVICE_TOKEN",
                browser_lane="isolated",
                lease_seconds=120,
                out_dir=tmp,
                agent_name=None,
                toolsets=None,
                execute_agent=False,
                mock_result=True,
            )
            with patch("coordinator.agent_worker.claim_next_fill_http") as claim_mock:
                with patch("coordinator.agent_worker.post_worker_result_http") as post_mock:
                    with patch(
                        "coordinator.agent_worker.run_external_agent_with_heartbeat"
                    ) as run_mock:
                        claim_mock.return_value = _claim(runtime_name="openclaw_isolated")
                        post_mock.return_value = {"run": {"status": "awaiting_submit_approval"}}
                        result = run_once(args)

        self.assertTrue(result["mock_result_posted"])
        self.assertEqual(result["mock_result_status"], "awaiting_submit_approval")
        posted_payload = post_mock.call_args.kwargs["payload"]
        self.assertEqual(posted_payload["status"], "complete")
        self.assertEqual(posted_payload["notes"], "mock")
        run_mock.assert_not_called()


if __name__ == "__main__":
    unittest.main()
