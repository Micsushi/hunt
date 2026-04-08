from __future__ import annotations

from pathlib import Path


def _read_lines(path: str | Path) -> list[str]:
    file_path = Path(path)
    if not file_path.exists():
        return []
    return [line.rstrip("\n") for line in file_path.read_text(encoding="utf-8").splitlines()]


def _split_tags(value: str) -> list[str]:
    if not value:
        return []
    separators = [",", ";"]
    normalized = value
    for separator in separators[1:]:
        normalized = normalized.replace(separator, separators[0])
    return [item.strip() for item in normalized.split(separators[0]) if item.strip()]


def _blank_experience_entry() -> dict:
    return {
        "entry_id": "",
        "company": "",
        "title": "",
        "location": "",
        "start_date": "",
        "end_date": "",
        "role_family_tags": [],
        "job_level_tags": [],
        "technology_tags": [],
        "leadership_tags": [],
        "pm_tags": [],
        "data_tags": [],
        "immutable_facts": [],
        "bullet_candidates": [],
        "extra_context": {},
    }


def _blank_project_entry() -> dict:
    return {
        "entry_id": "",
        "project_name": "",
        "url": "",
        "role_family_tags": [],
        "technology_tags": [],
        "relevance_notes": "",
        "immutable_facts": [],
        "bullet_candidates": [],
    }


def _blank_skill() -> dict:
    return {
        "skill_id": "",
        "name": "",
        "where_used": "",
        "strength_of_evidence": "",
        "related_role_families": [],
        "related_entry_ids": [],
    }


def _finalize_fact(entry: dict | None, fact: dict | None) -> None:
    if not entry or not fact:
        return
    if fact.get("fact_id"):
        entry["immutable_facts"].append(fact)


def _finalize_bullet(entry: dict | None, bullet: dict | None) -> None:
    if not entry or not bullet:
        return
    if bullet.get("bullet_id") and bullet.get("text"):
        entry["bullet_candidates"].append(bullet)


def _finalize_skill(target: dict, bucket: str | None, skill: dict | None) -> None:
    if not bucket or not skill:
        return
    if skill.get("skill_id") or skill.get("name"):
        target[bucket].append(skill)


def _append_entry(target: list[dict], entry: dict | None) -> None:
    if not entry:
        return
    if entry.get("entry_id") or entry.get("source_entry_id"):
        target.append(entry)


