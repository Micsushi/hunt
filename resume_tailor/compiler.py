from __future__ import annotations

import shutil
import subprocess
from pathlib import Path


def compile_tex(tex_path: str | Path) -> dict:
    tex_path = Path(tex_path)
    output_dir = tex_path.parent
    pdflatex = shutil.which("pdflatex")
    if not pdflatex:
        return {
            "compile_status": "tool_missing",
            "pdf_path": None,
            "page_count": None,
            "fits_one_page": False,
            "log_text": "pdflatex not found on PATH.",
        }

    result = subprocess.run(
        [pdflatex, "-interaction=nonstopmode", "-halt-on-error", tex_path.name],
        cwd=output_dir,
        capture_output=True,
        text=True,
    )
    pdf_path = output_dir / f"{tex_path.stem}.pdf"
    page_count = None
    if pdf_path.exists():
        page_count = get_pdf_page_count(pdf_path)

    return {
        "compile_status": "ok" if result.returncode == 0 and pdf_path.exists() else "failed",
        "pdf_path": str(pdf_path) if pdf_path.exists() else None,
        "page_count": page_count,
        "fits_one_page": page_count == 1,
        "log_text": (result.stdout or "") + ("\n" + result.stderr if result.stderr else ""),
    }


def get_pdf_page_count(pdf_path: str | Path) -> int | None:
    pdfinfo = shutil.which("pdfinfo")
    if not pdfinfo:
        return None
    result = subprocess.run([pdfinfo, str(pdf_path)], capture_output=True, text=True)
    if result.returncode != 0:
        return None
    for line in result.stdout.splitlines():
        if line.startswith("Pages:"):
            try:
                return int(line.split(":", 1)[1].strip())
            except ValueError:
                return None
    return None

