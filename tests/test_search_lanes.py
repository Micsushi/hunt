import unittest

from hunter.search_lanes import title_matches_search_lane


class SearchLanesTests(unittest.TestCase):
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