def load_candidate_profile(path: str | Path) -> dict:
    lines = _read_lines(path)
    profile = {
        "path": str(Path(path)),
        "experience_entries": [],
        "project_entries": [],
        "skills": {
            "languages": [],
            "frameworks": [],
            "developer_tools": [],
        },
        "experience_fact_ids": [],
        "project_fact_ids": [],
        "bullet_ids": [],
        "skill_ids": [],
    }

    current_section = ""
    current_entry_kind = ""
    current_subsection = ""
    current_entry: dict | None = None
    current_fact: dict | None = None
    current_bullet: dict | None = None
    current_skill_bucket: str | None = None
    current_skill: dict | None = None

    def flush_nested() -> None:
        nonlocal current_fact, current_bullet
        _finalize_fact(current_entry, current_fact)
        _finalize_bullet(current_entry, current_bullet)
        current_fact = None
        current_bullet = None

    def flush_entry() -> None:
        nonlocal current_entry, current_entry_kind, current_subsection
        flush_nested()
        if current_entry_kind == "experience":
            _append_entry(profile["experience_entries"], current_entry)
        elif current_entry_kind == "project":
            _append_entry(profile["project_entries"], current_entry)
        current_entry = None
        current_entry_kind = ""
        current_subsection = ""

    def flush_skill() -> None:
        nonlocal current_skill
        _finalize_skill(profile["skills"], current_skill_bucket, current_skill)
        current_skill = None

    for raw_line in lines:
        stripped = raw_line.strip()
        if not stripped:
            continue

        if stripped.startswith("## "):
            flush_entry()
            flush_skill()
            current_section = stripped[3:].strip()
            current_skill_bucket = None
            continue

        if stripped == "### Experience Entry":
            flush_entry()
            current_entry_kind = "experience"
            current_entry = _blank_experience_entry()
            continue

        if stripped == "### Project Entry":
            flush_entry()
            current_entry_kind = "project"
            current_entry = _blank_project_entry()
            continue

        if stripped.startswith("### ") and current_section == "Skills Inventory":
            flush_skill()
            heading = stripped[4:].strip()
            bucket_map = {
                "Languages": "languages",
                "Frameworks": "frameworks",
                "Developer Tools": "developer_tools",
            }
            current_skill_bucket = bucket_map.get(heading)
            continue

        if stripped.startswith("#### "):
            flush_nested()
            current_subsection = stripped[5:].strip()
            continue

        if current_skill_bucket:
            if stripped.startswith("- Skill ID:"):
                flush_skill()
                value = stripped.split(":", 1)[1].strip()
                current_skill = _blank_skill()
                current_skill["skill_id"] = value
                if value:
                    profile["skill_ids"].append(value)
                continue
            if current_skill is None:
                continue
            if stripped.startswith("- Name:"):
                current_skill["name"] = stripped.split(":", 1)[1].strip()
            elif stripped.startswith("- Where used:"):
                current_skill["where_used"] = stripped.split(":", 1)[1].strip()
            elif stripped.startswith("- Strength of evidence:"):
                current_skill["strength_of_evidence"] = stripped.split(":", 1)[1].strip()
            elif stripped.startswith("- Related role families:"):
                current_skill["related_role_families"] = _split_tags(
                    stripped.split(":", 1)[1].strip()
                )
            continue

        if not current_entry:
            continue

        if stripped.startswith("- Entry ID:"):
            current_entry["entry_id"] = stripped.split(":", 1)[1].strip()
        elif stripped.startswith("- Company:"):
            current_entry["company"] = stripped.split(":", 1)[1].strip()
        elif stripped.startswith("- Title:"):
            current_entry["title"] = stripped.split(":", 1)[1].strip()
        elif stripped.startswith("- Location:"):
            current_entry["location"] = stripped.split(":", 1)[1].strip()
        elif stripped.startswith("- Start date:"):
            current_entry["start_date"] = stripped.split(":", 1)[1].strip()
        elif stripped.startswith("- End date:"):
            current_entry["end_date"] = stripped.split(":", 1)[1].strip()
        elif stripped.startswith("- Project name:"):
            current_entry["project_name"] = stripped.split(":", 1)[1].strip()
        elif stripped.startswith("- URL:"):
            current_entry["url"] = stripped.split(":", 1)[1].strip()
        elif stripped.startswith("- Role-family tags:"):
            current_entry["role_family_tags"] = _split_tags(stripped.split(":", 1)[1].strip())
        elif stripped.startswith("- Job-level tags:"):
            current_entry["job_level_tags"] = _split_tags(stripped.split(":", 1)[1].strip())
        elif stripped.startswith("- Technology tags:"):
            current_entry["technology_tags"] = _split_tags(stripped.split(":", 1)[1].strip())
        elif stripped.startswith("- Leadership tags:"):
            current_entry["leadership_tags"] = _split_tags(stripped.split(":", 1)[1].strip())
        elif stripped.startswith("- PM tags:"):
            current_entry["pm_tags"] = _split_tags(stripped.split(":", 1)[1].strip())
        elif stripped.startswith("- Data tags:"):
            current_entry["data_tags"] = _split_tags(stripped.split(":", 1)[1].strip())
        elif stripped.startswith("- Relevance notes:"):
            current_entry["relevance_notes"] = stripped.split(":", 1)[1].strip()
        elif current_subsection == "Immutable facts" and stripped.startswith("- Fact ID:"):
            _finalize_fact(current_entry, current_fact)
            current_fact = {
                "fact_id": stripped.split(":", 1)[1].strip(),
                "text": "",
            }
            if current_fact["fact_id"]:
                target = (
                    "project_fact_ids" if current_entry_kind == "project" else "experience_fact_ids"
                )
                profile[target].append(current_fact["fact_id"])
        elif (
            current_subsection == "Immutable facts"
            and current_fact
            and stripped.startswith("- Text:")
        ):
            current_fact["text"] = stripped.split(":", 1)[1].strip()
        elif current_subsection == "Bullet candidates" and stripped.startswith("- Bullet ID:"):
            _finalize_bullet(current_entry, current_bullet)
            current_bullet = {
                "bullet_id": stripped.split(":", 1)[1].strip(),
                "text": "",
                "supported_fact_ids": [],
                "relevance_tags": [],
            }
            if current_bullet["bullet_id"]:
                profile["bullet_ids"].append(current_bullet["bullet_id"])
        elif (
            current_subsection == "Bullet candidates"
            and current_bullet
            and stripped.startswith("- Text:")
        ):
            current_bullet["text"] = stripped.split(":", 1)[1].strip()
        elif (
            current_subsection == "Bullet candidates"
            and current_bullet
            and stripped.startswith("- Supported by fact IDs:")
        ):
            current_bullet["supported_fact_ids"] = _split_tags(stripped.split(":", 1)[1].strip())
        elif (
            current_subsection == "Bullet candidates"
            and current_bullet
            and stripped.startswith("- Relevance tags:")
        ):
            current_bullet["relevance_tags"] = _split_tags(stripped.split(":", 1)[1].strip())
        elif stripped.startswith("- Systems:"):
            current_entry["extra_context"]["systems"] = stripped.split(":", 1)[1].strip()
        elif stripped.startswith("- Stakeholders:"):
            current_entry["extra_context"]["stakeholders"] = stripped.split(":", 1)[1].strip()
        elif stripped.startswith("- Scale:"):
            current_entry["extra_context"]["scale"] = stripped.split(":", 1)[1].strip()
        elif stripped.startswith("- Metrics:"):
            current_entry["extra_context"]["metrics"] = stripped.split(":", 1)[1].strip()
        elif stripped.startswith("- Tools:"):
            current_entry["extra_context"]["tools"] = stripped.split(":", 1)[1].strip()

    flush_entry()
    flush_skill()
    return profile


