import json

import pytest

from fletcher.resume.review_io import atomic_json, publication_lock


def test_failed_publication_preserves_previous_record(tmp_path, monkeypatch):
    target = tmp_path / "record.json"
    atomic_json(target, {"revision": 1})

    def fail(*args):
        raise OSError("synthetic replace failure")

    monkeypatch.setattr("fletcher.resume.review_io.os.replace", fail)
    with pytest.raises(OSError, match="synthetic"):
        atomic_json(target, {"revision": 2})
    assert json.loads(target.read_text()) == {"revision": 1}
    assert list(tmp_path.iterdir()) == [target]


def test_publication_lock_is_bounded_and_released(tmp_path):
    with publication_lock(tmp_path):
        with pytest.raises(ValueError, match="busy"):
            with publication_lock(tmp_path, timeout=0.02):
                pytest.fail("overlapping writer acquired lock")
    with publication_lock(tmp_path, timeout=0.02):
        pass
