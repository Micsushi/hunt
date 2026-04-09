import json
import unittest
from unittest.mock import patch

from fletcher import config
from fletcher.llm.llm_enrich import enrich_with_ollama_if_enabled


class Component2OllamaTests(unittest.TestCase):
    def test_heuristic_backend_skips_network(self):
        with patch.object(config, "DEFAULT_MODEL_BACKEND", "heuristic"):
            with patch("fletcher.llm.llm_enrich._ollama_chat") as mock_chat:
                c, k, meta = enrich_with_ollama_if_enabled(
                    title="Backend Engineer",
                    description="Python and AWS backend services.",
                    classification={"role_family": "software", "job_level": "mid"},
                    keywords={"must_have_terms": ["python"]},
                )
        mock_chat.assert_not_called()
        self.assertFalse(meta["ollama_enriched"])
        self.assertEqual(c["role_family"], "software")

    def test_ollama_success_sets_keywords_and_jd_usable(self):
        fake_response = json.dumps(
            {
                "jd_usable": True,
                "jd_usable_reason": "Full JD with stack listed.",
                "keywords": ["SQL", "Spark", "Airflow"],
            }
        )
        with patch.object(config, "DEFAULT_MODEL_BACKEND", "ollama"):
            with patch(
                "fletcher.llm.llm_enrich._ollama_chat", return_value=fake_response
            ):
                base_c = {
                    "role_family": "software",
                    "job_level": "unknown",
                    "confidence": 0.5,
                    "weak_description": True,
                    "recommended_base_resume": "software",
                    "reasons": [],
                    "concern_flags": ["weak_description"],
                }
                base_k = {
                    "must_have_terms": ["java"],
                    "nice_to_have_terms": ["x"],
                    "responsibilities": ["Old."],
                    "tools_and_technologies": [],
                    "domain_terms": ["y"],
                    "seniority_signals": [],
                    "concern_flags": [],
                }
                c, k, meta = enrich_with_ollama_if_enabled(
                    title="Data Engineer",
                    description="Senior data engineer with SQL and Spark.",
                    classification=base_c,
                    keywords=base_k,
                )
        self.assertTrue(meta["ollama_enriched"])
        self.assertIsNone(meta["error"])
        self.assertTrue(meta.get("jd_usable"))
        self.assertIn("Full JD", meta.get("jd_usable_reason", ""))
        self.assertFalse(c["weak_description"])
        self.assertNotIn("weak_description", c.get("concern_flags", []))
        self.assertEqual(k["must_have_terms"], ["SQL", "Spark", "Airflow"])
        self.assertEqual(k["nice_to_have_terms"], [])
        self.assertEqual(k["tools_and_technologies"], ["SQL", "Spark", "Airflow"])
        self.assertEqual(k["domain_terms"], [])

    def test_ollama_jd_not_usable_clears_keywords(self):
        fake_response = json.dumps(
            {
                "jd_usable": False,
                "jd_usable_reason": "Stub only.",
                "keywords": ["Should", "Be", "Ignored"],
            }
        )
        with patch.object(config, "DEFAULT_MODEL_BACKEND", "ollama"):
            with patch(
                "fletcher.llm.llm_enrich._ollama_chat", return_value=fake_response
            ):
                base_c = {
                    "role_family": "pm",
                    "job_level": "mid",
                    "confidence": 0.7,
                    "weak_description": False,
                    "recommended_base_resume": "pm",
                    "reasons": [],
                    "concern_flags": [],
                }
                base_k = {
                    "must_have_terms": ["roadmap"],
                    "nice_to_have_terms": [],
                    "responsibilities": [],
                    "tools_and_technologies": [],
                    "domain_terms": [],
                    "seniority_signals": [],
                    "concern_flags": [],
                }
                c, k, meta = enrich_with_ollama_if_enabled(
                    title="PM",
                    description="Product manager for B2B SaaS.",
                    classification=base_c,
                    keywords=base_k,
                )
        self.assertTrue(meta["ollama_enriched"])
        self.assertTrue(c["weak_description"])
        self.assertIn("weak_description", c["concern_flags"])
        self.assertEqual(k["must_have_terms"], [])

    def test_ollama_malformed_json_falls_back(self):
        with patch.object(config, "DEFAULT_MODEL_BACKEND", "ollama"):
            with patch("fletcher.llm.llm_enrich._ollama_chat", return_value="not json"):
                base_c = {
                    "role_family": "pm",
                    "job_level": "mid",
                    "confidence": 0.7,
                    "weak_description": False,
                    "recommended_base_resume": "pm",
                    "reasons": [],
                    "concern_flags": [],
                }
                base_k = {
                    "must_have_terms": ["roadmap"],
                    "nice_to_have_terms": [],
                    "responsibilities": [],
                    "tools_and_technologies": [],
                    "domain_terms": [],
                    "seniority_signals": [],
                    "concern_flags": [],
                }
                c, k, meta = enrich_with_ollama_if_enabled(
                    title="PM",
                    description="Product manager for B2B SaaS.",
                    classification=base_c,
                    keywords=base_k,
                )
        self.assertFalse(meta["ollama_enriched"])
        self.assertIsNotNone(meta["error"])
        self.assertEqual(c["role_family"], "pm")
        self.assertEqual(k["must_have_terms"], ["roadmap"])

    def test_ollama_connection_error_falls_back(self):
        import urllib.error

        with patch.object(config, "DEFAULT_MODEL_BACKEND", "ollama"):
            with patch("fletcher.llm.llm_enrich.urllib.request.urlopen") as mock_open:
                mock_open.side_effect = urllib.error.URLError("refused")
                base_c = {
                    "role_family": "general",
                    "job_level": "unknown",
                    "confidence": 0.4,
                    "weak_description": True,
                    "recommended_base_resume": "original",
                    "reasons": [],
                    "concern_flags": ["weak_description"],
                }
                base_k = {
                    "must_have_terms": [],
                    "nice_to_have_terms": [],
                    "responsibilities": [],
                    "tools_and_technologies": [],
                    "domain_terms": [],
                    "seniority_signals": [],
                    "concern_flags": ["weak_description"],
                }
                c, _, meta = enrich_with_ollama_if_enabled(
                    title="X",
                    description="short",
                    classification=base_c,
                    keywords=base_k,
                )
        self.assertFalse(meta["ollama_enriched"])
        self.assertIn("refused", meta["error"])
        self.assertEqual(c["role_family"], "general")
