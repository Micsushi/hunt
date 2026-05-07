from __future__ import annotations

from fletcher.llm.llm_enrich import (
    categorize_keyword,
    keyword_requires_direct_support,
    keyword_visible_in_text,
    validate_summary_grounding,
)


def test_domain_terms_do_not_get_extra_hardcoded_direct_support():
    for keyword in [
        "real-time threat intelligence",
        "SIEM",
        "XDR",
        "ITDR",
        "MDR",
        "AI-driven platform",
    ]:
        assert categorize_keyword(keyword) == "domain"
        assert not keyword_requires_direct_support(keyword)


def test_common_tech_terms_do_not_require_direct_support():
    for keyword in ["React", "backend services", "API", "Terraform"]:
        assert categorize_keyword(keyword) == "tech"
        assert not keyword_requires_direct_support(keyword)


def test_llm_validator_rejects_unsupported_claim(monkeypatch):
    import fletcher.llm.llm_enrich as mod

    monkeypatch.setattr(mod.config, "DEFAULT_MODEL_BACKEND", "ollama")
    monkeypatch.setattr(
        mod,
        "_ollama_chat",
        lambda _prompt: (
            '{"accepted": false, "keywords_supported": [], '
            '"keywords_rejected": ["Infrastructure as Code"], '
            '"reason": "Original only mentions Vercel and Supabase."}'
        ),
    )

    result = mod.validate_rewrite_with_ollama(
        original="Optimized scalability on Vercel and Supabase.",
        rewritten="Optimized scalability on Vercel and Supabase using Infrastructure as Code practices.",
        requested_keywords=["Infrastructure as Code"],
    )

    assert result["accepted"] is False
    assert result["keywords_rejected"] == ["Infrastructure as Code"]


def test_ambiguous_rewrite_fails_closed_when_validator_errors(monkeypatch):
    import fletcher.llm.llm_enrich as mod

    monkeypatch.setattr(mod.config, "DEFAULT_MODEL_BACKEND", "ollama")
    responses = iter(
        [
            (
                '{"bullet": "Optimized scalability on Vercel and Supabase using '
                'Infrastructure as Code practices.", "keywords_used": '
                '["Infrastructure as Code"], "keywords_skipped": []}'
            ),
            TimeoutError("validator timed out"),
        ]
    )

    def fake_chat(_prompt: str) -> str:
        response = next(responses)
        if isinstance(response, Exception):
            raise response
        return response

    monkeypatch.setattr(mod, "_ollama_chat", fake_chat)

    result = mod.rewrite_bullet_targeted(
        "Optimized scalability on Vercel and Supabase.",
        ["Infrastructure as Code"],
    )

    assert result["success"] is False
    assert result["error"] == "rewrite_validation_failed"
    assert result["keywords_skipped"] == ["Infrastructure as Code"]


def test_keyword_visible_helper_accepts_data_pipeline_monitoring_noun_form():
    assert keyword_visible_in_text(
        "Monitor data pipelines",
        "Improved data pipeline monitoring with Datadog metrics and alerts.",
    )


def test_model_claimed_keyword_not_counted_if_not_in_validated_rewrite(monkeypatch):
    import fletcher.llm.llm_enrich as mod

    monkeypatch.setattr(mod.config, "DEFAULT_MODEL_BACKEND", "ollama")
    monkeypatch.setattr(
        mod,
        "_ollama_chat",
        lambda _prompt: (
            '{"bullet": "Enhanced user engagement by building a responsive UI using Next.js.", '
            '"keywords_used": ["React"], "keywords_skipped": []}'
        ),
    )

    result = mod.rewrite_bullet_targeted(
        "Enhanced user engagement by building a responsive UI using Next.js.",
        ["React"],
    )

    assert result["success"] is False
    assert result["error"] == "rewrite_validation_failed"
    assert result["keywords_used"] == []
    assert result["keywords_skipped"] == ["React"]


def test_mixed_validation_failure_sends_all_attempted_keywords_to_summary(monkeypatch):
    import fletcher.llm.llm_enrich as mod

    monkeypatch.setattr(mod.config, "DEFAULT_MODEL_BACKEND", "ollama")
    responses = iter(
        [
            (
                '{"bullet": "Enhanced UI using React/Next.js for an AI-driven platform.", '
                '"keywords_used": ["React", "AI-driven platform"], "keywords_skipped": []}'
            ),
            (
                '{"accepted": false, "keywords_supported": ["React"], '
                '"keywords_rejected": ["AI-driven platform"], "reason": "AI claim unsupported."}'
            ),
        ]
    )
    monkeypatch.setattr(mod, "_ollama_chat", lambda _prompt: next(responses))

    result = mod.rewrite_bullet_targeted(
        "Enhanced UI using Next.js based on beta tester feedback.",
        ["React", "AI-driven platform"],
    )

    assert result["success"] is False
    assert result["keywords_used"] == []
    assert result["keywords_skipped"] == ["React", "AI-driven platform"]


def test_validator_ignores_supported_keywords_that_were_not_requested(monkeypatch):
    import fletcher.llm.llm_enrich as mod

    monkeypatch.setattr(mod.config, "DEFAULT_MODEL_BACKEND", "ollama")
    monkeypatch.setattr(
        mod,
        "_ollama_chat",
        lambda _prompt: (
            '{"accepted": false, "keywords_supported": ["Bitbucket pipelines", "ECR"], '
            '"keywords_rejected": ["Azure DevOps"], "reason": "unsupported"}'
        ),
    )

    result = mod.validate_rewrite_with_ollama(
        original="Automated CI/CD via Bitbucket pipelines and ECR.",
        rewritten="Automated CI/CD via Azure DevOps, Bitbucket pipelines, and ECR.",
        requested_keywords=["Azure DevOps"],
    )

    assert result["accepted"] is False
    assert result["keywords_supported"] == []
    assert result["keywords_rejected"] == ["Azure DevOps"]


def test_false_validator_acceptance_rejects_requested_keyword(monkeypatch):
    import fletcher.llm.llm_enrich as mod

    monkeypatch.setattr(mod.config, "DEFAULT_MODEL_BACKEND", "ollama")
    monkeypatch.setattr(
        mod,
        "_ollama_chat",
        lambda _prompt: (
            '{"accepted": false, "keywords_supported": ["Computer Engineering"], '
            '"keywords_rejected": [], "reason": "unsupported"}'
        ),
    )

    result = mod.validate_rewrite_with_ollama(
        original="Taught Computer Science courses.",
        rewritten="Taught Computer Science and Computer Engineering courses.",
        requested_keywords=["Computer Engineering"],
    )

    assert result["accepted"] is False
    assert result["keywords_supported"] == ["Computer Engineering"]
    assert result["keywords_rejected"] == ["Computer Engineering"]


def test_summary_grounding_leaves_domain_support_to_llm():
    result = validate_summary_grounding(
        "Software Engineer with XDR and real-time threat intelligence experience.",
        "Experience: Software Developer. Skills: Python, React, Terraform",
        ["XDR", "real-time threat intelligence"],
    )

    assert result["accepted"] is True


def test_summary_grounding_does_not_reject_unprompted_domain_claim():
    result = validate_summary_grounding(
        "Software Engineer with SIEM experience.",
        "Experience: Software Developer. Skills: Python, React, Terraform",
        [],
    )

    assert result["accepted"] is True


def test_summary_grounding_no_longer_runs_banned_tone_d_check():
    result = validate_summary_grounding(
        "Motivated developer eager to contribute immediately.",
        "Experience: Software Developer.",
        [],
    )

    assert result == {"accepted": True, "reasons": []}
