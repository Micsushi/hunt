import sys
import time

import pytest

from fletcher.resume.compiler import compile_tex, get_pdf_page_count
from fletcher.resume.compiler_process import run_tool


@pytest.mark.parametrize("pages", [1, 2, 3])
def test_fallback_counts_leaf_pages_without_subtracting_tree(tmp_path, monkeypatch, pages):
    monkeypatch.setattr("fletcher.resume.compiler.shutil.which", lambda _: None)
    pdf = tmp_path / "test.pdf"
    pdf.write_bytes(b"%PDF-1.4 /Type /Pages " + b"/Type /Page " * pages)
    assert get_pdf_page_count(pdf) == pages


def test_compressed_page_tree_is_unknown(tmp_path, monkeypatch):
    monkeypatch.setattr("fletcher.resume.compiler.shutil.which", lambda _: None)
    pdf = tmp_path / "test.pdf"
    pdf.write_bytes(b"%PDF-1.5 /Type /ObjStm /Type /Page")
    assert get_pdf_page_count(pdf) is None


def test_failed_tool_does_not_return_old_pdf(tmp_path, monkeypatch):
    monkeypatch.setattr("fletcher.resume.compiler.shutil.which", lambda _: "fake")
    monkeypatch.setattr(
        "fletcher.resume.compiler._run_bounded",
        lambda *a, **k: {"returncode": 1, "status": "timeout", "stdout": "", "log_text": "bounded"},
    )
    tex = tmp_path / "resume.tex"
    tex.write_text("synthetic")
    tex.with_suffix(".pdf").write_bytes(b"old")
    result = compile_tex(tex)
    assert result["compile_status"] == "timeout"
    assert result["pdf_path"] is None
    assert result["fits_one_page"] is False


def test_harmless_tool_success():
    result = run_tool([sys.executable, "-c", "print('synthetic')"])
    assert result["failure"] is None
    assert result["returncode"] == 0
    assert result["output"].strip() == "synthetic"


def test_harmless_stalled_tool_is_bounded():
    start = time.monotonic()
    result = run_tool([sys.executable, "-c", "import time; time.sleep(30)"], timeout=0.15)
    assert result["failure"] == "timeout"
    assert time.monotonic() - start < 5


def test_harmless_output_flood_is_bounded():
    result = run_tool(
        [sys.executable, "-c", "import os; os.write(1, b'x' * 1000000)"], max_output=4096
    )
    assert result["failure"] == "output_limit"
    assert len(result["output"]) <= 4096


def test_exited_parent_cannot_leave_pipe_open():
    script = "import subprocess,sys; subprocess.Popen([sys.executable,'-c','import time; time.sleep(30)'])"
    start = time.monotonic()
    result = run_tool([sys.executable, "-c", script], timeout=0.3)
    assert result["failure"] == "timeout"
    assert time.monotonic() - start < 5
