import unittest

from hunter.search_lanes import title_matches_search_lane, title_matches_target_preferences


class SearchLanesTests(unittest.TestCase):
    def test_target_preferences_require_selected_role_and_experience_level(self):
        targets = {
            "engineering": ["software engineer", "software developer"],
            "data": ["data scientist", "data analyst"],
        }
        levels = ["internship", "junior", "new_grad"]

        self.assertTrue(
            title_matches_target_preferences(
                "Software Engineer - Internship Opportunities",
                "engineering",
                targets,
                levels,
            )
        )
        self.assertTrue(
            title_matches_target_preferences(
                "Junior Data Scientist",
                "data",
                targets,
                levels,
            )
        )
        self.assertTrue(
            title_matches_target_preferences(
                "Software Engineering Intern",
                "engineering",
                targets,
                levels,
            )
        )
        self.assertTrue(
            title_matches_target_preferences(
                "Data Science New Grad",
                "data",
                targets,
                levels,
            )
        )
        self.assertTrue(
            title_matches_target_preferences(
                "Software Developer Co-op",
                "engineering",
                targets,
                levels,
            )
        )
        self.assertTrue(
            title_matches_target_preferences(
                "Associate Software Engineer",
                "engineering",
                targets,
                levels,
            )
        )
        self.assertTrue(
            title_matches_target_preferences(
                "Software Engineer I",
                "engineering",
                targets,
                levels,
            )
        )
        self.assertTrue(
            title_matches_target_preferences(
                "Software Developer 1",
                "engineering",
                targets,
                ["junior"],
            )
        )
        self.assertTrue(
            title_matches_target_preferences(
                "L1 Data Analyst",
                "data",
                targets,
                ["junior"],
            )
        )
        self.assertTrue(
            title_matches_target_preferences(
                "Entry-Level Data Scientist",
                "data",
                targets,
                ["new_grad"],
            )
        )
        self.assertFalse(
            title_matches_target_preferences(
                "Software Engineer",
                "engineering",
                targets,
                levels,
            )
        )
        self.assertFalse(
            title_matches_target_preferences(
                "AI/Machine Learning Engineer Intern",
                "data",
                targets,
                levels,
            )
        )
        self.assertTrue(
            title_matches_target_preferences(
                "Jr Software Engineer",
                "engineering",
                targets,
                ["junior"],
            )
        )
        self.assertFalse(
            title_matches_target_preferences(
                "International Software Engineer",
                "engineering",
                targets,
                ["internship"],
            )
        )
        self.assertFalse(
            title_matches_target_preferences(
                "Undergraduate Software Developer",
                "engineering",
                targets,
                ["new_grad"],
            )
        )

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

    def test_empty_title_fails(self):
        self.assertFalse(title_matches_search_lane("", "engineering"))


if __name__ == "__main__":
    unittest.main()
