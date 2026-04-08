import unittest

from hunter.resume_review_ui import (
    collect_highlight_terms,
    highlight_terms,
    summarize_tailoring,
)


class ResumeReviewUiTests(unittest.TestCase):
    def test_highlight_terms_wraps_longest_first(self):
        text = "We use Python and REST API daily."
        terms = collect_highlight_terms(
            {
                "must_have_terms": ["rest", "rest api", "python"],
                "nice_to_have_terms": [],
                "tools_and_technologies": [],
                "domain_terms": [],
            }
        )
        html = highlight_terms(text, terms)
        self.assertIn("REST API", html)
        self.assertIn('<mark class="resume-kw">REST API</mark>', html)
        self.assertIn('<mark class="resume-kw">Python</mark>', html)

    def test_summarize_counts_rewrites(self):
        structured = {
            "experience_entries": [
                {
                    "entry_id": "e1",
                    "bullet_plan": [
                        {
                            "mode": "rewrite",
                            "text": "Did X with AWS.",
                            "original_text": "Did X.",
                        },
                        {"mode": "reuse", "text": "Shipped Y.", "original_text": "Shipped Y."},
                    ],
                }
            ],
            "project_entries": [],
            "skills": {"languages": ["Python"], "frameworks": [], "developer_tools": []},
        }
        lines, counts = summarize_tailoring(structured)
        self.assertEqual(counts["rewritten_visible"], 1)
        self.assertTrue(any("Reworded" in line for line in lines))
