from __future__ import annotations

from pathlib import Path

import pytest

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


@pytest.mark.parametrize("failure", ["timeout", "output_limit"])
def test_failed_compile_terminates_and_never_publishes_a_stale_pdf(tmp_path, monkeypatch, failure):
    process = FakeProcess(returncode=None)

    def start(_args, **kwargs):
        if failure == "output_limit":
            kwargs["stdout"].write(b"x" * (compiler.MAX_CAPTURE_BYTES + 1))
        return process

    terminated = []
    monkeypatch.setattr(compiler.shutil, "which", lambda _: "pdflatex")
    monkeypatch.setattr(compiler.subprocess, "Popen", start)
    monkeypatch.setattr(compiler, "_terminate", terminated.append)
    tex_path = tmp_path / "resume.tex"
    tex_path.write_text("source", encoding="utf-8")
    tex_path.with_suffix(".pdf").write_bytes(b"stale")
    result = compiler.compile_tex(tex_path, timeout_seconds=0.25)

    assert result["compile_status"] == failure
    assert result["pdf_path"] is None
    assert result["page_count"] is None
    assert result["fits_one_page"] is False
    assert terminated == [process]
    if failure == "timeout":
        assert process.wait_calls == []
    else:
        assert "capture limit" in result["log_text"]
