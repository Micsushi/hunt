import base64
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from hunter import db  # noqa: E402
from scripts import c3_apply_prep  # noqa: E402
from scripts.reload_c3_extension import find_c3_target  # noqa: E402


class Component3Stage1Tests(unittest.TestCase):
    def make_temp_db_path(self):
        fd, path = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        return path

    def with_temp_db(self):
        class TempDbContext:
            def __init__(self, outer):
                self.outer = outer
                self.path = outer.make_temp_db_path()
                self.old_db_path = db.DB_PATH
                self.old_env_db_path = os.environ.get("HUNT_DB_PATH")

            def __enter__(self):
                db.DB_PATH = self.path
                os.environ["HUNT_DB_PATH"] = self.path
                db.init_db()
                return self.path

            def __exit__(self, exc_type, exc, tb):
                db.DB_PATH = self.old_db_path
                if self.old_env_db_path is None:
                    os.environ.pop("HUNT_DB_PATH", None)
                else:
                    os.environ["HUNT_DB_PATH"] = self.old_env_db_path
                if os.path.exists(self.path):
                    os.remove(self.path)

        return TempDbContext(self)

    def with_temp_orchestration_root(self):
        class TempRootContext:
            def __init__(self):
                self.root = tempfile.TemporaryDirectory()
                self.old_coord = os.environ.get("HUNT_COORDINATOR_ROOT")
                self.old_orch = os.environ.get("HUNT_ORCHESTRATION_ROOT")

            def __enter__(self):
                os.environ.pop("HUNT_COORDINATOR_ROOT", None)
                os.environ.pop("HUNT_ORCHESTRATION_ROOT", None)
                os.environ["HUNT_COORDINATOR_ROOT"] = self.root.name
                return self.root.name

            def __exit__(self, exc_type, exc, tb):
                for key in ("HUNT_COORDINATOR_ROOT", "HUNT_ORCHESTRATION_ROOT"):
                    os.environ.pop(key, None)
                if self.old_coord is not None:
                    os.environ["HUNT_COORDINATOR_ROOT"] = self.old_coord
                if self.old_orch is not None:
                    os.environ["HUNT_ORCHESTRATION_ROOT"] = self.old_orch
                self.root.cleanup()

        return TempRootContext()

    def insert_job(self, path, **overrides):
        defaults = {
            "title": "Software Engineer",
            "company": "Acme",
            "location": "Canada",
            "job_url": "https://www.linkedin.com/jobs/view/123",
            "apply_url": "https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/123",
            "description": "Interesting entry-level role.",
            "source": "linkedin",
            "date_posted": "2026-04-06",
            "is_remote": 1,
            "level": "junior",
            "priority": 0,
            "category": "engineering",
            "apply_type": "external_apply",
            "auto_apply_eligible": 1,
            "enrichment_status": "done",
            "enrichment_attempts": 1,
            "apply_host": "acme.wd5.myworkdayjobs.com",
            "ats_type": "workday",
            "last_enrichment_error": None,
            "last_enrichment_started_at": None,
            "next_enrichment_retry_at": None,
            "latest_resume_job_description_path": "",
            "latest_resume_flags": "",
            "selected_resume_version_id": "",
            "selected_resume_pdf_path": "",
            "selected_resume_tex_path": "",
            "selected_resume_selected_at": None,
            "selected_resume_ready_for_c3": 0,
        }
        defaults.update(overrides)

        conn = sqlite3.connect(path)
        try:
            conn.execute(
                """
                INSERT INTO jobs (
                    title, company, location, job_url, apply_url, description,
                    source, date_posted, is_remote, level, priority, category,
                    apply_type, auto_apply_eligible, enrichment_status,
                    enrichment_attempts, apply_host, ats_type, last_enrichment_error,
                    last_enrichment_started_at, next_enrichment_retry_at,
                    latest_resume_job_description_path, latest_resume_flags,
                    selected_resume_version_id, selected_resume_pdf_path,
                    selected_resume_tex_path, selected_resume_selected_at,
                    selected_resume_ready_for_c3
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    defaults["title"],
                    defaults["company"],
                    defaults["location"],
                    defaults["job_url"],
                    defaults["apply_url"],
                    defaults["description"],
                    defaults["source"],
                    defaults["date_posted"],
                    defaults["is_remote"],
                    defaults["level"],
                    defaults["priority"],
                    defaults["category"],
                    defaults["apply_type"],
                    defaults["auto_apply_eligible"],
                    defaults["enrichment_status"],
                    defaults["enrichment_attempts"],
                    defaults["apply_host"],
                    defaults["ats_type"],
                    defaults["last_enrichment_error"],
                    defaults["last_enrichment_started_at"],
                    defaults["next_enrichment_retry_at"],
                    defaults["latest_resume_job_description_path"],
                    defaults["latest_resume_flags"],
                    defaults["selected_resume_version_id"],
                    defaults["selected_resume_pdf_path"],
                    defaults["selected_resume_tex_path"],
                    defaults["selected_resume_selected_at"],
                    defaults["selected_resume_ready_for_c3"],
                ),
            )
            conn.commit()
            return conn.execute(
                "SELECT id FROM jobs WHERE job_url = ?",
                (defaults["job_url"],),
            ).fetchone()[0]
        finally:
            conn.close()

    def test_init_db_migrates_selected_resume_columns(self):
        path = self.make_temp_db_path()
        old_db_path = db.DB_PATH
        try:
            db.DB_PATH = path
            conn = sqlite3.connect(path)
            conn.execute(
                """
                CREATE TABLE jobs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    title TEXT NOT NULL,
                    company TEXT,
                    location TEXT,
                    job_url TEXT UNIQUE NOT NULL,
                    apply_url TEXT,
                    description TEXT,
                    source TEXT,
                    date_posted TEXT,
                    is_remote BOOLEAN,
                    status TEXT DEFAULT 'new',
                    date_scraped TEXT DEFAULT CURRENT_TIMESTAMP,
                    level TEXT,
                    priority BOOLEAN DEFAULT 0,
                    category TEXT
                )
                """
            )
            conn.commit()
            conn.close()

            db.init_db()

            conn = sqlite3.connect(path)
            columns = {row[1] for row in conn.execute("PRAGMA table_info(jobs)").fetchall()}
            conn.close()

            self.assertIn("selected_resume_version_id", columns)
            self.assertIn("selected_resume_pdf_path", columns)
            self.assertIn("selected_resume_tex_path", columns)
            self.assertIn("selected_resume_selected_at", columns)
            self.assertIn("selected_resume_ready_for_c3", columns)
            self.assertIn("latest_resume_job_description_path", columns)
            self.assertIn("latest_resume_flags", columns)
        finally:
            db.DB_PATH = old_db_path
            if os.path.exists(path):
                os.remove(path)

    def test_update_selected_resume_for_job_updates_apply_context(self):
        with self.with_temp_db() as path:
            job_id = self.insert_job(path)

            updated = db.update_selected_resume_for_job(
                job_id,
                version_id="resume-v1",
                pdf_path=str(REPO_ROOT / "sample_resume.pdf"),
                tex_path=str(REPO_ROOT / "main.tex"),
                ready_for_c3=True,
            )

            self.assertEqual(updated, 1)
            context = db.get_apply_context_for_job(job_id)
            self.assertEqual(context["selected_resume_version_id"], "resume-v1")
            self.assertTrue(context["selected_resume_pdf_path"].endswith("sample_resume.pdf"))
            self.assertTrue(context["selected_resume_tex_path"].endswith("main.tex"))
            self.assertTrue(context["selected_resume_ready_for_c3"])
            self.assertTrue(context["selected_resume_selected_at"])

    def test_build_apply_prep_payload_embeds_resume_and_writes_apply_context_artifact(self):
        with self.with_temp_db() as path:
            with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as resume_file:
                resume_file.write(b"%PDF-1.4 test resume")
                resume_file.flush()
                resume_path = resume_file.name

            try:
                job_id = self.insert_job(
                    path,
                    job_url="https://www.linkedin.com/jobs/view/456",
                    enrichment_status="done",
                    last_enrichment_error=None,
                    latest_resume_job_description_path=str(REPO_ROOT / "tmp_jd.txt"),
                    latest_resume_flags='["manual_review_recommended", "weak_description"]',
                    selected_resume_version_id="resume-v2",
                    selected_resume_pdf_path=resume_path,
                    selected_resume_tex_path=str(REPO_ROOT / "main.tex"),
                    selected_resume_ready_for_c3=1,
                )

                with self.with_temp_orchestration_root():
                    payload = c3_apply_prep.build_apply_prep_payload(job_id, embed_resume_data=True)
                    self.assertTrue(Path(payload["applyContextPath"]).exists())

                self.assertEqual(payload["jobId"], str(job_id))
                self.assertEqual(payload["atsType"], "workday")
                self.assertEqual(payload["selectedResumeVersionId"], "resume-v2")
                self.assertEqual(payload["selectedResumePath"], resume_path)
                self.assertEqual(payload["selectedResumeTexPath"], str(REPO_ROOT / "main.tex"))
                self.assertTrue(payload["selectedResumeSummary"])
                self.assertTrue(payload["selectedResumeReadyForC3"])
                self.assertEqual(payload["jdSnapshotPath"], str(REPO_ROOT / "tmp_jd.txt"))
                self.assertIn("manual_review_recommended", payload["concernFlags"])
                self.assertIn("weak_description", payload["concernFlags"])
                self.assertEqual(payload["selectedResumeName"], Path(resume_path).name)
                self.assertEqual(payload["selectedResumeMimeType"], "application/pdf")
                self.assertTrue(
                    payload["selectedResumeDataUrl"].startswith("data:application/pdf;base64,")
                )
                self.assertTrue(payload["primedAt"])
                self.assertTrue(payload["applyContextPath"])

                encoded_payload = payload["selectedResumeDataUrl"].split(",", 1)[1]
                self.assertEqual(base64.b64decode(encoded_payload), b"%PDF-1.4 test resume")
            finally:
                if os.path.exists(resume_path):
                    os.remove(resume_path)

    def test_build_apply_prep_payload_rejects_jobs_that_are_not_ready(self):
        with self.with_temp_db() as path:
            job_id = self.insert_job(
                path,
                job_url="https://www.linkedin.com/jobs/view/789",
                apply_type="easy_apply",
                auto_apply_eligible=0,
                selected_resume_ready_for_c3=0,
            )

            with self.assertRaises(c3_apply_prep.ApplyPrepNotReadyError) as error:
                c3_apply_prep.build_apply_prep_payload(job_id)

            self.assertEqual(error.exception.job_id, job_id)
            self.assertEqual(error.exception.reason, "not_external_apply")
            self.assertIn("not_external_apply", error.exception.flags)

    def test_resume_tex_parser_extracts_profile_from_main_tex(self):
        parser_path = REPO_ROOT / "executioner" / "src" / "options" / "resume-parser.js"
        main_tex_path = REPO_ROOT / "main.tex"
        script = f"""
            import {{ readFileSync }} from 'node:fs';
            import {{ parseResumeTex, listMissingProfileFields }} from {json.dumps(parser_path.as_uri())};
            const tex = readFileSync({json.dumps(str(main_tex_path))}, 'utf8');
            const profile = parseResumeTex(tex);
            console.log(JSON.stringify({{
                profile,
                missing: listMissingProfileFields(profile),
            }}));
        """

        try:
            result = subprocess.run(
                ["node", "--input-type=module", "-e", script],
                check=True,
                capture_output=True,
                text=True,
            )
        except FileNotFoundError:
            self.skipTest("node is required to test the C3 TeX parser")

        payload = json.loads(result.stdout)
        profile = payload["profile"]

        self.assertEqual(profile["fullName"], "Michael Shi")
        self.assertEqual(profile["email"], "wenjian2@ualberta.ca")
        self.assertEqual(profile["location"], "Edmonton, AB")
        self.assertEqual(profile["websiteUrl"], "https://mshi.ca")
        self.assertEqual(profile["linkedinUrl"], "https://linkedin.com/in/wjshi")
        self.assertEqual(profile["githubUrl"], "https://github.com/micsushi")
        self.assertIn("Phone", payload["missing"])

    def test_fill_route_names_cover_standalone_db_and_c4_modes(self):
        route_path = REPO_ROOT / "executioner" / "src" / "background" / "fill-routes.js"
        script = f"""
            import {{ selectFillRoute }} from {json.dumps(route_path.as_uri())};
            const availableAdapters = ["generic", "workday"];
            const routes = {{
                standaloneGeneric: selectFillRoute({{
                    activeApplyContext: {{}},
                    detectedAtsType: "unknown",
                    availableAdapters,
                }}),
                standaloneAts: selectFillRoute({{
                    activeApplyContext: {{}},
                    detectedAtsType: "workday",
                    availableAdapters,
                }}),
                dbGeneric: selectFillRoute({{
                    activeApplyContext: {{ jobId: "123", sourceMode: "db", atsType: "greenhouse" }},
                    detectedAtsType: "greenhouse",
                    availableAdapters,
                }}),
                dbAts: selectFillRoute({{
                    activeApplyContext: {{ jobId: "123", sourceMode: "db", atsType: "workday" }},
                    detectedAtsType: "workday",
                    availableAdapters,
                }}),
                c4Generic: selectFillRoute({{
                    activeApplyContext: {{ jobId: "123", sourceMode: "c4", atsType: "lever" }},
                    detectedAtsType: "lever",
                    availableAdapters,
                }}),
                c4Ats: selectFillRoute({{
                    activeApplyContext: {{ jobId: "123", sourceMode: "c4", atsType: "workday" }},
                    detectedAtsType: "workday",
                    availableAdapters,
                }}),
            }};
            console.log(JSON.stringify(routes));
        """

        try:
            result = subprocess.run(
                ["node", "--input-type=module", "-e", script],
                check=True,
                capture_output=True,
                text=True,
            )
        except FileNotFoundError:
            self.skipTest("node is required to test the C3 fill router")

        routes = json.loads(result.stdout)
        self.assertEqual(routes["standaloneGeneric"]["routeName"], "standalone_generic")
        self.assertEqual(routes["standaloneAts"]["routeName"], "standalone_ats_specific")
        self.assertEqual(routes["dbGeneric"]["routeName"], "db_generic")
        self.assertTrue(routes["dbGeneric"]["usedGenericFallback"])
        self.assertEqual(routes["dbAts"]["routeName"], "db_ats_specific")
        self.assertEqual(routes["c4Generic"]["routeName"], "c4_generic")
        self.assertTrue(routes["c4Generic"]["usedGenericFallback"])
        self.assertEqual(routes["c4Ats"]["routeName"], "c4_ats_specific")

    def test_devtools_target_picker_finds_c3_options_page(self):
        target = find_c3_target(
            [
                {
                    "id": "page-1",
                    "type": "page",
                    "title": "Other",
                    "url": "https://example.com",
                },
                {
                    "id": "extension-options",
                    "type": "page",
                    "title": "Hunt Apply Options",
                    "url": "chrome-extension://abc/src/options/options.html",
                },
            ]
        )

        self.assertEqual(target["id"], "extension-options")


if __name__ == "__main__":
    unittest.main()
