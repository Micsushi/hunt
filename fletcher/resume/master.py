from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from fletcher import config
from fletcher.llm.rag import score_bullets_for_drop

from .models import (
    EducationEntry,
    EducationSection,
    ExperienceEntry,
    ProjectEntry,
    ResumeDocument,
    ResumeHeader,
    SkillsSection,
)
from .renderer import render_resume_tex

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


def _strip_comment(line: str) -> str:
    in_single = False
    in_double = False
    escaped = False
    for idx, char in enumerate(line):
        if escaped:
            escaped = False
            continue
        if char == "\\":
            escaped = True
            continue
        if char == "'" and not in_double:
            in_single = not in_single
        elif char == '"' and not in_single:
            in_double = not in_double
        elif char == "#" and not in_single and not in_double:
            return line[:idx]
    return line


def _parse_scalar(value: str) -> Any:
    value = value.strip()
    if value == "":
        return ""
    if value in {"[]", "{}"}:
        return [] if value == "[]" else {}
    if value.startswith("[") and value.endswith("]"):
        inner = value[1:-1].strip()
        if not inner:
            return []
        return [_parse_scalar(part.strip()) for part in inner.split(",")]
    if _is_quoted(value):
        inner = value[1:-1]
        if value[0] == '"':
            inner = inner.replace("\\\\", "\\")
        return inner
    if value.lower() in {"true", "false"}:
        return value.lower() == "true"
    try:
        return int(value)
    except ValueError:
        pass
    try:
        return float(value)
    except ValueError:
        return value


def _is_quoted(value: str) -> bool:
    return len(value) >= 2 and value[0] in {"'", '"'} and value[-1] == value[0]


def _yaml_lines(text: str) -> list[tuple[int, str]]:
    result: list[tuple[int, str]] = []
    for raw in text.splitlines():
        line = _strip_comment(raw).rstrip()
        if not line.strip():
            continue
        result.append((len(line) - len(line.lstrip(" ")), line.strip()))
    return result


def _parse_block(lines: list[tuple[int, str]], index: int, indent: int) -> tuple[Any, int]:
    if index >= len(lines):
        return {}, index
    _, first = lines[index]
    if first.startswith("- "):
        return _parse_list(lines, index, indent)
    return _parse_dict(lines, index, indent)


def _parse_dict(lines: list[tuple[int, str]], index: int, indent: int) -> tuple[dict, int]:
    data: dict[str, Any] = {}
    while index < len(lines):
        line_indent, text = lines[index]
        if line_indent < indent:
            break
        if line_indent > indent:
            index += 1
            continue
        if text.startswith("- ") or ":" not in text:
            break
        key, raw = text.split(":", 1)
        key = key.strip()
        raw = raw.strip()
        index += 1
        if raw:
            data[key] = _parse_scalar(raw)
        else:
            data[key], index = _parse_block(lines, index, indent + 2)
    return data, index


def _parse_list(lines: list[tuple[int, str]], index: int, indent: int) -> tuple[list, int]:
    values: list[Any] = []
    while index < len(lines):
        line_indent, text = lines[index]
        if line_indent < indent:
            break
        if line_indent != indent or not text.startswith("- "):
            break
        raw = text[2:].strip()
        index += 1
        if raw and ":" in raw and not _is_quoted(raw):
            key, value = raw.split(":", 1)
            item: dict[str, Any] = {key.strip(): _parse_scalar(value.strip())}
            if index < len(lines) and lines[index][0] > indent:
                child, index = _parse_dict(lines, index, indent + 2)
                item.update(child)
            values.append(item)
        elif raw:
            values.append(_parse_scalar(raw))
        else:
            child, index = _parse_block(lines, index, indent + 2)
            values.append(child)
    return values, index


def parse_master_yaml(text: str) -> dict:
    parsed, _ = _parse_block(_yaml_lines(text), 0, 0)
    if not isinstance(parsed, dict):
        raise ValueError("Master resume YAML must be a mapping.")
    return parsed


def load_master_resume(path: str | Path | None = None) -> dict:
    master_path = Path(path or config.DEFAULT_MASTER_RESUME_PATH)
    if not master_path.exists():
        master_path = config.DEFAULT_MASTER_RESUME_TEMPLATE_PATH
    data = parse_master_yaml(master_path.read_text(encoding="utf-8"))
    data["path"] = str(master_path)
    return data


def _text(value: Any) -> str:
    return str(value or "").strip()


def _list(value: Any) -> list:
    return value if isinstance(value, list) else []


