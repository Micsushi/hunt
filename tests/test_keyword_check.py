"""Tests for fletcher.keyword_check.partition_keywords."""

from __future__ import annotations

from fletcher.keyword_check import _kw_in_text, partition_keywords


class TestKwInText:
    def test_single_word_present(self):
        assert _kw_in_text("Python", "Built a Python service.") is True

    def test_single_word_case_insensitive(self):
        assert _kw_in_text("python", "Built a Python service.") is True

    def test_single_word_not_present(self):
        assert _kw_in_text("MongoDB", "Used SQL databases.") is False

    def test_whole_word_boundary(self):
        # "Go" should not match "GoLang" as a whole word
        assert _kw_in_text("Go", "Used GoLang for microservices.") is False

    def test_whole_word_boundary_match(self):
        assert _kw_in_text("Go", "Wrote services in Go and Python.") is True

    def test_multiword_keyword_present(self):
        assert _kw_in_text("machine learning", "Applied machine learning models.") is True

    def test_multiword_keyword_case_insensitive(self):
        assert _kw_in_text("Machine Learning", "Applied machine learning models.") is True

    def test_multiword_keyword_not_present(self):
        assert _kw_in_text("deep learning", "Applied machine learning models.") is False

    def test_empty_keyword(self):
        assert _kw_in_text("", "Some text") is False

    def test_empty_text(self):
        assert _kw_in_text("Python", "") is False

    def test_keyword_with_special_chars(self):
        assert _kw_in_text("C++", "Wrote C++ code.") is True

    def test_keyword_not_partial_match(self):
        # "AWS" should not match "LAWN"
        assert _kw_in_text("AWS", "Used LAWN tools.") is False

    def test_restful_api_matches_rest_api_keyword(self):
        assert _kw_in_text("REST APIs", "Integrated platforms via RESTful APIs.") is True

    def test_hyphen_space_and_plural_variants_match(self):
        assert _kw_in_text("end-to-end", "Owned end to end testing.") is True
        assert _kw_in_text("unit tests", "Improved unit testing coverage.") is True


class TestPartitionKeywords:
    def test_basic_split(self):
        present, missing, coverage = partition_keywords(
            ["Python", "MongoDB"], ["Built Python service.", "Used SQL."]
        )
        assert present == ["Python"]
        assert missing == ["MongoDB"]

    def test_coverage_indices(self):
        bullets = ["Python here.", "More Python.", "SQL only."]
        present, missing, coverage = partition_keywords(["Python", "SQL", "Go"], bullets)
        assert coverage["Python"] == [0, 1]
        assert coverage["SQL"] == [2]
        assert coverage["Go"] == []

    def test_all_present(self):
        present, missing, _ = partition_keywords(["Python", "AWS"], ["Python and AWS service."])
        assert set(present) == {"Python", "AWS"}
        assert missing == []

    def test_all_missing(self):
        present, missing, _ = partition_keywords(["Rust", "Go"], ["Python and AWS service."])
        assert present == []
        assert set(missing) == {"Rust", "Go"}

    def test_empty_keywords(self):
        present, missing, coverage = partition_keywords([], ["some bullet"])
        assert present == []
        assert missing == []
        assert coverage == {}

    def test_empty_bullets(self):
        present, missing, coverage = partition_keywords(["Python"], [])
        assert present == []
        assert missing == ["Python"]
        assert coverage == {"Python": []}

    def test_multiword_keyword(self):
        present, missing, _ = partition_keywords(
            ["machine learning", "deep learning"],
            ["Applied machine learning models."],
        )
        assert present == ["machine learning"]
        assert missing == ["deep learning"]

    def test_case_insensitive_partition(self):
        present, missing, _ = partition_keywords(["PYTHON"], ["Built a python service."])
        assert present == ["PYTHON"]
        assert missing == []

    def test_preserves_keyword_order(self):
        kws = ["Z", "A", "M"]
        bullets = ["Z here.", "A here.", "M here."]
        present, _, _ = partition_keywords(kws, bullets)
        assert present == ["Z", "A", "M"]

    def test_duplicate_keywords_handled(self):
        present, missing, coverage = partition_keywords(["Python", "Python"], ["Uses Python."])
        assert present == ["Python", "Python"]
        assert coverage["Python"] == [0]
