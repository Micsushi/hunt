import importlib
import sqlite3


class _FakeCursor:
    lastrowid = None

    def fetchone(self):
        return {"username": "admin"}


class _FakeConn:
    def __init__(self):
        self.queries = []
        self.closed = False

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        return False

    def execute(self, query, params=()):
        self.queries.append((query, params))
        return _FakeCursor()

    def close(self):
        self.closed = True


def test_auth_session_uses_db_compat_connection(monkeypatch, tmp_path):
    fake_conn = _FakeConn()
    calls = []

    def fake_get_connection():
        calls.append("called")
        return fake_conn

    import hunter.db_compat as db_compat

    monkeypatch.setenv("HUNT_DB_URL", "postgresql://example")
    monkeypatch.setattr(db_compat, "get_connection", fake_get_connection)
    monkeypatch.setattr(
        sqlite3,
        "connect",
        lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("sqlite3.connect used")),
    )

    import backend.auth_session as auth_session

    importlib.reload(auth_session)
    auth_session.init_sessions_table()
    token = auth_session.create_session("admin")

    assert auth_session.validate_session(token) == "admin"
    assert calls
    assert fake_conn.closed


def test_job_json_normalizes_boolean_fields_to_ints():
    from backend.app import _job_json

    row = {
        "id": 1,
        "is_remote": True,
        "priority": False,
        "auto_apply_eligible": True,
        "selected_resume_ready_for_c3": False,
        "latest_resume_jd_usable": 1,
    }

    data = _job_json(row)

    assert data["is_remote"] == 1
    assert data["priority"] == 0
    assert data["auto_apply_eligible"] == 1
    assert data["selected_resume_ready_for_c3"] == 0
    assert data["latest_resume_jd_usable"] == 1
