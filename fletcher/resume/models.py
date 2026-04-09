from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class ResumeHeader(BaseModel):
    name: str
    contact_line: str


class EducationEntry(BaseModel):
    entry_id: str
    institution_and_degree: str
    date_text: str


class EducationSection(BaseModel):
    entry: EducationEntry
    bullets: list[str] = Field(default_factory=list)


class ExperienceEntry(BaseModel):
    entry_id: str
    title_company_location: str
    date_text: str
    bullets: list[str] = Field(default_factory=list)


class ProjectEntry(BaseModel):
    entry_id: str
    project_title: str
    date_or_link_text: str
    bullets: list[str] = Field(default_factory=list)


class SkillsSection(BaseModel):
    languages: list[str] = Field(default_factory=list)
    frameworks: list[str] = Field(default_factory=list)
    developer_tools: list[str] = Field(default_factory=list)


class ResumeDocument(BaseModel):
    source_path: str
    preamble: str
    header: ResumeHeader
    education: EducationSection
    experience: list[ExperienceEntry] = Field(default_factory=list)
    projects: list[ProjectEntry] = Field(default_factory=list)
    skills: SkillsSection
    section_order: list[Literal["Education", "Experience", "Projects", "Technical Skills"]] = Field(
        default_factory=lambda: ["Education", "Experience", "Projects", "Technical Skills"]
    )
