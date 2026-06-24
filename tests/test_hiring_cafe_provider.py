import json
import os
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO_ROOT)

from hunter import enrich_hiring_cafe  # noqa: E402
from hunter.providers import hiring_cafe  # noqa: E402


def _next_data_html(hits):
    payload = {"props": {"pageProps": {"ssrHits": hits}}}
    return (
        '<html><body><script id="__NEXT_DATA__" type="application/json">'
        + json.dumps(payload)
        + "</script></body></html>"
    )


def test_extract_search_hits_from_next_data():
    hit = {
        "id": "lever___kabam___abc",
        "source": "lever",
        "apply_url": "https://jobs.lever.co/kabam/abc/apply",
        "job_information": {"title": "Data Analyst (Contract)"},
        "v5_processed_job_data": {
            "company_name": "Kabam",
            "formatted_workplace_location": "Vancouver, British Columbia, Canada",
        },
    }

    hits = hiring_cafe.extract_search_hits(_next_data_html([hit]))

    assert hits == [hit]


def test_map_hit_to_hunt_job_fields():
    hit = {
        "id": "workday___autodesk___mobile-software-developer_26wd97481",
        "source": "workday",
        "apply_url": (
            "https://autodesk.wd1.myworkdayjobs.com/ext/job/Vancouver/"
            "Mobile-Software-Developer_26WD97481"
        ),
        "job_information": {
            "title": "Mobile Software Developer",
            "description": "<p>Build mobile tools.</p><ul><li>Ship iOS and Android features.</li></ul>",
        },
        "v5_processed_job_data": {
            "company_name": "Autodesk",
            "formatted_workplace_location": "Vancouver, British Columbia, Canada",
        },
    }

    job = hiring_cafe.map_hit(hit).to_hunt_job(search_url="https://hiring.cafe/?searchState=x")

    assert job["title"] == "Mobile Software Developer"
    assert job["company"] == "Autodesk"
    assert job["location"] == "Vancouver, British Columbia, Canada"
    assert job["apply_url"].endswith("Mobile-Software-Developer_26WD97481")
    assert job["apply_host"] == "autodesk.wd1.myworkdayjobs.com"
    assert job["ats_type"] == "workday"
    assert job["apply_type"] == "external_apply"
    assert job["auto_apply_eligible"] is True
    assert job["source"] == "hiring_cafe"
    assert job["external_source"] == "workday"
    assert job["description"] == "Build mobile tools.\nShip iOS and Android features."


def test_build_search_url_encodes_public_search_state():
    url = hiring_cafe.build_search_url("Kabam Data Analyst", days=30)

    assert url.startswith("https://hiring.cafe/?searchState=")
    assert "Kabam+Data+Analyst" in url
    assert "dateFetchedPastNDays" in url


def test_enrich_linkedin_job_with_hiring_cafe_selects_external_match():
    job = {
        "title": "Mobile Software Developer",
        "company": "Autodesk",
        "location": "Vancouver, Canada",
        "description": None,
    }
    candidate = hiring_cafe.HiringCafeJob(
        source_id="workday___autodesk___mobile-software-developer_26wd97481",
        title="Mobile Software Developer",
        company="Autodesk",
        location="Vancouver, British Columbia, Canada",
        apply_url="https://autodesk.wd1.myworkdayjobs.com/ext/job/26WD97481",
        description=None,
        source="workday",
        raw={},
    )

    def fake_search_jobs(query, **kwargs):
        assert query == "Autodesk Mobile Software Developer Vancouver, Canada"
        assert kwargs["include_descriptions"] is False
        assert kwargs["limit"] == 3
        return [candidate]

    def fake_fetch_description_html(source_id):
        assert source_id == "workday___autodesk___mobile-software-developer_26wd97481"
        return (
            "<p>Build mobile software, collaborate with product managers, write tests, "
            "and deliver production features for customers across platforms.</p>"
        )

    result = enrich_hiring_cafe.enrich_linkedin_job_with_hiring_cafe(
        job,
        search_jobs_fn=fake_search_jobs,
        fetch_description_html_fn=fake_fetch_description_html,
    )

    assert result["apply_type"] == "external_apply"
    assert result["apply_host"] == "autodesk.wd1.myworkdayjobs.com"
    assert result["ats_type"] == "workday"
    assert result["provider"] == "hiring_cafe"
    assert result["description"].startswith("Build mobile software")


def test_enrich_linkedin_job_with_hiring_cafe_rejects_generic_title_drift():
    job = {
        "title": "Data Analyst",
        "company": "Sun Life",
        "location": "Toronto, Canada",
        "description": None,
    }
    candidate = hiring_cafe.HiringCafeJob(
        source_id="workday___sunlife___senior-analyst-data-governance",
        title="Senior Analyst - Data Governance",
        company="Sun Life",
        location="Toronto, Ontario, Canada",
        apply_url="https://sunlife.wd3.myworkdayjobs.com/experienced-jobs/job/JR00122972",
        description=(
            "Lead data governance analysis, partner with stakeholders, document controls, "
            "and deliver reporting improvements across enterprise teams."
        ),
        source="workday",
        raw={},
    )

    def fake_search_jobs(_query, **_kwargs):
        return [candidate]

    try:
        enrich_hiring_cafe.enrich_linkedin_job_with_hiring_cafe(
            job, search_jobs_fn=fake_search_jobs
        )
    except enrich_hiring_cafe.HiringCafeEnrichmentError as exc:
        assert exc.code == "hiring_cafe_match_not_found"
    else:
        raise AssertionError("Expected generic title drift to be rejected.")


def test_hiring_cafe_rate_limit_failure_stays_retryable():
    assert enrich_hiring_cafe._get_failure_enrichment_status("rate_limited") == "failed"
    assert enrich_hiring_cafe._should_stop_batch_after_failure("rate_limited") is True


def test_hiring_cafe_failure_statuses_separate_url_and_description():
    assert (
        enrich_hiring_cafe._get_failure_enrichment_status("hiring_cafe_match_not_found")
        == "failed_url"
    )
    assert (
        enrich_hiring_cafe._get_failure_enrichment_status("description_not_found")
        == "failed_description"
    )
