from __future__ import annotations

import json

import pytest


def test_rewrite_preserves_explicit_scope_even_when_model_approves(monkeypatch):
    import fletcher.llm.llm_enrich as mod

    monkeypatch.setattr(mod.config, "DEFAULT_MODEL_BACKEND", "ollama")
    original = (
        "Wrote a Python script to check ten sample CSV rows for missing values in a class exercise."
    )
    for context, accepted in [("", False), (" during a class exercise", True)]:
        rewritten = (
            "Used Python for data validation on ten sample CSV rows, checking missing values"
            + context
            + "."
        )
        responses = iter(
            [
                json.dumps({"bullet": rewritten, "keywords_used": ["data validation"]}),
                json.dumps(
                    {
                        "accepted": True,
                        "keywords_supported": ["data validation"],
                        "keywords_rejected": [],
                    }
                ),
            ]
        )
        monkeypatch.setattr(mod, "_ollama_chat", lambda _prompt: next(responses))
        result = mod.rewrite_bullet_targeted(original, ["data validation"])
        assert result["success"] is accepted
        assert result["bullet"] == (rewritten if accepted else original)
        assert result["keywords_used"] == (["data validation"] if accepted else [])


@pytest.mark.parametrize(
    "original,rewritten,requested,supported,rejected,expected_supported",
    [
        (
            "Optimized scalability on Vercel and Supabase.",
            "Optimized scalability on Vercel and Supabase using Infrastructure as Code practices.",
            "Infrastructure as Code",
            [],
            ["Infrastructure as Code"],
            [],
        ),
        (
            "Automated CI/CD via Bitbucket pipelines and ECR.",
            "Automated CI/CD via Azure DevOps, Bitbucket pipelines, and ECR.",
            "Azure DevOps",
            ["Bitbucket pipelines", "ECR"],
            ["Azure DevOps"],
            [],
        ),
        (
            "Taught Computer Science courses.",
            "Taught Computer Science and Computer Engineering courses.",
            "Computer Engineering",
            ["Computer Engineering"],
            [],
            ["Computer Engineering"],
        ),
    ],
)
def test_rejected_rewrite_grounds_keywords_within_the_requested_scope(
    monkeypatch, original, rewritten, requested, supported, rejected, expected_supported
):
    import fletcher.llm.llm_enrich as mod

    monkeypatch.setattr(mod.config, "DEFAULT_MODEL_BACKEND", "ollama")
    response = {
        "accepted": False,
        "keywords_supported": supported,
        "keywords_rejected": rejected,
        "reason": "unsupported",
    }
    monkeypatch.setattr(mod, "_ollama_chat", lambda _: json.dumps(response))
    result = mod.validate_rewrite_with_ollama(
        original=original, rewritten=rewritten, requested_keywords=[requested]
    )
    assert result["accepted"] is False
    assert result["keywords_supported"] == expected_supported
    assert result["keywords_rejected"] == [requested]


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
    monkeypatch.setattr(
        mod,
        "validate_rewrite_with_ollama",
        lambda **_kwargs: {
            "accepted": True,
            "keywords_supported": ["React"],
            "keywords_rejected": [],
        },
    )

    result = mod.rewrite_bullet_targeted(
        "Enhanced user engagement by building a responsive UI using Next.js.",
        ["React"],
    )

    assert result["success"] is False
    assert result["error"] == "rewrite_validation_failed"
    assert result["keywords_used"] == []
    assert result["keywords_skipped"] == ["React"]


def test_rewrite_with_no_used_keywords_keeps_original_without_validation(monkeypatch):
    import fletcher.llm.llm_enrich as mod

    monkeypatch.setattr(mod.config, "DEFAULT_MODEL_BACKEND", "ollama")
    monkeypatch.setattr(
        mod,
        "_ollama_chat",
        lambda _prompt: (
            '{"bullet": "Enhanced user engagement by building a responsive UI using Next.js '
            'and Framer Motion, improving the overall user experience.", '
            '"keywords_used": [], "keywords_skipped": ["backend development", "Go ecosystem"]}'
        ),
    )

    def fail_validation(**_kwargs):
        raise AssertionError("validator should not rescue a zero-keyword rewrite")

    monkeypatch.setattr(mod, "validate_rewrite_with_ollama", fail_validation)

    original = (
        "Enhanced user engagement by building a responsive UI using Next.js and "
        "Framer Motion based on beta tester feedback."
    )
    result = mod.rewrite_bullet_targeted(original, ["backend development", "Go ecosystem"])

    assert result["success"] is False
    assert result["error"] == "rewrite_no_keywords_used"
    assert result["bullet"] == original
    assert result["keywords_used"] == []
    assert result["keywords_skipped"] == ["backend development", "Go ecosystem"]
