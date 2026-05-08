"""
Interactive GitHub project importer for master_resume.yaml.

Fetches your GitHub repos, lets you pick + order which to include,
generates resume bullets, and writes them back to the YAML.

Usage:
    python -m fletcher.github_import                         # uses Ollama (default)
    python -m fletcher.github_import --provider claude-code  # uses `claude` CLI (no extra cost)
    python scripts/hunterctl.py gh-import --provider claude-code

Required env vars:
    GITHUB_TOKEN or HUNT_GITHUB_TOKEN  — GitHub personal access token (read:user, public_repo)

LLM providers:
    ollama        Hunt's configured Ollama model (default, free/local)
    claude-code   Shells out to `claude --bare -p` — uses your Claude subscription, no API key needed
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

import httpx

from fletcher import config as _config
from fletcher.llm.client import generate_json

# ─── constants ────────────────────────────────────────────────────────────────

GITHUB_API = "https://api.github.com"
MASTER_YAML_PATH = _config.DEFAULT_MASTER_RESUME_PATH

# ─── GitHub helpers ────────────────────────────────────────────────────────────


def _gh_headers(token: str) -> dict:
    return {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }


def _get_github_token() -> str:
    token = os.getenv("GITHUB_TOKEN") or os.getenv("HUNT_GITHUB_TOKEN") or ""
    if not token:
        token = input("GitHub personal access token (needs public_repo read): ").strip()
    if not token:
        print("ERROR: GitHub token required.", file=sys.stderr)
        sys.exit(1)
    return token


def _detect_github_username(master_path: Path) -> str:
    override = os.getenv("HUNT_GITHUB_USERNAME", "").strip()
    if override:
        return override
    try:
        text = master_path.read_text(encoding="utf-8")
        m = re.search(r"github\.com/([a-zA-Z0-9_-]+)", text)
        if m:
            return m.group(1)
    except Exception:
        pass
    username = input("GitHub username: ").strip()
    if not username:
        print("ERROR: GitHub username required.", file=sys.stderr)
        sys.exit(1)
    return username


def fetch_repos(token: str, username: str) -> list[dict]:
    """Return all non-fork repos owned by username, sorted by updated_at desc."""
    headers = _gh_headers(token)
    all_repos: list[dict] = []
    page = 1
    while True:
        resp = httpx.get(
            f"{GITHUB_API}/users/{username}/repos",
            headers=headers,
            params={"per_page": 100, "sort": "updated", "type": "owner", "page": page},
            timeout=30,
        )
        resp.raise_for_status()
        batch = resp.json()
        if not batch:
            break
        all_repos.extend(batch)
        page += 1
        if len(batch) < 100:
            break
    # exclude forks, keep only real repos
    owned = [r for r in all_repos if not r.get("fork", False)]
    return owned


def fetch_repo_details(token: str, owner: str, repo_name: str) -> dict:
    """Fetch description, README, and language breakdown for a repo."""
    import base64

    headers = _gh_headers(token)
    details: dict[str, Any] = {"name": repo_name}

    r = httpx.get(f"{GITHUB_API}/repos/{owner}/{repo_name}", headers=headers, timeout=30)
    if r.status_code == 200:
        data = r.json()
        details["description"] = data.get("description") or ""
        details["topics"] = data.get("topics") or []
        details["language"] = data.get("language") or ""
        details["stars"] = data.get("stargazers_count", 0)
        details["html_url"] = data.get("html_url", f"https://github.com/{owner}/{repo_name}")

    r = httpx.get(f"{GITHUB_API}/repos/{owner}/{repo_name}/languages", headers=headers, timeout=30)
    if r.status_code == 200:
        details["language_breakdown"] = list(r.json().keys())

    r = httpx.get(f"{GITHUB_API}/repos/{owner}/{repo_name}/readme", headers=headers, timeout=30)
    if r.status_code == 200:
        content = r.json().get("content", "")
        try:
            readme_raw = base64.b64decode(content).decode("utf-8", errors="replace")
            readme_raw = re.sub(r"!\[.*?\]\(.*?\)", "", readme_raw)
            readme_raw = re.sub(
                r"\[.*?\]\(.*?\)", lambda m: m.group(0).split("](")[0][1:], readme_raw
            )
            details["readme"] = readme_raw[:2500].strip()
        except Exception:
            details["readme"] = ""
    else:
        details["readme"] = ""

    return details


# ─── Interactive selection ─────────────────────────────────────────────────────


def pick_repos(repos: list[dict]) -> list[dict]:
    """Show numbered list, return ordered selection chosen by user."""
    print("\n── Your GitHub repos ──────────────────────────────────────────")
    for i, repo in enumerate(repos, 1):
        desc = (repo.get("description") or "")[:60]
        lang = repo.get("language") or ""
        stars = repo.get("stargazers_count", 0)
        tag = f" ★{stars}" if stars else ""
        print(f"  {i:>3}.  {repo['name']:<35} [{lang}]{tag}")
        if desc:
            print(f"         {desc}")
    print()
    raw = input("Enter repo numbers to include (comma-separated, in desired order): ").strip()
    if not raw:
        print("No repos selected.", file=sys.stderr)
        sys.exit(0)

    selected: list[dict] = []
    seen: set[int] = set()
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        try:
            idx = int(part) - 1
        except ValueError:
            print(f"Skipping invalid input: {part!r}")
            continue
        if idx < 0 or idx >= len(repos):
            print(f"Number {idx + 1} out of range, skipping.")
            continue
        if idx in seen:
            continue
        seen.add(idx)
        selected.append(repos[idx])
    return selected


# ─── LLM bullet generation ─────────────────────────────────────────────────────

_SYSTEM_PROMPT = """\
You are a resume bullet writer for a software engineering resume.