def load_bullet_library(path: str | Path) -> dict:
    lines = _read_lines(path)
    library = {
        "path": str(Path(path)),
        "experience_entries": [],
        "project_entries": [],
        "skills": {
            "languages": [],
            "frameworks": [],
            "developer_tools": [],
        },
        "bullet_ids": [],
        "skill_ids": [],
    }

    current_section = ""
    current_subsection = ""
    current_entry_kind = ""
    current_entry: dict | None = None
    current_bullet: dict | None = None
    current_skill: dict | None = None
    current_skill_bucket: str | None = None

    def flush_bullet() -> None:
        nonlocal current_bullet
        _finalize_bullet(current_entry, current_bullet)
        current_bullet = None

    def flush_entry() -> None:
        nonlocal current_entry, current_entry_kind, current_subsection
        flush_bullet()
        if current_entry_kind == "experience":
            _append_entry(library["experience_entries"], current_entry)
        elif current_entry_kind == "project":
            _append_entry(library["project_entries"], current_entry)
        current_entry = None
        current_entry_kind = ""
        current_subsection = ""

    def flush_skill() -> None:
        nonlocal current_skill
        _finalize_skill(library["skills"], current_skill_bucket, current_skill)
        current_skill = None

    for raw_line in lines:
        stripped = raw_line.strip()
        if not stripped:
            continue

        if stripped.startswith("## "):
            flush_entry()
            flush_skill()
            current_section = stripped[3:].strip()
            current_skill_bucket = None
            continue

        if stripped == "### Entry":
            flush_entry()
            if current_section == "Experience Bullets":
                current_entry_kind = "experience"
                current_entry = {
                    "source_entry_id": "",
                    "company": "",
                    "title": "",
                    "role_family_tags": [],
                    "job_level_tags": [],
                    "technology_tags": [],
                    "domain_tags": [],
                    "bullet_candidates": [],
                }
            elif current_section == "Project Bullets":
                current_entry_kind = "project"
                current_entry = {
                    "source_entry_id": "",
                    "project_name": "",
                    "role_family_tags": [],
                    "technology_tags": [],
                    "domain_tags": [],
                    "bullet_candidates": [],
                }
            continue

        if stripped.startswith("#### "):
            flush_bullet()
            current_subsection = stripped[5:].strip()
            continue

        if current_section == "Skill Signals":
            if stripped.startswith("- Skill ID:"):
                flush_skill()
                value = stripped.split(":", 1)[1].strip()
                current_skill = _blank_skill()
                current_skill["skill_id"] = value
                if value:
                    library["skill_ids"].append(value)
                continue
            if current_skill is None:
                continue
            if stripped.startswith("- Name:"):
                current_skill["name"] = stripped.split(":", 1)[1].strip()
            elif stripped.startswith("- Where it was used:"):
                current_skill["where_used"] = stripped.split(":", 1)[1].strip()
            elif stripped.startswith("- Strength of evidence:"):
                current_skill["strength_of_evidence"] = stripped.split(":", 1)[1].strip()
            elif stripped.startswith("- Related role families:"):
                current_skill["related_role_families"] = _split_tags(
                    stripped.split(":", 1)[1].strip()
                )
            elif stripped.startswith("- Related entry IDs:"):
                current_skill["related_entry_ids"] = _split_tags(stripped.split(":", 1)[1].strip())
            continue

        if not current_entry:
            continue

        if stripped.startswith("- Source entry ID:"):
            current_entry["source_entry_id"] = stripped.split(":", 1)[1].strip()
        elif stripped.startswith("- Company:"):
            current_entry["company"] = stripped.split(":", 1)[1].strip()
        elif stripped.startswith("- Title:"):
            current_entry["title"] = stripped.split(":", 1)[1].strip()
        elif stripped.startswith("- Project name:"):
            current_entry["project_name"] = stripped.split(":", 1)[1].strip()
        elif stripped.startswith("- Role-family tags:"):
            current_entry["role_family_tags"] = _split_tags(stripped.split(":", 1)[1].strip())
        elif stripped.startswith("- Job-level tags:"):
            current_entry["job_level_tags"] = _split_tags(stripped.split(":", 1)[1].strip())
        elif stripped.startswith("- Technology tags:"):
            current_entry["technology_tags"] = _split_tags(stripped.split(":", 1)[1].strip())
        elif stripped.startswith("- Domain tags:"):
            current_entry["domain_tags"] = _split_tags(stripped.split(":", 1)[1].strip())
        elif current_subsection == "Bullet candidates" and stripped.startswith("- Bullet ID:"):
            flush_bullet()
            current_bullet = {
                "bullet_id": stripped.split(":", 1)[1].strip(),
                "text": "",
                "supported_fact_ids": [],
                "relevance_tags": [],
                "evidence_notes": "",
                "metrics": "",
            }
            if current_bullet["bullet_id"]:
                library["bullet_ids"].append(current_bullet["bullet_id"])
        elif (
            current_subsection == "Bullet candidates"
            and current_bullet
            and stripped.startswith("- Text:")
        ):
            current_bullet["text"] = stripped.split(":", 1)[1].strip()
        elif (
            current_subsection == "Bullet candidates"
            and current_bullet
            and stripped.startswith("- Supported by fact IDs:")
        ):
            current_bullet["supported_fact_ids"] = _split_tags(stripped.split(":", 1)[1].strip())
        elif (
            current_subsection == "Bullet candidates"
            and current_bullet
            and stripped.startswith("- Evidence notes:")
        ):
            current_bullet["evidence_notes"] = stripped.split(":", 1)[1].strip()
        elif (
            current_subsection == "Bullet candidates"
            and current_bullet
            and stripped.startswith("- Metrics:")
        ):
            current_bullet["metrics"] = stripped.split(":", 1)[1].strip()
        elif (
            current_subsection == "Bullet candidates"
            and current_bullet
            and stripped.startswith("- Relevance tags:")
        ):
            current_bullet["relevance_tags"] = _split_tags(stripped.split(":", 1)[1].strip())

    flush_entry()
    flush_skill()
    return library
