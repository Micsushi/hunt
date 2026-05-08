from __future__ import annotations

import hashlib
from enum import StrEnum
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field

from .models import ResumeDocument


class ResumeReviewVersionName(StrEnum):
    STARTING = "starting"
    NO_SUMMARY = "no_summary"
    WITH_SUMMARY = "with_summary"


class ResumeReviewSourceInfo(BaseModel):
    input_kind: str = "tex"
    input_filename: str = ""
    import_status: Literal["ok", "warning", "failed"] = "ok"
    import_warnings: list[str] = Field(default_factory=list)


class ResumeReviewJobInfo(BaseModel):
    job_id: int | None = None
    attempt_id: int | None = None
    title: str = ""
    company: str = ""
    description_hash: str = ""


class ResumeReviewLlmInfo(BaseModel):
    provider: str = "heuristic"
    model: str = ""
    cloud: bool = False


class ResumeReviewVersion(BaseModel):
    original: ResumeDocument
    generated: ResumeDocument
    current: ResumeDocument
    pdf_url: str
    tex_url: str
    dirty: bool = False
    compiled_revision: int = 0
    compile_status: str | None = None


class ResumeReviewPackage(BaseModel):
    review_id: str
    source: ResumeReviewSourceInfo = Field(default_factory=ResumeReviewSourceInfo)
    job: ResumeReviewJobInfo = Field(default_factory=ResumeReviewJobInfo)
    llm: ResumeReviewLlmInfo = Field(default_factory=ResumeReviewLlmInfo)
    keywords: dict[str, Any] = Field(default_factory=dict)
    versions: dict[ResumeReviewVersionName, ResumeReviewVersion] = Field(default_factory=dict)
    log_url: str


class ResumeReviewBlock(BaseModel):
    block_id: str
    section: str
    kind: str
    original_text: str
    generated_text: str
    current_text: str
    editable: bool = True
    revertible: bool = True


def model_to_dict(model: BaseModel) -> dict[str, Any]:
    if hasattr(model, "model_dump"):
        return model.model_dump(mode="json")  # type: ignore[attr-defined]
    return model.dict()  # type: ignore[no-any-return]


def model_validate(cls, payload: Any):
    if hasattr(cls, "model_validate"):
        return cls.model_validate(payload)
    return cls.parse_obj(payload)


def build_review_id(attempt_dir: str | Path) -> str:
    raw = str(Path(attempt_dir).resolve()).encode("utf-8", errors="replace")
    return hashlib.sha256(raw).hexdigest()[:24]


def _block(block_id: str, section: str, kind: str, text: str) -> ResumeReviewBlock:
    return ResumeReviewBlock(
        block_id=block_id,
        section=section,
        kind=kind,
        original_text=text,
        generated_text=text,
        current_text=text,
    )


def document_to_review_blocks(doc: ResumeDocument) -> list[ResumeReviewBlock]:
    blocks: list[ResumeReviewBlock] = [
        _block("header.name", "Header", "single_text", doc.header.name),
        _block("header.contact_line", "Header", "single_text", doc.header.contact_line),
    ]
    if doc.summary:
        blocks.append(_block("summary", "Summary", "single_text", doc.summary))
    blocks.append(
        _block(
            f"education.{doc.education.entry.entry_id}.header",
            "Education",
            "header",
            doc.education.entry.institution_and_degree,
        )
    )
    blocks.append(
        _block(
            f"education.{doc.education.entry.entry_id}.date",
            "Education",
            "date",
            doc.education.entry.date_text,
        )
    )
    for idx, bullet in enumerate(doc.education.bullets):
        blocks.append(
            _block(
                f"education.{doc.education.entry.entry_id}.bullet.{idx}",
                "Education",
                "bullet",
                bullet,
            )
        )
    for entry in doc.experience:
        blocks.append(
            _block(
                f"experience.{entry.entry_id}.header",
                "Experience",
                "header",
                entry.title_company_location,
            )
        )
        blocks.append(
            _block(f"experience.{entry.entry_id}.date", "Experience", "date", entry.date_text)
        )
        for idx, bullet in enumerate(entry.bullets):
            blocks.append(
                _block(f"experience.{entry.entry_id}.bullet.{idx}", "Experience", "bullet", bullet)
            )
    for entry in doc.projects:
        blocks.append(
            _block(f"projects.{entry.entry_id}.header", "Projects", "header", entry.project_title)
        )
        blocks.append(
            _block(f"projects.{entry.entry_id}.date", "Projects", "date", entry.date_or_link_text)
        )
        for idx, bullet in enumerate(entry.bullets):
            blocks.append(
                _block(f"projects.{entry.entry_id}.bullet.{idx}", "Projects", "bullet", bullet)
            )
    blocks.append(
        _block("skills.languages", "Technical Skills", "list", ", ".join(doc.skills.languages))
    )
    blocks.append(
        _block("skills.frameworks", "Technical Skills", "list", ", ".join(doc.skills.frameworks))
    )
    blocks.append(
        _block(
            "skills.developer_tools",
            "Technical Skills",
            "list",
            ", ".join(doc.skills.developer_tools),
        )
    )
    return blocks
