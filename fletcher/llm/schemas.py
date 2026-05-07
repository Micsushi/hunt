from __future__ import annotations

from pydantic import BaseModel, Field


class StrictModel(BaseModel):
    class Config:
        extra = "forbid"


class KeywordExtractResponse(StrictModel):
    jd_usable: bool = True
    jd_usable_reason: str = ""
    keywords: list[str] = Field(default_factory=list)


class BulletRewriteResponse(StrictModel):
    bullet: str
    keywords_used: list[str] = Field(default_factory=list)
    keywords_skipped: list[str] = Field(default_factory=list)


class RewriteValidationResponse(StrictModel):
    accepted: bool
    reasons: list[str] = Field(default_factory=list)
    keywords_rejected: list[str] = Field(default_factory=list)


class SummaryResponse(StrictModel):
    summary: str
    keywords_used: list[str] = Field(default_factory=list)
    keyword_use_reason: str = ""


def schema_for(model: type[BaseModel]) -> dict:
    if hasattr(model, "model_json_schema"):
        return model.model_json_schema()  # type: ignore[attr-defined,no-any-return]
    return model.schema()
