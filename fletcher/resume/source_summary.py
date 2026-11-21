"""Optional summaries copied from the user's original resume, without model prose."""

from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path

from .compiler import compile_tex
from .renderer import render_resume_tex


def capture_original_sources(original, selected) -> list[dict]:
    sources = []
    for kind, entries, originals in (
        ("exp", selected.experience, original.experience),
        ("proj", selected.projects, original.projects),
    ):
        for entry in entries:
            source_entry = next(
                (item for item in originals if item.entry_id == entry.entry_id), None
            )
            if source_entry is None:
                continue
            unused = list(enumerate(source_entry.bullets))
            for selected_index, text in enumerate(entry.bullets):
                match = next(((index, value) for index, value in unused if value == text), None)
                if match is None:
                    continue
                unused.remove(match)
                sources.append(
                    {
                        "kind": kind,
                        "entry_id": entry.entry_id,
                        "original_local_idx": match[0],
                        "selected_local_idx": selected_index,
                        "text": text,
                    }
                )
    return sources


def build_source_summary(original, sources: list[dict]) -> dict:
    if original.summary.strip():
        return {
            "summary": original.summary,
            "sources": [
                {
                    "field": "summary",
                    "sha256": hashlib.sha256(original.summary.encode()).hexdigest(),
                }
            ],
        }
    parts = []
    provenance = []
    seen = set()
    previous_entry = None
    for source in sources:
        kind = source["kind"]
        entries = original.experience if kind == "exp" else original.projects
        entry = next((entry for entry in entries if entry.entry_id == source["entry_id"]), None)
        index = source["original_local_idx"]
        if entry is None or not 0 <= index < len(entry.bullets):
            continue
        text = entry.bullets[index]
        if not text.strip() or text != source["text"]:
            continue
        identity = (kind, entry.entry_id, text)
        if identity in seen:
            continue
        seen.add(identity)
        attribution = entry.title_company_location if kind == "exp" else entry.project_title
        date = entry.date_text if kind == "exp" else entry.date_or_link_text
        if not attribution.strip():
            continue
        label = attribution + (f" ({date})" if date else "")
        if kind == "proj":
            label = "Project: " + label
        entry_key = (kind, entry.entry_id)
        parts.append(text if entry_key == previous_entry else f"{label}: {text}")
        previous_entry = entry_key
        provenance.append(
            {
                "kind": kind,
                "entry_id": entry.entry_id,
                "original_local_idx": index,
                "sha256": hashlib.sha256(text.encode()).hexdigest(),
            }
        )
        if len(parts) == 2:
            break
    return {"summary": " ".join(parts), "sources": provenance}


def compile_source_summary(
    attempt_dir: Path, fitted_doc, original, sources: list[dict], no_summary: dict
) -> dict:
    result = {
        **build_source_summary(original, sources),
        "summary_origin": "source",
        "summary_outcome": "omitted",
        "pdf_path_summary": None,
        "tex_path_summary": None,
        "summary_notice": None,
    }
    if no_summary.get("compile_status") != "ok" or not no_summary.get("fits_one_page"):
        reason = "the no-summary PDF is not ready"
        alternative = ""
    else:
        alternative = " The generated no-summary PDF is available."
        reason = "no retained source text is available"
        if result["summary"]:
            document = copy.deepcopy(fitted_doc)
            document.summary = result["summary"]
            path = attempt_dir / "output_summary.tex"
            try:
                path.write_text(render_resume_tex(document), encoding="utf-8")
                compiled = compile_tex(path)
            except Exception as exc:
                compiled = {"compile_status": "failed"}
                result["summary_compile_error"] = type(exc).__name__
            result["summary_compile_status"] = compiled.get("compile_status")
            result["summary_page_count"] = compiled.get("page_count")
            if (
                compiled.get("compile_status") == "ok"
                and compiled.get("fits_one_page")
                and compiled.get("page_count") == 1
            ):
                result.update(
                    summary_outcome="included",
                    pdf_path_summary=compiled.get("pdf_path"),
                    tex_path_summary=str(path),
                )
                reason = ""
            elif compiled.get("compile_status") != "ok":
                reason = "its PDF could not be compiled"
            elif compiled.get("page_count") is None:
                reason = "its page count could not be verified"
            else:
                reason = "it does not fit on one page"
    if reason:
        result["summary_notice"] = f"Automatic summary omitted because {reason}.{alternative}"
    (attempt_dir / "source_summary.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    return result
