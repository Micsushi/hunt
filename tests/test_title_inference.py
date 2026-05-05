from __future__ import annotations

from fletcher.jobs.title_inference import infer_title_from_description, normalize_title_candidate


def test_rejects_section_heading_about_us():
    assert normalize_title_candidate("**About Us**") == ""


def test_infers_seeking_title_from_sophos_jd():
    jd = """
    **About Us**
    Sophos is a cybersecurity leader.
    ### **Role Summary**
    We are seeking a Software Engineer to join our Security features team and help build systems.
    """
    assert infer_title_from_description(jd) == "Software Engineer"


def test_prefers_explicit_title_line():
    jd = "Job Title: Software Engineer, Security Features\nAbout Us\nSophos..."
    assert infer_title_from_description(jd) == "Software Engineer, Security Features"


def test_empty_when_no_signal():
    assert infer_title_from_description("About Us\nReady to Join Us?") == ""
