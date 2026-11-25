import os
import sys

if __package__ is None or __package__ == "":
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import signal
import time
from datetime import UTC, datetime
from threading import Event, Thread

from hunter.config import (
    BACKFILL_HOURS_OLD,
    BACKFILL_INTERVAL_SECONDS,
    ENRICH_AFTER_SCRAPE,
    ENRICHMENT_BATCH_LIMIT,
    PUBLIC_FEED_DISCOVERY,
    RUN_INTERVAL_SECONDS,
)
from hunter.db import (
    count_pending_jobs_for_enrichment,
    count_ready_jobs_for_enrichment,
    get_runtime_state,
    set_runtime_state,
)
from hunter.discovery_run import ScanBusy, stop_requested
from hunter.linkedin_schedule import run_linkedin_enrichment_schedule
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
    linkedin_stop = Event()
    linkedin_worker = None
    if ENRICH_AFTER_SCRAPE and ENRICHMENT_BATCH_LIMIT > 0:
        linkedin_worker = Thread(
            target=run_linkedin_enrichment_schedule,
            args=(linkedin_stop,),
            name="linkedin-enrichment",
            daemon=True,
        )
        linkedin_worker.start()

    run_number = 0
    while not _shutdown:
        run_number += 1
        print(f"\n{'=' * 60}")
        print(
            f"[runner] Run #{run_number} started at {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}"
        )
        print(f"{'=' * 60}")

        start = time.monotonic()
        retry_busy = False
        try:
            backfill = _backfill_due()
            summary = scrape(
                hours_old=BACKFILL_HOURS_OLD if backfill else None,
                include_public_sources=PUBLIC_FEED_DISCOVERY,
                include_company_queue=True,
                discovery_due_only=not backfill,
                include_linkedin_enrichment=False,
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
        except ScanBusy:
            retry_busy = True
            print("[runner] Another discovery scan holds the lease. Checking again in 30s.")
        except Exception as e:
            print(f"[runner] Run #{run_number} failed with error: {e}")

        elapsed = time.monotonic() - start
        minutes, seconds = divmod(int(elapsed), 60)
        print(f"[runner] Run #{run_number} finished in {minutes}m {seconds}s")

        if _shutdown:
            break

        remaining = 30 if retry_busy else max(0, RUN_INTERVAL_SECONDS - elapsed)
        next_run = datetime.fromtimestamp(time.time() + remaining)
        print(f"[runner] Next run at {next_run:%Y-%m-%d %H:%M:%S} (in {remaining:.0f}s)")

        # Stay responsive to shutdown and avoid running two cycles at once.
        sleep_end = time.monotonic() + remaining
        while time.monotonic() < sleep_end and not _shutdown:
            time.sleep(min(1, max(0, sleep_end - time.monotonic())))

    if linkedin_worker is not None:
        linkedin_stop.set()
        linkedin_worker.join()
    print("[runner] Shutting down cleanly.")


if __name__ == "__main__":
    main()
