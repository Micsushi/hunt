from __future__ import annotations

from c3_answering.pipeline import decide_answer
from c3_answering.prompts import build_standard_question
from c3_answering.schemas import C3AnswerRequest
from fletcher.llm.providers.base import LLMJsonResult


def make_request(question: str, options: list[str], profile: dict | None = None):
    return C3AnswerRequest(
        url="https://careers.example.test/apply",
        host="careers.example.test",
        ats="greenhouse",
        job={"title": "Software Engineer", "company": "Hootsuite"},
        field={
            "label": question,
            "question_hash": "q_test",
            "required": True,
            "kind": "combobox",
            "options": options,
        },
        profile={
            "location": "Edmonton, AB",
            "workAuthorized": True,
            "salaryFlexible": True,
            "previousEmployers": "",
            **(profile or {}),
        },
    )


def test_standard_question_format_is_stable():
    assert build_standard_question("  Do you like Python? * ", [" Yes ", "No"]) == (
        'question: do you like python?\noptions: ["Yes", "No"]'
    )


def test_preference_question_defaults_to_positive_pro_hiring_answer():
    decision = decide_answer(make_request("Do you like Python?", ["Yes", "No"]))

    assert decision.status == "fillable"
    assert decision.selected_option == "Yes"
    assert decision.canonical_field == "preference_or_interest"
    assert decision.source_fields == ["policy.pro_hiring_preference"]


def test_referral_and_previous_company_questions_default_to_no():
    referral = decide_answer(
        make_request("Do you know anyone at Hootsuite?", ["Yes", "No"])
    )
    previous = decide_answer(
        make_request("Have you previously worked at Hootsuite?", ["Yes", "No"])
    )

    assert referral.selected_option == "No"
    assert previous.selected_option == "No"


def test_llm_fallback_uses_schema_and_validates_exact_option(monkeypatch):
    def fake_generate_json(**_kwargs):
        return LLMJsonResult(
            provider="ollama",
            model="gemma-test",
            success=True,
            parsed={
                "action": "select_option",
                "canonical_field": "work_style_preference",
                "selected_option": "Hybrid",
                "answer_text": "",
                "confidence": 0.91,
                "source_fields": ["profile.notes"],
                "reason": "Profile notes support hybrid preference.",
            },
        )

    monkeypatch.setattr("c3_answering.pipeline.generate_json", fake_generate_json)

    decision = decide_answer(
        make_request(
            "Which work arrangement do you prefer?",
            ["Remote", "Hybrid", "On-site"],
            {"notes": "Hybrid is preferred when available."},
        )
    )

    assert decision.status == "fillable"
    assert decision.provider == "ollama"
    assert decision.model == "gemma-test"
    assert decision.selected_option == "Hybrid"


def test_llm_option_not_on_page_fails_validation(monkeypatch):
    def fake_generate_json(**_kwargs):
        return LLMJsonResult(
            provider="ollama",
            model="gemma-test",
            success=True,
            parsed={
                "action": "select_option",
                "canonical_field": "work_style_preference",
                "selected_option": "Flexible",
                "answer_text": "",
                "confidence": 0.91,
                "source_fields": ["profile.notes"],
                "reason": "Looks useful.",
            },
        )

    monkeypatch.setattr("c3_answering.pipeline.generate_json", fake_generate_json)

    decision = decide_answer(
        make_request(
            "Which work arrangement do you prefer?",
            ["Remote", "Hybrid", "On-site"],
            {"notes": "Hybrid is preferred when available."},
        )
    )

    assert decision.status == "validation_failed"
    assert decision.requires_review is True

