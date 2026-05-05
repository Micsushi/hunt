"""Tests for fletcher.pipeline_logger.PipelineLogger."""

from __future__ import annotations

from fletcher.pipeline_logger import PipelineLogger


def test_step_appears_in_log():
    log = PipelineLogger()
    log.step("parse_resume", path="/tmp/main.tex", count=3)
    text = log.get_log_text()
    assert "[STEP" in text
    assert "parse_resume" in text
    assert "path: /tmp/main.tex" in text
    assert "count: 3" in text


def test_llm_call_appears_in_log():
    log = PipelineLogger()
    log.llm_call(
        "keyword_extract",
        prompt="Extract keywords from: ...",
        response='{"keywords": ["Python"]}',
        duration_ms=420,
        success=True,
    )
    text = log.get_log_text()
    assert "[LLM" in text
    assert "keyword_extract" in text
    assert "success=True" in text
    assert "420ms" in text
    assert "--- PROMPT ---" in text
    assert "--- RESPONSE ---" in text
    assert "Python" in text


def test_llm_call_error_shown():
    log = PipelineLogger()
    log.llm_call(
        "bullet_rewrite",
        prompt="rephrase: ...",
        response="",
        duration_ms=50,
        success=False,
        error="ConnectionRefusedError",
    )
    text = log.get_log_text()
    assert "success=False" in text
    assert "ERROR: ConnectionRefusedError" in text


def test_multiple_entries_ordered():
    log = PipelineLogger()
    log.step("start")
    log.llm_call("kw", "p", "r", 100)
    log.step("end")
    text = log.get_log_text()
    start_pos = text.index("start")
    kw_pos = text.index("[LLM")
    end_pos = text.index("end")
    assert start_pos < kw_pos < end_pos


def test_timestamps_non_negative():
    log = PipelineLogger()
    log.step("a")
    text = log.get_log_text()
    # "+0." or "+1." — starts with "+"
    assert "+0." in text or "+1." in text or "+2." in text


def test_log_header_present():
    log = PipelineLogger()
    text = log.get_log_text()
    assert "PIPELINE LOG" in text
    assert "=" * 10 in text


def test_no_entries_log_still_valid():
    log = PipelineLogger()
    text = log.get_log_text()
    assert "PIPELINE LOG" in text
    assert "[STEP" not in text
    assert "[LLM" not in text


def test_multiline_prompt_indented():
    log = PipelineLogger()
    log.llm_call("t", "line1\nline2\nline3", "response", 10)
    text = log.get_log_text()
    assert "  line1" in text
    assert "  line2" in text
    assert "  line3" in text


def test_step_no_detail():
    log = PipelineLogger()
    log.step("bare_step")
    text = log.get_log_text()
    assert "bare_step" in text


def test_llm_none_duration():
    log = PipelineLogger()
    log.llm_call("t", "p", "r", None)
    text = log.get_log_text()
    assert "Noms" in text or "None" in text  # "None ms" or "Noms" depending on format
