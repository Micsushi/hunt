from __future__ import annotations

import re
from pathlib import Path

from .models import (
    EducationEntry,
    EducationSection,
    ExperienceEntry,
    ProjectEntry,
    ResumeDocument,
    ResumeHeader,
    SkillsSection,
)

SECTION_PATTERN = re.compile(r"\\section\{(?P<name>[^}]+)\}")
TWOCOL_PATTERN = re.compile(
    r"\\begin\{twocolentry\}\{(?P<right>.*?)\}\s*(?P<left>.*?)\\end\{twocolentry\}",
    re.DOTALL,
)
ONECOL_PATTERN = re.compile(
    r"\\begin\{onecolentry\}(?P<body>.*?)\\end\{onecolentry\}",
    re.DOTALL,
)
ITEM_PATTERN = re.compile(r"\\item\s+(.*?)(?=(?:\n\s*\\item|\n\s*\\end\{itemize\}))", re.DOTALL)
SKILL_LINE_PATTERN = re.compile(r"\\textbf\{(?P<label>[^:]+):\}\s*(?P<values>.+)")


def _find_matching_brace(text: str, open_idx: int) -> int:
    depth = 0
    for idx in range(open_idx, len(text)):
        char = text[idx]
        if char == "{" and (idx == 0 or text[idx - 1] != "\\"):
            depth += 1
        elif char == "}" and (idx == 0 or text[idx - 1] != "\\"):
            depth -= 1
            if depth == 0:
                return idx
    raise ValueError("Could not parse balanced LaTeX braces.")


def _twocol_entries(section_text: str) -> list[dict[str, str | int]]:
    entries: list[dict[str, str | int]] = []
    begin = r"\begin{twocolentry}"
    end = r"\end{twocolentry}"
    cursor = 0
    while True:
        start = section_text.find(begin, cursor)
        if start == -1:
            break
        arg_start = start + len(begin)
        while arg_start < len(section_text) and section_text[arg_start].isspace():
            arg_start += 1
        if arg_start >= len(section_text) or section_text[arg_start] != "{":
            raise ValueError("Could not parse twocolentry right-hand argument.")
        arg_end = _find_matching_brace(section_text, arg_start)
        end_start = section_text.find(end, arg_end + 1)
        if end_start == -1:
            raise ValueError("Could not find twocolentry end marker.")
        end_idx = end_start + len(end)
        entries.append(
            {
                "start": start,
                "end": end_idx,
                "right": section_text[arg_start + 1 : arg_end],
                "left": section_text[arg_end + 1 : end_start],
            }
        )
        cursor = end_idx
    return entries


def _slugify(value: str) -> str:
    slug = re.sub(r"\\href\{.*?\}\{(.*?)\}", r"\1", value)
    slug = re.sub(r"\\textbf\{(.*?)\}", r"\1", slug)
    slug = re.sub(r"[^a-zA-Z0-9]+", "_", slug).strip("_").lower()
    return slug or "entry"


def _split_document(tex: str) -> tuple[str, str]:
    marker = r"\begin{document}"
    end_marker = r"\end{document}"
    if marker not in tex or end_marker not in tex:
        raise ValueError("Resume LaTeX must contain both \\begin{document} and \\end{document}.")
    preamble, rest = tex.split(marker, 1)
    body, _ = rest.split(end_marker, 1)
    return preamble, body


def _extract_header(body: str) -> tuple[ResumeHeader, str]:
    center_match = re.search(r"\\begin\{center\}(?P<center>.*?)\\end\{center\}", body, re.DOTALL)
    if not center_match:
        raise ValueError("Could not find the centered resume header block.")

    center_block = center_match.group("center")
    name_match = re.search(r"\\textbf\{(?P<name>[^}]+)\}", center_block)
    if not name_match:
        raise ValueError("Could not parse resume header name.")

    lines = [line.strip() for line in center_block.splitlines() if line.strip()]
    contact_line = lines[-1]
    header = ResumeHeader(name=name_match.group("name").strip(), contact_line=contact_line)
    return header, body[center_match.end() :]


def _split_sections(body_after_header: str) -> dict[str, str]:
    matches = list(SECTION_PATTERN.finditer(body_after_header))
    if not matches:
        raise ValueError("Could not find any resume sections.")

    sections: dict[str, str] = {}
    for idx, match in enumerate(matches):
        start = match.end()
        end = matches[idx + 1].start() if idx + 1 < len(matches) else len(body_after_header)
        sections[match.group("name")] = body_after_header[start:end].strip()
    return sections


