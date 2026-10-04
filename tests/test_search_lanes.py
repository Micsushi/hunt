import unittest
from unittest.mock import patch

from hunter.search_lanes import title_matches_search_lane


class SearchLanesTests(unittest.TestCase):
    def test_custom_search_terms_control_both_existing_and_new_lanes(self):
        from hunter.search_lanes import matching_search_lane

        with patch("hunter.config.SEARCH_TERMS", {"healthcare": ["nurse"], "data": ["actuary"]}):
            self.assertEqual(matching_search_lane("Registered Nurse"), "healthcare")
            self.assertEqual(matching_search_lane("Associate Actuary"), "data")
            self.assertIsNone(matching_search_lane("Data Scientist"))
            self.assertIsNone(matching_search_lane("Nursemaid"))
            self.assertFalse(title_matches_search_lane("Cashier", "healthcare"))

    def test_default_search_terms_are_not_rejected_by_their_own_lane(self):
        from hunter.config import _DEFAULT_SEARCH_TERMS

        for lane, terms in _DEFAULT_SEARCH_TERMS.items():
            for term in terms:
                with self.subTest(lane=lane, term=term):
                    self.assertTrue(title_matches_search_lane(term, lane))

    def test_it_database_roles_and_qa_automation_specialists(self):
        self.assertTrue(title_matches_search_lane("Junior Database Administrator", "it_support"))
        self.assertTrue(title_matches_search_lane("Test Automation Specialist", "quality_security"))
        self.assertFalse(title_matches_search_lane("Office Administrator", "it_support"))

    def test_it_analyst_and_compliance_roles_require_word_boundaries(self):
        for title in ("IT Analyst", "IT Compliance Analyst", "IT Operations Coordinator"):
            self.assertTrue(title_matches_search_lane(title, "it_support"))
        for title in (
            "Benefit Analyst",
            "Audit Compliance Officer",
            "Credit Operations Coordinator",
            "Benefit Specialist",
        ):
            self.assertFalse(title_matches_search_lane(title, "it_support"))

    def test_engineering_lane_software_engineer(self):
        self.assertTrue(title_matches_search_lane("Junior Software Engineer", "engineering"))

    def test_engineering_lane_rejects_walmart_associate_manager(self):
        self.assertFalse(title_matches_search_lane("Associate Manager", "engineering"))

    def test_engineering_lane_developer(self):
        self.assertTrue(title_matches_search_lane("Full Stack Developer Intern", "engineering"))

    def test_product_lane_product_manager(self):
        self.assertTrue(title_matches_search_lane("Associate Product Manager", "product"))

    def test_product_lane_pm_token(self):
        self.assertTrue(title_matches_search_lane("Senior PM, Platform", "product"))

    def test_product_lane_rejects_cashier(self):
        self.assertFalse(title_matches_search_lane("Cashier", "product"))

    def test_data_lane_data_scientist(self):
        self.assertTrue(title_matches_search_lane("Junior Data Scientist", "data"))

    def test_data_lane_data_analyst(self):
        self.assertTrue(title_matches_search_lane("Data Analyst Intern", "data"))

    def test_unknown_lane_passes_through(self):
        self.assertTrue(title_matches_search_lane("Anything", "unknown_lane"))

    def test_noc_occupation_codes_are_not_network_operations(self):
        for title in (
            "Cashier Full Time, NOC 65100",
            "Clerk (NOC: 65102)",
            "Department Supervisor NOC code 62010",
            "Inoculation Technician",
        ):
            with self.subTest(title=title):
                self.assertFalse(title_matches_search_lane(title, "it_support"))
        for title in ("NOC Technician", "NOC Analyst (NOC 22221)", "IT Support NOC 22221"):
            with self.subTest(title=title):
                self.assertTrue(title_matches_search_lane(title, "it_support"))

    def test_empty_title_fails(self):
        self.assertFalse(title_matches_search_lane("", "engineering"))


if __name__ == "__main__":
    unittest.main()


def test_deployed_target_preferences_support_nontechnical_roles_and_levels():
    from unittest.mock import patch

    from hunter import config
    from hunter.search_lanes import build_search_queries, matching_search_lane

    roles = {"healthcare": ["registered nurse"]}
    queries = build_search_queries(roles, ["junior", "new_grad"])
    assert "registered nurse level one" in queries["healthcare"]
    assert len(queries["healthcare"]) == len(set(queries["healthcare"]))
    with patch.multiple(
        config,
        TARGETING_CONFIGURED=True,
        TARGET_JOB_TITLES=roles,
        EXPERIENCE_LEVELS=["junior"],
        SEARCH_TERMS=queries,
    ):
        assert matching_search_lane("Registered Nurse I") == "healthcare"
        assert matching_search_lane("Senior Registered Nurse") is None
        assert matching_search_lane("Junior Software Engineer") is None
    assert build_search_queries(roles, []) == roles
    assert build_search_queries({}, ["junior"]) == {}


def test_target_settings_load_without_legacy_search_terms(tmp_path):
    import json
    import os
    import subprocess
    import sys

    path = tmp_path / "profile.json"
    path.write_text(
        json.dumps(
            {"target_job_titles": {"healthcare": ["nurse"]}, "experience_levels": ["internship"]}
        ),
        encoding="utf-8",
    )
    env = dict(os.environ)
    for key in ("SEARCH_TERMS", "TARGET_JOB_TITLES", "EXPERIENCE_LEVELS"):
        env.pop(key, None)
    env["HUNT_USER_CONFIG_PATH"] = str(path)
    # Use the same environment key as the production configuration loader.
    code = "from hunter.config import SEARCH_TERMS,TARGETING_CONFIGURED; import json; print(json.dumps([TARGETING_CONFIGURED,SEARCH_TERMS]))"
    result = subprocess.run(
        [sys.executable, "-c", code], env=env, text=True, capture_output=True, check=True
    )
    assert json.loads(result.stdout) == [
        True,
        {"healthcare": ["nurse intern", "nurse internship", "nurse co-op", "nurse student"]},
    ]
