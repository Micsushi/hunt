"""Emit privacy-safe structural evidence from the vendored ResumeParser."""

from __future__ import annotations

import json
import sys

from resume_parser.extractors.contact_extractor import ContactExtractor
from resume_parser.extractors.education_extractor import EducationExtractor
from resume_parser.extractors.experience_extractor import ExperienceExtractor
from resume_parser.utils.skills_checker import SkillsChecker


def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit("usage: resume_parser_probe.py <resume.pdf>")

    path = sys.argv[1]
    contact = ContactExtractor().extract(path)
    education = EducationExtractor().extract(path)
    experience = ExperienceExtractor().extract(path)
    skill_categories = SkillsChecker().extract_general_skills(path)

    contact_count = sum(
        bool(contact.get(key)) for key in ("name", "email", "phone", "linkedin", "github")
    )
    contact_count += len(contact.get("additional_urls") or [])
    education_count = len(education.get("items") or [])
    experience_count = len(experience.get("items") or [])
    present_skill_categories = [
        values for values in skill_categories.values() if values.get("found")
    ]
    skill_count = sum(len(values.get("found") or []) for values in present_skill_categories)

    print(
        json.dumps(
            {
                "schema_version": 1,
                "tool": "ResumeParser",
                "contact": {
                    "present": contact_count > 0,
                    "field_count": contact_count,
                },
                "education": {
                    "present": education_count > 0,
                    "entry_count": education_count,
                },
                "experience": {
                    "present": experience_count > 0,
                    "entry_count": experience_count,
                },
                "skills": {
                    "present": skill_count > 0,
                    "category_count": len(present_skill_categories),
                    "skill_count": skill_count,
                },
            },
            separators=(",", ":"),
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
