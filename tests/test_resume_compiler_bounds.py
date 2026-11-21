import sys
import time

import pytest

from fletcher.resume.compiler import get_pdf_page_count
from fletcher.resume.compiler_process import run_tool


@pytest.mark.parametrize(
    "body,pages",
    [(b"/Type /Pages " + b"/Type /Page " * n, n) for n in (1, 2, 3)]
    + [(b"/Type /ObjStm /Type /Page", None)],
)
def test_fallback_page_count_requires_plain_leaf_entries(tmp_path, monkeypatch, body, pages):
    monkeypatch.setattr("fletcher.resume.compiler.shutil.which", lambda _: None)
    pdf = tmp_path / "test.pdf"
    pdf.write_bytes(b"%PDF-1.5 " + body)
    assert get_pdf_page_count(pdf) == pages


@pytest.mark.parametrize(
    "script,timeout,failure",
    [
        ("print('synthetic')", 5, None),
        ("import time; time.sleep(30)", 0.15, "timeout"),
        ("import os; os.write(1, b'x' * 1000000)", 5, "output_limit"),
        (
            "import subprocess,sys; subprocess.Popen([sys.executable,'-c','import time; time.sleep(30)'])",
            0.3,
            "timeout",
        ),
    ],
    ids=["success", "stalled", "output-flood", "child-retains-pipe"],
)
def test_tool_bounds_runtime_and_output(script, timeout, failure):
    start = time.monotonic()
    result = run_tool([sys.executable, "-c", script], timeout=timeout, max_output=4096)
    assert result["failure"] == failure
    assert time.monotonic() - start < 5
    assert len(result["output"]) <= 4096
    if failure is None:
        assert result["returncode"] == 0
        assert result["output"].strip() == "synthetic"
