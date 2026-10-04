"""Exercise the unattended C1 flow without C0, C2, AI, or external accounts."""

import builtins
import json
import os
import tempfile
import threading
import unittest
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch


class PackagedRunnerTest(unittest.TestCase):
    def test_http_discovery_persistence_and_restart_without_other_components(self):
        from hunter import config, db, runner, scraper

        occupations = {
            "healthcare": ("Registered Nurse", "Provide patient care and coordinate treatment."),
            "education": ("Primary School Teacher", "Teach lessons and assess student progress."),
            "trades": (
                "Journeyperson Electrician",
                "Install wiring and maintain electrical systems.",
            ),
            "retail": ("Retail Cashier", "Process purchases and assist customers in the store."),
        }
        postings = {
            f"/{category}/careers": {
                "@type": "JobPosting",
                "title": title,
                "url": f"/jobs/{category}",
                "jobLocation": {"address": {"addressCountry": "CA"}},
                "datePosted": datetime.now(UTC).date().isoformat(),
                "description": description,
            }
            for category, (title, description) in occupations.items()
        }
        requests = []

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                requests.append(self.path)
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.end_headers()
                self.wfile.write(
                    (
                        '<script type="application/ld+json">'
                        + json.dumps(postings[self.path])
                        + "</script>"
                    ).encode()
                )

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        original_import = builtins.__import__

        def c1_only(name, *args, **kwargs):
            if name.split(".")[0] in {"backend", "fletcher", "chromadb", "openai", "ollama"}:
                raise ImportError(f"C1 must not require {name}")
            return original_import(name, *args, **kwargs)

        summaries = []

        def one_cycle(**kwargs):
            result = scraper.scrape(**kwargs)
            summaries.append(result)
            runner._shutdown = True
            return result

        try:
            with tempfile.TemporaryDirectory() as directory:
                path = str(Path(directory) / "hunt.db")
                with (
                    patch.dict(
                        os.environ, HUNT_DB_URL="", HUNT_DB_PATH=path, HUNT_AUDIT_LOG_ROOT=directory
                    ),
                    patch.object(db, "DB_PATH", path),
                    patch.object(
                        config,
                        "SEARCH_TERMS",
                        {key: [value[0]] for key, value in occupations.items()},
                    ),
                    patch.object(config, "TARGETING_CONFIGURED", False),
                    patch.object(scraper, "SITES", []),
                    patch.object(scraper, "ENRICH_AFTER_SCRAPE", False),
                    patch.object(
                        scraper,
                        "COMPANY_CAREER_SITES",
                        {
                            f"Unseen {category} employer": f"http://127.0.0.1:{server.server_port}/{category}/careers"
                            for category in occupations
                        },
                    ),
                    patch.object(scraper, "_notify_priority_jobs") as notify,
                    patch.object(runner, "PUBLIC_FEED_DISCOVERY", False),
                    patch.object(runner, "scrape", one_cycle),
                    patch("builtins.__import__", side_effect=c1_only),
                ):
                    for _ in range(2):
                        with patch.object(runner, "_shutdown", False):
                            runner.main()
                    self.assertEqual([r["inserted"] for r in summaries], [4, 0])
                    self.assertCountEqual(requests, postings)
                    jobs = db.get_all_jobs()
                    self.assertEqual(len(jobs), 4)
                    self.assertEqual({job["category"] for job in jobs}, set(occupations))
                    for job in jobs:
                        self.assertIsNone(job["discovery_suppressed_reason"])
                        self.assertFalse(job["auto_apply_eligible"])
                        self.assertEqual(
                            [row["id"] for row in db.search_jobs(job["title"])], [job["id"]]
                        )
                    self.assertTrue(
                        all(row["state"] == "partial" for row in db.list_company_fetch_queue())
                    )
                    self.assertFalse(runner._backfill_due())
                    self.assertTrue(notify.called)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)


if __name__ == "__main__":
    unittest.main()
