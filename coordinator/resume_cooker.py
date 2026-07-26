"""Versioned Resume Cooker subprocess boundary and Fletcher quality policy."""

from __future__ import annotations

import json
import os
import shlex
import subprocess
import tempfile
import threading
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

SUPPORTED_SCHEMA_VERSION = 1
TERMINAL_STATUSES = frozenset({"pass", "pass_with_warnings", "fail"})
MAX_CAPTURE_BYTES = 1_000_000


@dataclass(frozen=True)
class QualityOverride:
    actor: str
    reason: str
    created_at: str

    @classmethod
    def create(cls, *, actor: str, reason: str) -> QualityOverride:
        actor = actor.strip()
        reason = reason.strip()
        if not actor or not reason:
            raise ValueError("Resume Cooker override requires actor and reason.")
        return cls(
            actor=actor,
            reason=reason,
            created_at=datetime.now(UTC).replace(microsecond=0).isoformat(),
        )

    def to_dict(self) -> dict[str, str]:
        return {
            "actor": self.actor,
            "reason": self.reason,
            "created_at": self.created_at,
        }


@dataclass(frozen=True)
class ResumeCookerConfig:
    enabled: bool = False
    command: tuple[str, ...] = ("resume-cooker",)
    timeout_seconds: float = 120.0
    report_root: Path = Path(".state/resume_cooker")
    required: bool = True

    @classmethod
    def from_env(cls, *, repo_root: str | Path | None = None) -> ResumeCookerConfig:
        root = Path(repo_root or Path(__file__).resolve().parents[1])
        raw_command = os.getenv("HUNT_RESUME_COOKER_COMMAND", "resume-cooker")
        command = tuple(shlex.split(raw_command, posix=os.name != "nt"))
        if not command:
            raise ValueError("HUNT_RESUME_COOKER_COMMAND is empty.")
        return cls(
            enabled=_truthy(os.getenv("HUNT_RESUME_COOKER_ENABLED")),
            command=command,
            timeout_seconds=float(os.getenv("HUNT_RESUME_COOKER_TIMEOUT_SECONDS", "120")),
            report_root=Path(
                os.getenv(
                    "HUNT_RESUME_COOKER_REPORT_ROOT",
                    str(root / ".state" / "resume_cooker"),
                )
            ),
            required=not _truthy(os.getenv("HUNT_RESUME_COOKER_OPTIONAL")),
        )


@dataclass(frozen=True)
class AdapterResult:
    kind: str
    report: dict[str, Any] | None
    report_path: str | None
    message: str
    exit_code: int | None

    @property
    def completed(self) -> bool:
        return self.kind == "completed" and self.report is not None

    @property
    def status(self) -> str | None:
        return self.report.get("status") if self.report else None

    @property
    def report_id(self) -> str | None:
        return self.report.get("run_id") if self.report else None

    def to_public_dict(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "status": self.status,
            "report_id": self.report_id,
            "report_path": self.report_path,
            "message": self.message,
            "exit_code": self.exit_code,
        }