Generate exactly 4-5 strong, concise bullet points for the project section of the resume.

BULLET RULES:
- Start with a strong past-tense action verb (Built, Developed, Achieved, Secured, Optimized, Engineered, etc.)
- Structure: [Action verb] [quantified impact] by [method/technology used]
- Mention specific technologies, frameworks, or tools where relevant
- Bold numbers and metrics using \\textbf{} (e.g. \\textbf{85\\%}, \\textbf{\\$4,000}, \\textbf{10,000+})
- Bold % needs to be written as \\textbf{85\\%} — the % must be escaped with a backslash
- If no hard metrics exist, focus on technical scope, team size, or user-facing impact
- Each bullet is 1-2 sentences max

SKILLS RULES:
Return a JSON object with skills grouped by the EXACT category names below:
  "Languages", "Frameworks", "Cloud & Data", "Developer Tools"
Only include skills genuinely used in this project. No invented skills.

DISPLAY NAME RULES:
- Use "ProjectName: SubTitle" format if there is an award or notable distinction
- Otherwise just use a clean title-case name
"""

_SCHEMA = {
    "type": "object",
    "properties": {
        "display_name": {"type": "string"},
        "bullets": {"type": "array", "items": {"type": "string"}},
        "skills": {
            "type": "object",
            "properties": {
                "Languages": {"type": "array", "items": {"type": "string"}},
                "Frameworks": {"type": "array", "items": {"type": "string"}},
                "Cloud & Data": {"type": "array", "items": {"type": "string"}},
                "Developer Tools": {"type": "array", "items": {"type": "string"}},
            },
        },
    },
    "required": ["display_name", "bullets", "skills"],
}


def _user_msg(repo: dict) -> str:
    return f"""Project name: {repo["name"]}
Description: {repo.get("description") or "(none)"}
Stars: {repo.get("stars", 0)}
Primary language: {repo.get("language") or "unknown"}
All languages used: {", ".join(repo.get("language_breakdown", [])) or "unknown"}
Topics/tags: {", ".join(repo.get("topics", [])) or "none"}

README excerpt:
{repo.get("readme", "(no README)") or "(no README)"}

Generate 4-5 resume bullets and extract skills for this project.
Use \\textbf{{}} for numbers/metrics, \\% for percent signs inside \\textbf.

