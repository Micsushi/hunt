from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from fletcher.resume.models import ExperienceEntry, ProjectEntry, ResumeDocument
from fletcher.resume.parser import parse_resume_file

DEFAULT_SUMMARY_KEYS = ("software", "pm", "data", "infrastructure", "firmware", "general")
DEFAULT_SELECTION = {
    "min_experience": 2,
    "max_experience": 4,
    "min_projects": 1,
    "max_projects": 3,
    "max_bullets_per_experience": 6,
    "max_bullets_per_project": 4,
    "experience_position_bonus": 0.12,
    "project_position_bonus": 0.08,
    "bullet_position_bonus": 0.08,
}


def import_master_resume_yaml(
    resume_path: str | Path,
    *,
    source_comment: str | None = None,
) -> str:
    doc = parse_resume_file(resume_path)
    return master_resume_yaml_from_document(
        doc,
        source_comment=source_comment or f"Imported from {Path(resume_path).name}.",
    )


def master_resume_yaml_from_document(
    doc: ResumeDocument,
    *,
    source_comment: str = "Imported from a parsed LaTeX resume.",
) -> str:
    lines: list[str] = [
        "# Fletcher master resume source.",
        f"# {source_comment}",
        "",
        "selection:",
    ]
    for key, value in DEFAULT_SELECTION.items():
        lines.append(f"  {key}: {value}")

    lines.extend(
        [
            "",
            "header:",
            f"  name: {_yaml_string(doc.header.name)}",
            f"  contact: {_yaml_string(doc.header.contact_line)}",
            "",
            "summaries:",
        ]
    )
    for key in DEFAULT_SUMMARY_KEYS:
        summary = doc.summary if key == "general" else ""
        lines.append(f"  {key}: {_yaml_string(summary)}")

    lines.extend(
        [
            "",
            "education:",
            f"  institution_and_degree: {_yaml_string(doc.education.entry.institution_and_degree)}",
            f"  date_text: {_yaml_string(doc.education.entry.date_text)}",
            "  bullets:",
        ]
    )
    if doc.education.bullets:
        for bullet in doc.education.bullets:
            lines.append(f"    - {_yaml_string(bullet)}")
    else:
        lines.append("    []")

    lines.extend(["", "experience:"])
    if doc.experience:
        for idx, entry in enumerate(doc.experience, start=1):
            lines.extend(_experience_yaml(entry, idx))
            lines.append("")
        lines.pop()
    else:
        lines.append("  []")

    lines.extend(["", "projects:"])
    if doc.projects:
        for idx, entry in enumerate(doc.projects, start=1):
            lines.extend(_project_yaml(entry, idx))
            lines.append("")
        lines.pop()
    else:
        lines.append("  []")

    lines.extend(["", "skills:"])
    categories = doc.skills.categories or {
        "Languages": doc.skills.languages,
        "Frameworks": doc.skills.frameworks,
        "Developer Tools": doc.skills.developer_tools,
    }
    categories = {label: values for label, values in categories.items() if values}
    if categories:
        for label, values in categories.items():
            lines.append(f"  {label}:")
            for value in values:
                lines.append(f"    - {_yaml_string(value)}")
    else:
        lines.append("  {}")

    return "\n".join(lines).rstrip() + "\n"


def _experience_yaml(entry: ExperienceEntry, index: int) -> list[str]:
    parts = _split_experience_header(entry.title_company_location)
    fallback_id = f"job{index}_{parts.get('company') or parts.get('title') or entry.entry_id}"
    lines = [
        f"  - id: {_yaml_string(_stable_id(fallback_id))}",
        f"    title: {_yaml_string(parts.get('title') or entry.title_company_location)}",
        f"    company: {_yaml_string(parts.get('company') or '')}",
        f"    location: {_yaml_string(parts.get('location') or '')}",
        f"    dates: {_yaml_string(entry.date_text)}",
        "    bullets:",
    ]
    lines.extend(_bullet_lines(entry.bullets))
    return lines


def _project_yaml(entry: ProjectEntry, index: int) -> list[str]:
    title = _strip_wrapping_textbf(entry.project_title)
    url = _extract_href_url(entry.date_or_link_text)
    lines = [
        f"  - id: {_yaml_string(_stable_id(f'proj{index}_{title or entry.entry_id}'))}",
        f"    name: {_yaml_string(title or entry.project_title)}",
        f"    url: {_yaml_string(url)}",
        "    bullets:",
    ]
    lines.extend(_bullet_lines(entry.bullets))
    return lines


def _bullet_lines(bullets: list[str]) -> list[str]:
    if not bullets:
        return ["      []"]
    return [f"      - text: {_yaml_string(bullet)}" for bullet in bullets]


def _split_experience_header(value: str) -> dict[str, str]:
    text = " ".join(str(value or "").split())
    location = ""
    if " -- " in text:
        text, location = text.rsplit(" -- ", 1)
    title = ""
    company = ""
    match = re.match(r"^\\textbf\{(?P<title>.*?)\}\s*,\s*(?P<company>.*)$", text)
    if match:
        title = match.group("title").strip()
        company = match.group("company").strip()
    elif "," in text:
        title, company = [part.strip() for part in text.split(",", 1)]
        title = _strip_wrapping_textbf(title)
    else:
        title = _strip_wrapping_textbf(text)
    return {"title": title, "company": company, "location": location}


def _strip_wrapping_textbf(value: str) -> str:
    text = str(value or "").strip()
    match = re.fullmatch(r"\\textbf\{(?P<body>.*)\}", text)
    return match.group("body").strip() if match else text


def _extract_href_url(value: str) -> str:
    text = str(value or "").strip()
    match = re.match(r"\\href\{(?P<url>[^}]+)\}\{[^}]*\}", text)
    return match.group("url").strip() if match else text


def _stable_id(value: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9]+", "_", str(value or "")).strip("_").lower()
    return slug or "entry"


def _yaml_string(value: Any) -> str:
    text = str(value or "")
    text = text.replace('"', "'")
    return '"' + text.replace("\\", "\\\\") + '"'
