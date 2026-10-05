"""Local advisory resume checks and the Resume Cooker subprocess boundary."""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import shlex
import signal
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

SUPPORTED_SCHEMA_VERSION = 1
TERMINAL_STATUSES = frozenset({"pass", "pass_with_warnings", "fail"})
MAX_CAPTURE_BYTES = 1_000_000


@dataclass(frozen=True)
class ResumeCookerConfig:
    command: tuple[str, ...] = ("resume-cooker",)
    timeout_seconds: float = 120.0
    report_root: Path = Path(".state/resume_cooker")

    def __post_init__(self) -> None:
        if not math.isfinite(self.timeout_seconds) or self.timeout_seconds <= 0:
            raise ValueError("Resume Cooker timeout must be positive and finite.")

    @classmethod
    def from_env(cls, *, repo_root: str | Path | None = None) -> ResumeCookerConfig:
        root = Path(repo_root or Path(__file__).resolve().parents[1])
        raw_command = os.getenv("HUNT_C2_RESUME_CHECK_COMMAND", "")
        command = (
            tuple(part.strip('"') for part in shlex.split(raw_command, posix=os.name != "nt"))
            if raw_command
            else ("node", str(Path(__file__).with_name("resume_cooker") / "hunt-check.mjs"))
        )
        if not command:
            raise ValueError("HUNT_C2_RESUME_CHECK_COMMAND is empty.")
        timeout_seconds = float(os.getenv("HUNT_RESUME_COOKER_TIMEOUT_SECONDS", "120"))
        return cls(
            command=command,
            timeout_seconds=timeout_seconds,
            report_root=Path(
                os.getenv(
                    "HUNT_RESUME_COOKER_REPORT_ROOT",
                    str(root / ".state" / "resume_cooker"),
                )
            ),
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
                    start_new_session=os.name != "nt",
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
        if not report_path.is_file() or report_path.stat().st_size > MAX_CAPTURE_BYTES:
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
    if report.get("content_left_machine") is not False:
        return "Local resume checks must not send content off this machine."
    checks = report.get("checks")
    if not isinstance(checks, list) or not all(isinstance(check, dict) for check in checks):
        return "Resume Cooker checks must be a list of objects."
    expected = expected_exit(report)
    if exit_code != expected:
        return "Resume Cooker exit code and report status disagree."
    return None


def expected_exit(report: dict[str, Any]) -> int:
    if any(
        isinstance(check, dict)
        and isinstance(check.get("metadata"), dict)
        and check["metadata"].get("required_capability_unavailable") is True
        for check in report["checks"]
    ):
        return 69
    return 2 if report.get("status") == "fail" else 0


def _terminate(process: subprocess.Popen[str]) -> None:
    if process.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(
            ["taskkill.exe", "/PID", str(process.pid), "/T", "/F"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    else:
        try:
            os.killpg(os.getpgid(process.pid), signal.SIGTERM)
        except OSError:
            process.terminate()
    try:
        process.communicate(timeout=5)
        return
    except subprocess.TimeoutExpired:
        if os.name != "nt":
            try:
                os.killpg(os.getpgid(process.pid), signal.SIGKILL)
            except OSError:
                pass
        if process.poll() is None:
            process.kill()
        try:
            process.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            return


def _read_capture(stream: Any) -> str | None:
    stream.seek(0)
    value = stream.read(MAX_CAPTURE_BYTES + 1)
    if len(value) > MAX_CAPTURE_BYTES:
        return None
    return value.decode("utf-8", errors="replace")


def check_resume(path: str | Path, *, job_description: str = "") -> dict[str, Any]:
    """Read-only, local assessment. Never calls tailoring or selects a resume."""
    path = Path(path)
    if path.suffix.lower() not in {".pdf", ".tex"}:
        raise ValueError("Choose a PDF or TeX resume.")
    if path.stat().st_size > 10 * 1024 * 1024:
        raise ValueError("Resume must be 10 MB or smaller.")
    if len(job_description) > 100_000:
        raise ValueError("Job description must be 100,000 characters or fewer.")
    checks = []

    def finding(name: str, ok: bool, evidence: str, fix: str = "") -> None:
        checks.append(
            {
                "id": name,
                "category": "independent_pdf",
                "severity": "medium",
                "status": "pass" if ok else "warning",
                "evidence": evidence,
                "suggested_fix": "" if ok else fix,
            }
        )

    if path.suffix.lower() == ".pdf":
        from pdfminer.high_level import extract_text
        from pypdf import PdfReader

        try:
            reader = PdfReader(path)
            if reader.is_encrypted:
                raise ValueError("Upload an unencrypted PDF.")
            if len(reader.pages) > 20:
                raise ValueError("Resume exceeds the 20-page checking limit.")
            text = extract_text(str(path))
            other = "\n".join(page.extract_text() or "" for page in reader.pages)
        except ValueError:
            raise
        except Exception as exc:
            raise ValueError("Could not read this PDF. Export a fresh text-based PDF.") from exc
        finding(
            "page_count",
            len(reader.pages) <= 2,
            f"{len(reader.pages)} page(s). Length is advisory, not an ATS rejection rule.",
            "Check whether every page adds relevant evidence.",
        )

        def tokens(value):
            return Counter(re.findall(r"[a-z0-9+#]+", value.lower()))

        left, right = tokens(text), tokens(other)
        total = max(sum(left.values()), sum(right.values()))
        agreement = sum((left & right).values()) / total if total else 0
        finding(
            "independent_parser_agreement",
            agreement >= 0.95,
            f"pdfminer and pypdf agree on {agreement:.0%} of extracted word occurrences.",
            "Inspect copy/paste text and reading order; export with Unicode font mappings.",
        )
        broken = text.count("\ufffd") + other.count("\ufffd")
        finding(
            "unicode_mapping",
            broken == 0,
            f"Independent parsers found {broken} replacement characters in total.",
            "Export with embedded fonts and Unicode mappings; recheck bullets and apostrophes.",
        )
    else:
        source = path.read_text(encoding="utf-8")
        # Source-only checks cannot establish PDF parseability.
        text = re.sub(r"\\[A-Za-z]+\*?(?:\[[^]]*\])?", " ", source)
        text = re.sub(r"[{}]", " ", text)
        finding(
            "pdf_not_checked",
            False,
            "TeX source only; PDF parsing has not been tested.",
            "Upload the exported PDF to check its actual text layer.",
        )
    finding(
        "contact_email",
        bool(re.search(r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}", text)),
        "Email address found." if "@" in text else "No email address detected.",
        "Keep an email address in selectable body text.",
    )
    with tempfile.TemporaryDirectory(prefix="hunt-resume-check-") as directory:
        root = Path(directory)
        extracted = root / "resume.txt"
        extracted.write_text(text, encoding="utf-8")
        args = ["--text", str(extracted)]
        if path.suffix.lower() == ".tex":
            args += ["--source", str(path.resolve())]
        if job_description.strip():
            jd = root / "job.txt"
            jd.write_text(job_description, encoding="utf-8")
            args += ["--jd", str(jd)]
        config = ResumeCookerConfig.from_env()
        config = ResumeCookerConfig(
            command=config.command, timeout_seconds=config.timeout_seconds, report_root=root
        )
        result = ResumeCookerAdapter(config).run("check", args)
        if not result.completed:
            raise RuntimeError(result.message)
        checks = result.report["checks"] + checks
    scored = [item for item in checks if item["category"] != "jd_match"]
    passed = sum(item["status"] == "pass" for item in scored)
    return {
        "schema_version": 1,
        "status": "fail"
        if any(c["status"] == "fail" for c in checks)
        else "pass_with_warnings"
        if any(c["status"] != "pass" for c in checks)
        else "pass",
        "score": round(100 * passed / len(scored)) if scored else None,
        "score_label": "Local checks passed (%)",
        "passed_checks": passed,
        "total_checks": len(scored),
        "checks": checks,
        "content_left_machine": False,
        "input_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "job_specific": bool(job_description.strip()),
        "limitations": "Advisory checks, not an employer ATS score or hiring prediction. "
        "No automatic rewriting or score optimization.",
    }


def check_resume_upload(path: Path, *, job_description: str = "") -> dict[str, Any]:
    """Bound PDF parsing as well as Node checking for untrusted uploads."""
    with tempfile.TemporaryDirectory(prefix="hunt-check-worker-") as directory:
        root = Path(directory)
        jd_path = root / "jd.txt"
        output = root / "report.json"
        jd_path.write_text(job_description, encoding="utf-8")
        try:
            result = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "fletcher.resume_checker",
                    str(path),
                    "--jd",
                    str(jd_path),
                    "--out",
                    str(output),
                ],
                cwd=Path(__file__).resolve().parents[1],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=150,
                check=False,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except subprocess.TimeoutExpired as exc:
            raise RuntimeError("Resume checking timed out. Try a smaller PDF.") from exc
        if not output.is_file() or output.stat().st_size > MAX_CAPTURE_BYTES:
            raise RuntimeError("Resume checking did not produce a valid report.")
        report = json.loads(output.read_text(encoding="utf-8"))
        if result.returncode == 2:
            raise ValueError(report["error"])
        if result.returncode:
            raise RuntimeError(report.get("error", "Resume checking failed."))
        return report


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Check a resume locally without modifying it.")
    parser.add_argument("resume")
    parser.add_argument("--jd", type=Path)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    code = 0
    try:
        payload = check_resume(
            args.resume, job_description=args.jd.read_text(encoding="utf-8") if args.jd else ""
        )
    except (ValueError, UnicodeError):
        payload = {
            "error": "Could not read the resume. Use an unencrypted text PDF (up to 20 pages) or UTF-8 TeX, up to 10 MB."
        }
        code = 2
    except Exception:
        payload = {
            "error": "Resume checking is unavailable. Check Node.js and the installed PDF dependencies."
        }
        code = 1
    encoded = json.dumps(payload, ensure_ascii=True, indent=2)
    if args.out:
        args.out.write_text(encoded, encoding="utf-8")
    else:
        print(encoded)
    raise SystemExit(code)
