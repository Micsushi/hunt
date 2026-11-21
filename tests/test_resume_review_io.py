import json

import pytest

from fletcher.resume.review_io import atomic_json, publication_lock


def test_publication_lock_and_failed_replace_preserve_the_previous_revision(tmp_path, monkeypatch):
    target = tmp_path / "record.json"
    with publication_lock(tmp_path):
        atomic_json(target, {"revision": 1})
        with pytest.raises(ValueError, match="busy"):
            with publication_lock(tmp_path, timeout=0.02):
                pytest.fail("overlapping writer acquired lock")

    before = set(tmp_path.iterdir())

    def fail(*args):
        raise OSError("synthetic replace failure")

    monkeypatch.setattr("fletcher.resume.review_io.os.replace", fail)
    with pytest.raises(OSError, match="synthetic"), publication_lock(tmp_path, timeout=0.02):
        atomic_json(target, {"revision": 2})
    assert json.loads(target.read_text()) == {"revision": 1}
    assert set(tmp_path.iterdir()) == before
    with publication_lock(tmp_path, timeout=0.02):
        pass
