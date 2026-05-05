from __future__ import annotations

from fletcher.jobs.keyword_policy import (
    KeywordKind,
    KeywordRoute,
    classify_keyword_policy,
)


def test_job_title_not_bullet_rewrite():
    policy = classify_keyword_policy(
        "Software Development Intern", job_title="Software Development Intern"
    )

    assert policy.kind == KeywordKind.ROLE_TITLE
    assert policy.route == KeywordRoute.SUMMARY
    assert policy.allow_bullet_rewrite is False


def test_non_actionable_org_terms_are_ignored():
    for keyword in ["China-based team", "CEO", "MBB"]:
        policy = classify_keyword_policy(keyword, job_title="Product Manager")
        assert policy.allow_bullet_rewrite is False
        assert policy.route == KeywordRoute.IGNORE


def test_language_requirement_ignored_without_resume_support():
    policy = classify_keyword_policy("Mandarin", resume_context="Python React")

    assert policy.kind == KeywordKind.LANGUAGE_REQUIREMENT
    assert policy.route == KeywordRoute.IGNORE


def test_language_requirement_summary_when_resume_supports_it():
    policy = classify_keyword_policy("Mandarin", resume_context="Languages: English, Mandarin")

    assert policy.kind == KeywordKind.LANGUAGE_REQUIREMENT
    assert policy.route == KeywordRoute.SUMMARY


def test_education_terms_not_bullet_rewrite():
    for keyword in ["Computer Engineering", "Mathematics", "Computer Science"]:
        policy = classify_keyword_policy(keyword)
        assert policy.kind == KeywordKind.EDUCATION
        assert policy.allow_bullet_rewrite is False


def test_ci_cd_tool_substitution_allowed():
    policy = classify_keyword_policy("Azure DevOps")

    assert policy.kind == KeywordKind.TOOL
    assert policy.allow_bullet_rewrite is True
    assert policy.allow_same_category_tool_substitution is True


def test_data_tool_rewrite_requires_same_category_support():
    policy = classify_keyword_policy("Databricks")

    assert policy.kind == KeywordKind.TOOL
    assert policy.allow_same_category_tool_substitution is True


def test_observability_tool_classified_as_tool():
    policy = classify_keyword_policy("Datadog")

    assert policy.kind == KeywordKind.TOOL
    assert policy.route == KeywordRoute.REWRITE


def test_domain_terms_require_same_bullet_evidence():
    for keyword in ["robotics", "SIEM", "cybersecurity", "AI-powered super app"]:
        policy = classify_keyword_policy(keyword)
        assert policy.kind == KeywordKind.DOMAIN
        assert policy.requires_same_bullet_evidence is True


def test_process_and_quality_terms_are_rewrite_candidates():
    for keyword in ["A/B testing", "bug triage", "leadership"]:
        policy = classify_keyword_policy(keyword)
        assert policy.kind in {KeywordKind.PROCESS, KeywordKind.QUALITY}
        assert policy.route == KeywordRoute.REWRITE


def test_common_stack_terms_are_rewrite_candidates():
    for keyword in ["SQL", "PL/SQL", "React", "Next.js"]:
        policy = classify_keyword_policy(keyword)
        assert policy.kind in {KeywordKind.LANGUAGE, KeywordKind.FRAMEWORK, KeywordKind.TECH}
        assert policy.route == KeywordRoute.REWRITE
