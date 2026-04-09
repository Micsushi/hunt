from __future__ import annotations

from .models import EducationSection, ExperienceEntry, ProjectEntry, ResumeDocument, SkillsSection


def _render_header(doc: ResumeDocument) -> str:
    return (
        "\\begin{document}\n"
        "    \\begin{center}\n"
        f"        {{\\fontsize{{24pt}}{{24pt}}\\selectfont\\textbf{{{doc.header.name}}}}}\n"
        "        \n"
        "        \\vspace{0.2cm}\n"
        "        \n"
        f"        {doc.header.contact_line}\n"
        "    \\end{center}\n"
        "    \n"
    )


def _render_bullets(bullets: list[str]) -> str:
    lines = [
        "    \\begin{onecolentry}",
        "        \\begin{itemize}[leftmargin=2em, itemsep=1pt, parsep=0pt, topsep=0pt, partopsep=0pt]",
    ]
    for bullet in bullets:
        lines.append(f"            \\item {bullet}")
    lines.extend(
        [
            "        \\end{itemize}",
            "    \\end{onecolentry}",
        ]
    )
    return "\n".join(lines)


def _render_education(section: EducationSection) -> str:
    return (
        "    \\vspace{0.10 cm}\n"
        "    \\section{Education}\n\n"
        f"    \\begin{{twocolentry}}{{{section.entry.date_text}}}\n"
        f"        {section.entry.institution_and_degree}\n"
        "    \\end{twocolentry}\n\n"
        "    \\vspace{0.10 cm}\n"
        f"{_render_bullets(section.bullets)}\n"
    )


def _render_experience_entry(entry: ExperienceEntry) -> str:
    return (
        f"    \\begin{{twocolentry}}{{{entry.date_text}}}\n"
        f"        {entry.title_company_location}\n"
        "    \\end{twocolentry}\n\n"
        "    \\vspace{0.10 cm}\n"
        f"{_render_bullets(entry.bullets)}\n"
    )


def _render_project_entry(entry: ProjectEntry) -> str:
    return (
        f"    \\begin{{twocolentry}}{{{entry.date_or_link_text}}}\n"
        f"        {entry.project_title}\n"
        "    \\end{twocolentry}\n\n"
        "    \\vspace{0.10 cm}\n"
        f"{_render_bullets(entry.bullets)}\n"
    )


def _render_skills(skills: SkillsSection) -> str:
    def onecol(label: str, values: list[str]) -> str:
        joined = ", ".join(values)
        return (
            "    \\begin{onecolentry}\n"
            f"        \\textbf{{{label}:}} {joined}\n"
            "    \\end{onecolentry}"
        )

    return (
        "    \\vspace{0.10 cm}\n"
        "    \\section{Technical Skills}\n\n"
        f"{onecol('Languages', skills.languages)}\n\n"
        "    \\vspace{0.1 cm}\n\n"
        f"{onecol('Frameworks', skills.frameworks)}\n\n"
        "    \\vspace{0.1 cm}\n\n"
        f"{onecol('Developer Tools', skills.developer_tools)}\n"
    )


def render_resume_tex(doc: ResumeDocument) -> str:
    parts = [doc.preamble.rstrip(), "", _render_header(doc), _render_education(doc.education)]

    parts.append("    \\vspace{0.10 cm}\n    \\section{Experience}\n")
    for idx, entry in enumerate(doc.experience):
        parts.append(_render_experience_entry(entry))
        if idx != len(doc.experience) - 1:
            parts.append("    \n    \\vspace{0.10 cm}\n")

    parts.append("    \\vspace{0.10 cm}\n    \\section{Projects}\n")
    for idx, entry in enumerate(doc.projects):
        parts.append(_render_project_entry(entry))
        if idx != len(doc.projects) - 1:
            parts.append("    \n    \\vspace{0.10 cm}\n")

    parts.append(_render_skills(doc.skills))
    parts.append("\n\\end{document}\n")
    return "\n".join(part.rstrip("\n") for part in parts if part is not None)
