from __future__ import annotations

from fletcher.llm import rag


def test_score_bullets_for_drop_uses_top_three_average(monkeypatch):
    vectors = {
        "bullet": [1.0, 0.0],
        "kw1": [1.0, 0.0],
        "kw2": [0.8, 0.6],
        "kw3": [0.6, 0.8],
        "kw4": [0.0, 1.0],
    }

    monkeypatch.setattr(rag, "_embed", lambda text: vectors[text])

    scores = rag.score_bullets_for_drop(["bullet"], ["kw1", "kw2", "kw3", "kw4"])

    assert scores == [0.8]
