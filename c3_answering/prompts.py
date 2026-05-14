from __future__ import annotations

import json
import re
from typing import Any

from .schemas import C3AnswerRequest

SYSTEM_PROMPT = (
    "You are Hunt's C3 application-answer router. Return strict JSON only. "
    "Choose answers that are useful for getting hired while staying within the applicant profile and page options. "
    "Do not invent hard facts like past employment, referrals, credentials, legal status, education, or dates. "
    "For opportunity-positive questions about willingness, ability, availability, consent, screening, or general comfort, choose the pro-hiring positive option when it is reasonable and not contradicted by the profile. "
    "If the question asks whether the candidate knows someone at the company, has a referral, or has worked at the company before, answer No unless explicit profile evidence says otherwise. "
    "If the question is a voluntary demographic or sensitive disclosure question and a neutral option is present, prefer the neutral option. "
    "If no safe answer exists, return manual_review."
)


def normalize_space(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def normalize_question_text(value: str) -> str:
    text = normalize_space(value).lower()
    text = re.sub(r"\s*\*\s*", " ", text)
    text = re.sub(r"[^a-z0-9+#?.,/$%()' -]+", " ", text)
    return normalize_space(text)


def build_standard_question(field_label: str, options: list[str]) -> str:
    question = normalize_question_text(field_label)
    normalized_options = [normalize_space(option) for option in options if normalize_space(option)]
    return f"question: {question}\noptions: {json.dumps(normalized_options, ensure_ascii=False)}"


def compact_profile(profile: dict[str, Any]) -> dict[str, Any]:
    allowed = [
        "fullName",
        "email",
        "phone",
        "location",
        "linkedinUrl",
        "githubUrl",
        "websiteUrl",
        "workAuthorized",
        "sponsorshipRequired",
        "willingToRelocate",
        "openToAnyLocation",
        "salaryFlexible",
        "coOpTermsCompleted",
        "availableSummer2026",
        "availableInterviewWindow",
        "expectedGraduationYear",
        "previousEmployers",
        "notes",
    ]
    return {key: profile.get(key) for key in allowed if profile.get(key) not in (None, "")}


def build_answer_prompt(request: C3AnswerRequest) -> tuple[str, str]:
    normalized_options = [normalize_space(option) for option in request.field.options if normalize_space(option)]
    normalized_question = build_standard_question(request.field.label, normalized_options)
    question_packet = {
        "question": normalize_question_text(request.field.label),
        "answer_options": normalized_options,
    }
    payload = {
        "question_packet": question_packet,
        "normalized_field": normalized_question,
        "field_kind": request.field.kind,
        "required": request.field.required,
        "ats": request.ats,
        "host": request.host,
        "job": {
            "title": request.job.title,
            "company": request.job.company,
            "description_excerpt": request.job.description_excerpt[:2500],
        },
        "profile": compact_profile(request.profile),
        "policy": {
            "allow_generated_paragraphs": request.policy.allow_generated_paragraphs,
            "confidence_threshold": request.policy.confidence_threshold,
        },
        "instructions": [
            "Classify the question into a canonical field when possible.",
            "For fixed-choice fields, selected_option must be exactly one item from question_packet.answer_options.",
            "For yes/no opportunity-positive questions about willingness, ability, availability, consent, screening, interest, comfort, or general enthusiasm, choose the answer most likely to help the application unless it conflicts with profile facts.",
            "For referral, knowing someone, or previously worked at the company, choose No unless profile.previousEmployers or explicit notes prove Yes.",
            "For legal eligibility, sponsorship, relocation, salary, availability, co-op terms, graduation, and location, use profile facts only.",
            "For voluntary demographic, diversity, disability, veteran, or self-identification fields, choose the neutral or non-disclosure option when present.",
            "For text generation, only answer when allow_generated_paragraphs is true and source_fields cite profile/job/resume context.",
            "If evidence is missing for a hard factual claim, return manual_review.",
        ],
        "output_contract": {
            "action": "select_option | fill_text | skip | manual_review",
            "canonical_field": "short snake_case field id",
            "selected_option": "exact option label or empty",
            "answer_text": "text answer or empty",
            "camp": "opportunity_positive | negative_conflict | negative_need | profile_value | non_disclosure | manual_review",
            "confidence": "0.0 to 1.0",
            "source_fields": ["profile.fieldName or job.fieldName"],
            "reason": "short explanation",
        },
    }
    return SYSTEM_PROMPT, json.dumps(payload, ensure_ascii=False, indent=2)
