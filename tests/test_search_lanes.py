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
