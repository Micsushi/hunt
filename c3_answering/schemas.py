from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class StrictModel(BaseModel):
    class Config:
        extra = "forbid"


class C3JobContext(StrictModel):
    title: str = ""
    company: str = ""
    description_excerpt: str = ""


class C3FieldContext(StrictModel):
    label: str = ""
    question_hash: str = ""
    required: bool = False
    kind: str = ""
    options: list[str] = Field(default_factory=list)


class C3AnswerPolicy(StrictModel):
    required_only: bool = True
    allow_generated_paragraphs: bool = False
    allow_cloud: bool = False
    confidence_threshold: float = 0.72


class C3AnswerRequest(StrictModel):
    url: str = ""
    host: str = ""
    ats: str = ""
    job: C3JobContext = Field(default_factory=C3JobContext)
    field: C3FieldContext
    profile: dict[str, Any] = Field(default_factory=dict)
    policy: C3AnswerPolicy = Field(default_factory=C3AnswerPolicy)


class C3AnswerDecision(StrictModel):
    status: Literal[
        "fillable",
        "manual_review",
        "skip",
        "provider_unavailable",
        "validation_failed",
    ]
    action: Literal["select_option", "fill_text", "skip", "manual_review"]
    canonical_field: str = ""
    selected_option: str = ""
    answer_text: str = ""
    camp: str = ""
    confidence: float = 0.0
    source_fields: list[str] = Field(default_factory=list)
    provider: str = "deterministic"
    model: str = ""
    reason: str = ""
    requires_review: bool = False
    normalized_question: str = ""


class C3LlmAnswerResponse(StrictModel):
    action: Literal["select_option", "fill_text", "skip", "manual_review"]
    canonical_field: str = ""
    selected_option: str = ""
    answer_text: str = ""
    camp: str = ""
    confidence: float = 0.0
    source_fields: list[str] = Field(default_factory=list)
    reason: str = ""


def schema_for(model: type[BaseModel]) -> dict[str, Any]:
    if hasattr(model, "model_json_schema"):
        return model.model_json_schema()  # type: ignore[attr-defined,no-any-return]
    return model.schema()  # type: ignore[no-any-return]
