from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

from ..config import DEFAULT_OG_RESUME_PATH
from .models import (
    EducationEntry,
    EducationSection,
    ExperienceEntry,
    ProjectEntry,
    ResumeDocument,
    ResumeHeader,
    SkillsSection,
)
from .parser import parse_resume_file


@dataclass
class ImportReport:
    input_kind: str
    input_filename: str
    import_status: str = "ok"
    import_warnings: list[str] = field(default_factory=list)
    raw_text: str = ""


def parse_resume_upload(path: str | Path) -> tuple[ResumeDocument, ImportReport]:
    p = Path(path)
    suffix = p.suffix.lower()
    if suffix == ".tex":
        return parse_resume_file(p), ImportReport("tex", p.name)
    if suffix == ".pdf":
        text = extract_pdf_text(p)
        return parse_resume_text(text, str(p), p.name)
    raise ValueError("Unsupported resume upload type. Use .tex or text-based .pdf.")


def extract_pdf_text(path: str | Path) -> str:
    try:
        from pdfminer.high_level import extract_text
    except Exception as exc:  # pragma: no cover
        raise RuntimeError("pdfminer.six is required for PDF resume import.") from exc
    return extract_text(str(path)) or ""


def _slug(value: str, prefix: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9]+", "_", value).strip("_").lower()
    return f"{prefix}_{slug or 'entry'}"


def _clean_lines(text: str) -> list[str]:
    text = text.replace("\u2022", "\n- ").replace("â€¢", "\n- ")
    return [re.sub(r"\s+", " ", line).strip() for line in text.splitlines() if line.strip()]


def _section_map(lines: list[str]) -> dict[str, list[str]]:
    headings = {
        "summary": "Summary",
        "education": "Education",
        "experience": "Experience",
        "work experience": "Experience",
        "projects": "Projects",
        "technical skills": "Technical Skills",
        "skills": "Technical Skills",
    }
    sections: dict[str, list[str]] = {"Header": []}
    current = "Header"
    for line in lines:
        key = line.lower().strip(":")
        if key in headings:
            current = headings[key]
            sections.setdefault(current, [])
            continue
        sections.setdefault(current, []).append(line)
    return sections


def _is_bullet(line: str) -> bool:
    return bool(re.match(r"^[-*]\s+", line))


def _strip_bullet(line: str) -> str:
    return re.sub(r"^[-*]\s+", "", line).strip()


def _parse_entries(lines: list[str], *, project: bool = False):
    entries = []
    current_header = ""
    current_date = ""
    bullets: list[str] = []

    def flush() -> None:
        nonlocal current_header, current_date, bullets
        if not current_header and not bullets:
            return
        header = current_header or ("Project" if project else "Experience")
        if project:
            entries.append(
                ProjectEntry(
                    entry_id=_slug(header, "proj"),
                    project_title=header,
                    date_or_link_text=current_date,
                    bullets=list(bullets),
                )
            )
        else:
            entries.append(
                ExperienceEntry(
                    entry_id=_slug(header, "exp"),
                    title_company_location=header,
                    date_text=current_date,
                    bullets=list(bullets),
                )
            )
        current_header = ""
        current_date = ""
        bullets = []

    date_pat = re.compile(r"\b(20\d{2}|19\d{2}|present|current)\b", re.I)
    for line in lines:
        if _is_bullet(line):
            bullets.append(_strip_bullet(line))
            continue
        if date_pat.search(line) and current_header and not current_date:
            current_date = line
            continue
        if bullets or current_header:
            flush()
        current_header = line
    flush()
    return entries


def _parse_skills(lines: list[str]) -> SkillsSection:
    buckets = {"languages": [], "frameworks": [], "developer_tools": []}
    label_map = {
        "languages": "languages",
        "frameworks": "frameworks",
        "libraries": "frameworks",
        "developer tools": "developer_tools",
        "tools": "developer_tools",
        "skills": "developer_tools",
    }
    for line in lines:
        label, sep, values = line.partition(":")
        key = label_map.get(label.strip().lower()) if sep else "developer_tools"
        raw_values = values if sep else line
        items = [item.strip() for item in re.split(r",|·|\|", raw_values) if item.strip()]
        buckets[key or "developer_tools"].extend(items)
    return SkillsSection(**buckets)


def parse_resume_text(
    text: str, source_path: str, input_filename: str | None = None
) -> tuple[ResumeDocument, ImportReport]:
    lines = _clean_lines(text)
    report = ImportReport("pdf", input_filename or Path(source_path).name, raw_text=text)
    if len(" ".join(lines)) < 40:
        report.import_status = "failed"
        report.import_warnings.append("PDF did not contain enough extractable text.")
    sections = _section_map(lines)
    header_lines = sections.get("Header", [])
    name = header_lines[0] if header_lines else ""
    contact = " | ".join(header_lines[1:4]) if len(header_lines) > 1 else ""
    if not name:
        name = "Imported Resume"
        report.import_status = "warning"
        report.import_warnings.append("Could not confidently parse the resume header.")
    education_lines = sections.get("Education", [])
    edu_header = education_lines[0] if education_lines else "Education"
    edu_date = education_lines[1] if len(education_lines) > 1 else ""
    edu_bullets = [_strip_bullet(line) for line in education_lines[2:] if _is_bullet(line)]
    experience = _parse_entries(sections.get("Experience", []), project=False)
    projects = _parse_entries(sections.get("Projects", []), project=True)
    skills = _parse_skills(sections.get("Technical Skills", []))
    if not education_lines:
        report.import_status = "warning"
        report.import_warnings.append("Education section was not detected.")
    if not experience and not projects:
        report.import_status = "warning" if report.import_status != "failed" else "failed"
        report.import_warnings.append("No experience or project bullets were detected.")
    preamble = ""
    try:
        preamble = (
            DEFAULT_OG_RESUME_PATH.read_text(encoding="utf-8")
            .split(r"\begin{document}", 1)[0]
            .rstrip()
        )
    except Exception:
        preamble = ""
    doc = ResumeDocument(
        source_path=source_path,
        preamble=preamble,
        header=ResumeHeader(name=name, contact_line=contact),
        summary=" ".join(sections.get("Summary", [])),
        education=EducationSection(
            entry=EducationEntry(
                entry_id="edu_primary",
                institution_and_degree=edu_header,
                date_text=edu_date,
            ),
            bullets=edu_bullets,
        ),
        experience=experience,
        projects=projects,
        skills=skills,
    )
    return doc, report
