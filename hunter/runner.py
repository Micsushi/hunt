import os
import sys

if __package__ is None or __package__ == "":
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import signal
import time
from datetime import UTC, datetime

from hunter.config import (
    BACKFILL_HOURS_OLD,
    BACKFILL_INTERVAL_SECONDS,
    PUBLIC_FEED_DISCOVERY,
    RUN_INTERVAL_SECONDS,
)
from hunter.db import (
    count_pending_jobs_for_enrichment,
    count_ready_jobs_for_enrichment,
    get_runtime_state,
    set_runtime_state,
)
from hunter.discovery_run import stop_requested
from hunter.scraper import scrape

_shutdown = False


def _handle_signal(signum, frame):
    global _shutdown
    print(f"\n[runner] Received signal {signum}, saving progress and stopping new work.")
    _shutdown = True
    stop_requested.set()


signal.signal(signal.SIGTERM, _handle_signal)
signal.signal(signal.SIGINT, _handle_signal)

_LAST_BACKFILL_KEY = "hunt_last_discovery_backfill"


def _backfill_due(now=None):
    now = now or datetime.now(UTC)
    row = get_runtime_state([_LAST_BACKFILL_KEY]).get(_LAST_BACKFILL_KEY)
    if not row or not row.get("value"):
        return True
    try:
        previous = datetime.fromisoformat(row["value"])
        if previous.tzinfo is None:
            previous = previous.replace(tzinfo=UTC)
    except (TypeError, ValueError):
        return True
    return (now - previous).total_seconds() >= BACKFILL_INTERVAL_SECONDS


def main():
    run_number = 0
    while not _shutdown:
        run_number += 1
        print(f"\n{'=' * 60}")
        print(
            f"[runner] Run #{run_number} started at {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}"
        )
        print(f"{'=' * 60}")

        start = time.time()
        try:
            backfill = _backfill_due()
            summary = scrape(
                hours_old=BACKFILL_HOURS_OLD if backfill else None,
                include_public_sources=PUBLIC_FEED_DISCOVERY,
                include_company_queue=True,
                discovery_due_only=not backfill,
            )
            if backfill and not (summary or {}).get("interrupted"):
                set_runtime_state(_LAST_BACKFILL_KEY, datetime.now(UTC).isoformat())
            if summary and summary.get("enrichment_exit_code") not in (None, 0):
                print("[runner] Post-scrape enrichment finished with some unresolved failures.")
            print(
                "[runner] Enrichment queue "
                f"ready={count_ready_jobs_for_enrichment()} "
                f"pending={count_pending_jobs_for_enrichment()}"
            )
        except Exception as e:
            print(f"[runner] Run #{run_number} failed with error: {e}")

        elapsed = time.time() - start
        minutes, seconds = divmod(int(elapsed), 60)
        print(f"[runner] Run #{run_number} finished in {minutes}m {seconds}s")

        if _shutdown:
            break

        next_run = datetime.fromtimestamp(time.time() + RUN_INTERVAL_SECONDS)
        print(
            f"[runner] Next run at {next_run.strftime('%Y-%m-%d %H:%M:%S')} "
            f"(sleeping {RUN_INTERVAL_SECONDS // 60}m)"
        )

        # Sleep in small increments so SIGTERM/SIGINT is caught promptly
        sleep_end = time.time() + RUN_INTERVAL_SECONDS
        while time.time() < sleep_end and not _shutdown:
            time.sleep(1)

    print("[runner] Shutting down cleanly.")


if __name__ == "__main__":
    main()