Respond with ONLY a JSON object matching this schema — no prose, no markdown fences:
{{
  "display_name": "...",
  "bullets": ["...", "..."],
  "skills": {{
    "Languages": ["..."],
    "Frameworks": ["..."],
    "Cloud & Data": ["..."],
    "Developer Tools": ["..."]
  }}
}}"""


def _generate_via_ollama(repo: dict) -> dict:
    result = generate_json(
        task_name="project_bullets",
        system=_SYSTEM_PROMPT,
        user=_user_msg(repo),
        schema=_SCHEMA,
        temperature=0.4,
        timeout_sec=300,
    )
    if result.success and result.parsed:
        return result.parsed
    print(f"  LLM error: {result.error}", file=sys.stderr)
    return {}


def _generate_via_claude_code(repo: dict) -> dict:
    """Shell out to `claude --bare -p` — uses existing Claude subscription, no API key needed."""
    claude_bin = shutil.which("claude")
    if not claude_bin:
        raise RuntimeError("`claude` CLI not found on PATH. Is Claude Code installed?")

    full_prompt = _SYSTEM_PROMPT + "\n\n" + _user_msg(repo)

    proc = subprocess.run(
        [claude_bin, "--bare", "-p", "--output-format", "json"],
        input=full_prompt,
        capture_output=True,
        text=True,
        timeout=120,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"claude CLI exited {proc.returncode}: {proc.stderr[:300]}")

    # outer envelope: {"result": "<assistant text>", "session_id": ..., ...}
    outer = json.loads(proc.stdout)
    text = outer.get("result", "")

    # strip optional markdown fences the model may add
    text = re.sub(r"^```json\s*", "", text.strip())
    text = re.sub(r"\s*```$", "", text.strip())

    return json.loads(text)


def generate_bullets(repo: dict, provider: str = "ollama") -> dict:
    """Generate resume bullets for a repo. provider: 'ollama' | 'claude-code'"""
    try:
        if provider == "claude-code":
            return _generate_via_claude_code(repo)
        return _generate_via_ollama(repo)
    except Exception as exc:
        print(f"  LLM error: {exc}", file=sys.stderr)
        return {"display_name": repo["name"], "bullets": [], "skills": {}}


# ─── YAML write helpers ────────────────────────────────────────────────────────


def _yaml_escape(text: str) -> str:
    # master.py parser does replace("\\\\", "\\") on double-quoted values,
    # so double every backslash so it round-trips to a single backslash in LaTeX.
    return text.replace("\\", "\\\\").replace('"', '\\"')


def _format_project_entry(proj_id: str, name: str, url: str, bullets: list[str]) -> str:
    lines = [
        f'  - id: "{proj_id}"',
        f'    name: "{_yaml_escape(name)}"',
        f'    url: "{url}"',
        "    bullets:",
    ]
    for bullet in bullets:
        lines.append(f'      - text: "{_yaml_escape(bullet)}"')
    return "\n".join(lines)


def _make_proj_id(index: int, name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")[:20]
    return f"proj{index}_{slug}"


def write_projects_section(projects: list[dict], master_path: Path) -> None:
    """Replace the projects: section in master_resume.yaml."""
    raw = master_path.read_text(encoding="utf-8")
    lines = raw.splitlines()

    proj_start: int | None = None
    next_top: int | None = None

    for i, line in enumerate(lines):
        if line.rstrip() == "projects:":
            proj_start = i
        elif (
            proj_start is not None
            and line
            and not line.startswith(" ")
            and line.rstrip().endswith(":")
        ):
            next_top = i
            break

    if proj_start is None:
        print("ERROR: 'projects:' section not found in master_resume.yaml", file=sys.stderr)
        return

    proj_blocks = []
    for idx, proj in enumerate(projects, 1):
        proj_id = _make_proj_id(idx, proj["name"])
        url = proj.get("url", "")
        bullets = proj.get("bullets", [])
        proj_blocks.append(_format_project_entry(proj_id, proj["name"], url, bullets))

    new_section = "projects:\n  \n" + "\n\n".join(proj_blocks)

    before = "\n".join(lines[:proj_start])
    after = "\n".join(lines[next_top:]) if next_top is not None else ""
    separator = "\n\n" if after else ""

    updated = before + "\n" + new_section + separator + after
    master_path.write_text(updated.rstrip() + "\n", encoding="utf-8")
    print(f"  Wrote {len(projects)} project(s) to {master_path.name}")


def write_skills_section(new_skills_by_cat: dict[str, list[str]], master_path: Path) -> None:
    """Merge new skills into the skills: section, deduplicating case-insensitively."""
    raw = master_path.read_text(encoding="utf-8")
    lines = raw.splitlines()

    skills_start: int | None = None
    skills_end: int | None = None
    for i, line in enumerate(lines):
        if line.rstrip() == "skills:":
            skills_start = i
        elif (
            skills_start is not None
            and line
            and not line.startswith(" ")
            and line.rstrip().endswith(":")
        ):
            skills_end = i
            break

    if skills_start is None:
        print("WARNING: 'skills:' section not found, skipping skill merge.", file=sys.stderr)
        return

    existing: dict[str, list[str]] = {}
    current_cat: str | None = None
    section_lines = lines[skills_start + 1 : skills_end]
    for line in section_lines:
        stripped = line.strip()
        if not stripped:
            continue
        if line.startswith("  ") and not line.startswith("    ") and stripped.endswith(":"):
            current_cat = stripped[:-1]
            existing[current_cat] = []
        elif line.startswith("    - ") and current_cat is not None:
            existing[current_cat].append(stripped[2:])

    all_existing_lower = {s.lower() for cat_items in existing.values() for s in cat_items}
    added_count = 0
    for cat, skills in new_skills_by_cat.items():
        for skill in skills:
            if skill and skill.lower() not in all_existing_lower:
                existing.setdefault(cat, []).append(skill)
                all_existing_lower.add(skill.lower())
                added_count += 1

    skill_lines = ["skills:"]
    for cat, items in existing.items():
        skill_lines.append(f"  {cat}:")
        for item in items:
            skill_lines.append(f"    - {item}")

    new_block = "\n".join(skill_lines)
    before = "\n".join(lines[:skills_start])
    after = "\n".join(lines[skills_end:]) if skills_end is not None else ""
    separator = "\n" if after else ""

    updated = before + "\n" + new_block + separator + after
    master_path.write_text(updated.rstrip() + "\n", encoding="utf-8")
    print(f"  Merged {added_count} new skill(s) into skills section")


# ─── Interactive review ────────────────────────────────────────────────────────


def _review_project(proj: dict) -> dict:
    """Let user confirm or edit display name and preview bullets."""
    print(f"\n── {proj['name']} (url: {proj.get('url', '')})")
    new_name = input("   Display name (Enter to keep, or type new): ").strip()
    if new_name:
        proj = {**proj, "name": new_name}

    print("   Bullets:")
    for i, b in enumerate(proj.get("bullets", []), 1):
        print(f"   {i}. {b[:100]}{'...' if len(b) > 100 else ''}")

    keep = input("   Keep these bullets? [Y/n]: ").strip().lower()
    if keep == "n":
        print("   (skipping this project)")
        return {}

    return proj


# ─── Main flow ─────────────────────────────────────────────────────────────────


def run(master_path: Path | None = None, provider: str = "ollama") -> None:
    master_path = Path(master_path or MASTER_YAML_PATH)

    print(f"── GitHub Project Importer (LLM: {provider}) ─────────────────")

    token = _get_github_token()
    username = _detect_github_username(master_path)

    print(f"\nFetching repos for @{username}...")
    repos = fetch_repos(token, username)
    if not repos:
        print("No owned repos found.", file=sys.stderr)
        sys.exit(1)
    print(f"Found {len(repos)} owned repos.")

    selected = pick_repos(repos)
    if not selected:
        print("Nothing selected.")
        sys.exit(0)

    print(f"\nGenerating bullets for {len(selected)} repo(s)...")
    projects: list[dict] = []
    all_skills: dict[str, list[str]] = {}

    for repo in selected:
        print(f"\n  → {repo['name']}")
        details = fetch_repo_details(token, username, repo["name"])
        result = generate_bullets(details, provider=provider)

        for cat, skills in (result.get("skills") or {}).items():
            all_skills.setdefault(cat, []).extend(skills)

        proj = {
            "name": result.get("display_name") or repo["name"],
            "url": details.get("html_url", f"https://github.com/{username}/{repo['name']}"),
            "bullets": result.get("bullets", []),
        }
        reviewed = _review_project(proj)
        if reviewed:
            projects.append(reviewed)

    if not projects:
        print("No projects to write.")
        return

    print(f"\nWriting to {master_path}...")
    write_projects_section(projects, master_path)
    if all_skills:
        write_skills_section(all_skills, master_path)

    print("\nDone. Review master_resume.yaml and run `python ci.py` to verify.")


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(
        description="Interactive GitHub project importer for master_resume.yaml."
    )
    parser.add_argument("--master", default=None, help="Override path to master_resume.yaml.")
    parser.add_argument(
        "--provider",
        choices=["ollama", "claude-code"],
        default="ollama",
        help="LLM provider: 'ollama' (default, local/free) or 'claude-code' (uses `claude` CLI subscription).",
    )
    args = parser.parse_args()
    run(master_path=args.master, provider=args.provider)


if __name__ == "__main__":
    main()
