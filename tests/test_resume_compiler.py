from __future__ import annotations

import subprocess
from pathlib import Path

from fletcher.resume import compiler


class FakeProcess:
    def __init__(self, *, returncode: int | None = 0, stdout: object | None = None) -> None:
        self.returncode = returncode
        self.pid = 1234
        self.wait_calls: list[float | None] = []
        self.killed = False
        if stdout is not None:
            stdout.write(b"compiler output")

    def poll(self) -> int | None:
        return self.returncode

    def wait(self, timeout: float | None = None) -> int | None:
        self.wait_calls.append(timeout)
        return self.returncode

    def kill(self) -> None:
        self.killed = True
        self.returncode = -9


def test_fallback_page_count_keeps_page_tree_parent_out_of_count(tmp_path: Path, monkeypatch):
    pdf_path = tmp_path / "resume.pdf"
    pdf_path.write_bytes(
        b"<< /Type /Pages /Count 2 >> "
        b"<< /Type /Page /Parent 1 0 R >> "
        b"<< /Type /Page /Parent 1 0 R >>"
    )
    monkeypatch.setattr(compiler.shutil, "which", lambda _name: None)

    assert compiler.get_pdf_page_count(pdf_path) == 2


def test_pdfinfo_output_is_read_through_the_bounded_runner(tmp_path: Path, monkeypatch):
    process_holder: list[FakeProcess] = []

    def start(_args, **kwargs):
        process = FakeProcess(stdout=kwargs["stdout"])
        kwargs["stdout"].seek(0)
        kwargs["stdout"].truncate(0)
        kwargs["stdout"].write(b"Pages:                 3\n")
        process_holder.append(process)
        return process

    monkeypatch.setattr(compiler.shutil, "which", lambda _name: "pdfinfo")
    monkeypatch.setattr(compiler.subprocess, "Popen", start)

    assert compiler.get_pdf_page_count(tmp_path / "resume.pdf") == 3
    assert process_holder[0].wait_calls == []


def test_compile_publishes_only_a_successful_current_pdf(tmp_path: Path, monkeypatch):
    def start(_args, **kwargs):
        Path(kwargs["cwd"]).joinpath("resume.pdf").write_bytes(
            b"<< /Type /Pages >> << /Type /Page >>"
        )
        return FakeProcess(stdout=kwargs["stdout"])

    def find_tool(name: str) -> str | None:
        return "pdflatex" if name == "pdflatex" else None

    monkeypatch.setattr(compiler.shutil, "which", find_tool)
    monkeypatch.setattr(compiler.subprocess, "Popen", start)
    tex_path = tmp_path / "resume.tex"
    tex_path.write_text("source", encoding="utf-8")

    result = compiler.compile_tex(tex_path, timeout_seconds=0.25)

    assert result["compile_status"] == "ok"
    assert result["pdf_path"] == str(tmp_path / "resume.pdf")
    assert result["page_count"] == 1
    assert result["fits_one_page"] is True


def test_compile_timeout_terminates_and_does_not_publish_stale_pdf(tmp_path: Path, monkeypatch):
    class TimeoutProcess(FakeProcess):
        def __init__(self, **kwargs):
            super().__init__(returncode=None, stdout=kwargs["stdout"])

        def poll(self) -> None:
            return None

        def wait(self, timeout: float | None = None) -> None:
            self.wait_calls.append(timeout)
            raise subprocess.TimeoutExpired("pdflatex", timeout)

    process_holder: list[TimeoutProcess] = []

    def start(_args, **kwargs):
        process = TimeoutProcess(**kwargs)
        process_holder.append(process)
        return process

    terminated: list[object] = []
    monkeypatch.setattr(compiler.shutil, "which", lambda _name: "pdflatex")
    monkeypatch.setattr(compiler.subprocess, "Popen", start)
    monkeypatch.setattr(compiler, "_terminate", lambda process: terminated.append(process))
    tex_path = tmp_path / "resume.tex"
    tex_path.write_text("\\documentclass{article}", encoding="utf-8")
    (tmp_path / "resume.pdf").write_bytes(b"stale")

    result = compiler.compile_tex(tex_path, timeout_seconds=0.25)

    assert result["compile_status"] == "timeout"
    assert result["pdf_path"] is None
    assert result["page_count"] is None
    assert terminated == process_holder
    assert process_holder[0].wait_calls == []


def test_compile_output_limit_is_fail_closed(tmp_path: Path, monkeypatch):
    class LoudProcess(FakeProcess):
        def __init__(self, **kwargs):
            self.returncode = None
            self.pid = 1234
            self.wait_calls: list[float | None] = []
            self.killed = False
            kwargs["stdout"].write(b"x" * (compiler.MAX_CAPTURE_BYTES + 1))

        def poll(self) -> None:
            return None

    process_holder: list[LoudProcess] = []

    def start(_args, **kwargs):
        process = LoudProcess(**kwargs)
        process_holder.append(process)
        return process

    terminated: list[object] = []
    monkeypatch.setattr(compiler.shutil, "which", lambda _name: "pdflatex")
    monkeypatch.setattr(compiler.subprocess, "Popen", start)
    monkeypatch.setattr(compiler, "_terminate", lambda process: terminated.append(process))
    tex_path = tmp_path / "resume.tex"
    tex_path.write_text("source", encoding="utf-8")

    result = compiler.compile_tex(tex_path)

    assert result["compile_status"] == "output_limit"
    assert result["pdf_path"] is None
    assert "capture limit" in result["log_text"]
    assert terminated == process_holder
