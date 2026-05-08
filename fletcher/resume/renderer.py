from __future__ import annotations

import re

from .models import EducationSection, ExperienceEntry, ProjectEntry, ResumeDocument, SkillsSection


def _render_header(doc: ResumeDocument) -> str:
    return (
        "\\begin{document}\n"
        "    \\begin{center}\n"
        f"        {{\\fontsize{{24pt}}{{24pt}}\\selectfont\\textbf{{{_escape_latex(doc.header.name)}}}}}\n"
        "        \n"
        "        \\vspace{0.2cm}\n"
        "        \n"
        f"        {_escape_latex(doc.header.contact_line)}\n"
        "    \\end{center}\n"
        "    \n"
    )


def _escape_latex(text: str) -> str:
    """Escape LaTeX special characters that aren't already escaped."""
    # Escape each special char only when NOT already preceded by a backslash.
    result = text
    for char in ("$", "%", "&", "#"):
        result = re.sub(r"(?<!\\)" + re.escape(char), "\\" + char, result)
    return result


def _escape_bullet(text: str) -> str:
    """Escape LaTeX special characters in bullet text.

    Bullets from main.tex already have \\$ etc. Bullets from candidate_profile
    or LLM rewrites may have raw $, %, & which break LaTeX compilation.
    """
    return _escape_latex(text)


def _render_bullets(bullets: list[str]) -> str:
    lines = [
        "    \\begin{onecolentry}",
        "        \\begin{itemize}[leftmargin=2em, itemsep=1pt, parsep=0pt, topsep=0pt, partopsep=0pt]",
    ]
    for bullet in bullets:
        lines.append(f"            \\item {_escape_bullet(bullet)}")
    lines.extend(
        [
            "        \\end{itemize}",
            "    \\end{onecolentry}",
        ]
    )
    return "\n".join(lines)


def _render_education(section: EducationSection) -> str:
    if (
        not section.entry.institution_and_degree
        and not section.entry.date_text
        and not section.bullets
    ):
        return ""
    return (
        "    \\vspace{0.10 cm}\n"
        "    \\section{Education}\n\n"
        f"    \\begin{{twocolentry}}{{{_escape_latex(section.entry.date_text)}}}\n"
        f"        {_escape_latex(section.entry.institution_and_degree)}\n"
        "    \\end{twocolentry}\n\n"
        "    \\vspace{0.10 cm}\n"
        f"{_render_bullets(section.bullets)}\n"
    )


def _render_experience_entry(entry: ExperienceEntry) -> str:
    return (
        f"    \\begin{{twocolentry}}{{{_escape_latex(entry.date_text)}}}\n"
        f"        {_escape_latex(entry.title_company_location)}\n"
        "    \\end{twocolentry}\n\n"
        "    \\vspace{0.10 cm}\n"
        f"{_render_bullets(entry.bullets)}\n"
    )


def _render_project_entry(entry: ProjectEntry) -> str:
    return (
        f"    \\begin{{twocolentry}}{{{_escape_latex(entry.date_or_link_text)}}}\n"
        f"        {_escape_latex(entry.project_title)}\n"
        "    \\end{twocolentry}\n\n"
        "    \\vspace{0.10 cm}\n"
        f"{_render_bullets(entry.bullets)}\n"
    )


def _render_summary(text: str) -> str:
    escaped = _escape_latex(text)
    return (
        "    \\vspace{0.10 cm}\n"
        "    \\section{Summary}\n\n"
        "    \\begin{onecolentry}\n"
        f"        {escaped}\n"
        "    \\end{onecolentry}\n"
    )


def _render_skills(skills: SkillsSection) -> str:
    def onecol(label: str, values: list[str]) -> str:
        escaped_label = _escape_latex(label)
        joined = ", ".join(_escape_latex(value) for value in values)
        return (
            "    \\begin{onecolentry}\n"
            f"        \\textbf{{{escaped_label}:}} {joined}\n"
            "    \\end{onecolentry}"
        )

    categories = skills.categories or {
        "Languages": skills.languages,
        "Frameworks": skills.frameworks,
        "Developer Tools": skills.developer_tools,
    }
    categories = {label: values for label, values in categories.items() if values}
    if not categories:
        return ""
    rendered = ["    \\vspace{0.10 cm}\n    \\section{Technical Skills}\n"]
    for idx, (label, values) in enumerate(categories.items()):
        if idx:
            rendered.append("    \\vspace{0.1 cm}\n")
        rendered.append(onecol(label, values))
    return "\n\n".join(rendered) + "\n"


def render_resume_tex(doc: ResumeDocument) -> str:
    parts = [doc.preamble.rstrip(), "", _render_header(doc)]
    if doc.summary:
        parts.append(_render_summary(doc.summary))
    parts.append(_render_education(doc.education))

    if doc.experience:
        parts.append("    \\vspace{0.10 cm}\n    \\section{Experience}\n")
        for idx, entry in enumerate(doc.experience):
            parts.append(_render_experience_entry(entry))
            if idx != len(doc.experience) - 1:
                parts.append("    \n    \\vspace{0.10 cm}\n")

    if doc.projects:
        parts.append("    \\vspace{0.10 cm}\n    \\section{Projects}\n")
        for idx, entry in enumerate(doc.projects):
            parts.append(_render_project_entry(entry))
            if idx != len(doc.projects) - 1:
                parts.append("    \n    \\vspace{0.10 cm}\n")

    parts.append(_render_skills(doc.skills))
    parts.append("\n\\end{document}\n")
    return "\n".join(part.rstrip("\n") for part in parts if part is not None)
