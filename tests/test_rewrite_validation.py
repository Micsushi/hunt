from __future__ import annotations

from fletcher.llm.llm_enrich import (
    categorize_keyword,
    keyword_requires_direct_support,
    validate_rewrite_grounding,
)


def test_security_domain_terms_require_direct_support():
    for keyword in [
        "real-time threat intelligence",
        "SIEM",
        "XDR",
        "ITDR",
        "MDR",
        "AI-driven platform",
    ]:
        assert categorize_keyword(keyword) == "domain"
        assert keyword_requires_direct_support(keyword)


def test_common_tech_terms_do_not_require_direct_support():
    for keyword in ["React", "backend services", "API", "Terraform"]:
        assert categorize_keyword(keyword) == "tech"
        assert not keyword_requires_direct_support(keyword)


def test_rejects_datadog_threat_intelligence_claim():
    result = validate_rewrite_grounding(
        original=(
            "Optimized bug detection speed by configuring Datadog metrics, monitors and "
            "centralized logging with automated alerting and error traces."
        ),
        rewritten=(
            "Optimized bug detection speed by configuring Datadog metrics, monitors, "
            "and centralized logging, integrating real-time threat intelligence with "
            "automated alerting and error traces."
        ),
        requested_keywords=["real-time threat intelligence"],
    )

    assert result["accepted"] is False
    assert result["keywords_rejected"] == ["real-time threat intelligence"]


def test_rejects_ai_platform_feedback_claim():
    result = validate_rewrite_grounding(
        original=(
            "Enhanced user engagement by building a responsive UI using Next.js and "
            "Framer Motion based on beta tester feedback."
        ),
        rewritten=(
            "Enhanced user engagement by building a responsive UI using Next.js and "
            "Framer Motion, leveraging an AI-driven platform for iterative improvements."
        ),
        requested_keywords=["AI-driven platform"],
    )

    assert result["accepted"] is False
    assert result["keywords_rejected"] == ["AI-driven platform"]


def test_accepts_machine_learning_brainwave_processing():
    result = validate_rewrite_grounding(
        original=(
            "Achieved 85% accuracy in attention scoring by developing a Python backend "
            "for real-time brainwave processing and data optimization."
        ),
        rewritten=(
            "Achieved 85% accuracy in attention scoring by developing a Python backend "
            "for real-time brainwave processing and data optimization using machine "
            "learning techniques."
        ),
        requested_keywords=["machine learning"],
    )

    assert result["accepted"] is True
    assert result["keywords_supported"] == ["machine learning"]


def test_flags_redundant_backend_services_phrase():
    result = validate_rewrite_grounding(
        original=(
            "Enhanced real-time subscriber targeting accuracy by developing Kotlin "
            "microservices that integrated platforms via RESTful APIs."
        ),
        rewritten=(
            "Enhanced real-time subscriber targeting accuracy by developing Kotlin "
            "microservices and backend services that integrated platforms via RESTful APIs."
        ),
        requested_keywords=["backend services"],
    )

    assert result["accepted"] is False
    assert result["keywords_rejected"] == ["backend services"]


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
