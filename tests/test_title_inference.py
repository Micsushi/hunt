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


def test_rejects_metadata_lines():
    assert normalize_title_candidate("Function: Engineering") == ""
    assert normalize_title_candidate("Location: **Hamilton**") == ""
    assert normalize_title_candidate("Employment Status: Hourly Full-Time") == ""
    assert normalize_title_candidate("Req ID: **27635**") == ""


def test_infers_intern_title_from_first_line():
    jd = """Software Development Intern
Lincoln Electric is the world leader in the engineering...
Location: Hamilton
Function: Engineering"""
    assert infer_title_from_description(jd) == "Software Development Intern"


def test_infers_we_are_looking_for_plural_intern_title():
    jd = """
    Salary range: 61,500 - 76,900 About the role
    We are looking for **Database Software Developer interns** for our growing team!
    Required technical skills: SQL, PL/SQL, Git, Jira, Confluence.
    """

    assert infer_title_from_description(jd) == "Database Software Developer Intern"