def _normalize(value: str) -> str:
    return re.sub(r"[^a-z0-9+#/.]+", " ", value.lower()).strip()


def _tokens(value: str) -> set[str]:
    return {token for token in _normalize(value).split() if len(token) > 1}


def _lexical_score(text: str, signals: list[str]) -> float:
    haystack = _tokens(text)
    if not haystack or not signals:
        return 0.0
    signal_tokens = set()
    phrase_hits = 0
    normalized_text = _normalize(text)
    for signal in signals:
        normalized_signal = _normalize(signal)
        if not normalized_signal:
            continue
        if normalized_signal in normalized_text:
            phrase_hits += 1
        signal_tokens.update(_tokens(signal))
    if not signal_tokens:
        return 0.0
    overlap = len(haystack & signal_tokens) / max(1, len(signal_tokens))
    return min(1.0, overlap + phrase_hits * 0.08)


def _entry_text(entry: dict) -> str:
    fields = [
        _text(entry.get("title")),
        _text(entry.get("company")),
        _text(entry.get("project_name")),
        _text(entry.get("summary")),
    ]
    fields.extend(_text(bullet.get("text")) for bullet in _list(entry.get("bullets")))
    return " ".join(fields)


def _rank_entries(entries: list[dict], signals: list[str], bonus: float) -> list[dict]:
    ranked = []
    for idx, entry in enumerate(entries):
        text = _entry_text(entry)
        score = _semantic_score(text, signals) + max(0.0, bonus * (1 / (idx + 1)))
        ranked.append({"entry": entry, "index": idx, "score": round(score, 4)})
    ranked.sort(key=lambda item: (item["score"], -item["index"]), reverse=True)
    return ranked


def _rank_bullets(bullets: list[dict], signals: list[str], bonus: float) -> list[dict]:
    ranked = []
    for idx, bullet in enumerate(bullets):
        text = _text(bullet.get("text") if isinstance(bullet, dict) else bullet)
        score = _semantic_score(text, signals) + max(0.0, bonus * (1 / (idx + 1)))
        ranked.append({"text": text, "index": idx, "score": round(score, 4)})
    ranked.sort(key=lambda item: (item["score"], -item["index"]), reverse=True)
    return ranked


def _semantic_score(text: str, signals: list[str]) -> float:
    try:
        scores = score_bullets_for_drop([text], signals)
        if scores:
            return max(float(scores[0]), _lexical_score(text, signals))
    except Exception:
        pass
    return _lexical_score(text, signals)


