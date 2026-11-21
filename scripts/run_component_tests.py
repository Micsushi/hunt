#!/usr/bin/env python3
"""Run grouped Hunt test suites with a short cross-platform command."""

from __future__ import annotations

import argparse
import ast
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NODE_TEST = re.compile(
    r"(?:^|[;)}])\s*(?:await\s+)?(?:test|it|\w+\.test)(?:\.(?:skip|todo|only|each|concurrent|serial))*\s*\(",
    re.MULTILINE,
)
TEST_TARGETS = {
    "all": [
        "tests",
    ],
    "c0": [
        "tests/test_c0_control_api.py",
        "tests/test_c3_product_handoff.py",
        "tests/test_review_ops.py",
        "tests/test_frontend_jobs_ui.py",
    ],
    "c1": [
        "tests/test_stage1.py",
        "tests/test_stage2.py",
        "tests/test_stage3.py",
        "tests/test_stage32.py",
        "tests/test_stage4.py",
        "tests/test_search_lanes.py",
        "tests/test_c1_discovery_policy.py",
        "tests/test_c1_review_regressions.py",
        "tests/test_c1_public_discovery.py",
        "tests/test_c1_structured_discovery.py",
        "tests/test_c1_google_discovery.py",
        "tests/test_c1_rmk_discovery.py",
        "tests/test_c1_sap_discovery.py",
        "tests/test_c1_taleo_discovery.py",
        "tests/test_c1_talentbrew_discovery.py",
        "tests/test_c1_schedule.py",
        "tests/test_c1_packaged_runner.py",
        "tests/test_c1_linkedin_discovery.py",
        "tests/test_c1_indeed_discovery.py",
        "tests/test_c1_public_verification.py",
        "tests/test_c1_postgres_live.py",
        "tests/test_component1_service_api.py",
    ],
    "c2": [
        "tests/test_fletcher_resume_checker.py",
        "tests/test_ad_hoc_pipeline.py",
        "tests/test_rewrite_validation.py",
        "tests/test_resume_compiler.py",
        "tests/test_fletcher_review_workspace.py",
        "tests/test_component2_stage1.py",
        "tests/test_component2_pipeline.py",
        "tests/test_fletcher_service.py",
        "tests/test_fletcher_queue_recovery.py",
        "tests/test_fletcher_postgres_live.py",
        "tests/test_resume_review_io.py",
        "tests/test_resume_renderer.py",
        "tests/test_resume_compiler_bounds.py",
        "tests/test_master_resume.py",
        "tests/test_llm_provider_routing.py",
    ],
    "shared": [
        "tests/test_db_compat.py",
        "tests/test_new_tables.py",
        "tests/test_deploy_readiness.py",
        "tests/test_github_actions_workflow_security.py",
    ],
    "frontend": [
        "tests/test_frontend_jobs_ui.py",
    ],
}
TARGET_ALIASES = {
    "backend": "c0",
    "hunter": "c1",
    "fletcher": "c2",
    "infra": "shared",
    "full": "all",
}


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run grouped Hunt test suites with one short command."
    )
    parser.add_argument(
        "target",
        nargs="?",
        default="all",
        help="Test target: all, c0, c1, c2, shared, frontend",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the pytest command without running it.",
    )
    parser.add_argument(
        "-k",
        dest="pytest_k",
        default=None,
        help="Optional pytest -k expression to narrow the target suite.",
    )
    return parser.parse_args(argv)


def _resolve_target(name: str) -> tuple[str, list[str]]:
    canonical = TARGET_ALIASES.get(name, name)
    patterns = TEST_TARGETS.get(canonical)
    if patterns is None:
        valid = ", ".join(sorted(TEST_TARGETS))
        raise RuntimeError(f"Unknown test target `{name}`. Valid targets: {valid}")
    return canonical, patterns


def _test_definition_count() -> int:
    # Use version-control scope so tests under scripts, shared code, or new
    # components count without pulling in dependencies or generated output.
    def git_files(*options: str) -> set[str]:
        names = subprocess.check_output(["git", "ls-files", "-z", *options], cwd=ROOT)
        return set(names.decode("utf-8").split("\0")) - {""}

    tracked = git_files("--cached")
    if not tracked:
        raise RuntimeError("No tracked repository files found while counting tests")
    roots = {name.split("/", 1)[0] for name in tracked if "/" in name}
    candidates = {
        name
        for name in git_files("--others", "--exclude-standard")
        if "/" not in name or name.split("/", 1)[0] in roots
    }
    # New top-level components join this inventory as soon as their first file is staged.
    count = 0
    for name in tracked | candidates:
        path = ROOT / name
        if not path.is_file():
            continue  # A tracked deletion may still be unstaged.
        if path.suffix == ".py":
            tree = ast.parse(path.read_bytes(), filename=name)
            count += sum(
                isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
                and node.name.startswith("test_")
                for node in ast.walk(tree)
            )
        elif path.suffix in {".ts", ".tsx", ".js", ".jsx", ".cjs", ".mjs", ".cts", ".mts"}:
            source = path.read_text(encoding="utf-8-sig")
            test_file = bool(re.search(r"\.(?:test|spec)\.", path.name))
            if test_file or re.search(
                r"""['"](?:node:test|vitest|@jest/globals|@playwright/test|bun:test)['"]""", source
            ):
                # Node treats a standalone assertion file as one test.
                count += max(int(test_file), len(NODE_TEST.findall(source)))
        elif path.name.lower().endswith(".tests.ps1"):
            count += len(
                re.findall(r"^\s*It\s+", path.read_text(encoding="utf-8-sig"), re.I | re.M)
            )
    if not count:
        raise RuntimeError("No permanent tests found in repository sources")
    return count


def main() -> int:
    args = _parse_args(sys.argv[1:])

    try:
        target, patterns = _resolve_target(args.target)
    except RuntimeError as exc:
        print(f"[tests] {exc}", file=sys.stderr)
        return 1

    command = [sys.executable, "-m", "pytest", "-q", *patterns]
    if args.pytest_k:
        command.extend(["-k", args.pytest_k])

    if target == "all":
        count = _test_definition_count()
        print(f"[tests] permanent test definitions: {count}")

    print("[tests] repo:", ROOT)
    print("[tests] target:", target)
    print("[tests] command:", " ".join(command))

    if args.dry_run:
        print("[tests] dry-run complete")
        return 0

    result = subprocess.run(command, cwd=ROOT)
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
