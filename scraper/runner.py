import sys
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import signal
import time
from datetime import datetime

from scraper import scrape
from config import RUN_INTERVAL_SECONDS
from db import get_linkedin_queue_summary

_shutdown = False

def _handle_signal(signum, frame):
    global _shutdown
    print(f"\n[runner] Received signal {signum}, will stop after current run completes.")
    _shutdown = True

signal.signal(signal.SIGTERM, _handle_signal)
signal.signal(signal.SIGINT, _handle_signal)

def main():
    run_number = 0
    while not _shutdown:
        run_number += 1
        print(f"\n{'='*60}")
        print(f"[runner] Run #{run_number} started at {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        print(f"{'='*60}")

        start = time.time()
        try:
            summary = scrape()
            if summary and summary.get("enrichment_exit_code") not in (None, 0):
                print("[runner] Post-scrape enrichment finished with some unresolved failures.")
            queue_summary = get_linkedin_queue_summary()
            print(
                "[runner] LinkedIn queue "
                f"ready={queue_summary['ready_count']} "
                f"pending={queue_summary['pending_count']} "
                f"blocked={queue_summary['blocked_count']} "
                f"stale_processing={queue_summary['stale_processing_count']}"
            )
        except Exception as e:
            print(f"[runner] Run #{run_number} failed with error: {e}")

        elapsed = time.time() - start
        minutes, seconds = divmod(int(elapsed), 60)
        print(f"[runner] Run #{run_number} finished in {minutes}m {seconds}s")

        if _shutdown:
            break

        next_run = datetime.fromtimestamp(time.time() + RUN_INTERVAL_SECONDS)
        print(f"[runner] Next run at {next_run.strftime('%Y-%m-%d %H:%M:%S')} "
              f"(sleeping {RUN_INTERVAL_SECONDS // 60}m)")

        # Sleep in small increments so SIGTERM/SIGINT is caught promptly
        sleep_end = time.time() + RUN_INTERVAL_SECONDS
        while time.time() < sleep_end and not _shutdown:
            time.sleep(1)

    print("[runner] Shutting down cleanly.")

if __name__ == "__main__":
    main()
