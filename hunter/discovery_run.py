"""Shared scan ownership and checkpoints, using the existing runtime-state store."""

import hashlib
import json
import threading
import time
import uuid

from hunter.db import get_connection, get_runtime_state, set_runtime_state

RUN_KEY = "discovery_run"
LEASE_KEY = "discovery_run_lease"
stop_requested = threading.Event()


class ScanBusy(RuntimeError):
    pass


class ScanStopped(BaseException):
    """Not a source error; broad transport handlers must not swallow cancellation."""


def check_cancelled():
    if stop_requested.is_set():
        raise ScanStopped()


def read_progress():
    row = get_runtime_state([RUN_KEY]).get(RUN_KEY, {})
    try:
        value = json.loads(row.get("value") or "{}")
        return value if isinstance(value, dict) else {}
    except (ValueError, TypeError):
        return {}


def scan_is_running():
    row = get_runtime_state([LEASE_KEY]).get(LEASE_KEY, {})
    try:
        value = json.loads(row.get("value") or "{}")
        return isinstance(value, dict) and value.get("expires", 0) > time.time()
    except (ValueError, TypeError, AttributeError):
        return False


def _claim(previous, value):
    """Compare-and-swap works across both SQLite and PostgreSQL processes."""
    conn = get_connection()
    try:
        if previous is None:
            cursor = conn.execute(
                "INSERT INTO runtime_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING",
                (LEASE_KEY, value),
            )
        else:
            cursor = conn.execute(
                "UPDATE runtime_state SET value = ? WHERE key = ? AND value = ?",
                (value, LEASE_KEY, previous),
            )
        conn.commit()
        return cursor.rowcount == 1
    finally:
        conn.close()


class ScanRun:
    def __init__(self, settings):
        self.signature = hashlib.sha256(json.dumps(settings, sort_keys=True).encode()).hexdigest()
        self.owner = uuid.uuid4().hex
        self.lock = threading.RLock()
        self.finished = threading.Event()
        self.lost = False

    def __enter__(self):
        row = get_runtime_state([LEASE_KEY]).get(LEASE_KEY, {})
        previous = row.get("value")
        try:
            lease = json.loads(previous or "{}")
        except (ValueError, TypeError):
            lease = {}
        if not isinstance(lease, dict):
            lease = {}
        if isinstance(lease.get("expires"), (int, float)) and lease["expires"] > time.time():
            raise ScanBusy("A discovery scan is already running")
        self.lease = json.dumps({"owner": self.owner, "expires": time.time() + 120})
        if not _claim(previous, self.lease):
            raise ScanBusy("A discovery scan is already running")
        try:
            prior = read_progress()
            resumable = (
                prior.get("signature") == self.signature
                and prior.get("state") != "completed"
                and isinstance(prior.get("started_at"), (int, float))
                and isinstance(prior.get("completed"), list)
                and isinstance(prior.get("saved"), int)
                and 0 <= time.time() - prior["started_at"] < 86400
            )
            self.progress = (
                prior
                if resumable
                else {
                    "signature": self.signature,
                    "started_at": time.time(),
                    "completed": [],
                    "saved": 0,
                }
            )
            self.progress.update(state="running", active={}, resumed=bool(resumable))
            self._write()
        except BaseException:
            _claim(self.lease, "{}")
            raise
        self.thread = threading.Thread(target=self._heartbeat, daemon=True)
        self.thread.start()
        return self

    def _write(self):
        self.progress["updated_at"] = time.time()
        set_runtime_state(RUN_KEY, json.dumps(self.progress))

    def _heartbeat(self):
        while not self.finished.wait(20):
            try:
                renewed = json.dumps({"owner": self.owner, "expires": time.time() + 120})
                if not _claim(self.lease, renewed):
                    self.lost = True
                    return
                self.lease = renewed
            except Exception:
                self.lost = True
                return

    def stopped(self):
        return stop_requested.is_set() or self.lost

    def pending_terms(self, source, terms):
        with self.lock:
            return {
                category: [
                    term
                    for term in values
                    if f"query:{source}: {category} / {term}" not in self.progress["completed"]
                ]
                for category, values in terms.items()
            }

    def start(self, key):
        with self.lock:
            if self.stopped() or key in self.progress["completed"]:
                return False
            self.progress["active"][key] = time.time()
            self._write()
            return True

    def saved(self, key, count=0, *, complete=True):
        with self.lock:
            if self.lost:
                raise ScanBusy("Discovery scan ownership was lost")
            self.progress["saved"] += count
            self.progress["last_saved_at"] = time.time()
            if complete:
                self.progress["active"].pop(key, None)
                if key not in self.progress["completed"]:
                    self.progress["completed"].append(key)
            self._write()

    def __exit__(self, exc_type, exc, traceback):
        self.finished.set()
        self.thread.join()
        if not self.lost:
            with self.lock:
                self.progress["state"] = (
                    "interrupted" if exc_type or self.stopped() else "completed"
                )
                self.progress["active"] = {}
                self.progress["finished_at"] = time.time()
                try:
                    self._write()
                finally:
                    _claim(self.lease, "{}")
