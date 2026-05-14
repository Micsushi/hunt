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
    referral = decide_answer(make_request("Do you know anyone at Hootsuite?", ["Yes", "No"]))
    previous = decide_answer(
        make_request("Have you previously worked at Hootsuite?", ["Yes", "No"])
    )

    assert referral.selected_option == "No"
    assert previous.selected_option == "No"
    assert referral.camp == "negative_conflict"
    assert previous.camp == "negative_conflict"


def test_neutral_disclosure_shortcut_skips_llm(monkeypatch):
    def fail_generate_json(**_kwargs):
        raise AssertionError("neutral disclosure should not call LLM")

    monkeypatch.setattr("c3_answering.pipeline.generate_json", fail_generate_json)

    decision = decide_answer(
        make_request(
            "Please indicate your veteran status.",
            ["Select One", "Yes", "No", "I choose not to disclose"],
        )
    )

    assert decision.status == "fillable"
    assert decision.selected_option == "I choose not to disclose"
    assert decision.camp == "non_disclosure"


def test_neutral_disclosure_handles_workday_self_identify_text(monkeypatch):
    def fail_generate_json(**_kwargs):
        raise AssertionError("self-identify non-disclosure should not call LLM")

    monkeypatch.setattr("c3_answering.pipeline.generate_json", fail_generate_json)

    decision = decide_answer(
        make_request(
            "Gender",
            ["Select One", "Female", "Male", "I do not wi h to elf-identify"],
        )
    )

    assert decision.status == "fillable"
    assert decision.selected_option == "I do not wi h to elf-identify"
    assert decision.camp == "non_disclosure"


def test_disclosure_other_is_not_treated_as_neutral(monkeypatch):
    def fake_generate_json(**_kwargs):
        return LLMJsonResult(
            provider="ollama",
            model="gemma-test",
            success=True,
            parsed={
                "action": "requires_review",
                "canonical_field": "voluntary_disclosure",
                "selected_option": "",
                "answer_text": "",
                "camp": "non_disclosure",
                "confidence": 0.1,
                "source_fields": ["policy.neutral_disclosure"],
                "reason": "No true non-disclosure option is available.",
            },
        )

    monkeypatch.setattr("c3_answering.pipeline.generate_json", fake_generate_json)

    decision = decide_answer(
        make_request(
            "Please indicate your gender.",
            ["Select One", "Woman", "Man", "Non-binary", "Other"],
        )
    )

    assert decision.status == "validation_failed"
    assert decision.selected_option == ""


def test_opportunity_positive_defaults_to_yes_after_placeholder_filtering():
    decision = decide_answer(
        make_request(
            "Can you comply with all background screening requirements?",
            ["Select One", "Yes", "No"],
        )
    )

    assert decision.status == "fillable"
    assert decision.selected_option == "Yes"
    assert decision.camp == "opportunity_positive"


def test_profile_specific_relocation_wins_before_opportunity_positive():
    decision = decide_answer(
        make_request(
            "Are you willing to relocate for this role?",
            ["Select One", "Yes", "No"],
            {"willingToRelocate": False},
        )
    )

    assert decision.status == "fillable"
    assert decision.selected_option == "No"
    assert decision.canonical_field == "willing_to_relocate"
    assert decision.source_fields == ["profile.willingToRelocate"]


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
                "camp": "profile_value",
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
    assert decision.camp == "profile_value"


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
                "camp": "profile_value",
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


def test_llm_option_substring_is_rejected_by_exact_d_check(monkeypatch):
    def fake_generate_json(**_kwargs):
        return LLMJsonResult(
            provider="ollama",
            model="gemma-test",
            success=True,
            parsed={
                "action": "select_option",
                "canonical_field": "work_style_preference",
                "selected_option": "Yes",
                "answer_text": "",
                "camp": "opportunity_positive",
                "confidence": 0.91,
                "source_fields": ["policy.pro_applicant_default"],
                "reason": "Looks useful.",
            },
        )

    monkeypatch.setattr("c3_answering.pipeline.generate_json", fake_generate_json)

    decision = decide_answer(
        make_request(
            "Which proof document applies to this application?",
            ["Yes, I am a citizen or permanent resident of Canada", "No"],
        )
    )

    assert decision.status == "validation_failed"
    assert decision.requires_review is True
