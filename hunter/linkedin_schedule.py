"""Pace scheduled LinkedIn enrichment independently of discovery scans."""

import json
import random
import time

from hunter.config import ENRICHMENT_HEADFUL, ENRICHMENT_SLOW_MO_MS, ENRICHMENT_TIMEOUT_MS
from hunter.db import compare_and_set_runtime_state, get_runtime_state
from hunter.discovery_run import stop_requested
from hunter.enrichment_dispatch import run_enrichment_round

_SCHEDULE_KEY = "hunt_linkedin_enrichment_starts"
_HOUR_SECONDS = 3600
_MIN_PER_HOUR = 5
_MAX_PER_HOUR = 15
_SLOT_GRACE_SECONDS = 30
_MIN_START_GAP_SECONDS = 60


def _hour_slots(hour_start):
    # Keep the same plan for this hour if the scheduler restarts.
    rng = random.Random(hour_start)
    target = rng.randint(_MIN_PER_HOUR, _MAX_PER_HOUR)
    segment_seconds = _HOUR_SECONDS / target
    return [
        hour_start + (index + rng.uniform(0.15, 0.85)) * segment_seconds for index in range(target)
    ]


def _claim_due_slot(now):
    hour_start = int(now // _HOUR_SECONDS) * _HOUR_SECONDS
    if not any(0 <= now - slot < _SLOT_GRACE_SECONDS for slot in _hour_slots(hour_start)):
        return False

    previous = get_runtime_state([_SCHEDULE_KEY]).get(_SCHEDULE_KEY, {}).get("value")
    starts = [start for start in json.loads(previous or "[]") if now - start < _HOUR_SECONDS]
    if len(starts) >= _MAX_PER_HOUR:
        return False
    if starts and now - starts[-1] < _MIN_START_GAP_SECONDS:
        return False

    return compare_and_set_runtime_state(_SCHEDULE_KEY, previous, json.dumps([*starts, now]))


def run_linkedin_enrichment_schedule(stopped):
    while not (stopped.is_set() or stop_requested.is_set()):
        try:
            if _claim_due_slot(time.time()):
                if stopped.is_set() or stop_requested.is_set():
                    return
                run_enrichment_round(
                    limit=1,
                    sources=("linkedin",),
                    headless=not ENRICHMENT_HEADFUL,
                    slow_mo=ENRICHMENT_SLOW_MO_MS,
                    timeout_ms=ENRICHMENT_TIMEOUT_MS,
                )
        except Exception as exc:
            print(f"[linkedin-schedule] Enrichment could not run: {exc}")
        stopped.wait(10)
