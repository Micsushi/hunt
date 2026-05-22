from __future__ import annotations

from c3_answering.pipeline import decide_answer
from c3_answering.prompts import build_standard_question, clean_question_label
from c3_answering.schemas import C3AnswerPolicy, C3AnswerRequest
from fletcher.llm.providers.base import LLMJsonResult


def make_request(
    question: str,
    options: list[str],
    profile: dict | None = None,
    *,
    kind: str = "combobox",
):
    return C3AnswerRequest(
        url="https://careers.example.test/apply",
        host="careers.example.test",
        ats="greenhouse",
        job={"title": "Software Engineer", "company": "Hootsuite"},
        field={
            "label": question,
            "question_hash": "q_test",
            "required": True,
            "kind": kind,
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


def test_standard_question_strips_workday_validation_noise():
    label = (
        "Describe your interactions with the Workday system.* "
        "Error: The field Describe your interactions with the Workday system. "
        "is required and must have a value. "
        "primaryQuestionnaire--abb0ca13b2d2100029b6ff2864450002 textarea required"
    )

    assert clean_question_label(label) == "Describe your interactions with the Workday system.*"
    assert build_standard_question(label, []) == (
        "question: describe your interactions with the workday system.\noptions: []"
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


def test_salary_text_question_uses_profile_range_without_llm(monkeypatch):
    def fail_generate_json(**_kwargs):
        raise AssertionError("profile salary text should not call LLM")

    monkeypatch.setattr("c3_answering.pipeline.generate_json", fail_generate_json)

    decision = decide_answer(
        make_request(
            "Please indicate your desired salary range.",
            [],
            {"salaryExpectationRange": "90,000 - 105,000"},
            kind="textarea",
        )
    )

    assert decision.status == "fillable"
    assert decision.action == "fill_text"
    assert decision.answer_text == "90,000 - 105,000"
    assert decision.canonical_field == "salary_expectation"
    assert decision.source_fields == ["profile.salaryExpectationRange"]


def test_salary_text_question_uses_default_without_llm(monkeypatch):
    def fail_generate_json(**_kwargs):
        raise AssertionError("salary default should not call LLM")

    monkeypatch.setattr("c3_answering.pipeline.generate_json", fail_generate_json)

    decision = decide_answer(
        make_request(
            "Please indicate your desired salary range.",
            [],
            {"salaryExpectationRange": "", "salaryExpectation": ""},
            kind="textarea",
        )
    )

    assert decision.status == "fillable"
    assert decision.action == "fill_text"
    assert decision.answer_text == "90,000 - 105,000"
    assert decision.source_fields == ["default.salaryExpectationRange"]
    assert decision.confidence == 0.72


def test_hourly_expectation_text_question_uses_calculated_hourly_without_llm(monkeypatch):
    def fail_generate_json(**_kwargs):
        raise AssertionError("hourly expectation text should not call LLM")

    monkeypatch.setattr("c3_answering.pipeline.generate_json", fail_generate_json)

    decision = decide_answer(
        make_request(
            "What are your Hourly expectations for the Position?",
            [],
            {"salaryExpectation": "97500", "salaryExpectationRange": "90,000 - 105,000"},
            kind="text",
        )
    )

    assert decision.status == "fillable"
    assert decision.action == "fill_text"
    assert decision.answer_text == "46.88"
    assert decision.canonical_field == "salary_expectation"
    assert decision.source_fields == ["calculated.salaryExpectationHourly"]


def test_hourly_rate_text_question_uses_explicit_hourly_without_llm(monkeypatch):
    def fail_generate_json(**_kwargs):
        raise AssertionError("hourly rate text should not call LLM")

    monkeypatch.setattr("c3_answering.pipeline.generate_json", fail_generate_json)

    decision = decide_answer(
        make_request(
            "What is your expected hourly rate?",
            [],
            {"salaryExpectation": "97500", "hourlyPayExpectation": "46.88"},
            kind="text",
        )
    )

    assert decision.status == "fillable"
    assert decision.action == "fill_text"
    assert decision.answer_text == "46.88"
    assert decision.canonical_field == "salary_expectation"
    assert decision.source_fields == ["profile.hourlyPayExpectation"]


def test_accessibility_accommodation_request_defaults_no_without_llm(monkeypatch):
    def fail_generate_json(**_kwargs):
        raise AssertionError("accommodation request yes/no should not call LLM")

    monkeypatch.setattr("c3_answering.pipeline.generate_json", fail_generate_json)

    decision = decide_answer(
        make_request(
            "Do you require accessibility accommodations or adjustments?",
            [
                "Select One",
                "Yes, I will require accessibility accommodations or adjustments",
                "No, I do not require accessibility accommodations or adjustments",
            ],
        )
    )

    assert decision.status == "fillable"
    assert decision.selected_option == "No, I do not require accessibility accommodations or adjustments"
    assert decision.canonical_field == "accommodation_request"
    assert decision.source_fields == ["default.accommodationRequest"]


def test_accessibility_accommodation_request_can_use_profile_yes_without_llm(monkeypatch):
    def fail_generate_json(**_kwargs):
        raise AssertionError("accommodation request yes/no should not call LLM")

    monkeypatch.setattr("c3_answering.pipeline.generate_json", fail_generate_json)

    decision = decide_answer(
        make_request(
            "Do you require accessibility accommodations or adjustments?",
            [
                "Select One",
                "Yes, I will require accessibility accommodations or adjustments",
                "No, I do not require accessibility accommodations or adjustments",
            ],
            {"accommodationRequest": "yes"},
        )
    )

    assert decision.status == "fillable"
    assert decision.selected_option == "Yes, I will require accessibility accommodations or adjustments"
    assert decision.canonical_field == "accommodation_request"
    assert decision.source_fields == ["profile.accommodationRequest"]


def test_basic_qualification_question_defaults_yes_without_llm(monkeypatch):
    def fail_generate_json(**_kwargs):
        raise AssertionError("basic qualification yes/no should not call LLM")

    monkeypatch.setattr("c3_answering.pipeline.generate_json", fail_generate_json)

    decision = decide_answer(
        make_request(
            "Do you meet all the basic requirements/qualifications for this role?",
            ["Select One", "Yes", "No"],
        )
    )

    assert decision.status == "fillable"
    assert decision.selected_option == "Yes"
    assert decision.canonical_field == "basic_requirements_qualified"
    assert decision.source_fields == ["policy.basic_requirements_qualified"]


def test_desired_start_date_text_question_uses_profile_without_llm(monkeypatch):
    def fail_generate_json(**_kwargs):
        raise AssertionError("desired start date should not call LLM")

    monkeypatch.setattr("c3_answering.pipeline.generate_json", fail_generate_json)

    decision = decide_answer(
        make_request(
            "What date are you available to start work?",
            [],
            {"desiredStartDate": "2026-05-25"},
            kind="text",
        )
    )

    assert decision.status == "fillable"
    assert decision.action == "fill_text"
    assert decision.answer_text == "05/25/2026"
    assert decision.canonical_field == "desired_start_date"
    assert decision.source_fields == ["profile.desiredStartDate"]


def test_required_written_question_can_use_llm_when_generation_allowed(monkeypatch):
    def fake_generate_json(**_kwargs):
        return LLMJsonResult(
            provider="ollama",
            model="gemma-test",
            success=True,
            parsed={
                "action": "fill_text",
                "canonical_field": "workday_system_interaction",
                "selected_option": "",
                "answer_text": "I have used Workday as an applicant and am comfortable navigating Workday workflows, forms, and related business-system interactions.",
                "camp": "profile_value",
                "confidence": 0.78,
                "source_fields": ["profile.skills", "job.title"],
                "reason": "The written question asks for a short free-response answer and generation is allowed.",
            },
        )

    monkeypatch.setattr("c3_answering.pipeline.generate_json", fake_generate_json)

    request = make_request(
        "Describe your interactions with the Workday system.",
        [],
        {"skills": ["Python", "React"]},
        kind="textarea",
    )
    request.policy = C3AnswerPolicy(allow_generated_paragraphs=True)
    decision = decide_answer(request)

    assert decision.status == "fillable"
    assert decision.action == "fill_text"
    assert "Workday" in decision.answer_text
    assert decision.provider == "ollama"


def test_written_question_repairs_unparsed_llm_response(monkeypatch):
    calls = []

    def fake_generate_json(**kwargs):
        calls.append(kwargs["task_name"])
        if len(calls) == 1:
            return LLMJsonResult(
                provider="ollama",
                model="gemma-test",
                success=False,
                parsed=None,
                error="provider returned no parsed JSON",
            )
        return LLMJsonResult(
            provider="ollama",
            model="gemma-test",
            success=True,
            parsed={
                "action": "fill_text",
                "canonical_field": "workday_system_interaction",
                "selected_option": "",
                "answer_text": "I have used Workday as an applicant and can navigate Workday forms and workflows confidently.",
                "camp": "profile_value",
                "confidence": 0.78,
                "source_fields": ["profile.skills", "job.title"],
                "reason": "Repair returned valid JSON for the written question.",
            },
        )

    monkeypatch.setattr("c3_answering.pipeline.generate_json", fake_generate_json)

    request = make_request(
        "Describe your interactions with the Workday system.",
        [],
        {"skills": ["React"]},
        kind="textarea",
    )
    request.policy = C3AnswerPolicy(allow_generated_paragraphs=True)
    decision = decide_answer(request)

    assert calls == ["c3_answer_decision", "c3_answer_decision_repair"]
    assert decision.status == "fillable"
    assert decision.action == "fill_text"


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