class ResumeCookerAdapter:
    def __init__(
        self,
        config: ResumeCookerConfig,
        *,
        popen_factory: Callable[..., subprocess.Popen[str]] = subprocess.Popen,
    ) -> None:
        self.config = config
        self._popen_factory = popen_factory

    def run(
        self,
        command: str,
        args: list[str],
        *,
        cancel_event: threading.Event | None = None,
    ) -> AdapterResult:
        report_path = self._report_path(command)
        argv = [
            *self.config.command,
            command,
            *args,
            "--out",
            str(report_path),
            "--json",
        ]
        creationflags = (
            subprocess.CREATE_NO_WINDOW
            if os.name == "nt" and hasattr(subprocess, "CREATE_NO_WINDOW")
            else 0
        )
        with (
            tempfile.TemporaryFile(mode="w+b") as stdout_file,
            tempfile.TemporaryFile(mode="w+b") as stderr_file,
        ):
            try:
                process = self._popen_factory(
                    argv,
                    stdin=subprocess.DEVNULL,
                    stdout=stdout_file,
                    stderr=stderr_file,
                    shell=False,
                    creationflags=creationflags,
                )
            except OSError:
                return AdapterResult(
                    "unavailable",
                    None,
                    None,
                    "Resume Cooker executable is unavailable.",
                    None,
                )

            deadline = time.monotonic() + self.config.timeout_seconds
            while process.poll() is None:
                if cancel_event and cancel_event.is_set():
                    _terminate(process)
                    return AdapterResult("cancelled", None, None, "Resume Cooker cancelled.", None)
                if time.monotonic() >= deadline:
                    _terminate(process)
                    return AdapterResult("timeout", None, None, "Resume Cooker timed out.", None)
                time.sleep(0.02)

            stdout = _read_capture(stdout_file)
            stderr = _read_capture(stderr_file)
        if stdout is None or stderr is None:
            return AdapterResult(
                "malformed",
                None,
                None,
                "Resume Cooker output exceeded the capture limit.",
                process.returncode,
            )
        try:
            report = json.loads(stdout)
        except (json.JSONDecodeError, UnicodeDecodeError, TypeError):
            return AdapterResult(
                "malformed",
                None,
                None,
                "Resume Cooker returned invalid JSON.",
                process.returncode,
            )
        validation_error = validate_report(report, command, process.returncode)
        if validation_error:
            return AdapterResult(
                "malformed",
                None,
                None,
                validation_error,
                process.returncode,
            )
        if not report_path.is_file():
            return AdapterResult(
                "malformed",
                None,
                None,
                "Resume Cooker did not persist its report.",
                process.returncode,
            )
        try:
            persisted = json.loads(report_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return AdapterResult(
                "malformed",
                None,
                None,
                "Resume Cooker persisted an unreadable report.",
                process.returncode,
            )
        if persisted != report:
            return AdapterResult(
                "malformed",
                None,
                None,
                "Resume Cooker stdout and persisted report disagree.",
                process.returncode,
            )
        return AdapterResult(
            "completed",
            report,
            str(report_path),
            "Resume Cooker completed.",
            process.returncode,
        )

    def _report_path(self, command: str) -> Path:
        self.config.report_root.mkdir(parents=True, exist_ok=True)
        return self.config.report_root / f"{command}-{uuid.uuid4()}.json"


class ResumeCookerQualityGate:
    def __init__(
        self,
        config: ResumeCookerConfig,
        *,
        adapter: ResumeCookerAdapter | None = None,
    ) -> None:
        self.config = config
        self.adapter = adapter or ResumeCookerAdapter(config)

    def run(
        self,
        *,
        source_path: str | Path,
        fletcher: Callable[[], dict[str, Any]],
        jd_path: str | Path | None = None,
        preflight_override: QualityOverride | None = None,
        postflight_override: QualityOverride | None = None,
        cancel_event: threading.Event | None = None,
    ) -> dict[str, Any]:
        if not self.config.enabled:
            return fletcher()

        preflight_args = ["--suite", "local", "--resume", str(source_path)]
        if jd_path:
            preflight_args.extend(["--jd", str(jd_path)])
        preflight = self.adapter.run("check", preflight_args, cancel_event=cancel_event)
        if not _allowed(preflight, preflight_override, required=self.config.required):
            return self._record_decision(blocked_result("preflight", preflight, preflight_override))

        fletcher_result = fletcher()
        if not isinstance(fletcher_result, dict):
            raise TypeError("Fletcher result must be a dictionary.")
        after = fletcher_result.get("tex_path")
        pdf = fletcher_result.get("pdf_path")
        if not after or not pdf or not Path(after).is_file() or not Path(pdf).is_file():
            return self._record_decision(
                {
                    **fletcher_result,
                    "selected_for_c3": False,
                    "resume_cooker_quality": {
                        "enabled": True,
                        "ready_for_c3": False,
                        "preflight": preflight.to_public_dict(),
                        "postflight": {
                            "kind": "not_run",
                            "message": "Fletcher produced no complete final artifacts.",
                        },
                        "flags": ["resume_cooker.fletcher_artifacts_missing"],
                    },
                }
            )

        postflight_args = [
            "--before",
            str(source_path),
            "--after",
            str(after),
            "--pdf",
            str(pdf),
        ]
        if jd_path:
            postflight_args.extend(["--jd", str(jd_path)])
        postflight = self.adapter.run("compare", postflight_args, cancel_event=cancel_event)
        ready = _allowed(postflight, postflight_override, required=self.config.required)
        flags = [
            *report_flags(preflight),
            *report_flags(postflight),
            *[
                f"fletcher.{_flag(value)}"
                for value in fletcher_result.get("concern_flags", [])
                if _flag(value)
            ],
        ]
        return self._record_decision(
            {
                **fletcher_result,
                "selected_for_c3": bool(
                    fletcher_result.get(
                        "quality_candidate_for_c3",
                        fletcher_result.get("selected_for_c3"),
                    )
                )
                and ready,
                "resume_cooker_quality": {
                    "enabled": True,
                    "ready_for_c3": ready,
                    "preflight": preflight.to_public_dict(),
                    "postflight": postflight.to_public_dict(),
                    "preflight_override": preflight_override.to_dict()
                    if preflight_override
                    else None,
                    "postflight_override": postflight_override.to_dict()
                    if postflight_override
                    else None,
                    "flags": list(dict.fromkeys(flags)),
                    "content_left_machine": any(
                        item.report and item.report.get("content_left_machine") is True
                        for item in (preflight, postflight)
                    ),
                },
            }
        )

    def _record_decision(self, result: dict[str, Any]) -> dict[str, Any]:
        decision_id = str(uuid.uuid4())
        recorded_at = datetime.now(UTC).replace(microsecond=0).isoformat()
        quality = result["resume_cooker_quality"]
        self.config.report_root.mkdir(parents=True, exist_ok=True)
        decision_path = self.config.report_root / f"decision-{decision_id}.json"
        temporary = decision_path.with_suffix(".json.tmp")
        quality["decision_id"] = decision_id
        quality["decision_path"] = str(decision_path)
        quality["recorded_at"] = recorded_at
        payload = {
            "schema_version": SUPPORTED_SCHEMA_VERSION,
            "decision_id": decision_id,
            "recorded_at": recorded_at,
            "selected_for_c3": bool(result.get("selected_for_c3")),
            "resume_cooker_quality": quality,
        }
        try:
            with temporary.open("x", encoding="utf-8") as stream:
                json.dump(payload, stream, indent=2, sort_keys=True)
                stream.write("\n")
            os.replace(temporary, decision_path)
        finally:
            temporary.unlink(missing_ok=True)
        return result


def validate_report(report: Any, command: str, exit_code: int) -> str | None:
    if not isinstance(report, dict):
        return "Resume Cooker report must be an object."
    if report.get("schema_version") != SUPPORTED_SCHEMA_VERSION:
        return "Resume Cooker schema version is unsupported."
    if report.get("command") != command:
        return "Resume Cooker report command does not match the request."
    if report.get("status") not in TERMINAL_STATUSES:
        return "Resume Cooker report status is invalid."
    if not isinstance(report.get("run_id"), str) or not report["run_id"].strip():
        return "Resume Cooker report identity is missing."
    if not isinstance(report.get("content_left_machine"), bool):
        return "Resume Cooker privacy metadata is missing."
    expected = expected_exit(report)
    if exit_code != expected:
        return "Resume Cooker exit code and report status disagree."
    return None


def expected_exit(report: dict[str, Any]) -> int:
    if any(
        isinstance(check, dict)
        and isinstance(check.get("metadata"), dict)
        and check["metadata"].get("required_capability_unavailable") is True
        for check in report.get("checks", [])
    ):
        return 69
    return 2 if report.get("status") == "fail" else 0


def report_flags(result: AdapterResult) -> list[str]:
    if not result.completed:
        return [f"resume_cooker.{_flag(result.kind)}"]
    return [
        f"resume_cooker.{_flag(str(check.get('id', 'finding')))}"
        for check in result.report.get("checks", [])
        if isinstance(check, dict) and check.get("status") != "pass"
    ]


def blocked_result(
    stage: str,
    result: AdapterResult,
    override: QualityOverride | None,
) -> dict[str, Any]:
    return {
        "status": "blocked_quality",
        "selected_for_c3": False,
        "resume_cooker_quality": {
            "enabled": True,
            "ready_for_c3": False,
            stage: result.to_public_dict(),
            f"{stage}_override": override.to_dict() if override else None,
            "flags": report_flags(result),
            "content_left_machine": bool(
                result.report and result.report.get("content_left_machine") is True
            ),
        },
    }


def _allowed(
    result: AdapterResult,
    override: QualityOverride | None,
    *,
    required: bool,
) -> bool:
    if override is not None:
        return result.completed
    if not result.completed:
        return not required
    return result.status in {"pass", "pass_with_warnings"}


def _flag(value: str) -> str:
    return "".join(
        char if char.isalnum() or char in "._-" else "_" for char in value.lower()
    ).strip("._-")


def _terminate(process: subprocess.Popen[str]) -> None:
    try:
        if os.name == "nt" and process.poll() is None:
            subprocess.run(
                ["taskkill.exe", "/PID", str(process.pid), "/T", "/F"],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        if process.poll() is None:
            process.kill()
    finally:
        try:
            process.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            pass


def _read_capture(stream: Any) -> str | None:
    stream.seek(0)
    value = stream.read(MAX_CAPTURE_BYTES + 1)
    if len(value) > MAX_CAPTURE_BYTES:
        return None
    return value.decode("utf-8", errors="replace")


def _truthy(value: Any) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}