def _clamp(value: Any, default: int, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = default
    return max(minimum, min(maximum, parsed))


def _selection_config(master: dict, overrides: dict | None = None) -> dict:
    cfg = dict(DEFAULT_SELECTION)
    raw = master.get("selection")
    if isinstance(raw, dict):
        cfg.update(raw)
    if overrides:
        cfg.update({k: v for k, v in overrides.items() if v not in {None, ""}})
    cfg["min_experience"] = _clamp(cfg.get("min_experience"), 2, 0, 4)
    cfg["max_experience"] = _clamp(cfg.get("max_experience"), 4, cfg["min_experience"], 4)
    cfg["min_projects"] = _clamp(cfg.get("min_projects"), 1, 0, 3)
    cfg["max_projects"] = _clamp(cfg.get("max_projects"), 3, cfg["min_projects"], 3)
    cfg["max_bullets_per_experience"] = _clamp(cfg.get("max_bullets_per_experience"), 6, 1, 8)
    cfg["max_bullets_per_project"] = _clamp(cfg.get("max_bullets_per_project"), 4, 1, 6)
    return cfg


def _choose_count(ranked: list[dict], min_count: int, max_count: int) -> int:
    if not ranked or max_count <= 0:
        return 0
    positive = sum(1 for item in ranked if float(item["score"]) > 0.05)
    return min(len(ranked), max(min_count, min(max_count, positive or min_count)))


def _category_map(skills: Any) -> dict[str, list[str]]:
    if isinstance(skills, dict):
        return {
            str(label): [str(item) for item in _list(values)]
            for label, values in skills.items()
            if isinstance(values, list)
        }
    if isinstance(skills, list):
        categories: dict[str, list[str]] = {}
        for item in skills:
            if isinstance(item, dict):
                label = _text(item.get("category") or item.get("name"))
                values = [str(v) for v in _list(item.get("items") or item.get("skills"))]
                if label:
                    categories[label] = values
        return categories
    return {}


def _experience_entry(entry: dict, bullets: list[str]) -> ExperienceEntry:
    title = _text(entry.get("title"))
    company = _text(entry.get("company"))
    location = _text(entry.get("location"))
    header_parts = [title]
    if company:
        header_parts.append(company)
    header = ", ".join(header_parts)
    if location:
        header = f"{header} -- {location}"
    return ExperienceEntry(
        entry_id=_text(entry.get("id") or entry.get("entry_id") or title or "experience"),
        title_company_location=header,
        date_text=_text(entry.get("dates") or entry.get("date_text")),
        bullets=bullets,
    )


def _project_entry(entry: dict, bullets: list[str]) -> ProjectEntry:
    title = _text(entry.get("name") or entry.get("project_name"))
    url = _text(entry.get("url") or entry.get("date_or_link_text"))
    date_or_link = (
        f"\\href{{{url}}}{{{url.replace('https://', '').replace('http://', '')}}}"
        if url.startswith("http")
        else url
    )
    return ProjectEntry(
        entry_id=_text(entry.get("id") or entry.get("entry_id") or title or "project"),
        project_title=f"\\textbf{{{title}}}"
        if title and not title.startswith("\\textbf")
        else title,
        date_or_link_text=date_or_link,
        bullets=bullets,
    )


def build_master_resume_document(
    master: dict,
    *,
    title: str,
    keywords: list[str],
    role_family: str = "general",
    selection_overrides: dict | None = None,
) -> tuple[ResumeDocument, dict]:
    cfg = _selection_config(master, selection_overrides)
    signals = [title, role_family, *keywords]
    ranked_exp = _rank_entries(
        _list(master.get("experience")),
        signals,
        float(cfg.get("experience_position_bonus") or 0.0),
    )
    ranked_proj = _rank_entries(
        _list(master.get("projects")),
        signals,
        float(cfg.get("project_position_bonus") or 0.0),
    )
    exp_count = _choose_count(ranked_exp, int(cfg["min_experience"]), int(cfg["max_experience"]))
    proj_count = _choose_count(ranked_proj, int(cfg["min_projects"]), int(cfg["max_projects"]))

    selected_exp = sorted(ranked_exp[:exp_count], key=lambda item: item["index"])
    selected_proj = sorted(ranked_proj[:proj_count], key=lambda item: item["index"])
    exp_entries: list[ExperienceEntry] = []
    proj_entries: list[ProjectEntry] = []
    selected_bullets: list[str] = []
    for item in selected_exp:
        entry = item["entry"]
        bullets = [
            bullet["text"]
            for bullet in sorted(
                _rank_bullets(
                    _list(entry.get("bullets")),
                    signals,
                    float(cfg.get("bullet_position_bonus") or 0.0),
                )[: int(cfg["max_bullets_per_experience"])],
                key=lambda bullet: bullet["index"],
            )
            if bullet["text"]
        ]
        if bullets:
            exp_entries.append(_experience_entry(entry, bullets))
            selected_bullets.extend(bullets)
    for item in selected_proj:
        entry = item["entry"]
        bullets = [
            bullet["text"]
            for bullet in sorted(
                _rank_bullets(
                    _list(entry.get("bullets")),
                    signals,
                    float(cfg.get("bullet_position_bonus") or 0.0),
                )[: int(cfg["max_bullets_per_project"])],
                key=lambda bullet: bullet["index"],
            )
            if bullet["text"]
        ]
        if bullets:
            proj_entries.append(_project_entry(entry, bullets))
            selected_bullets.extend(bullets)

    header = master.get("header") if isinstance(master.get("header"), dict) else {}
    education = master.get("education") if isinstance(master.get("education"), dict) else {}
    summary_map = master.get("summaries") if isinstance(master.get("summaries"), dict) else {}
    summary = _text(summary_map.get(role_family) or summary_map.get("general"))
    categories = _category_map(master.get("skills"))
    doc = ResumeDocument(
        source_path=_text(master.get("path") or config.DEFAULT_MASTER_RESUME_PATH),
        preamble=_text(master.get("preamble") or _default_preamble()),
        header=ResumeHeader(
            name=_text(header.get("name") or "Candidate Name"),
            contact_line=_text(header.get("contact") or header.get("contact_line")),
        ),
        summary=summary,
        education=EducationSection(
            entry=EducationEntry(
                entry_id="edu_primary",
                institution_and_degree=_text(education.get("institution_and_degree")),
                date_text=_text(education.get("date_text")),
            ),
            bullets=[str(item) for item in _list(education.get("bullets"))],
        ),
        experience=exp_entries,
        projects=proj_entries,
        skills=SkillsSection(
            languages=categories.get("Languages", []),
            frameworks=categories.get("Frameworks", []),
            developer_tools=categories.get("Developer Tools", []),
            categories=categories,
        ),
    )
    selection_report = {
        "role_family": role_family,
        "signals": signals,
        "selection": cfg,
        "experience": [
            {"id": item["entry"].get("id") or item["entry"].get("entry_id"), "score": item["score"]}
            for item in selected_exp
        ],
        "projects": [
            {"id": item["entry"].get("id") or item["entry"].get("entry_id"), "score": item["score"]}
            for item in selected_proj
        ],
        "skills": categories,
    }
    return doc, selection_report


def render_selected_master_resume(
    *,
    title: str,
    keywords: list[str],
    role_family: str = "general",
    master_path: str | Path | None = None,
    selection_overrides: dict | None = None,
) -> tuple[str, dict]:
    master = load_master_resume(master_path)
    doc, report = build_master_resume_document(
        master,
        title=title,
        keywords=keywords,
        role_family=role_family,
        selection_overrides=selection_overrides,
    )
    return render_resume_tex(doc), report


def sync_master_selection_config(updates: dict[str, Any], path: str | Path | None = None) -> None:
    master_path = Path(path or config.DEFAULT_MASTER_RESUME_PATH)
    if not master_path.exists():
        return
    lines = master_path.read_text(encoding="utf-8").splitlines()
    allowed = set(DEFAULT_SELECTION)
    cleaned = {k: v for k, v in updates.items() if k in allowed}
    if not cleaned:
        return
    result: list[str] = []
    in_selection = False
    seen: set[str] = set()
    for line in lines:
        stripped = line.strip()
        if stripped == "selection:":
            in_selection = True
            result.append(line)
            continue
        if in_selection and line and not line.startswith(" "):
            for key, value in cleaned.items():
                if key not in seen:
                    result.append(f"  {key}: {value}")
            in_selection = False
        if in_selection:
            key = stripped.split(":", 1)[0] if ":" in stripped else ""
            if key in cleaned:
                result.append(f"  {key}: {cleaned[key]}")
                seen.add(key)
            else:
                result.append(line)
        else:
            result.append(line)
    if in_selection:
        for key, value in cleaned.items():
            if key not in seen:
                result.append(f"  {key}: {value}")
    master_path.write_text("\n".join(result).rstrip() + "\n", encoding="utf-8")


def _default_preamble() -> str:
    return r"""\documentclass[10pt, letterpaper]{article}
\usepackage[
    ignoreheadfoot,
    top=0.7 cm,
    bottom=1 cm,
    left=1 cm,
    right=1 cm,
    footskip=1.0 cm,
]{geometry}
\usepackage{titlesec}
\usepackage{tabularx}
\usepackage{array}
\usepackage[dvipsnames]{xcolor}
\usepackage{enumitem}
\usepackage{fontawesome5}
\usepackage{amsmath}
\usepackage[colorlinks=true,urlcolor=black]{hyperref}
\usepackage[pscoord]{eso-pic}
\usepackage{calc}
\usepackage{bookmark}
\usepackage{changepage}
\usepackage{paracol}
\usepackage{ifthen}
\usepackage{needspace}
\usepackage{iftex}
\ifPDFTeX
    \input{glyphtounicode}
    \pdfgentounicode=1
    \usepackage[T1]{fontenc}
    \usepackage[utf8]{inputenc}
    \usepackage{lmodern}
\fi
\usepackage{charter}
\raggedright
\AtBeginEnvironment{adjustwidth}{\partopsep0pt}
\pagestyle{empty}
\setcounter{secnumdepth}{0}
\setlength{\parindent}{0pt}
\setlength{\topskip}{0pt}
\setlength{\columnsep}{0.15cm}
\pagenumbering{gobble}
\titleformat{\section}{\needspace{4\baselineskip}\bfseries\large}{}{0pt}{}[\vspace{1pt}\titlerule]
\titlespacing{\section}{-1pt}{0.2 cm}{0.2 cm}
\renewcommand\labelitemi{$\vcenter{\hbox{\small$\bullet$}}$}
\newenvironment{onecolentry}{\begin{adjustwidth}{0 cm + 0.00001 cm}{0 cm + 0.00001 cm}}{\end{adjustwidth}}
\newenvironment{twocolentry}[2][]{\onecolentry\def\secondColumn{#2}\setcolumnwidth{\fill, 6 cm}\begin{paracol}{2}}{\switchcolumn \raggedleft \secondColumn\end{paracol}\endonecolentry}
"""
