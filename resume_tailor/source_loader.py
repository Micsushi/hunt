from __future__ import annotations

from pathlib import Path


def _read_lines(path: str | Path) -> list[str]:
    file_path = Path(path)
    if not file_path.exists():
        return []
    return [line.rstrip("\n") for line in file_path.read_text(encoding="utf-8").splitlines()]


def load_candidate_profile(path: str | Path) -> dict:
    lines = _read_lines(path)
    facts: dict[str, list[str] | str] = {
        "experience_fact_ids": [],
        "project_fact_ids": [],
        "bullet_ids": [],
        "skill_ids": [],
        "path": str(Path(path)),
    }
    current_section = None

    for raw_line in lines:
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith("## "):
            current_section = line[3:].strip()
            continue
        if line.startswith("- Fact ID:"):
            key = "project_fact_ids" if current_section == "Project Inventory" else "experience_fact_ids"
            value = line.split(":", 1)[1].strip()
            if value:
                facts[key].append(value)
        elif line.startswith("- Bullet ID:"):
            value = line.split(":", 1)[1].strip()
            if value:
                facts["bullet_ids"].append(value)
        elif line.startswith("- Skill ID:"):
            value = line.split(":", 1)[1].strip()
            if value:
                facts["skill_ids"].append(value)

    return facts


def load_bullet_library(path: str | Path) -> dict:
    lines = _read_lines(path)
    bullet_ids: list[str] = []
    skill_ids: list[str] = []
    for raw_line in lines:
        line = raw_line.strip()
        if line.startswith("- Bullet ID:"):
            value = line.split(":", 1)[1].strip()
            if value:
                bullet_ids.append(value)
        elif line.startswith("- Skill ID:"):
            value = line.split(":", 1)[1].strip()
            if value:
                skill_ids.append(value)
    return {
        "path": str(Path(path)),
        "bullet_ids": bullet_ids,
        "skill_ids": skill_ids,
    }