def _extract_bullets(block: str) -> list[str]:
    return [item.strip() for item in ITEM_PATTERN.findall(block)]


def _parse_education(section_text: str) -> EducationSection:
    entries = _twocol_entries(section_text)
    if not entries:
        raise ValueError("Could not parse education entry.")
    twocol = entries[0]
    bullets = _extract_bullets(section_text[int(twocol["end"]) :])
    left = " ".join(line.strip() for line in str(twocol["left"]).splitlines() if line.strip())
    entry = EducationEntry(
        entry_id="edu_primary",
        institution_and_degree=left,
        date_text=str(twocol["right"]).strip(),
    )
    return EducationSection(entry=entry, bullets=bullets)


def _parse_repeated_entries(
    section_text: str, kind: str
) -> list[ExperienceEntry] | list[ProjectEntry]:
    entries = []
    matches = _twocol_entries(section_text)
    for idx, match in enumerate(matches):
        start = int(match["end"])
        end = int(matches[idx + 1]["start"]) if idx + 1 < len(matches) else len(section_text)
        bullets = _extract_bullets(section_text[start:end])
        left = " ".join(line.strip() for line in str(match["left"]).splitlines() if line.strip())
        right = str(match["right"]).strip()
        entry_id = f"{'exp' if kind == 'experience' else 'proj'}_{_slugify(left)}"
        if kind == "experience":
            entries.append(
                ExperienceEntry(
                    entry_id=entry_id,
                    title_company_location=left,
                    date_text=right,
                    bullets=bullets,
                )
            )
        else:
            entries.append(
                ProjectEntry(
                    entry_id=entry_id,
                    project_title=left,
                    date_or_link_text=right,
                    bullets=bullets,
                )
            )
    return entries


def _parse_skills(section_text: str) -> SkillsSection:
    buckets: dict[str, list[str]] = {"Languages": [], "Frameworks": [], "Developer Tools": []}
    for block in ONECOL_PATTERN.findall(section_text):
        flattened = " ".join(line.strip() for line in block.splitlines() if line.strip())
        match = SKILL_LINE_PATTERN.search(flattened)
        if not match:
            continue
        label = match.group("label").strip()
        values = [item.strip() for item in match.group("values").split(",") if item.strip()]
        if label in buckets:
            buckets[label] = values

    return SkillsSection(
        languages=buckets["Languages"],
        frameworks=buckets["Frameworks"],
        developer_tools=buckets["Developer Tools"],
    )


def _clean_inline_latex(text: str) -> str:
    cleaned = re.sub(r"\\textbf\{(.*?)\}", r"\1", text)
    cleaned = re.sub(r"\\href\{.*?\}\{(.*?)\}", r"\1", cleaned)
    cleaned = re.sub(r"\\[a-zA-Z]+\*?(?:\[[^\]]*\])?(?:\{([^{}]*)\})?", r"\1", cleaned)
    cleaned = cleaned.replace(r"\%", "%").replace(r"\$", "$").replace(r"\&", "&")
    return re.sub(r"\s+", " ", cleaned).strip()


def _parse_summary(section_text: str | None) -> str:
    if not section_text:
        return ""
    onecol = ONECOL_PATTERN.search(section_text)
    body = onecol.group("body") if onecol else section_text
    return _clean_inline_latex(body)


def parse_resume_tex(tex: str, *, source_path: str = "<memory>") -> ResumeDocument:
    preamble, body = _split_document(tex)
    header, body_after_header = _extract_header(body)
    sections = _split_sections(body_after_header)

    return ResumeDocument(
        source_path=source_path,
        preamble=preamble.rstrip(),
        header=header,
        summary=_parse_summary(sections.get("Summary")),
        education=_parse_education(sections["Education"]),
        experience=_parse_repeated_entries(sections["Experience"], "experience"),
        projects=_parse_repeated_entries(sections["Projects"], "project"),
        skills=_parse_skills(sections["Technical Skills"]),
    )


def parse_resume_file(path: str | Path) -> ResumeDocument:
    resume_path = Path(path)
    return parse_resume_tex(resume_path.read_text(encoding="utf-8"), source_path=str(resume_path))
