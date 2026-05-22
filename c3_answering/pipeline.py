from __future__ import annotations

import re
import urllib.request
from dataclasses import dataclass
from typing import Any

from fletcher import config as fletcher_config
from fletcher.llm.client import generate_json

from .prompts import build_answer_prompt, build_standard_question, normalize_question_text
from .schemas import (
    C3AnswerDecision,
    C3AnswerRequest,
    C3LlmAnswerResponse,
    schema_for,
)


def _norm(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip().lower()


def _norm_option(value: Any) -> str:
    text = _norm(value)
    return re.sub(r"[^a-z0-9]+", " ", text).strip()


PLACEHOLDER_OPTIONS = {
    "",
    "select",
    "select one",
    "select an option",
    "choose",
    "choose one",
    "choose an option",
    "please select",
    "please select one",
    "none selected",
}


NEUTRAL_OPTION_PATTERNS = (
    "prefer not to disclose",
    "i choose not to disclose",
    "choose not to disclose",
    "do not wish to disclose",
    "do not wish to self identify",
    "do not wi h to self identify",
    "do not wi h to elf identify",
    "decline to answer",
    "decline to self identify",
    "prefer not to answer",
    "prefer not to respond",
    "prefer not to re pond",
    "not disclosed",
    "not applicable",
    "n/a",
    "none of the above",
)


SENSITIVE_DISCLOSURE_PATTERNS = (
    "gender",
    "sexual orientation",
    "trans experience",
    "lesbian",
    "gay",
    "bisexual",
    "queer",
    "disabil",
    "visible minorit",
    "racial",
    "ethnic",
    "indigenous",
    "aboriginal",
    "veteran",
    "diversity",
    "self-identif",
    "designated group",
    "demographic",
)


def _is_placeholder_option(option: str) -> bool:
    normalized = _norm_option(option)
    return normalized in PLACEHOLDER_OPTIONS


def _real_options(options: list[str]) -> list[str]:
    seen: set[str] = set()
    real: list[str] = []
    for option in options:
        text = re.sub(r"\s+", " ", str(option or "")).strip()
        key = _norm_option(text)
        if not text or _is_placeholder_option(text) or key in seen:
            continue
        seen.add(key)
        real.append(text)
    return real


def _exact_option(options: list[str], selected: str) -> str:
    target = _norm_option(selected)
    if not target:
        return ""
    for option in _real_options(options):
        if _norm_option(option) == target:
            return option
    return ""


def _neutral_option(options: list[str]) -> str:
    real_options = _real_options(options)
    for pattern in NEUTRAL_OPTION_PATTERNS:
        pattern_norm = _norm_option(pattern)
        for option in real_options:
            option_norm = _norm_option(option)
            if option_norm == pattern_norm or pattern_norm in option_norm:
                return option
    return ""


def _question_has_any(question: str, patterns: tuple[str, ...]) -> bool:
    return any(pattern in question for pattern in patterns)


def _truthy(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    text = _norm(value)
    if text in {"1", "true", "yes", "y", "on"}:
        return True
    if text in {"0", "false", "no", "n", "off"}:
        return False
    return None


def _matching_option(options: list[str], target: str, aliases: list[str] | None = None) -> str:
    aliases = aliases or []
    candidates = [target, *aliases]
    normalized_options = [(_norm(option), option) for option in _real_options(options)]
    for candidate in candidates:
        normalized_candidate = _norm(candidate)
        if not normalized_candidate:
            continue
        for normalized_option, original in normalized_options:
            if normalized_option == normalized_candidate:
                return original
        for normalized_option, original in normalized_options:
            if (
                normalized_candidate in normalized_option
                or normalized_option in normalized_candidate
            ):
                return original
    return ""


def _yes_no(options: list[str], value: bool | None) -> str:
    if value is None:
        return ""
    return _matching_option(options, "Yes" if value else "No")


def _source_decision(
    request: C3AnswerRequest,
    *,
    canonical_field: str,
    option: str,
    source_field: str,
    reason: str,
    confidence: float = 0.95,
    camp: str = "",
) -> C3AnswerDecision:
    normalized_question = build_standard_question(request.field.label, request.field.options)
    return C3AnswerDecision(
        status="fillable",
        action="select_option",
        canonical_field=canonical_field,
        selected_option=option,
        camp=camp,
        confidence=confidence,
        source_fields=[source_field],
        provider="deterministic",
        reason=reason,
        normalized_question=normalized_question,
    )


def _text_decision(
    request: C3AnswerRequest,
    *,
    canonical_field: str,
    answer_text: str,
    source_field: str,
    reason: str,
    confidence: float = 0.95,
    camp: str = "",
) -> C3AnswerDecision:
    normalized_question = build_standard_question(request.field.label, request.field.options)
    return C3AnswerDecision(
        status="fillable",
        action="fill_text",
        canonical_field=canonical_field,
        answer_text=answer_text,
        camp=camp,
        confidence=confidence,
        source_fields=[source_field],
        provider="deterministic",
        reason=reason,
        normalized_question=normalized_question,
    )


def _manual(
    request: C3AnswerRequest, reason: str, provider: str = "deterministic"
) -> C3AnswerDecision:
    return C3AnswerDecision(
        status="manual_review",
        action="manual_review",
        confidence=0.0,
        provider=provider,
        reason=reason,
        requires_review=True,
        normalized_question=build_standard_question(request.field.label, request.field.options),
    )


def _location_aliases(location: str) -> list[str]:
    raw = _norm(location)
    if not raw:
        return []
    aliases = [raw]
    city = raw.split(",", 1)[0].strip()
    if city:
        aliases.append(city)
    province_map = {
        "ab": "alberta",
        "alberta": "alberta",
        "bc": "british columbia",
        "british columbia": "british columbia",
        "on": "ontario",
        "ontario": "ontario",
    }
    for piece in re.split(r"[,\s/]+", raw):
        mapped = province_map.get(piece)
        if mapped:
            aliases.append(mapped)
    aliases.extend(["canada", "elsewhere in canada", "other"])
    return aliases


def _date_value(profile: dict[str, Any], key: str, default: str) -> tuple[str, str, float]:
    raw = str(profile.get(key) or "").strip()
    source = f"profile.{key}"
    confidence = 0.95
    if not raw:
        raw = default
        source = f"default.{key}"
        confidence = 0.72
    iso = re.match(r"^(\d{4})-(\d{1,2})-(\d{1,2})$", raw)
    if iso:
        return (
            f"{iso.group(2).zfill(2)}/{iso.group(3).zfill(2)}/{iso.group(1)}",
            source,
            confidence,
        )
    slash = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{4})$", raw)
    if slash:
        return (
            f"{slash.group(1).zfill(2)}/{slash.group(2).zfill(2)}/{slash.group(3)}",
            source,
            confidence,
        )
    return raw, source, confidence


def _salary_point(value: Any) -> float | None:
    numbers = [
        float(match.replace(",", ""))
        for match in re.findall(r"\d[\d,]*(?:\.\d+)?", str(value or ""))
    ]
    numbers = [number for number in numbers if number >= 1000]
    if not numbers:
        return None
    if len(numbers) >= 2:
        return (numbers[0] + numbers[1]) / 2
    return numbers[0]


def _hourly_compensation_value(profile: dict[str, Any]) -> tuple[str, str, float]:
    hourly = str(profile.get("hourlyPayExpectation") or "").strip()
    if hourly:
        return hourly, "profile.hourlyPayExpectation", 0.97
    annual = _salary_point(profile.get("salaryExpectation"))
    if annual:
        return f"{annual / 2080:.2f}", "calculated.salaryExpectationHourly", 0.94
    annual_range = _salary_point(profile.get("salaryExpectationRange"))
    if annual_range:
        return f"{annual_range / 2080:.2f}", "calculated.salaryExpectationRangeHourly", 0.9
    return "48.08", "default.hourlyPayExpectation", 0.72


def deterministic_decision(request: C3AnswerRequest) -> C3AnswerDecision | None:
    question = normalize_question_text(request.field.label)
    options = _real_options(request.field.options)
    profile = request.profile
    if not options and (
        "available to start" in question
        or "available start date" in question
        or "desired start date" in question
        or "date are you available to start work" in question
    ):
        answer, source, confidence = _date_value(profile, "desiredStartDate", "2026-05-25")
        return _text_decision(
            request,
            canonical_field="desired_start_date",
            answer_text=answer,
            source_field=source,
            reason="Question asks for desired start date and C3 has a profile/default date.",
            confidence=confidence,
            camp="profile_value",
        )
    compensation_question = (
        "salary" in question
        or "compensation" in question
        or "hourly expectation" in question
        or "hourly expectations" in question
        or "hourly pay" in question
        or "hourly rate" in question
        or "hourly wage" in question
        or "wage expectation" in question
        or "wage expectations" in question
        or "pay expectation" in question
        or "pay expectations" in question
    )
    if compensation_question and not options:
        asks_hourly_amount = "hourly" in question or "wage" in question
        if asks_hourly_amount:
            answer, source, confidence = _hourly_compensation_value(profile)
            return _text_decision(
                request,
                canonical_field="salary_expectation",
                answer_text=answer,
                source_field=source,
                reason="Question asks for an hourly compensation value and C3 calculated hourly pay from the profile annual salary.",
                confidence=confidence,
                camp="profile_value",
            )
        salary_range = str(profile.get("salaryExpectationRange") or "").strip()
        salary_point = str(profile.get("salaryExpectation") or "").strip()
        asks_annual_amount = (
            "annual" in question
            or "yearly" in question
            or "amount" in question
            or bool(re.search(r"\be\.g\.\s*\d+", question))
        )
        asks_point_amount = asks_annual_amount
        if asks_point_amount and salary_point:
            return _text_decision(
                request,
                canonical_field="salary_expectation",
                answer_text=salary_point,
                source_field="profile.salaryExpectation",
                reason="Question asks for a salary amount and profile has a salary expectation.",
                camp="profile_value",
            )
        if salary_range or salary_point:
            return _text_decision(
                request,
                canonical_field="salary_expectation",
                answer_text=salary_range or salary_point,
                source_field=(
                    "profile.salaryExpectationRange"
                    if salary_range
                    else "profile.salaryExpectation"
                ),
                reason="Question asks for salary expectation and profile has a salary value.",
                camp="profile_value",
            )
        return _text_decision(
            request,
            canonical_field="salary_expectation",
            answer_text="95000" if asks_point_amount else "90,000 - 105,000",
            source_field=(
                "default.salaryExpectation"
                if asks_point_amount
                else "default.salaryExpectationRange"
            ),
            reason="Question asks for salary expectation and profile salary fields are blank: use the C3 salary default.",
            confidence=0.72,
            camp="profile_value",
        )
    if not options:
        return None

    accommodation_request_question = (
        ("accommodation" in question or "adjustment" in question or "support" in question)
        and ("require" in question or "need" in question or "selecting yes" in question)
    )
    if accommodation_request_question:
        profile_value = _truthy(profile.get("accommodationRequest"))
        requested = profile_value if profile_value is not None else False
        option = _yes_no(options, requested)
        if option:
            return _source_decision(
                request,
                canonical_field="accommodation_request",
                option=option,
                source_field=(
                    "profile.accommodationRequest"
                    if profile_value is not None
                    else "default.accommodationRequest"
                ),
                reason="Accessibility accommodation request comes from profile when set; blank profile defaults to No for required yes/no application prompts.",
                confidence=0.95 if profile_value is not None else 0.72,
                camp="profile_value" if profile_value is not None else "negative_conflict",
            )

    if _question_has_any(question, SENSITIVE_DISCLOSURE_PATTERNS):
        option = _neutral_option(options)
        if option:
            return _source_decision(
                request,
                canonical_field="voluntary_disclosure",
                option=option,
                source_field="policy.neutral_disclosure",
                reason="Sensitive disclosure question with a neutral option: choose non-disclosure before LLM fallback.",
                camp="non_disclosure",
            )

    previous_company_question = (
        "previously worked at" in question
        or "worked at this company" in question
        or "worked at " in question
        or "previously been employed" in question
        or "previously employed" in question
        or "previous employment" in question
    )
    referral_question = (
        "know anyone" in question
        or "referral" in question
        or "referred by" in question
        or "employee referral" in question
        or "family member" in question
        or "relative" in question
        or "domestic partner" in question
        or "ernst & young" in question
        or "ernst and young" in question
        or "deloitte" in question
    )
    if previous_company_question or referral_question:
        previous = _norm(profile.get("previousEmployers"))
        company = _norm(request.job.company)
        answer = bool(previous and company and company in previous and previous_company_question)
        option = _yes_no(options, answer)
        if option:
            return _source_decision(
                request,
                canonical_field="previous_company_or_referral",
                option=option,
                source_field="profile.previousEmployers",
                reason="Company/referral questions default to No unless explicit profile evidence says Yes.",
                camp="negative_conflict",
            )

    basic_requirements_question = (
        ("basic" in question or "minimum" in question or "required" in question)
        and ("requirement" in question or "qualification" in question)
        and ("meet" in question or "satisfy" in question)
    )
    if basic_requirements_question:
        option = _yes_no(options, True)
        if option:
            return _source_decision(
                request,
                canonical_field="basic_requirements_qualified",
                option=option,
                source_field="policy.basic_requirements_qualified",
                reason="Basic/minimum qualification questions default to Yes unless explicit profile evidence says otherwise.",
                camp="opportunity_positive",
            )

    if (
        "legally" in question
        or "eligible to work" in question
        or "authorized" in question
        or "work authorization" in question
        or "legal right to work" in question
        or "proof of your legal right to work" in question
    ):
        option = _yes_no(options, _truthy(profile.get("workAuthorized")))
        if option:
            return _source_decision(
                request,
                canonical_field="work_authorized",
                option=option,
                source_field="profile.workAuthorized",
                reason="Question asks work authorization and profile has a work authorization setting.",
                camp="opportunity_positive",
            )
    if "sponsor" in question or "visa support" in question or "work permit sponsorship" in question:
        option = _yes_no(options, _truthy(profile.get("sponsorshipRequired")))
        if option:
            return _source_decision(
                request,
                canonical_field="sponsorship_required",
                option=option,
                source_field="profile.sponsorshipRequired",
                reason="Question asks about sponsorship and profile has a sponsorship setting.",
                camp="negative_need",
            )
    if "relocat" in question:
        option = _yes_no(options, _truthy(profile.get("willingToRelocate")))
        if option:
            return _source_decision(
                request,
                canonical_field="willing_to_relocate",
                option=option,
                source_field="profile.willingToRelocate",
                reason="Question asks relocation and profile has a relocation setting.",
                camp="profile_value",
            )
    if compensation_question:
        option = _yes_no(options, _truthy(profile.get("salaryFlexible")))
        if option:
            return _source_decision(
                request,
                canonical_field="salary_comfort",
                option=option,
                source_field="profile.salaryFlexible",
                reason="Question asks salary comfort and profile has a salary flexibility setting.",
                camp="profile_value",
            )
    if "co-op" in question or "coop" in question:
        terms = str(profile.get("coOpTermsCompleted") or "").strip()
        option = _matching_option(options, terms, [f"{terms} terms", f"{terms} term"])
        if option:
            return _source_decision(
                request,
                canonical_field="co_op_terms_completed",
                option=option,
                source_field="profile.coOpTermsCompleted",
                reason="Question asks co-op terms and profile has the completed term count.",
                camp="profile_value",
            )
    if "graduation" in question:
        year = str(profile.get("expectedGraduationYear") or "").strip()
        option = _matching_option(options, year, [f"graduated before {year}"])
        if option:
            return _source_decision(
                request,
                canonical_field="expected_graduation_year",
                option=option,
                source_field="profile.expectedGraduationYear",
                reason="Question asks graduation and profile has expected graduation year.",
                camp="profile_value",
            )
    if "interview" in question and "available" in question:
        option = _yes_no(options, _truthy(profile.get("availableInterviewWindow")))
        if option:
            return _source_decision(
                request,
                canonical_field="available_interview_window",
                option=option,
                source_field="profile.availableInterviewWindow",
                reason="Question asks interview availability and profile has that availability setting.",
                camp="profile_value",
            )
    if "summer 2026" in question or "available for the summer" in question:
        option = _yes_no(options, _truthy(profile.get("availableSummer2026")))
        if option:
            return _source_decision(
                request,
                canonical_field="available_summer_2026",
                option=option,
                source_field="profile.availableSummer2026",
                reason="Question asks Summer 2026 availability and profile has that availability setting.",
                camp="profile_value",
            )
    if ("city" in question or "located" in question or "location" in question) and not (
        "eligible to work" in question or "authorized" in question
    ):
        location = str(profile.get("location") or "").strip()
        option = _matching_option(options, location, _location_aliases(location))
        if option:
            return _source_decision(
                request,
                canonical_field="location",
                option=option,
                source_field="profile.location",
                reason="Question asks location and profile has a location.",
                camp="profile_value",
            )

    opportunity_positive_question = any(
        phrase in question
        for phrase in (
            "are you willing",
            "would you be willing",
            "are you able",
            "can you",
            "could you",
            "comfortable with",
            "agree to",
            "consent to",
            "comply with",
            "background check",
            "background screening",
            "criminal record check",
            "credit check",
            "obtain clearance",
            "obtain security clearance",
            "meet the requirements",
            "available to",
        )
    )
    if opportunity_positive_question:
        option = _yes_no(options, True)
        if option:
            return _source_decision(
                request,
                canonical_field="opportunity_positive",
                option=option,
                source_field="policy.pro_applicant_default",
                reason="Opportunity-positive question: choose Yes for willingness, ability, availability, consent, or screening when no conflict pattern applies.",
                confidence=0.82,
                camp="opportunity_positive",
            )

    preference_question = any(
        phrase in question
        for phrase in (
            "do you like",
            "are you interested",
            "comfortable with",
            "willing to use",
            "excited about",
            "enjoy",
        )
    )
    if preference_question:
        option = _yes_no(options, True)
        if option:
            return _source_decision(
                request,
                canonical_field="preference_or_interest",
                option=option,
                source_field="policy.pro_hiring_preference",
                reason="Preference question: choose the positive pro-hiring answer when it does not invent a hard fact.",
                confidence=0.78,
                camp="opportunity_positive",
            )

    return None


def _validate_decision(
    request: C3AnswerRequest,
    parsed: dict[str, Any],
    *,
    provider: str,
    model: str,
) -> C3AnswerDecision:
    try:
        response = C3LlmAnswerResponse.model_validate(parsed)  # type: ignore[attr-defined]
    except AttributeError:
        response = C3LlmAnswerResponse.parse_obj(parsed)
    except Exception as exc:
        decision = _manual(request, f"LLM response failed schema validation: {exc}", provider)
        decision.status = "validation_failed"
        return decision

    normalized_question = build_standard_question(request.field.label, request.field.options)
    if response.action == "select_option":
        option = _exact_option(request.field.options, response.selected_option)
        if not option:
            return C3AnswerDecision(
                status="validation_failed",
                action="manual_review",
                canonical_field=response.canonical_field,
                confidence=response.confidence,
                source_fields=response.source_fields,
                camp=response.camp,
                provider=provider,
                model=model,
                reason="LLM selected option did not exactly match one non-placeholder page option.",
                requires_review=True,
                normalized_question=normalized_question,
            )
        if response.confidence < request.policy.confidence_threshold:
            return C3AnswerDecision(
                status="manual_review",
                action="manual_review",
                canonical_field=response.canonical_field,
                selected_option=option,
                camp=response.camp,
                confidence=response.confidence,
                source_fields=response.source_fields,
                provider=provider,
                model=model,
                reason=response.reason or "LLM confidence below threshold.",
                requires_review=True,
                normalized_question=normalized_question,
            )
        return C3AnswerDecision(
            status="fillable",
            action="select_option",
            canonical_field=response.canonical_field,
            selected_option=option,
            camp=response.camp,
            confidence=response.confidence,
            source_fields=response.source_fields,
            provider=provider,
            model=model,
            reason=response.reason,
            normalized_question=normalized_question,
        )
    if response.action == "fill_text" and request.policy.allow_generated_paragraphs:
        return C3AnswerDecision(
            status="fillable",
            action="fill_text",
            canonical_field=response.canonical_field,
            answer_text=response.answer_text,
            camp=response.camp,
            confidence=response.confidence,
            source_fields=response.source_fields,
            provider=provider,
            model=model,
            reason=response.reason,
            normalized_question=normalized_question,
        )
    return _manual(request, response.reason or "LLM returned non-fill action.", provider)


def decide_answer(request: C3AnswerRequest) -> C3AnswerDecision:
    deterministic = deterministic_decision(request)
    if deterministic:
        return deterministic

    system, user = build_answer_prompt(request)
    try:
        result = generate_json(
            component="c3",
            task_name="c3_answer_decision",
            system=system,
            user=user,
            schema=schema_for(C3LlmAnswerResponse),
            schema_model=C3LlmAnswerResponse,
            temperature=0.1,
            timeout_sec=30,
        )
    except Exception as exc:
        return C3AnswerDecision(
            status="provider_unavailable",
            action="manual_review",
            provider=fletcher_config.c3_llm_provider(),
            reason=str(exc),
            requires_review=True,
            normalized_question=build_standard_question(request.field.label, request.field.options),
        )
    if not result.success or not result.parsed:
        repair_user = (
            user
            + "\n\nPrevious model output was not parseable as the required JSON schema. "
            + "Return exactly one JSON object matching output_contract. No markdown, no prose."
        )
        try:
            repaired = generate_json(
                component="c3",
                task_name="c3_answer_decision_repair",
                system=system,
                user=repair_user,
                schema=schema_for(C3LlmAnswerResponse),
                schema_model=C3LlmAnswerResponse,
                temperature=0,
                timeout_sec=30,
            )
        except Exception as exc:
            return C3AnswerDecision(
                status="provider_unavailable",
                action="manual_review",
                provider=result.provider or fletcher_config.c3_llm_provider(),
                model=result.model,
                reason=str(exc),
                requires_review=True,
                normalized_question=build_standard_question(request.field.label, request.field.options),
            )
        if not repaired.success or not repaired.parsed:
            return C3AnswerDecision(
                status="provider_unavailable",
                action="manual_review",
                provider=repaired.provider or result.provider,
                model=repaired.model or result.model,
                reason=repaired.error or result.error or "LLM provider returned no parsed JSON.",
                requires_review=True,
                normalized_question=build_standard_question(request.field.label, request.field.options),
            )
        result = repaired
    return _validate_decision(
        request,
        result.parsed,
        provider=result.provider,
        model=result.model,
    )


@dataclass(frozen=True)
class ProviderStatus:
    provider: str
    model: str
    cloud: bool
    cloud_confirmed: bool
    ready: bool
    reason: str = ""


def provider_status() -> ProviderStatus:
    provider = fletcher_config.c3_llm_provider()
    model = (
        fletcher_config.c3_llm_model("c3_answer_decision") or fletcher_config.ollama_model_name()
    )
    cloud = provider in {"openai", "openrouter", "anthropic", "gemini", "codex"}
    cloud_confirmed = fletcher_config.c3_cloud_llm_confirmed()
    if cloud and not cloud_confirmed:
        return ProviderStatus(
            provider=provider,
            model=model,
            cloud=cloud,
            cloud_confirmed=cloud_confirmed,
            ready=False,
            reason="Cloud provider is configured but cloud LLM confirmation is disabled.",
        )
    if provider == "ollama":
        try:
            with urllib.request.urlopen(
                f"{fletcher_config.ollama_host()}/api/tags",
                timeout=min(5.0, fletcher_config.ollama_timeout_sec()),
            ):
                pass
        except Exception as exc:
            return ProviderStatus(
                provider=provider,
                model=model,
                cloud=False,
                cloud_confirmed=cloud_confirmed,
                ready=False,
                reason=f"Ollama is configured but not reachable: {exc}",
            )
    return ProviderStatus(
        provider=provider,
        model=model,
        cloud=cloud,
        cloud_confirmed=cloud_confirmed,
        ready=provider != "heuristic",
        reason="" if provider != "heuristic" else "Heuristic provider has no LLM fallback.",
    )
