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
        self.assertEqual(profile["education"][0]["school"], "University of Alberta")
        self.assertIn("Computer Science", profile["education"][0]["degree"])
        self.assertEqual(profile["education"][0]["degreeLevel"], "Bachelors")
        self.assertEqual(profile["education"][0]["fieldOfStudy"], "Computer Science")
        self.assertNotIn("Awards", profile["education"][0]["overallResult"])
        self.assertEqual(profile["education"][0]["endYear"], "2026")
        self.assertEqual(profile["workExperience"][0]["company"], "INVIDI Technologies")
        self.assertEqual(
            profile["workExperience"][0]["jobTitle"], "Junior Software Developer (Part-time)"
        )
        self.assertIn("Kotlin microservices", profile["workExperience"][0]["description"])
        self.assertTrue(profile["workExperience"][0]["description"].startswith("- "))
        self.assertIn("($38,000)", profile["workExperience"][1]["description"])
        self.assertNotIn(r"\$", profile["workExperience"][1]["description"])
        self.assertIn("Python", profile["skills"])
        self.assertIn("Kubernetes", profile["skills"])
        self.assertIn("Phone", payload["missing"])

    def test_resume_text_and_pdf_parser_extract_experience_sections(self):
        parser_path = REPO_ROOT / "executioner" / "src" / "options" / "resume-parser.js"
        resume_text = """
Michael Shi
Edmonton, AB | wenjian2@ualberta.ca | https://mshi.ca | https://linkedin.com/in/wjshi | https://github.com/micsushi

Education
University of Alberta, BSc in Computer Science with Specialization
Expected Graduation: Sep 2026

Experience
Junior Software Developer, INVIDI Technologies -- Edmonton, AB | May 2025 - Feb 2026
- Built Kotlin microservices and browser automation.

Software Developer Intern, INVIDI Technologies -- Edmonton, AB | May 2024 - May 2025
- Built production tooling.

Technical Skills
Languages: Python, TypeScript
Tools: React, Kubernetes
"""
        long_bullet_resume_text = """
Michael Shi
Edmonton, AB | wenjian2@ualberta.ca | https://mshi.ca

Experience
Junior Software Developer, INVIDI Technologies -- Edmonton, AB | May 2025 - Present
Enhanced real-time subscriber targeting accuracy by developing Kotlin microservices that integrated external marketing, forecasting, and analytics platforms via RESTful APIs.
Established S3 cost saving blueprint for 100+ developers, resulting in a 74% (\\$18,000) reduction by implementing intelligent-tiering and S3 life cycle policies in our Terraform architecture.
Accelerated deployment cycles and saved 2 hours of weekly developer time by automating CI/CD via Bitbucket pipelines and ECR/Kubernetes.
Optimized bug detection speed by configuring Datadog metrics, monitors and centralized logging with automated alerting and error traces.
Drove technical alignment by presenting completed features to stakeholders and leading design discussion meetings to gather feedback and refine system architecture.
Minimized product downtime by resolving critical production node failures and bugs during on-call incident management.

Education
University of Alberta, BSc in Computer Science with Specialization
Expected Graduation: Sep 2026
"""
        inline_bullet_resume_text = """
Michael Shi
Edmonton, AB | wenjian2@ualberta.ca | https://mshi.ca

Experience
Teaching Assistant, University of Alberta -- Edmonton, AB | Sep 2023 - Apr 2024
- Taught multiple upper-level Computer Science courses, providing instructional support and mentoring students in advanced programming concepts. - Mentored 500+ students in technical best practices, ensuring a 95% project success rate in attaining A/A+ grades through Agile workflow facilitation. - Reduced evaluation time by 85% and ensured grading consistency by developing Python-based automation scripts for grading workflows.

Education
University of Alberta, BSc in Computer Science with Specialization
Expected Graduation: Sep 2026
"""

        def pdf_literal(line):
            return line.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")

        pdf_source = "%PDF-1.4\n" + "\n".join(
            f"({pdf_literal(line)}) Tj" for line in resume_text.splitlines()
        )
        long_bullet_pdf_source = "%PDF-1.4\n" + "\n".join(
            f"({pdf_literal(line)}) Tj" for line in long_bullet_resume_text.splitlines()
        )
        inline_bullet_pdf_source = "%PDF-1.4\n" + "\n".join(
            f"({pdf_literal(line)}) Tj" for line in inline_bullet_resume_text.splitlines()
        )
        script = f"""
            import {{ parseResumeText, parseResumePdfBytes }} from {json.dumps(parser_path.as_uri())};
            const textProfile = parseResumeText({json.dumps(resume_text)});
            const pdfProfile = parseResumePdfBytes(new TextEncoder().encode({json.dumps(pdf_source)}));
            const longTextProfile = parseResumeText({json.dumps(long_bullet_resume_text)});
            const longPdfProfile = parseResumePdfBytes(new TextEncoder().encode({json.dumps(long_bullet_pdf_source)}));
            const inlineTextProfile = parseResumeText({json.dumps(inline_bullet_resume_text)});
            const inlinePdfProfile = parseResumePdfBytes(new TextEncoder().encode({json.dumps(inline_bullet_pdf_source)}));
            console.log(JSON.stringify({{ textProfile, pdfProfile, longTextProfile, longPdfProfile, inlineTextProfile, inlinePdfProfile }}));
        """

        try:
            result = subprocess.run(
                ["node", "--input-type=module", "-e", script],
                check=True,
                capture_output=True,
                text=True,
            )
        except FileNotFoundError:
            self.skipTest("node is required to test the C3 resume parser")

        payload = json.loads(result.stdout)
        for profile_key in ["textProfile", "pdfProfile"]:
            profile = payload[profile_key]
            self.assertEqual(profile["fullName"], "Michael Shi")
            self.assertEqual(profile["email"], "wenjian2@ualberta.ca")
            self.assertEqual(profile["education"][0]["school"], "University of Alberta")
            self.assertEqual(profile["education"][0]["degreeLevel"], "Bachelors")
            self.assertEqual(profile["education"][0]["fieldOfStudy"], "Computer Science")
            self.assertEqual(profile["education"][0]["overallResult"], "")
            self.assertEqual(profile["education"][0]["endYear"], "2026")
            self.assertEqual(len(profile["workExperience"]), 2)
            self.assertEqual(profile["workExperience"][0]["company"], "INVIDI Technologies")
            self.assertEqual(profile["workExperience"][0]["startMonth"], "05")
            self.assertEqual(profile["workExperience"][0]["endYear"], "2026")
            self.assertTrue(profile["workExperience"][0]["description"].startswith("- "))
            self.assertIn("Python", profile["skills"])
            self.assertIn("Kubernetes", profile["skills"])

        for profile_key in ["longTextProfile", "longPdfProfile"]:
            description = payload[profile_key]["workExperience"][0]["description"]
            self.assertEqual(description.count("\n- "), 5)
            self.assertTrue(description.startswith("- Enhanced real-time"))
            self.assertIn("- Established S3 cost saving blueprint", description)
            self.assertIn("($18,000)", description)
            self.assertIn("- Minimized product downtime", description)

        for profile_key in ["inlineTextProfile", "inlinePdfProfile"]:
            description = payload[profile_key]["workExperience"][0]["description"]
            self.assertEqual(description.count("\n- "), 2)
            self.assertTrue(description.startswith("- Taught multiple upper-level"))
            self.assertIn("\n- Mentored 500+ students", description)
            self.assertIn("\n- Reduced evaluation time", description)

    def test_fill_route_names_cover_standalone_db_and_c4_modes(self):
        route_path = REPO_ROOT / "executioner" / "src" / "background" / "fill-routes.js"
        script = f"""
            import {{ selectFillRoute }} from {json.dumps(route_path.as_uri())};
            const availableAdapters = ["generic", "workday", "greenhouse", "lever"];
            const routes = {{
                filler: selectFillRoute({{
                    activeApplyContext: {{}},
                    detectedAtsType: "unknown",
                    availableAdapters,
                }}),
                atsFiller: selectFillRoute({{
                    activeApplyContext: {{}},
                    detectedAtsType: "workday",
                    availableAdapters,
                }}),
                dbFiller: selectFillRoute({{
                    activeApplyContext: {{ jobId: "123", sourceMode: "db", atsType: "icims" }},
                    detectedAtsType: "icims",
                    availableAdapters,
                }}),
                dbGreenhouse: selectFillRoute({{
                    activeApplyContext: {{ jobId: "123", sourceMode: "db", atsType: "greenhouse" }},
                    detectedAtsType: "greenhouse",
                    availableAdapters,
                }}),
                dbAtsFiller: selectFillRoute({{
                    activeApplyContext: {{ jobId: "123", sourceMode: "db", atsType: "workday" }},
                    detectedAtsType: "workday",
                    availableAdapters,
                }}),
                c4Filler: selectFillRoute({{
                    activeApplyContext: {{ jobId: "123", sourceMode: "c4", atsType: "taleo" }},
                    detectedAtsType: "taleo",
                    availableAdapters,
                }}),
                c4Lever: selectFillRoute({{
                    activeApplyContext: {{ jobId: "123", sourceMode: "c4", atsType: "lever" }},
                    detectedAtsType: "lever",
                    availableAdapters,
                }}),
                c4AtsFiller: selectFillRoute({{
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
        self.assertEqual(routes["filler"]["routeName"], "filler")
        self.assertEqual(routes["atsFiller"]["routeName"], "ats_filler")
        self.assertEqual(routes["dbFiller"]["routeName"], "db_filler")
        self.assertTrue(routes["dbFiller"]["usedGenericFallback"])
        self.assertEqual(routes["dbGreenhouse"]["routeName"], "db_ats_filler")
        self.assertFalse(routes["dbGreenhouse"]["usedGenericFallback"])
        self.assertEqual(routes["dbAtsFiller"]["routeName"], "db_ats_filler")
        self.assertEqual(routes["c4Filler"]["routeName"], "c4_filler")
        self.assertTrue(routes["c4Filler"]["usedGenericFallback"])
        self.assertEqual(routes["c4Lever"]["routeName"], "c4_ats_filler")
        self.assertEqual(routes["c4AtsFiller"]["routeName"], "c4_ats_filler")

    def test_ats_registry_detects_embedded_greenhouse_and_popular_backlog(self):
        registry_path = REPO_ROOT / "executioner" / "src" / "ats" / "registry.js"
        matrix_path = REPO_ROOT / "executioner" / "src" / "ats" / "support-matrix.js"
        script = f"""
            import {{ ATS_REGISTRY, chooseDetectedAtsType, detectAtsFromUrl }} from {json.dumps(registry_path.as_uri())};
            import {{ genericBackedAtsNames }} from {json.dumps(matrix_path.as_uri())};
            const result = {{
                greenhouseFrame: detectAtsFromUrl("https://job-boards.greenhouse.io/embed/job_app?for=hootsuite"),
                hootsuiteEmbedded: chooseDetectedAtsType({{
                    pageUrl: "https://careers.hootsuite.com/job/123",
                    frameUrls: ["https://job-boards.greenhouse.io/embed/job_app?for=hootsuite"],
                    embeddedAtsTypes: [],
                    availableAdapters: ["generic", "workday", "greenhouse"],
                }}),
                workable: detectAtsFromUrl("https://apply.workable.com/acme/j/123"),
                oracle: detectAtsFromUrl("https://eezy.fa.ca2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/job/19347/apply/email"),
                taleo: detectAtsFromUrl("https://acme.taleo.net/careersection/jobdetail.ftl"),
                genericBacked: genericBackedAtsNames(),
                names: ATS_REGISTRY.map((entry) => entry.name),
            }};
            console.log(JSON.stringify(result));
        """

        try:
            result = subprocess.run(
                ["node", "--input-type=module", "-e", script],
                check=True,
                capture_output=True,
                text=True,
            )
        except FileNotFoundError:
            self.skipTest("node is required to test the C3 ATS registry")

        payload = json.loads(result.stdout)
        self.assertEqual(payload["greenhouseFrame"], "greenhouse")
        self.assertEqual(payload["hootsuiteEmbedded"], "greenhouse")
        self.assertEqual(payload["workable"], "workable")
        self.assertEqual(payload["oracle"], "oracle")
        self.assertEqual(payload["taleo"], "taleo")
        self.assertIn("greenhouse", payload["genericBacked"])
        self.assertIn("lever", payload["genericBacked"])
        self.assertIn("oracle", payload["genericBacked"])
        self.assertIn("icims", payload["names"])

    def test_extension_has_c4_polling_scaffold(self):
        backend_app = (REPO_ROOT / "backend" / "app.py").read_text(encoding="utf-8")
        manifest = json.loads((REPO_ROOT / "executioner" / "manifest.json").read_text())
        settings = (REPO_ROOT / "executioner" / "src" / "shared" / "settings.js").read_text(
            encoding="utf-8"
        )
        storage = (REPO_ROOT / "executioner" / "src" / "shared" / "storage.js").read_text(
            encoding="utf-8"
        )
        background = (REPO_ROOT / "executioner" / "src" / "background" / "index.js").read_text(
            encoding="utf-8"
        )
        api = (REPO_ROOT / "executioner" / "src" / "shared" / "api.js").read_text(encoding="utf-8")
        shared_utils = (REPO_ROOT / "executioner" / "src" / "shared" / "injected.js").read_text(
            encoding="utf-8"
        )
        background = (REPO_ROOT / "executioner" / "src" / "background" / "index.js").read_text(
            encoding="utf-8"
        )
        fill_runner = (
            REPO_ROOT / "executioner" / "src" / "background" / "fill-runner.js"
        ).read_text(encoding="utf-8")
        popup_js = (REPO_ROOT / "executioner" / "src" / "popup" / "popup.js").read_text(
            encoding="utf-8"
        )
        popup_html = (REPO_ROOT / "executioner" / "src" / "popup" / "popup.html").read_text(
            encoding="utf-8"
        )
        options = (REPO_ROOT / "executioner" / "src" / "options" / "options.html").read_text(
            encoding="utf-8"
        )
        clear_pipeline_v2 = (
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "clear-pipeline.js"
        ).read_text(encoding="utf-8")
        safe_next = (REPO_ROOT / "executioner" / "src" / "background" / "safe-next.js").read_text(
            encoding="utf-8"
        )

        self.assertIn("alarms", manifest["permissions"])
        self.assertIn("downloads", manifest["permissions"])
        self.assertEqual(manifest["host_permissions"], ["<all_urls>"])
        self.assertEqual(manifest["content_scripts"][0]["matches"], ["<all_urls>"])
        self.assertIn("c4PollingEnabled", settings)
        self.assertIn("autoPromptEnabled", settings)
        self.assertIn("autoAccountSignupLoginEnabled", settings)
        self.assertIn("autoEmailVerificationEnabled", settings)
        self.assertIn("emailVerificationBridgeUrl", settings)
        self.assertIn("emailVerificationTimeoutSeconds", settings)
        self.assertIn("autoClickNextAfterFill", settings)
        self.assertIn("autoClickNextAfterFill: true", settings)
        self.assertIn("fillRequiredOnly", settings)
        self.assertIn("settingsVersion: 6", settings)
        self.assertIn("browserContext", settings)
        self.assertIn("DEFAULT_BROWSER_CONTEXT", settings)
        self.assertIn("autoExportLogs", settings)
        self.assertIn("debugLogSinkEnabled", settings)
        self.assertIn("accountEmail", settings)
        self.assertIn("accountPassword", settings)
        self.assertIn("phoneDeviceType", settings)
        self.assertIn("phoneCountryCode", settings)
        self.assertIn("middleName", settings)
        self.assertIn("city", settings)
        self.assertIn("province", settings)
        self.assertIn("country", settings)
        self.assertIn("addressLine1", settings)
        self.assertIn("addressLine2", settings)
        self.assertIn("postalCode", settings)
        self.assertIn("applicationSource", settings)
        self.assertIn("applicationSourceCategory", settings)
        self.assertIn("applicationSourceDetail", settings)
        self.assertIn("profile-phone-device-type", options)
        self.assertIn("profile-phone-country-code", options)
        self.assertIn("profile-city", options)
        self.assertIn("profile-province", options)
        self.assertIn("profile-country", options)
        self.assertIn("profile-application-source-category", options)
        self.assertIn("coOpTermsCompleted", settings)
        self.assertIn("workExperience", settings)
        self.assertIn("education", settings)
        self.assertIn("skills", settings)
        self.assertIn("canadianCitizenOrPermanentResident", settings)
        self.assertIn("sinStartsWithNine", settings)
        self.assertIn("sinExpiryDate", settings)
        self.assertIn("interestedTemporaryShortContract", settings)
        self.assertIn("disclosureGender", settings)
        self.assertIn("disclosureTransExperience", settings)
        self.assertIn("disclosureLgbqIdentity", settings)
        self.assertIn("disclosureDisability", settings)
        self.assertIn("disclosureIndigenousIdentity", settings)
        self.assertIn("disclosureVisibleMinority", settings)
        self.assertIn("disclosureVeteranStatus", settings)
        self.assertIn("llmAnswerFallbackEnabled", settings)
        self.assertIn("useFieldPipelineV2", settings)
        self.assertIn("useFieldPipelineV2: true", settings)
        self.assertIn("useFieldPipelineV2: true", storage)
        self.assertIn("degreeLevel", settings)
        self.assertIn("highestEducation", settings)
        self.assertIn("preferredEducationIndex", settings)
        self.assertIn("autoExportLogPrefix", settings)
        self.assertIn("backendUrl", settings)
        self.assertIn("serviceToken", settings)
        self.assertIn("pollIntervalSeconds", storage)
        self.assertIn("emailVerificationBridgeUrl", storage)
        self.assertIn("function sanitizeBackendUrl", storage)
        self.assertIn('"http://127.0.0.1:8000"', storage)
        self.assertIn("DEFAULT_SETTINGS.backendUrl", storage)
        self.assertIn("sanitizeText(profile.middleName)", storage)
        self.assertIn("sanitizeText(profile.phoneCountryCode)", storage)
        self.assertIn("sanitizeV2Audit", storage)
        self.assertIn("sanitizeBrowserContext", storage)
        self.assertIn("STORAGE_KEYS.browserContext", storage)
        self.assertIn("autoClickNextAfterFill", storage)
        self.assertIn("function sameJson", storage)
        self.assertIn("const localPatch = {}", storage)
        self.assertIn("if (Object.keys(localPatch).length)", storage)
        self.assertIn("fetchPendingFills", api)
        self.assertIn("/api/c3/pending-fills", api)
        self.assertIn("/api/c3/fill-result", api)
        self.assertIn("/api/c3/debug-log", api)
        self.assertIn("postAnswerDecision", api)
        self.assertIn("/api/c3/answer-decision", api)
        self.assertIn("chrome.alarms.onAlarm", background)
        self.assertIn("hunt.apply.poll_c4_once", background)
        self.assertIn("hunt.apply.click_next_after_fill", background)
        self.assertIn("createSafeNextFunction", background)
        self.assertIn("V2_PAGE_WALK_MAX_PAGES", background)
        self.assertIn("runV2PageWalkAfterFill", background)
        self.assertIn("c3_v2_page_walk", background)
        self.assertIn("c3_v2_clear_audit", background)
        self.assertIn("after_next_validation_repair", background)
        self.assertIn("visible_validation_errors_after_next", background)
        self.assertIn('reason === "visible_validation_errors_after_next"', background)
        self.assertIn("class C3AuthWorkflow", background)
        self.assertIn("class C3ApplyEntryWorkflow", background)
        self.assertIn("class C3JobFillWorkflow", background)
        self.assertIn("class C3CombinedFillWorkflow", background)
        self.assertIn("c3_workflow_phase", background)
        self.assertIn("workflow.${this.name}.${action}", background)
        self.assertIn('super({ ...input, name: "auth" })', background)
        self.assertIn('super({ ...input, name: "apply_entry" })', background)
        self.assertIn('super({ ...input, name: "job_fill" })', background)
        self.assertIn("createClickAuthPrimaryActionFunction", background)
        self.assertIn("clickAuthPrimaryActionForTab", background)
        self.assertIn('kind: "auth_primary_action"', background)
        self.assertIn("clicked_auth_primary_action", background)
        self.assertIn("checkVisibleAuthConsentBoxes", background)
        self.assertIn("checkedConsentBoxes", background)
        self.assertIn("auth_action_did_not_advance", background)
        self.assertIn("currentStepIsAuth ||", background)
        self.assertIn('var wantsLandingChoice = authUiState === "landing_choice"', background)
        self.assertIn("exactEmailSignin", background)
        self.assertIn("\\bsign in with email\\b", background)
        self.assertIn("score = 135", background)
        self.assertIn("(startApplication && /\\/apply\\/applyManually/i.test(label))", background)
        self.assertIn("createClickWorkdayApplyManuallyFunction", background)
        self.assertIn("isWorkdayDetailsApplyLabel", background)
        self.assertIn("isPlainWorkdayApplyCandidate", background)
        self.assertIn("isApplyManuallyCandidate", background)
        self.assertIn('path.includes("/job/")', background)
        self.assertIn('/\\/(?:details|job)\\//i.test(location.pathname || "")', background)
        self.assertNotIn('[id*="error"]', safe_next)
        self.assertIn("function currentWorkdayStep()", background)
        self.assertIn("preferClick: isPlainApplyFirstClick", background)
        self.assertIn("function v2ReviewIssues", background)
        self.assertIn('"warn", "blocked", "error"', background)
        self.assertIn("clearCurrentPageV2", background)
        self.assertIn('id="c4-polling-enabled"', options)
        self.assertIn('id="poll-c4-once"', options)
        self.assertIn('id="auto-prompt-enabled"', options)
        self.assertIn('id="auto-account-signup-login-enabled"', options)

        self.assertIn('id="auto-email-verification-enabled"', options)
        self.assertIn('id="email-verification-timeout-seconds"', options)
        self.assertIn('id="email-verification-bridge-url"', options)
        self.assertIn('id="auto-click-next-after-fill"', options)
        self.assertIn('id="fill-required-only"', options)
        self.assertIn('id="auto-export-logs"', options)
        self.assertIn('id="debug-log-sink-enabled"', options)
        self.assertNotIn('id="use-field-pipeline-v2"', options)
        self.assertIn('id="auto-export-log-prefix"', options)
        self.assertIn('id="backend-url-status"', popup_js + popup_html)
        self.assertIn('id="service-token-status"', popup_js + popup_html)
        self.assertIn("summarizeBackendUrl", popup_js)
        self.assertIn('id="profile-account-email"', options)
        self.assertIn('id="profile-account-password"', options)
        self.assertIn('id="export-logs-now"', options)
        self.assertIn('id="test-debug-log-sink"', options)
        self.assertIn('id="activity-log-count"', options)
        self.assertIn('data-tab-target="experience"', options)
        self.assertIn('id="work-experience-list"', options)
        self.assertIn('id="education-list"', options)
        self.assertIn('id="profile-skills"', options)
        self.assertIn('id="profile-canadian-citizen-pr"', options)
        self.assertIn('id="profile-sin-starts-with-nine"', options)
        self.assertIn('id="profile-sin-expiry-date"', options)
        self.assertIn('id="profile-temporary-short-contract"', options)
        self.assertIn('id="profile-disclosure-gender"', options)
        self.assertIn('id="profile-disclosure-trans-experience"', options)
        self.assertIn('id="profile-disclosure-lgbq"', options)
        self.assertIn('id="profile-disclosure-disability"', options)
        self.assertIn('id="profile-disclosure-indigenous"', options)
        self.assertIn('id="profile-disclosure-visible-minority"', options)
        self.assertIn('id="profile-disclosure-veteran"', options)
        self.assertIn('id="profile-degree-level"', options)
        self.assertIn('id="profile-highest-education"', options)
        self.assertIn('id="profile-preferred-education-index"', options)
        self.assertIn("max-height: min(420px, 52vh)", options)
        options_js = (REPO_ROOT / "executioner" / "src" / "options" / "options.js").read_text(
            encoding="utf-8"
        )
        self.assertIn("const currentProfile = readFullProfileForm()", options_js)
        self.assertIn("mergeProfileFromResume(currentProfile, parsedProfile)", options_js)
        self.assertIn("hunt.apply.export_logs", background)
        self.assertIn("hunt.apply.test_debug_log_sink", background)
        self.assertIn("chrome.downloads.download", background)
        self.assertIn("data:application/json;base64", background)
        self.assertIn("utf8Base64", background)
        self.assertNotIn("URL.createObjectURL", background)
        self.assertIn("showPageToast", background)
        self.assertIn("debugIdentityForState", background)
        self.assertIn('pipelineVersion: "v2"', background)
        self.assertIn('browserContext: browserContext.name || "normal_chrome"', background)
        fill_runner = (
            REPO_ROOT / "executioner" / "src" / "background" / "fill-runner.js"
        ).read_text(encoding="utf-8")
        self.assertIn("workday-ui-v2.js", fill_runner)
        self.assertIn("workday-drivers-v2.js", fill_runner)
        self.assertIn("workday-repeatables-v2.js", fill_runner)
        self.assertIn("workday-repeatables-v2.js", background)
        workday_ui_v2 = (
            REPO_ROOT / "executioner" / "src" / "ats" / "workday" / "workday-ui-v2.js"
        ).read_text(encoding="utf-8")
        workday_drivers_v2 = (
            REPO_ROOT / "executioner" / "src" / "ats" / "workday" / "workday-drivers-v2.js"
        ).read_text(encoding="utf-8")
        workday_repeatables_v2 = (
            REPO_ROOT / "executioner" / "src" / "ats" / "workday" / "workday-repeatables-v2.js"
        ).read_text(encoding="utf-8")
        field_pipeline_v2 = (
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "field-pipeline.js"
        ).read_text(encoding="utf-8")
        self.assertIn("phone_country_code", workday_ui_v2)
        self.assertIn("workday_search_select", workday_ui_v2)
        self.assertIn("workday_popup_options_missing", workday_drivers_v2)
        self.assertIn("workday_commit_not_verified", workday_drivers_v2)
        self.assertIn("!option &&", workday_drivers_v2)
        self.assertIn('"non_disclosure"', workday_drivers_v2)
        self.assertNotIn("Boolean(state.selected && clean", workday_drivers_v2)
        self.assertIn("hasHumanText(buttonText)", workday_drivers_v2)
        self.assertIn("hasHumanText(inputVal)", workday_drivers_v2)
        self.assertIn("workday_selected_item_clear", workday_drivers_v2)
        self.assertIn("fillWorkdayRepeatables", workday_repeatables_v2)
        self.assertIn("clearWorkdayRepeatables", workday_repeatables_v2)
        self.assertIn("workday_repeatables_fill", workday_repeatables_v2)
        self.assertIn("workday_repeatables_clear", workday_repeatables_v2)
        self.assertIn("sectionHasMissingRequiredControls", workday_repeatables_v2)
        self.assertIn("educationDegreeAnswer(entry)", workday_repeatables_v2)
        self.assertIn('"Bachelor of Science"', workday_repeatables_v2)
        self.assertIn("clearResumeUpload", workday_repeatables_v2)
        self.assertIn("deleteAllRows", workday_repeatables_v2)
        self.assertIn("collectNonRepeatableWorkdayCandidates", workday_repeatables_v2)
        self.assertIn("isRepeatableElement", workday_repeatables_v2)
        self.assertIn("fillDatePairs", workday_repeatables_v2)
        self.assertIn("commitValue(control)", workday_repeatables_v2)
        self.assertIn("entry.job_title", workday_repeatables_v2)
        self.assertIn("entry.company_name", workday_repeatables_v2)
        self.assertIn("processedFieldKeys", field_pipeline_v2)
        self.assertIn("fieldIdentityKey", field_pipeline_v2)
        self.assertIn("shouldFillOptionalProfileCorrection", field_pipeline_v2)
        self.assertIn("address--countryregion", field_pipeline_v2)
        self.assertIn("activeApplyContext,\n    defaultResume", field_pipeline_v2)
        self.assertIn("activeApplyContext: activeApplyContext || {}", field_pipeline_v2)
        self.assertIn("defaultResume: defaultResume || {}", field_pipeline_v2)
        self.assertIn("activeApplyContext: context.activeApplyContext || {}", field_pipeline_v2)
        self.assertIn("defaultResume: context.defaultResume || {}", field_pipeline_v2)
        self.assertIn("containsUploadedFileText", clear_pipeline_v2)
        self.assertIn("collectUploadedFileNodes", clear_pipeline_v2)
        self.assertIn("sendDebugLog", background)
        self.assertIn("requestBackendAnswerDecisions", fill_runner)
        self.assertIn("createApplyAnswerDecisionsFunction", fill_runner)
        self.assertIn("genericBackedAtsNames", fill_runner)
        self.assertIn("detectAtsTypeForTab", fill_runner)
        self.assertIn("collectFrameSignals", fill_runner)
        self.assertIn("class C3AutofillPipeline", fill_runner)
        self.assertIn("class C3AutofillPipelineContext", fill_runner)
        self.assertIn("class ResolveActiveTabStep", fill_runner)
        self.assertIn("class DetectAtsStep", fill_runner)
        self.assertIn("class SelectFillRouteStep", fill_runner)
        self.assertIn("class ResolveFillAdapterStep", fill_runner)
        self.assertIn("class InjectSharedUtilitiesStep", fill_runner)
        self.assertIn("class RunAdapterFillStep", fill_runner)
        self.assertIn("class PrepareLlmHelpStep", fill_runner)
        self.assertIn("class PersistFillAttemptStep", fill_runner)
        self.assertIn("class BuildFillResponseStep", fill_runner)
        self.assertLess(
            fill_runner.index("new ResolveActiveTabStep()"),
            fill_runner.index("new DetectAtsStep()"),
        )
        self.assertLess(
            fill_runner.index("new DetectAtsStep()"),
            fill_runner.index("new SelectFillRouteStep()"),
        )
        self.assertLess(
            fill_runner.index("new SelectFillRouteStep()"),
            fill_runner.index("new ResolveFillAdapterStep()"),
        )
        self.assertLess(
            fill_runner.index("new ResolveFillAdapterStep()"),
            fill_runner.index("new InjectSharedUtilitiesStep()"),
        )
        self.assertLess(
            fill_runner.index("new InjectSharedUtilitiesStep()"),
            fill_runner.index("new RunAdapterFillStep()"),
        )
        self.assertLess(
            fill_runner.index("new RunAdapterFillStep()"),
            fill_runner.index("new PrepareLlmHelpStep()"),
        )
        self.assertLess(
            fill_runner.index("new PrepareLlmHelpStep()"),
            fill_runner.index("new PersistFillAttemptStep()"),
        )
        self.assertLess(
            fill_runner.index("new PersistFillAttemptStep()"),
            fill_runner.index("new BuildFillResponseStep()"),
        )
        self.assertIn("attachPendingLlmSummary", fill_runner)
        self.assertIn("markInventoryFilledByDecision", fill_runner)
        self.assertIn("pendingLlmFields", fill_runner)
        self.assertIn("SCREENSHOT_CAPTURE_TIMEOUT_MS", fill_runner)
        self.assertIn("Promise.race", fill_runner)
        self.assertIn("chrome.tabs.captureVisibleTab", fill_runner)
        self.assertIn("capture_visible_tab_timeout", fill_runner)
        self.assertIn("persistenceDiagnostics", fill_runner)
        self.assertIn("sanitizeAttempt", fill_runner)
        self.assertIn("let attempt = sanitizeAttempt(attemptPayload)", fill_runner)
        self.assertIn("debugIdentityForState(context.extensionState)", fill_runner)
        self.assertNotIn("FILL_ADAPTERS_V2", fill_runner)
        self.assertNotIn("createGenericFillFunction", fill_runner)
        self.assertNotIn("createWorkdayFillFunction", fill_runner)
        self.assertIn("v2_fill_cancelled", field_pipeline_v2)
        self.assertIn("__huntApplyActiveFillRunId", field_pipeline_v2)
        self.assertIn("__huntApplyCancelledFillRunIds", field_pipeline_v2)
        self.assertIn("shouldSkipPasswordField", field_pipeline_v2)
        self.assertIn("autoAccountSignupLoginEnabled === true", field_pipeline_v2)
        self.assertIn("profile.accountPassword", field_pipeline_v2)
        self.assertIn("src/shared/v2/audit.js", fill_runner)
        self.assertIn("c3_v2_audit", fill_runner)
        self.assertIn("v2Audit", fill_runner)
        self.assertIn("filledTextNeedsBackendRepair", fill_runner)
        self.assertIn("generated_or_placeholder_text_fallback", fill_runner)
        self.assertIn("filled required unknown textbox with fallback text", fill_runner)
        self.assertNotIn("Boolean(warning) ||", fill_runner)
        self.assertIn("entry.filled && isFallbackFill", fill_runner)
        self.assertIn('valueSource.startsWith("fallback:")', fill_runner)
        self.assertIn('tagName === "TEXTAREA"', fill_runner)
        self.assertIn("bestEffortWarning", fill_runner)
        self.assertIn("c3_backend_answer_inventory", fill_runner)
        self.assertIn("BACKEND_ANSWER_DECISION_TIMEOUT_MS", fill_runner)
        self.assertIn("abortSignal: context.options.abortSignal", fill_runner)
        self.assertIn("isCancelled: () => context.cancelled", fill_runner)
        self.assertIn("signal: abortSignal", fill_runner)
        self.assertIn("timeoutMs: BACKEND_ANSWER_DECISION_TIMEOUT_MS", fill_runner)
        self.assertIn("realisticOptionClick", fill_runner)
        self.assertIn('button[aria-haspopup="listbox"]', fill_runner)
        self.assertIn("decisionById", fill_runner)
        self.assertIn("fillWorkdayButton", fill_runner)
        self.assertIn("pointerdown", fill_runner)
        self.assertIn('keyOn(el, "Enter")', fill_runner)
        self.assertIn("answerDecisionDiagnostics", background)
        self.assertIn("extensionState = null", fill_runner)
        self.assertIn("runFillForTab(activeTabId, extensionState", fill_runner)
        self.assertIn(
            "No unanswered required questions are available for LLM help on this tab.",
            fill_runner,
        )
        self.assertIn("llm.prompt.show", background)
        self.assertIn("hunt.apply.fill_remaining_with_llm", popup_js)
        self.assertIn("showNextConfirm", popup_js)
        self.assertIn("hunt.apply.click_next_after_fill", popup_js)
        self.assertIn("const state = await getExtensionState();", background)
        self.assertIn("runPendingLlmFillForTab(", background)
        self.assertIn("new AbortController()", background)
        self.assertIn("run.abortController?.abort", background)
        self.assertIn("abortSignal: activeFillRuns.get(fillRunId)", background)
        self.assertIn("Promise.allSettled([", background)
        self.assertIn("state.settings.llmAnswerFallbackEnabled === true", background)
        self.assertIn("message.payload?.allowLlmAnswers !== false", background)
        self.assertIn("showLlmConfirm", popup_js)
        option_collector_v2 = (
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "option-collector.js"
        ).read_text(encoding="utf-8")
        self.assertIn('[role="combobox"]', option_collector_v2)
        self.assertIn("realisticOptionClick", shared_utils)
        self.assertIn("pointerdown", shared_utils)
        self.assertIn('key("Enter")', shared_utils)
        self.assertIn('state.source === "input"', shared_utils)
        self.assertNotIn("window.confirm", popup_js)
        self.assertIn("postDebugLog", background)
        self.assertIn("localActivityLogSkipped", background)
        self.assertIn("C3 activity log storage failed", background)
        self.assertIn("fill_result", background)
        self.assertIn("No default resume is saved", background)
        self.assertIn('@app.post("/api/c3/debug-log")', backend_app)
        self.assertIn('@app.post("/api/c3/answer-decision")', backend_app)
        self.assertIn('@app.get("/api/c3/llm-status")', backend_app)
        self.assertIn("c3_extension_debug.jsonl", backend_app)
        configure_debug = (REPO_ROOT / "scripts" / "configure_c3_debug_sink.js").read_text(
            encoding="utf-8"
        )
        self.assertIn('const BROWSER_CONTEXT_KEY = "hunt.apply.browserContext"', configure_debug)
        self.assertIn('name: "p_chrome"', configure_debug)
        self.assertIn('pipelineVersion: "v2"', configure_debug)
        self.assertIn("browserContext: result.browserContext", configure_debug)

    def test_v2_invalid_controls_are_treated_as_required_for_repair(self):
        inspector = (
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "ui-inspector.js"
        ).read_text(encoding="utf-8")
        self.assertIn("hasRequiredValidation", inspector)
        self.assertIn('el?.getAttribute?.("aria-invalid") === "true"', inspector)
        self.assertIn("check the box", inspector)

    def test_v2_question_identifier_prefers_work_authorization_over_country(self):
        catalog_path = REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "field-catalog.js"
        identifier_path = (
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "question-identifier.js"
        )
        resolver_path = REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "answer-resolver.js"
        script = f"""
            const fs = require("node:fs");
            const vm = require("node:vm");
            const context = {{ window: {{ __huntV2: {{}} }} }};
            vm.createContext(context);
            vm.runInContext(fs.readFileSync({json.dumps(str(catalog_path))}, "utf8"), context);
            vm.runInContext(fs.readFileSync({json.dumps(str(identifier_path))}, "utf8"), context);
            vm.runInContext(fs.readFileSync({json.dumps(str(resolver_path))}, "utf8"), context);
            const root = context.window.__huntV2;
            const field = {{
              workday: {{
                fieldLabel: "Are you legally entitled to work in the country the job is located in ?*"
              }},
              fieldId: "primaryQuestionnaire--workAuth",
              descriptor: "Are you legally entitled to work in the country the job is located in ?* Select One"
            }};
            const question = root.questionIdentifier.identifyQuestion(field, null, null);
            const answer = root.answerResolver.resolveAnswer({{
              question,
              field,
              profile: {{ workAuthorized: true }},
              audit: null,
              fieldAudit: null
            }});
            console.log(JSON.stringify({{
              type: question.type,
              source: question.source,
              value: answer.value,
              valueSource: answer.source
            }}));
        """
        try:
            result = subprocess.run(
                ["node", "-e", script],
                check=True,
                capture_output=True,
                text=True,
            )
        except FileNotFoundError:
            self.skipTest("node is required to test the C3 V2 question identifier")

        self.assertEqual(
            json.loads(result.stdout),
            {
                "type": "work_authorized",
                "source": "alias",
                "value": "Yes",
                "valueSource": "profile:workAuthorized",
            },
        )

    def test_v2_required_address_line_2_uses_nonblank_default(self):
        paths = [
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "field-catalog.js",
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "question-identifier.js",
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "answer-resolver.js",
        ]
        script = f"""
            const fs = require("node:fs");
            const vm = require("node:vm");
            const context = {{ window: {{ __huntV2: {{}} }} }};
            vm.createContext(context);
            for (const path of {json.dumps([str(path) for path in paths])}) {{
              vm.runInContext(fs.readFileSync(path, "utf8"), context);
            }}
            const root = context.window.__huntV2;
            const field = {{
              workday: {{
                fieldLabel: "Address Line 2*"
              }},
              fieldId: "address--addressLine2",
              descriptor: "Address Line 2* Error: The field Address Line 2 is required and must have a value.",
              required: true,
              uiModel: "textbox"
            }};
            const question = root.questionIdentifier.identifyQuestion(field, null, null);
            const answer = root.answerResolver.resolveAnswer({{
              question,
              field,
              profile: {{}},
              audit: null,
              fieldAudit: null
            }});
            console.log(JSON.stringify({{
              type: question.type,
              value: answer.value,
              valueSource: answer.source
            }}));
        """
        try:
            result = subprocess.run(
                ["node", "-e", script],
                check=True,
                capture_output=True,
                text=True,
            )
        except FileNotFoundError:
            self.skipTest("node is required to test the C3 V2 address default")

        self.assertEqual(
            json.loads(result.stdout),
            {
                "type": "address_line_2",
                "value": "N/A",
                "valueSource": "default:required_address_line_2",
            },
        )

    def test_v2_ethnicity_does_not_match_city_alias(self):
        paths = [
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "field-catalog.js",
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "question-identifier.js",
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "answer-resolver.js",
        ]
        script = f"""
            const fs = require("node:fs");
            const vm = require("node:vm");
            const context = {{ window: {{ __huntV2: {{}} }} }};
            vm.createContext(context);
            for (const path of {json.dumps([str(path) for path in paths])}) {{
              vm.runInContext(fs.readFileSync(path, "utf8"), context);
            }}
            const root = context.window.__huntV2;
            const field = {{
              workday: {{
                fieldLabel: "Please select the ethnicity which most accurately describes how you identify yourself."
              }},
              fieldId: "personalInfoUS--ethnicity",
              descriptor: "Please select the ethnicity which most accurately describes how you identify yourself.* Select One",
              required: true,
              uiModel: "button_listbox"
            }};
            const question = root.questionIdentifier.identifyQuestion(field, null, null);
            const answer = root.answerResolver.resolveAnswer({{
              question,
              field,
              profile: {{}},
              audit: null,
              fieldAudit: null
            }});
            console.log(JSON.stringify({{
              type: question.type,
              value: answer.value,
              valueSource: answer.source
            }}));
        """
        try:
            result = subprocess.run(
                ["node", "-e", script],
                check=True,
                capture_output=True,
                text=True,
            )
        except FileNotFoundError:
            self.skipTest("node is required to test the C3 V2 question identifier")

        self.assertEqual(
            json.loads(result.stdout),
            {
                "type": "ethnicity_disclosure_neutral",
                "value": "I decline to disclose",
                "valueSource": "default:ethnicity_disclosure_neutral",
            },
        )

    def test_v2_identity_verification_upon_hire_is_yes(self):
        paths = [
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "field-catalog.js",
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "question-identifier.js",
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "answer-resolver.js",
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "option-matcher.js",
        ]
        script = f"""
            const fs = require("node:fs");
            const vm = require("node:vm");
            const context = {{ window: {{ __huntV2: {{}} }} }};
            vm.createContext(context);
            for (const path of {json.dumps([str(path) for path in paths])}) {{
              vm.runInContext(fs.readFileSync(path, "utf8"), context);
            }}
            const root = context.window.__huntV2;
            const field = {{
              workday: {{ fieldLabel: "Can you provide verification of your identify upon hire?*" }},
              fieldId: "primaryQuestionnaire--identity",
              descriptor: "Can you provide verification of your identify upon hire?* Select One",
              required: true,
              uiModel: "button_listbox"
            }};
            const question = root.questionIdentifier.identifyQuestion(field, null, null);
            const answer = root.answerResolver.resolveAnswer({{
              question,
              field,
              profile: {{}},
              audit: null,
              fieldAudit: null
            }});
            const match = root.optionMatcher.matchOption({{
              options: [
                {{ label: "Select One", placeholder: true }},
                {{ label: "Yes" }},
                {{ label: "No" }}
              ],
              answer,
              field,
              audit: null,
              fieldAudit: null
            }});
            console.log(JSON.stringify({{
              type: question.type,
              value: answer.value,
              valueSource: answer.source,
              option: match.option && match.option.label,
              source: match.source,
              fallback: match.fallback
            }}));
        """
        try:
            result = subprocess.run(
                ["node", "-e", script],
                check=True,
                capture_output=True,
                text=True,
            )
        except FileNotFoundError:
            self.skipTest("node is required to test the C3 V2 identity answer")

        self.assertEqual(
            json.loads(result.stdout),
            {
                "type": "identity_verification_upon_hire",
                "value": "Yes",
                "valueSource": "default:identity_verification_upon_hire",
                "option": "Yes",
                "source": "exact",
                "fallback": False,
            },
        )

    def test_v2_visa_sms_and_ai_consent_dropdowns_opt_out(self):
        paths = [
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "field-catalog.js",
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "question-identifier.js",
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "answer-resolver.js",
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "option-matcher.js",
        ]
        script = f"""
            const fs = require("node:fs");
            const vm = require("node:vm");
            const context = {{ window: {{ __huntV2: {{}} }} }};
            vm.createContext(context);
            for (const path of {json.dumps([str(path) for path in paths])}) {{
              vm.runInContext(fs.readFileSync(path, "utf8"), context);
            }}
            const root = context.window.__huntV2;
            function resolve(label) {{
              const field = {{
                workday: {{ fieldLabel: label }},
                fieldId: label.includes("SMS") ? "smsConsent" : "aiProcessingConsent",
                descriptor: `${{label}} Select One`,
                required: true,
                uiModel: "button_listbox"
              }};
              const question = root.questionIdentifier.identifyQuestion(field, null, null);
              const answer = root.answerResolver.resolveAnswer({{
                question,
                field,
                profile: {{}},
                audit: null,
                fieldAudit: null
              }});
              const match = root.optionMatcher.matchOption({{
                options: [
                  {{ label: "Select One", placeholder: true }},
                  {{ label: "Opt-In" }},
                  {{ label: "Opt-Out" }}
                ],
                answer,
                field,
                audit: null,
                fieldAudit: null
              }});
              return {{
                type: question.type,
                value: answer.value,
                valueSource: answer.source,
                option: match.option && match.option.label,
                source: match.source,
                fallback: match.fallback
              }};
            }}
            console.log(JSON.stringify([
              resolve("I agree that Visa may reach out to me via SMS regarding my application and candidate experience. Message and data rates may apply. I can opt-out at any time.*"),
              resolve("Visa may use automated tools such as AI to support review of your application for this role, and if applicable, match you with relevant existing and future open roles. If you prefer not to have your application processed by these tools, you can opt-out. Opting out will not impact your eligibility for this role or to apply for relevant open roles.*")
            ]));
        """
        try:
            result = subprocess.run(
                ["node", "-e", script],
                check=True,
                capture_output=True,
                text=True,
            )
        except FileNotFoundError:
            self.skipTest("node is required to test the C3 V2 consent answers")

        self.assertEqual(
            json.loads(result.stdout),
            [
                {
                    "type": "sms_application_contact_opt_out",
                    "value": "Opt-Out",
                    "valueSource": "default:sms_application_contact_opt_out",
                    "option": "Opt-Out",
                    "source": "exact",
                    "fallback": False,
                },
                {
                    "type": "automated_ai_processing_opt_out",
                    "value": "Opt-Out",
                    "valueSource": "default:automated_ai_processing_opt_out",
                    "option": "Opt-Out",
                    "source": "exact",
                    "fallback": False,
                },
            ],
        )

    def test_v2_gender_not_declared_matches_non_disclosure(self):
        paths = [
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "field-catalog.js",
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "question-identifier.js",
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "answer-resolver.js",
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "option-matcher.js",
        ]
        script = f"""
            const fs = require("node:fs");
            const vm = require("node:vm");
            const context = {{ window: {{ __huntV2: {{}} }} }};
            vm.createContext(context);
            for (const path of {json.dumps([str(path) for path in paths])}) {{
              vm.runInContext(fs.readFileSync(path, "utf8"), context);
            }}
            const root = context.window.__huntV2;
            const field = {{
              workday: {{ fieldLabel: "What is your gender?*" }},
              fieldId: "personalInfoPerson--gender",
              descriptor: "What is your gender?* Select One",
              required: true,
              uiModel: "button_listbox"
            }};
            const question = root.questionIdentifier.identifyQuestion(field, null, null);
            const answer = root.answerResolver.resolveAnswer({{
              question,
              field,
              profile: {{}},
              audit: null,
              fieldAudit: null
            }});
            const match = root.optionMatcher.matchOption({{
              options: [
                {{ label: "Select One", placeholder: true }},
                {{ label: "Female" }},
                {{ label: "Male" }},
                {{ label: "Not Declared" }}
              ],
              answer,
              field,
              audit: null,
              fieldAudit: null
            }});
            console.log(JSON.stringify({{
              type: question.type,
              option: match.option && match.option.label,
              source: match.source,
              fallback: match.fallback
            }}));
        """
        try:
            result = subprocess.run(
                ["node", "-e", script],
                check=True,
                capture_output=True,
                text=True,
            )
        except FileNotFoundError:
            self.skipTest("node is required to test the C3 V2 gender answer")

        self.assertEqual(
            json.loads(result.stdout),
            {
                "type": "disclosure_neutral",
                "option": "Not Declared",
                "source": "alias",
                "fallback": False,
            },
        )

    def test_v2_unknown_yes_no_has_no_safe_option(self):
        paths = [
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "field-catalog.js",
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "option-matcher.js",
        ]
        script = f"""
            const fs = require("node:fs");
            const vm = require("node:vm");
            const context = {{ window: {{ __huntV2: {{}} }} }};
            vm.createContext(context);
            for (const path of {json.dumps([str(path) for path in paths])}) {{
              vm.runInContext(fs.readFileSync(path, "utf8"), context);
            }}
            const root = context.window.__huntV2;
            const match = root.optionMatcher.matchOption({{
              options: [{{ label: "Yes" }}, {{ label: "No" }}],
              answer: {{ value: "", answerType: "unknown" }},
              field: {{ required: true, uiModel: "button_listbox" }},
              audit: null,
              fieldAudit: null
            }});
            console.log(JSON.stringify({{
              option: match.option && match.option.label,
              source: match.source,
              fallback: match.fallback
            }}));
        """
        try:
            result = subprocess.run(
                ["node", "-e", script],
                check=True,
                capture_output=True,
                text=True,
            )
        except FileNotFoundError:
            self.skipTest("node is required to test the C3 V2 option matcher")

        self.assertEqual(
            json.loads(result.stdout),
            {
                "option": None,
                "source": "unknown_no_safe_option",
                "fallback": False,
            },
        )

    def test_v2_unknown_text_fallback_does_not_use_space(self):
        driver_path = REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "field-drivers.js"
        driver_source = driver_path.read_text(encoding="utf-8")
        self.assertIn('"fallback:not_applicable"', driver_source)
        self.assertIn('"fallback:na"', driver_source)
        self.assertNotIn('"fallback:space"', driver_source)

    def test_v2_background_check_consent_is_yes(self):
        paths = [
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "field-catalog.js",
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "question-identifier.js",
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "answer-resolver.js",
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "option-matcher.js",
        ]
        script = f"""
            const fs = require("node:fs");
            const vm = require("node:vm");
            const context = {{ window: {{ __huntV2: {{}} }} }};
            vm.createContext(context);
            for (const path of {json.dumps([str(path) for path in paths])}) {{
              vm.runInContext(fs.readFileSync(path, "utf8"), context);
            }}
            const root = context.window.__huntV2;
            const field = {{
              workday: {{
                fieldLabel: "Would you be willing to complete a background security check, including criminal record and references?*"
              }},
              fieldId: "primaryQuestionnaire--backgroundCheck",
              descriptor: "Would you be willing to complete a background security check, including criminal record and references?* Select One",
              uiModel: "button_listbox",
              required: true
            }};
            const question = root.questionIdentifier.identifyQuestion(field, null, null);
            const answer = root.answerResolver.resolveAnswer({{
              question,
              field,
              profile: {{}},
              audit: null,
              fieldAudit: null
            }});
            const match = root.optionMatcher.matchOption({{
              options: [
                {{ label: "No", value: "No" }},
                {{ label: "Yes", value: "Yes" }}
              ],
              answer,
              field,
              audit: null,
              fieldAudit: null
            }});
            console.log(JSON.stringify({{
              type: question.type,
              value: answer.value,
              valueSource: answer.source,
              selectedOption: match.option && match.option.label,
              optionSource: match.source,
              fallback: match.fallback
            }}));
        """
        try:
            result = subprocess.run(
                ["node", "-e", script],
                check=True,
                capture_output=True,
                text=True,
            )
        except FileNotFoundError:
            self.skipTest("node is required to test the C3 V2 background check answer")

        self.assertEqual(
            json.loads(result.stdout),
            {
                "type": "background_check_consent",
                "value": "Yes",
                "valueSource": "default:background_check_consent",
                "selectedOption": "Yes",
                "optionSource": "exact",
                "fallback": False,
            },
        )

    def test_v2_workday_application_questions_do_not_match_province(self):
        paths = [
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "field-catalog.js",
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "question-identifier.js",
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "answer-resolver.js",
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "option-matcher.js",
        ]
        script = f"""
            const fs = require("node:fs");
            const vm = require("node:vm");
            const context = {{ window: {{ __huntV2: {{}} }} }};
            vm.createContext(context);
            for (const path of {json.dumps([str(path) for path in paths])}) {{
              vm.runInContext(fs.readFileSync(path, "utf8"), context);
            }}
            const root = context.window.__huntV2;
            function resolve(fieldLabel, options, descriptorSuffix = " Country/Region Select One") {{
              const field = {{
                workday: {{ fieldLabel }},
                fieldId: "primaryQuestionnaire--workday",
                descriptor: fieldLabel + descriptorSuffix,
                uiModel: "button_listbox",
                required: true
              }};
              const question = root.questionIdentifier.identifyQuestion(field, null, null);
              const answer = root.answerResolver.resolveAnswer({{
                question,
                field,
                profile: {{ province: "Alberta" }},
                audit: null,
                fieldAudit: null
              }});
              const match = root.optionMatcher.matchOption({{
                options,
                answer,
                field,
                audit: null,
                fieldAudit: null
              }});
              return {{
                type: question.type,
                value: answer.value,
                selectedOption: match.option && match.option.label,
                fallback: match.fallback
              }};
            }}
            console.log(JSON.stringify({{
              usage: resolve("In your current job, do you use or work on the Workday system?", [
                {{ label: "Yes, I work for Workday", value: "Yes, I work for Workday" }},
                {{ label: "Yes, I work for a partner implementing or supporting Workday projects", value: "Yes, I work for a partner implementing or supporting Workday projects" }},
                {{ label: "No, I do not use the Workday system in my current job", value: "No, I do not use the Workday system in my current job" }}
              ]),
              written: resolve("Describe your interactions with the Workday system.", [], ""),
              acknowledgement: resolve("Please enter yes if you acknowledge that you have read and answered all questions truthfully and accurately.", [
                {{ label: "Yes", value: "Yes" }},
                {{ label: "No", value: "No" }}
              ])
            }}));
        """
        try:
            result = subprocess.run(
                ["node", "-e", script],
                check=True,
                capture_output=True,
                text=True,
            )
        except FileNotFoundError:
            self.skipTest("node is required to test the C3 V2 question identifier")

        self.assertEqual(
            json.loads(result.stdout),
            {
                "usage": {
                    "type": "workday_system_usage",
                    "value": "No, I do not use the Workday system in my current job",
                    "selectedOption": "No, I do not use the Workday system in my current job",
                    "fallback": False,
                },
                "written": {
                    "type": "unknown",
                    "value": "",
                    "selectedOption": None,
                    "fallback": False,
                },
                "acknowledgement": {
                    "type": "truthful_application_acknowledgement",
                    "value": "Yes",
                    "selectedOption": "Yes",
                    "fallback": False,
                },
            },
        )

    def test_v2_country_territory_is_country_not_province(self):
        paths = [
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "field-catalog.js",
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "question-identifier.js",
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "answer-resolver.js",
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "option-matcher.js",
        ]
        script = f"""
            const fs = require("node:fs");
            const vm = require("node:vm");
            const context = {{ window: {{ __huntV2: {{}} }} }};
            vm.createContext(context);
            for (const path of {json.dumps([str(path) for path in paths])}) {{
              vm.runInContext(fs.readFileSync(path, "utf8"), context);
            }}
            const root = context.window.__huntV2;
            const field = {{
              workday: {{ fieldLabel: "Country / Territory*" }},
              fieldId: "country--country",
              descriptor: "Country / Territory* Canada",
              uiModel: "button_listbox",
              required: true
            }};
            const question = root.questionIdentifier.identifyQuestion(field, null, null);
            const answer = root.answerResolver.resolveAnswer({{
              question,
              field,
              profile: {{ country: "Canada", province: "Alberta" }},
              audit: null,
              fieldAudit: null
            }});
            const match = root.optionMatcher.matchOption({{
              options: [
                {{ label: "Bonaire, Sint Eustatius, and Saba" }},
                {{ label: "Canada" }}
              ],
              answer,
              field,
              audit: null,
              fieldAudit: null
            }});
            console.log(JSON.stringify({{
              type: question.type,
              value: answer.value,
              source: answer.source,
              selectedOption: match.option && match.option.label,
              matchSource: match.source,
              fallback: match.fallback
            }}));
        """
        try:
            result = subprocess.run(
                ["node", "-e", script],
                check=True,
                capture_output=True,
                text=True,
            )
        except FileNotFoundError:
            self.skipTest("node is required to test the C3 V2 country matcher")

        self.assertEqual(
            json.loads(result.stdout),
            {
                "type": "country",
                "value": "Canada",
                "source": "profile:country",
                "selectedOption": "Canada",
                "matchSource": "exact",
                "fallback": False,
            },
        )

    def test_v2_terms_checkbox_is_deterministic_affirmative(self):
        paths = [
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "field-catalog.js",
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "question-identifier.js",
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "answer-resolver.js",
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "option-matcher.js",
        ]
        script = f"""
            const fs = require("node:fs");
            const vm = require("node:vm");
            const context = {{ window: {{ __huntV2: {{}} }} }};
            vm.createContext(context);
            for (const path of {json.dumps([str(path) for path in paths])}) {{
              vm.runInContext(fs.readFileSync(path, "utf8"), context);
            }}
            const root = context.window.__huntV2;
            const cases = [
              {{
                workday: {{
                  fieldLabel: "Yes, I have read and consent to the terms and conditions*"
                }},
                fieldId: "termsAndConditions--acceptTermsAndAgreements",
                descriptor: "Yes, I have read and consent to the terms and conditions*",
                uiModel: "checkbox"
              }},
              {{
                workday: {{
                  fieldLabel: "I agree to creating this account to allow me to apply for positions with Workday."
                }},
                fieldId: "input-39",
                descriptor: "I agree to creating this account to allow me to apply for positions with Workday.",
                uiModel: "checkbox"
              }},
              {{
                workday: {{
                  fieldLabel: "By continuing, you agree to the above Career Privacy Notice"
                }},
                fieldId: "input-9",
                descriptor: "By continuing, you agree to the above Career Privacy Notice",
                uiModel: "checkbox"
              }}
            ];
            const results = cases.map((field) => {{
              const question = root.questionIdentifier.identifyQuestion(field, null, null);
              const answer = root.answerResolver.resolveAnswer({{
                question,
                field,
                profile: {{}},
                audit: null,
                fieldAudit: null
              }});
              const match = root.optionMatcher.matchOption({{
                options: [{{ label: field.descriptor, value: field.descriptor }}],
                answer,
                field,
                audit: null,
                fieldAudit: null
              }});
              return {{
                type: question.type,
                answer: answer.value,
                valueSource: answer.source,
                optionSource: match.source,
                fallback: match.fallback
              }};
            }});
            console.log(JSON.stringify(results));
        """
        try:
            result = subprocess.run(
                ["node", "-e", script],
                check=True,
                capture_output=True,
                text=True,
            )
        except FileNotFoundError:
            self.skipTest("node is required to test the C3 V2 checkbox matcher")

        self.assertEqual(
            json.loads(result.stdout),
            [
                {
                    "type": "terms_acceptance",
                    "answer": "Yes",
                    "valueSource": "default:terms_acceptance",
                    "optionSource": "affirmative_checkbox",
                    "fallback": False,
                },
                {
                "type": "terms_acceptance",
                "answer": "Yes",
                "valueSource": "default:terms_acceptance",
                "optionSource": "affirmative_checkbox",
                "fallback": False,
                },
                {
                    "type": "terms_acceptance",
                    "answer": "Yes",
                    "valueSource": "default:terms_acceptance",
                    "optionSource": "affirmative_checkbox",
                    "fallback": False,
                },
            ],
        )

    def test_v2_workday_signature_and_current_date_prompts(self):
        paths = [
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "field-catalog.js",
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "question-identifier.js",
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "answer-resolver.js",
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "option-matcher.js",
        ]
        script = f"""
            const fs = require("node:fs");
            const vm = require("node:vm");
            const context = {{ window: {{ __huntV2: {{}} }} }};
            vm.createContext(context);
            for (const path of {json.dumps([str(path) for path in paths])}) {{
              vm.runInContext(fs.readFileSync(path, "utf8"), context);
            }}
            const root = context.window.__huntV2;
            function resolve(field, profile = {{}}) {{
              const question = root.questionIdentifier.identifyQuestion(field, null, null);
              const answer = root.answerResolver.resolveAnswer({{
                question,
                field,
                profile,
                audit: null,
                fieldAudit: null
              }});
              return {{
                type: question.type,
                value: answer.value,
                source: answer.source
              }};
            }}
            const nameField = {{
              workday: {{ fieldLabel: "Please enter your name:" }},
              fieldId: "secondaryQuestionnaire--signature",
              descriptor: "Please enter your name:*",
              uiModel: "textarea",
              required: true
            }};
            const monthField = {{
              workday: {{ fieldLabel: "Please enter today's date:" }},
              fieldId: "secondaryQuestionnaire--date-dateSectionMonth-input",
              descriptor: "Please enter today's date:* Month",
              uiModel: "text",
              required: true,
              element: {{
                getAttribute: (name) => name === "aria-label" ? "Month" : name === "data-automation-id" ? "dateSectionMonth-input" : "",
                id: "secondaryQuestionnaire--date-dateSectionMonth-input",
                name: ""
              }}
            }};
            const dayField = {{
              workday: {{ fieldLabel: "Please enter today's date:" }},
              fieldId: "secondaryQuestionnaire--date-dateSectionDay-input",
              descriptor: "Please enter today's date:* Day",
              uiModel: "text",
              required: true,
              element: {{
                getAttribute: (name) => name === "aria-label" ? "Day" : name === "data-automation-id" ? "dateSectionDay-input" : "",
                id: "secondaryQuestionnaire--date-dateSectionDay-input",
                name: ""
              }}
            }};
            const yearField = {{
              workday: {{ fieldLabel: "Please enter today's date:" }},
              fieldId: "secondaryQuestionnaire--date-dateSectionYear-input",
              descriptor: "Please enter today's date:* Year",
              uiModel: "text",
              required: true,
              element: {{
                getAttribute: (name) => name === "aria-label" ? "Year" : name === "data-automation-id" ? "dateSectionYear-input" : "",
                id: "secondaryQuestionnaire--date-dateSectionYear-input",
                name: ""
              }}
            }};
            const disabilityNameField = {{
              workday: {{ fieldLabel: "Name" }},
              fieldId: "selfIdentifiedDisabilityData--name",
              descriptor: "Name* Voluntary Self-Identification of Disability",
              uiModel: "text",
              required: true
            }};
            const disabilityDateField = {{
              workday: {{ fieldLabel: "Date" }},
              fieldId: "selfIdentifiedDisabilityData--dateSignedOn-dateSectionYear-input",
              descriptor: "Date* Year",
              uiModel: "text",
              required: true,
              element: {{
                getAttribute: (name) => name === "aria-label" ? "Year" : name === "data-automation-id" ? "dateSectionYear-input" : "",
                id: "selfIdentifiedDisabilityData--dateSignedOn-dateSectionYear-input",
                name: ""
              }}
            }};
            const agreementField = {{
              workday: {{ fieldLabel: "Have you read and agree to the Non Disclosure Agreement?" }},
              fieldId: "secondaryQuestionnaire--nda",
              descriptor: "Have you read and agree to the Non Disclosure Agreement?* Select One",
              uiModel: "button_listbox",
              required: true
            }};
            const desiredStartMonthField = {{
              workday: {{ fieldLabel: "If you receive and accept a job offer, what is the earliest date that you could start work?" }},
              fieldId: "primaryQuestionnaire--desiredStart-dateSectionMonth-input",
              descriptor: "If you receive and accept a job offer, what is the earliest date that you could start work?* Month",
              uiModel: "text",
              required: true,
              element: {{
                getAttribute: (name) => name === "aria-label" ? "Month" : name === "data-automation-id" ? "dateSectionMonth-input" : "",
                id: "primaryQuestionnaire--desiredStart-dateSectionMonth-input",
                name: ""
              }}
            }};
            const agreementQuestion = root.questionIdentifier.identifyQuestion(agreementField, null, null);
            const agreementAnswer = root.answerResolver.resolveAnswer({{
              question: agreementQuestion,
              field: agreementField,
              profile: {{}},
              audit: null,
              fieldAudit: null
            }});
            const agreementMatch = root.optionMatcher.matchOption({{
              options: [
                {{ label: "I have read and agree to the Non Disclosure Agreement" }},
                {{ label: "I have read and DO NOT agree to the Non Disclosure Agreement" }}
              ],
              answer: agreementAnswer,
              field: agreementField,
              audit: null,
              fieldAudit: null
            }});
            console.log(JSON.stringify({{
              name: resolve(nameField, {{ fullName: "Hunt Test" }}),
              month: resolve(monthField),
              day: resolve(dayField),
              year: resolve(yearField),
              disabilityName: resolve(disabilityNameField, {{ fullName: "Hunt Test" }}),
              disabilityDate: resolve(disabilityDateField),
              desiredStartMonth: resolve(desiredStartMonthField, {{ desiredStartDate: "2026-06-15" }}),
              agreement: {{
                type: agreementQuestion.type,
                answer: agreementAnswer.value,
                selectedOption: agreementMatch.option && agreementMatch.option.label,
                optionSource: agreementMatch.source,
                fallback: agreementMatch.fallback
              }}
            }}));
        """
        try:
            result = subprocess.run(
                ["node", "-e", script],
                check=True,
                capture_output=True,
                text=True,
            )
        except FileNotFoundError:
            self.skipTest("node is required to test the C3 V2 Workday date answers")

        parsed = json.loads(result.stdout)
        self.assertEqual(
            parsed["name"],
            {"type": "full_name", "value": "Hunt Test", "source": "profile:fullName"},
        )
        self.assertRegex(parsed["month"]["value"], r"^\d{2}$")
        self.assertRegex(parsed["day"]["value"], r"^\d{2}$")
        self.assertRegex(parsed["year"]["value"], r"^\d{4}$")
        self.assertEqual(parsed["month"]["source"], "default:current_date:month")
        self.assertEqual(parsed["day"]["source"], "default:current_date:day")
        self.assertEqual(parsed["year"]["source"], "default:current_date:year")
        self.assertEqual(
            parsed["disabilityName"],
            {"type": "full_name", "value": "Hunt Test", "source": "profile:fullName"},
        )
        self.assertEqual(parsed["disabilityDate"]["source"], "default:current_date:year")
        self.assertEqual(
            parsed["desiredStartMonth"],
            {
                "type": "desired_start_date",
                "value": "06",
                "source": "profile:desiredStartDate:month",
            },
        )
        self.assertEqual(
            parsed["agreement"],
            {
                "type": "terms_acceptance",
                "answer": "Yes",
                "selectedOption": "I have read and agree to the Non Disclosure Agreement",
                "optionSource": "affirmative_agreement",
                "fallback": False,
            },
        )

    def test_v2_salary_textarea_uses_profile_range_before_fallback(self):
        paths = [
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "field-catalog.js",
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "question-identifier.js",
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "answer-resolver.js",
        ]
        script = f"""
            const fs = require("node:fs");
            const vm = require("node:vm");
            const context = {{ window: {{ __huntV2: {{}} }} }};
            vm.createContext(context);
            for (const path of {json.dumps([str(path) for path in paths])}) {{
              vm.runInContext(fs.readFileSync(path, "utf8"), context);
            }}
            const root = context.window.__huntV2;
            const field = {{
              workday: {{
                fieldLabel: "Please indicate your desired salary range.*"
              }},
              fieldId: "primaryQuestionnaire--salary",
              descriptor: "Please indicate your desired salary range.*",
              tagName: "TEXTAREA",
              uiModel: "textarea",
              required: true
            }};
            const question = root.questionIdentifier.identifyQuestion(field, null, null);
            const answer = root.answerResolver.resolveAnswer({{
              question,
              field,
              profile: {{ salaryExpectationRange: "90,000 - 105,000" }},
              audit: null,
              fieldAudit: null
            }});
            console.log(JSON.stringify({{
              type: question.type,
              source: question.source,
              value: answer.value,
              valueSource: answer.source
            }}));
        """
        try:
            result = subprocess.run(
                ["node", "-e", script],
                check=True,
                capture_output=True,
                text=True,
            )
        except FileNotFoundError:
            self.skipTest("node is required to test the C3 V2 salary resolver")

        self.assertEqual(
            json.loads(result.stdout),
            {
                "type": "salary_expectation",
                "source": "alias",
                "value": "90,000 - 105,000",
                "valueSource": "profile:salaryExpectationRange",
            },
        )

    def test_v2_salary_textarea_has_default_when_profile_is_blank(self):
        paths = [
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "field-catalog.js",
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "question-identifier.js",
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "answer-resolver.js",
        ]
        script = f"""
            const fs = require("node:fs");
            const vm = require("node:vm");
            const context = {{ window: {{ __huntV2: {{}} }} }};
            vm.createContext(context);
            for (const path of {json.dumps([str(path) for path in paths])}) {{
              vm.runInContext(fs.readFileSync(path, "utf8"), context);
            }}
            const root = context.window.__huntV2;
            const field = {{
              workday: {{
                fieldLabel: "Please indicate your desired salary range.*"
              }},
              fieldId: "primaryQuestionnaire--salary",
              descriptor: "Please indicate your desired salary range.*",
              tagName: "TEXTAREA",
              uiModel: "textarea",
              required: true
            }};
            const question = root.questionIdentifier.identifyQuestion(field, null, null);
            const answer = root.answerResolver.resolveAnswer({{
              question,
              field,
              profile: {{}},
              audit: null,
              fieldAudit: null
            }});
            console.log(JSON.stringify({{
              type: question.type,
              value: answer.value,
              valueSource: answer.source,
              confidence: answer.confidence
            }}));
        """
        try:
            result = subprocess.run(
                ["node", "-e", script],
                check=True,
                capture_output=True,
                text=True,
            )
        except FileNotFoundError:
            self.skipTest("node is required to test the C3 V2 salary resolver")

        self.assertEqual(
            json.loads(result.stdout),
            {
                "type": "salary_expectation",
                "value": "90,000 - 105,000",
                "valueSource": "default:salaryExpectationRange",
                "confidence": 0.72,
            },
        )

    def test_v2_salary_dropdown_refuses_unsafe_option_fallback(self):
        paths = [
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "field-catalog.js",
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "question-identifier.js",
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "answer-resolver.js",
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "option-matcher.js",
        ]
        script = f"""
            const fs = require("node:fs");
            const vm = require("node:vm");
            const issues = [];
            const context = {{
              window: {{
                __huntV2: {{
                  audit: {{
                    pushIssue: (_audit, _fieldAudit, issue) => issues.push(issue),
                    pushFieldStep: () => undefined
                  }}
                }}
              }}
            }};
            vm.createContext(context);
            for (const path of {json.dumps([str(path) for path in paths])}) {{
              vm.runInContext(fs.readFileSync(path, "utf8"), context);
            }}
            const root = context.window.__huntV2;
            const field = {{
              workday: {{ fieldLabel: "What is your target salary range?*" }},
              fieldId: "primaryQuestionnaire--salary",
              descriptor: "What is your target salary range?* $30000 - $35000",
              uiModel: "button_listbox",
              required: true
            }};
            const question = root.questionIdentifier.identifyQuestion(field, null, null);
            const answer = root.answerResolver.resolveAnswer({{
              question,
              field,
              profile: {{ salaryExpectationRange: "90,000 - 105,000" }},
              audit: null,
              fieldAudit: null
            }});
            const match = root.optionMatcher.matchOption({{
              options: [
                {{ label: "$30000 - $35000", value: "$30000 - $35000" }},
                {{ label: "$35000 - $40000", value: "$35000 - $40000" }}
              ],
              answer,
              field,
              audit: null,
              fieldAudit: null
            }});
            console.log(JSON.stringify({{
              type: question.type,
              valueSource: answer.source,
              option: match.option ? match.option.label : "",
              source: match.source,
              fallback: match.fallback,
              issueKind: issues[0] && issues[0].kind
            }}));
        """
        try:
            result = subprocess.run(
                ["node", "-e", script],
                check=True,
                capture_output=True,
                text=True,
            )
        except FileNotFoundError:
            self.skipTest("node is required to test the C3 V2 salary matcher")

        self.assertEqual(
            json.loads(result.stdout),
            {
                "type": "salary_expectation",
                "valueSource": "profile:salaryExpectationRange",
                "option": "",
                "source": "salary_no_safe_match",
                "fallback": False,
                "issueKind": "salary_option_no_safe_match",
            },
        )

    def test_v2_salary_dropdown_matches_same_numeric_range(self):
        paths = [
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "field-catalog.js",
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "question-identifier.js",
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "answer-resolver.js",
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "option-matcher.js",
        ]
        script = f"""
            const fs = require("node:fs");
            const vm = require("node:vm");
            const context = {{ window: {{ __huntV2: {{}} }} }};
            vm.createContext(context);
            for (const path of {json.dumps([str(path) for path in paths])}) {{
              vm.runInContext(fs.readFileSync(path, "utf8"), context);
            }}
            const root = context.window.__huntV2;
            const field = {{
              workday: {{ fieldLabel: "What is your target salary range?*" }},
              fieldId: "primaryQuestionnaire--salary",
              descriptor: "What is your target salary range?*",
              uiModel: "button_listbox",
              required: true
            }};
            const question = root.questionIdentifier.identifyQuestion(field, null, null);
            const answer = root.answerResolver.resolveAnswer({{
              question,
              field,
              profile: {{ salaryExpectationRange: "90,000 - 105,000" }},
              audit: null,
              fieldAudit: null
            }});
            const match = root.optionMatcher.matchOption({{
              options: [
                {{ label: "$30000 - $35000", value: "$30000 - $35000" }},
                {{ label: "$90000 - $105000", value: "$90000 - $105000" }}
              ],
              answer,
              field,
              audit: null,
              fieldAudit: null
            }});
            console.log(JSON.stringify({{
              option: match.option ? match.option.label : "",
              source: match.source,
              fallback: match.fallback
            }}));
        """
        try:
            result = subprocess.run(
                ["node", "-e", script],
                check=True,
                capture_output=True,
                text=True,
            )
        except FileNotFoundError:
            self.skipTest("node is required to test the C3 V2 salary matcher")

        self.assertEqual(
            json.loads(result.stdout),
            {
                "option": "$90000 - $105000",
                "source": "salary_numeric_match",
                "fallback": False,
            },
        )

    def test_extension_has_detected_page_prompt_for_signup_and_ats_pages(self):
        content = (REPO_ROOT / "executioner" / "src" / "content" / "bootstrap.js").read_text(
            encoding="utf-8"
        )
        popup = (REPO_ROOT / "executioner" / "src" / "popup" / "popup.html").read_text(
            encoding="utf-8"
        )
        popup_js = (REPO_ROOT / "executioner" / "src" / "popup" / "popup.js").read_text(
            encoding="utf-8"
        )
        background = (REPO_ROOT / "executioner" / "src" / "background" / "index.js").read_text(
            encoding="utf-8"
        )
        injected = (REPO_ROOT / "executioner" / "src" / "shared" / "injected.js").read_text(
            encoding="utf-8"
        )
        safe_next = (REPO_ROOT / "executioner" / "src" / "background" / "safe-next.js").read_text(
            encoding="utf-8"
        )
        clear_pipeline = (
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "clear-pipeline.js"
        ).read_text(encoding="utf-8")
        field_drivers = (
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "field-drivers.js"
        ).read_text(encoding="utf-8")

        self.assertIn("detectPageKind", content)
        self.assertIn("ATS_HOST_PATTERNS", content)
        self.assertIn("job-boards.greenhouse.io", content)
        self.assertIn("EMBEDDED_ATS_SELECTORS", content)
        self.assertIn("#grnhse_app", content)
        self.assertIn("SIGNUP_TERMS", content)
        self.assertIn("SIGNIN_TERMS", content)
        self.assertIn("visibleFormControls", content)
        self.assertIn('atsType === "workday"', content)
        self.assertIn("hasWorkdaySigninChoice", content)
        self.assertIn("hasWorkdayLoginChoice", content)
        self.assertIn("hasSignInWithEmailAction", content)
        self.assertIn("\\bsign in with email\\b", content)
        self.assertIn('return { kind: "signup", inputCount, atsType }', content)
        self.assertIn('return { kind: "signin", inputCount, atsType }', content)
        self.assertLess(
            content.index('return { kind: "signup", inputCount, atsType }'),
            content.index('return { kind: "ats", inputCount, atsType }'),
        )
        self.assertLess(
            content.index("hasWorkdaySigninChoice"),
            content.index('return { kind: "ats", inputCount, atsType }'),
        )
        self.assertIn('detection.kind === "signin"', content)
        self.assertIn("atsType,", content)
        self.assertIn("Detected job site with Apply", content)
        self.assertIn("Detected sign-in page", content)
        self.assertIn("Detected signup page", content)
        self.assertIn("Detected job application", content)
        self.assertIn("Open the email sign-in choice before filling credentials.", content)
        self.assertIn("No credential fields are visible yet.", content)
        self.assertIn("Hunt is moving through the account sign-in step.", content)
        self.assertIn("Create account", content)
        self.assertIn("Fill application", content)
        self.assertIn("hunt.apply.fill_current_page", content)
        self.assertIn("hunt.apply.show_toast", content)
        self.assertIn("hunt-apply-page-toasts", content)
        self.assertIn("hunt.apply.show_fill_progress", content)
        self.assertIn("hunt.apply.show_fill_summary", content)
        self.assertIn("hunt-apply-fill-summary", content)
        self.assertIn("hunt.apply.hide_fill_progress", content)
        self.assertIn("hunt.apply.dismiss_transient_ui", content)
        self.assertIn("MutationObserver", content)
        self.assertIn("schedulePromptCheck", content)
        self.assertIn("navigation_click", content)
        self.assertIn("dom_change", content)
        self.assertIn("dismissedPromptSignatures", content)
        self.assertIn("hunt-apply-fill-progress-spinner", content)
        self.assertIn("function fillProgressTitle", content)
        self.assertIn("attempt\\u00a0$1", content)
        self.assertIn("white-space: nowrap", content)
        self.assertIn("text-overflow: ellipsis", content)
        self.assertIn("Filling page", content)
        self.assertIn("detected_page_prompt", content)
        self.assertIn(
            "Prompt on signup/ATS pages",
            (REPO_ROOT / "executioner" / "src" / "options" / "options.html").read_text(
                encoding="utf-8"
            ),
        )
        self.assertIn('id="auto-prompt"', popup)
        self.assertIn('id="auto-account-signup-login"', popup)
        self.assertIn('id="auto-email-verification"', popup)
        self.assertIn("autoAccountSignupLoginEnabled", popup_js)
        self.assertIn("autoEmailVerificationEnabled", popup_js)
        self.assertIn('id="llm-confirm"', popup)
        self.assertIn('id="llm-use"', popup)
        self.assertIn('id="llm-skip"', popup)
        self.assertIn('id="next-confirm"', popup)
        self.assertIn('id="next-go"', popup)
        self.assertIn('id="next-always"', popup)
        self.assertIn('id="clear-page"', popup)
        self.assertIn('id="reload-extension"', popup)
        self.assertNotIn('id="poll-c4-once"', popup)
        self.assertNotIn('id="clear-context"', popup)
        self.assertIn("sender.tab?.id", background)
        self.assertIn("hunt.apply.clear_current_page", background)
        self.assertIn("showFillProgress", background)
        self.assertIn("hideFillProgress", background)
        self.assertIn("dismissPageTransientUi", background)
        self.assertIn("await dismissPageTransientUi(tabId)", background)
        self.assertIn("await showFillProgress(tabId", background)
        self.assertIn("await hideFillProgress(tabId)", background)
        self.assertIn('triggeredBy: "popup_fill_current_page"', popup_js)
        self.assertIn("Extension reload requested from popup.", popup_js)
        self.assertIn("chrome.runtime.reload()", popup_js)
        self.assertIn("window.close()", popup_js)
        self.assertIn("page.clear", background)
        self.assertIn("allFrames: true", background)
        self.assertIn("clearCurrentPageV2", background)
        self.assertIn("runHuntV2Clear", background)
        self.assertIn("[role='combobox']", clear_pipeline)
        self.assertIn("clearGenericIconControls", clear_pipeline)
        self.assertIn("selectedControlContextFor", clear_pipeline)
        self.assertIn("generic_clear_icon_result", clear_pipeline)
        self.assertIn("uploadedFileClears", clear_pipeline)
        self.assertIn("field_clear_failed", clear_pipeline)
        self.assertIn("withTimeout", background)
        self.assertIn("safe_next_probe_timeout", background)
        self.assertIn("Safe Next check timed out.", background)
        self.assertIn("visible_validation_errors", safe_next)
        self.assertIn("visibleValidationErrors: probe.visibleValidationErrors || []", background)
        self.assertIn(
            "visibleValidationErrors: nextAction.visibleValidationErrors || []", background
        )
        self.assertIn("fieldIdentityKey", (REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "field-pipeline.js").read_text(encoding="utf-8"))
        self.assertIn("skills_not_committed", (REPO_ROOT / "executioner" / "src" / "ats" / "workday" / "workday-repeatables-v2.js").read_text(encoding="utf-8"))
        self.assertIn("Fill timed out before the page responded.", background)
        self.assertIn("fill_timeout", background)
        self.assertIn("clearUploadedFileControls", clear_pipeline)
        self.assertIn("uploadedFileClears", clear_pipeline)
        self.assertIn("successfully uploaded", clear_pipeline)
        self.assertIn("fieldDrivers.clearField", clear_pipeline)
        self.assertIn("fieldState.readFieldState", clear_pipeline)
        self.assertIn("realisticClick", background)
        self.assertIn("dispatchTextEvents", field_drivers)
        self.assertIn('new InputEvent("input"', injected)
        self.assertIn('new InputEvent("beforeinput"', injected)
        self.assertIn(".select__container", clear_pipeline)
        self.assertIn("[aria-haspopup='listbox']", clear_pipeline)
        self.assertIn("clearControlTarget", clear_pipeline)
        self.assertIn("clickVisibleUploadConfirmButton", clear_pipeline)
        self.assertIn("remove attachment:", clear_pipeline)

    def test_options_resume_save_uses_direct_storage_and_toasts(self):
        options = (REPO_ROOT / "executioner" / "src" / "options" / "options.js").read_text(
            encoding="utf-8"
        )

        self.assertIn("saveDefaultResumeDirect", options)
        self.assertIn("showToast", options)
        self.assertIn("Choose a PDF resume before saving.", options)
        self.assertIn("Default resume saved:", options)
        self.assertIn("currentDefaultResume", options)

    def test_options_settings_and_profile_autosave_changes(self):
        options = (REPO_ROOT / "executioner" / "src" / "options" / "options.js").read_text(
            encoding="utf-8"
        )
        options_html = (REPO_ROOT / "executioner" / "src" / "options" / "options.html").read_text(
            encoding="utf-8"
        )

        self.assertIn("const AUTOSAVE_DELAY_MS", options)
        self.assertIn("function installAutosave", options)
        self.assertIn('form.addEventListener("input", scheduleSave)', options)
        self.assertIn('form.addEventListener("change", scheduleSave)', options)
        self.assertIn("readSettingsForm", options)
        self.assertIn("autoAccountSignupLoginEnabled", options)
        self.assertIn("autoEmailVerificationEnabled", options)
        self.assertIn("emailVerificationTimeoutSeconds", options)
        self.assertIn('type: "hunt.apply.save_settings"', options)
        self.assertIn('type: "hunt.apply.save_profile"', options)
        self.assertIn('"settings-form"', options)
        self.assertIn('"profile-form"', options)
        self.assertIn("Settings autosaved.", options)
        self.assertIn("Profile autosaved.", options)
        self.assertIn("languageEntries", options)
        self.assertIn('id="add-language"', options_html)
        self.assertIn('id="language-list"', options_html)
        self.assertNotIn("Save Settings", options_html)
        self.assertNotIn("Save Profile", options_html)

    def test_options_activity_log_rows_expand_details(self):
        options = (REPO_ROOT / "executioner" / "src" / "options" / "options.js").read_text(
            encoding="utf-8"
        )
        options_html = (REPO_ROOT / "executioner" / "src" / "options" / "options.html").read_text(
            encoding="utf-8"
        )

        self.assertIn("function formatLogDetails", options)
        self.assertIn('toggle.textContent = "details"', options)
        self.assertIn('details.className = "log-details"', options)
        self.assertIn('row.classList.toggle("expanded")', options)
        self.assertIn(".log-entry.expanded .log-details", options_html)
        self.assertIn("grid-column: 1 / -1", options_html)

    def test_generic_manual_fixture_pages_exist_for_next_smokes(self):
        fixture_dir = REPO_ROOT / "executioner" / "fixtures" / "generic"
        signup = (fixture_dir / "signup_account.html").read_text(encoding="utf-8")
        signup_email = (fixture_dir / "signup_email_verification.html").read_text(encoding="utf-8")
        email_verified = (fixture_dir / "email_verified.html").read_text(encoding="utf-8")
        two_step = (fixture_dir / "two_step_application.html").read_text(encoding="utf-8")
        custom_selects = (fixture_dir / "greenhouse_custom_selects.html").read_text(
            encoding="utf-8"
        )

        self.assertIn("Username", signup)
        self.assertIn("Password", signup)
        self.assertIn("Confirm password", signup_email)
        self.assertIn("Email verification needed", signup_email)
        self.assertIn('data-email-verified="true"', email_verified)
        self.assertIn("Position applied for", two_step)
        self.assertIn("Why are you interested?", two_step)
        self.assertIn('role="combobox"', custom_selects)
        self.assertIn("legally eligible to work", custom_selects)
        self.assertIn("expected graduation date", custom_selects)

    def test_c3_email_verification_bridge_and_smoke_exist(self):
        bridge = (REPO_ROOT / "scripts" / "c3_mail_verify_bridge.js").read_text(encoding="utf-8")
        smoke = (REPO_ROOT / "scripts" / "c3_email_verification_smoke.js").read_text(
            encoding="utf-8"
        )
        gmail_oauth_smoke = (REPO_ROOT / "scripts" / "c3_gmail_oauth_smoke.js").read_text(
            encoding="utf-8"
        )
        cdp_lib = (REPO_ROOT / "scripts" / "lib" / "c3_cdp.js").read_text(encoding="utf-8")
        gmail_oauth_lib = (REPO_ROOT / "scripts" / "lib" / "c3_gmail_oauth.js").read_text(
            encoding="utf-8"
        )
        fresh_apply = (REPO_ROOT / "scripts" / "c3_workday_fresh_apply_smoke.js").read_text(
            encoding="utf-8"
        )
        live_smoke = (REPO_ROOT / "scripts" / "c3_workday_live_smoke.js").read_text(
            encoding="utf-8"
        )
        configure_sink = (REPO_ROOT / "scripts" / "configure_c3_debug_sink.js").read_text(
            encoding="utf-8"
        )
        p_chrome_defaults = (REPO_ROOT / "scripts" / "c3_p_chrome_defaults.js").read_text(
            encoding="utf-8"
        )
        background = (REPO_ROOT / "executioner" / "src" / "background" / "index.js").read_text(
            encoding="utf-8"
        )
        answer_resolver = (
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "answer-resolver.js"
        ).read_text(encoding="utf-8")

        self.assertIn("POST /verify-email", bridge)
        self.assertIn("HUNT_C3_MAIL_PROVIDER", bridge)
        self.assertIn("HUNT_C3_MAIL_IMAP_HOST", bridge)
        self.assertIn("HUNT_C3_GMAIL_CREDENTIALS_PATH", gmail_oauth_lib)
        self.assertIn("HUNT_C3_GMAIL_TOKEN_DIR", gmail_oauth_lib)
        self.assertIn("checkGmailAuth", bridge)
        self.assertIn("verifyGmail", bridge)
        self.assertIn("--check-auth", bridge)
        self.assertIn("checkMailAuth", bridge)
        self.assertIn("safeVerificationLinks", bridge)
        self.assertIn("verificationCodeCandidates", bridge)
        self.assertIn("code.length >= 4 && code.length <= 8", bridge)
        self.assertIn("Multiple verification codes matched", bridge)
        self.assertIn('method: "code"', bridge)
        self.assertIn("code: codes[0]", bridge)
        self.assertIn("unsubscribe", bridge)
        self.assertIn("verifyEmail", bridge)
        self.assertIn("signup_email_verification.html", smoke)
        self.assertIn("email_verified.html", smoke)
        self.assertIn("enterVerificationCode", smoke)
        self.assertIn("Email verification code found", smoke)
        self.assertIn("codeEntry", smoke)
        self.assertIn("HUNT_C3_TEST_WORKDAY_URL", smoke)
        self.assertIn("loadDotEnv", smoke)
        self.assertIn("checkMailAuth", smoke)
        self.assertIn("clickSafeAccountAction", smoke)
        self.assertNotIn("clickedInPage", smoke)
        self.assertIn("--reset-site-data", smoke)
        self.assertIn("resetBrowserSiteData", smoke)
        self.assertIn("clickSignInAction", smoke)
        self.assertIn("recordWorkflowEvent", smoke)
        self.assertIn("detect_account_state", smoke)
        self.assertIn("workdayPageKindExpression", smoke)
        self.assertIn("waitForWorkdayPageReady", smoke)
        self.assertIn("signin_choice", smoke)
        self.assertIn("application_step", smoke)
        self.assertIn("workday_page_still_loading", smoke)
        self.assertIn("session_detected", smoke)
        self.assertIn("clickWorkdayLoginSubmit", smoke)
        self.assertIn("login_submit_not_found", smoke)
        self.assertIn("normalizedTextOf", smoke)
        self.assertIn("left === right", smoke)
        self.assertIn("already_on_login_page", smoke)
        self.assertIn("account_login_fields_found", smoke)
        self.assertIn("login_first_succeeded", smoke)
        self.assertIn("login_first_no_verification_needed", smoke)
        self.assertIn("signed_in_before_signup", smoke)
        self.assertIn("signup_account_exists_signin_succeeded", smoke)
        self.assertIn("hunt.apply.fill_current_page", smoke)
        self.assertIn("confirmMatches", smoke)
        self.assertIn('require("./lib/c3_cdp")', smoke)
        self.assertNotIn("class CdpClient", smoke)
        self.assertIn("c3_email_verification_smoke.js", fresh_apply)
        self.assertIn("c3_workday_live_smoke.js", fresh_apply)
        self.assertIn("Detecting existing Workday session", fresh_apply)
        self.assertIn("Detecting signed-in Workday start page", fresh_apply)
        self.assertIn("logWorkflowPhase", fresh_apply)
        self.assertIn("--extension-auto-next", fresh_apply)
        self.assertIn("--reset-site-data", fresh_apply)
        self.assertIn("--clear-before-fill", fresh_apply)
        self.assertIn("--keep-existing-workday-tabs", fresh_apply)
        self.assertIn("visibleValidationErrors", live_smoke)
        self.assertIn('progressBarActiveStep', live_smoke)
        self.assertIn("workday_catalog_after_auth", background)
        self.assertIn("detectWorkdayCatalogPageForTab", background)
        self.assertIn("hasVisibleAuthChoice", background)
        self.assertIn("isWorkdayLoginPath", background)
        self.assertIn("auth_landing_choice_clicked", background)
        self.assertIn("auth_landing_choice_not_clicked", background)
        self.assertIn("Opening email sign-in choice", background)
        self.assertIn('mode: "manual"', live_smoke)
        self.assertIn("clickApplyManuallyEntry", live_smoke)
        self.assertIn("logWorkflowPhase", live_smoke)
        self.assertIn("waitForWorkdayPageReady", live_smoke)
        self.assertIn("Workday page reached a classified state", live_smoke)
        self.assertIn("Detected start-application page and clicked Apply Manually", live_smoke)
        self.assertIn('phase: "apply_entry"', live_smoke)
        self.assertIn('phase: "job_fill"', live_smoke)
        self.assertIn("already_on_application_step", live_smoke)
        self.assertIn("allowLlmAnswers", live_smoke)
        self.assertIn('require("./lib/c3_cdp")', live_smoke)
        self.assertNotIn("class CdpClient", live_smoke)
        self.assertIn("--no-llm-answers", live_smoke)
        self.assertIn("--audit-json", live_smoke)
        self.assertIn("buildFillAudit", live_smoke)
        self.assertIn("writeAuditJson", live_smoke)
        self.assertIn("valuePut", live_smoke)
        self.assertIn("visible_validation_errors", live_smoke)
        self.assertIn("makeWorkdayProfileDefaults", live_smoke)
        self.assertIn("makeWorkdayProfileDefaults", configure_sink)
        self.assertIn("withWorkdayProfileAliases", live_smoke)
        self.assertIn("7804923111", p_chrome_defaults)
        self.assertIn("phoneDeviceType", p_chrome_defaults)
        self.assertIn("applicationSource", p_chrome_defaults)
        self.assertIn("applicationSourceCategory", p_chrome_defaults)
        self.assertIn("Job Board", p_chrome_defaults)
        self.assertIn('entry.id === "application_source"', answer_resolver)
        self.assertIn("applicationSourceDetail", answer_resolver)
        self.assertIn("Social Media", answer_resolver)
        self.assertIn("Job Sites", answer_resolver)
        self.assertIn("hunt.apply.await_email_verification", background)
        self.assertIn('progressBarActiveStep', background)
        self.assertIn("emailVerificationBridgeUrl", background)
        self.assertIn("settings.emailVerificationBridgeUrl", background)
        self.assertIn("autoEmailVerificationEnabled", background)
        self.assertIn("email_verification_disabled", background)
        self.assertIn("emailVerificationTimeoutSeconds", background)
        self.assertIn("Verification code required. Checking email", background)
        self.assertIn("Checking ${email} for a verification code", background)
        self.assertIn("enterEmailVerificationCode", background)
        self.assertIn("Verification code found. Entering code", background)
        self.assertIn("Verification link found. Opening link", background)
        self.assertIn("email_verification.enter_code", background)
        self.assertIn("detectEmailVerificationCodePage", background)
        self.assertIn("maybeHandleEmailVerificationGate", background)
        self.assertIn("c3_email_verification_code_gate", background)
        self.assertIn("email_verification.code_gate", background)
        self.assertIn("directVerificationGate", background)
        self.assertIn('routeName: "email_verification"', background)
        self.assertIn("pin-code", background)
        self.assertIn("confirm your identity", background)
        self.assertIn("enter (?:the )?(?:verification|security|one", background)
        self.assertIn("isOracleEmailGate", background)
        self.assertIn("oracle_email_gate_reached", background)
        self.assertIn("http://127.0.0.1:8765/verify-email", background)
        self.assertIn('require("./lib/c3_gmail_oauth")', bridge)
        self.assertIn('require("./lib/c3_gmail_oauth")', gmail_oauth_smoke)
        self.assertIn("settingsVersion: 6", configure_sink)
        self.assertIn("class CdpClient", cdp_lib)
        self.assertIn("function httpJson", cdp_lib)
        self.assertIn("function tokenPathFor", gmail_oauth_lib)
        self.assertIn("async function gmailAuthorizedToken", gmail_oauth_lib)

    def test_workday_adapter_handles_hidden_file_inputs_and_missing_resume_logging(self):
        field_drivers = (
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "field-drivers.js"
        ).read_text(encoding="utf-8")
        field_pipeline = (
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "field-pipeline.js"
        ).read_text(encoding="utf-8")
        workday_ui = (
            REPO_ROOT / "executioner" / "src" / "ats" / "workday" / "workday-ui-v2.js"
        ).read_text(encoding="utf-8")
        workday_drivers = (
            REPO_ROOT / "executioner" / "src" / "ats" / "workday" / "workday-drivers-v2.js"
        ).read_text(encoding="utf-8")
        workday_repeatables = (
            REPO_ROOT / "executioner" / "src" / "ats" / "workday" / "workday-repeatables-v2.js"
        ).read_text(encoding="utf-8")
        field_catalog = (
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "field-catalog.js"
        ).read_text(encoding="utf-8")
        answer_resolver = (
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "answer-resolver.js"
        ).read_text(
            encoding="utf-8"
        )
        shared_utils = (REPO_ROOT / "executioner" / "src" / "shared" / "injected.js").read_text(
            encoding="utf-8"
        )
        fill_runner = (
            REPO_ROOT / "executioner" / "src" / "background" / "fill-runner.js"
        ).read_text(encoding="utf-8")
        storage = (REPO_ROOT / "executioner" / "src" / "shared" / "storage.js").read_text(
            encoding="utf-8"
        )
        background = (REPO_ROOT / "executioner" / "src" / "background" / "index.js").read_text(
            encoding="utf-8"
        )

        self.assertIn("attachResumeToFileInput", field_drivers)
        self.assertIn("resume_upload:", field_drivers)
        self.assertIn("fieldInventory", field_pipeline)
        self.assertIn("interactionTrace", field_pipeline)
        self.assertIn('new FocusEvent("focusout"', shared_utils)
        self.assertIn("traceHoverAndClick", shared_utils)
        self.assertIn("select_radio_option", shared_utils)
        self.assertIn("select_combobox_option", shared_utils)
        self.assertIn("sanitizeInteractionTrace", storage)
        self.assertIn("sanitizeWorkExperience", storage)
        self.assertIn("sanitizeEducation", storage)
        self.assertIn("sanitizeLanguages", storage)
        self.assertIn("workdayWidgetKind", workday_ui)
        self.assertIn("nearestWorkdayField", workday_ui)
        self.assertIn('"manual_review"', fill_runner)
        self.assertIn("manual review needed", fill_runner)
        self.assertIn("allFrames: true", fill_runner)
        self.assertIn("chooseBestFrameResult", fill_runner)
        self.assertIn("frameResults", fill_runner)
        self.assertIn("frameUrl", fill_runner)
        self.assertIn("shouldSkipPasswordField", field_pipeline)
        self.assertIn("applicationSource", field_catalog)
        self.assertIn('button[aria-haspopup="listbox"]', workday_ui + workday_drivers)
        self.assertIn("aria-invalid", field_pipeline)
        self.assertIn("bestEffortWarnings", field_pipeline)
        self.assertIn("selectedOption", field_pipeline)
        self.assertIn('[role="listbox"]', workday_drivers)
        self.assertIn('[id^="pill-"]', workday_drivers)
        self.assertIn("clearSelectedItems", workday_drivers)
        self.assertIn("terms_acceptance", field_catalog)
        self.assertIn("fillWorkdayRepeatables", workday_repeatables)
        self.assertIn("fillTechnicalSkills", workday_drivers)
        self.assertIn("chooseStructuredChoice", shared_utils)
        self.assertIn("optionScoreForChoice", shared_utils)
        self.assertIn("phone device type", shared_utils)
        self.assertIn("countryParts.country", shared_utils)
        self.assertIn("fieldId", field_pipeline)
        self.assertIn("family member employed", shared_utils)
        self.assertIn("lived or traveled outside", shared_utils)
        self.assertIn("lived or travelled outside", shared_utils)
        self.assertIn("ernst & young", shared_utils)
        self.assertIn("deloitte", shared_utils)
        self.assertIn("language skills", shared_utils)
        self.assertIn("preferred language", shared_utils)
        self.assertIn("background security check", field_catalog)
        self.assertIn("automated tools such as ai", field_catalog)
        self.assertIn("inferWorkdayLocationFromApplyContext", shared_utils)
        self.assertIn("All Canada Employers", shared_utils)
        self.assertIn("nameParts", answer_resolver)
        self.assertIn("salaryExpectationRange", field_catalog)
        self.assertIn("Yes, I am a citizen or permanent resident of Canada", shared_utils)
        self.assertIn('option.startsWith(target + ",")', shared_utils)
        self.assertIn("how did you hear", shared_utils)
        self.assertIn("knownProvinces", shared_utils)
        self.assertIn("previous_employer", field_catalog)
        self.assertIn("profile:canadianCitizenOrPermanentResident", shared_utils)
        self.assertIn("profile:sinStartsWithNine", shared_utils)
        self.assertIn("profile:sinExpiryDate", shared_utils)
        self.assertIn("profile:interestedTemporaryShortContract", shared_utils)
        self.assertIn("profile:disclosureGender", shared_utils)
        self.assertIn("profile:disclosureTransExperience", shared_utils)
        self.assertIn("profile:disclosureLgbqIdentity", shared_utils)
        self.assertIn("profile:disclosureDisability", shared_utils)
        self.assertIn("profile:disclosureIndigenousIdentity", shared_utils)
        self.assertIn("profile:disclosureVisibleMinority", shared_utils)
        self.assertIn("profile:disclosureVeteranStatus", shared_utils)
        self.assertIn("profile:accountEmail", shared_utils)
        self.assertIn("profile:accountPassword", shared_utils)
        self.assertIn("current password", shared_utils)
        self.assertIn("profile:middleName", shared_utils)
        self.assertIn('desc.includes("middlename")', shared_utils)
        self.assertIn("I choose not to disclose", shared_utils)
        self.assertIn("resume_already_uploaded", field_drivers)
        self.assertIn("not_resume_input", field_drivers)
        self.assertIn("resume/cv", field_catalog)
        self.assertIn("drop files", field_catalog)
        self.assertIn("fileInput", field_drivers)

    def test_workday_review_fixes_have_regression_guards(self):
        field_pipeline = (
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "field-pipeline.js"
        ).read_text(encoding="utf-8")
        workday_drivers = (
            REPO_ROOT / "executioner" / "src" / "ats" / "workday" / "workday-drivers-v2.js"
        ).read_text(
            encoding="utf-8"
        )
        field_drivers = (
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "field-drivers.js"
        ).read_text(encoding="utf-8")
        fill_runner = (
            REPO_ROOT / "executioner" / "src" / "background" / "fill-runner.js"
        ).read_text(encoding="utf-8")
        storage = (REPO_ROOT / "executioner" / "src" / "shared" / "storage.js").read_text(
            encoding="utf-8"
        )

        clear_pipeline = (
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "clear-pipeline.js"
        ).read_text(encoding="utf-8")
        self.assertIn("try {", workday_drivers)
        self.assertIn("traceTruncated", field_pipeline)
        self.assertIn("generated_or_placeholder_text_fallback", field_drivers)
        self.assertIn("workday_commit_not_verified", workday_drivers)
        self.assertIn("clear_failed", clear_pipeline)
        self.assertIn("traceTruncated", fill_runner)
        self.assertIn("traceTruncated", storage)

    def test_workday_my_experience_live_regression_guards(self):
        workday_repeatables = (
            REPO_ROOT / "executioner" / "src" / "ats" / "workday" / "workday-repeatables-v2.js"
        ).read_text(
            encoding="utf-8"
        )

        self.assertIn("findAddButton", workday_repeatables)
        self.assertIn("findAddButton(section, index > 0)", workday_repeatables)
        self.assertIn("add another", workday_repeatables)
        self.assertIn("sectionHasMissingRequiredControls", workday_repeatables)
        self.assertIn("fillWorkdayRepeatables", workday_repeatables)
        self.assertIn("fillWebsiteUrlInputs", workday_repeatables)
        self.assertIn("deleteAllRows", workday_repeatables)
        self.assertIn("clearWorkdayRepeatables", workday_repeatables)
        self.assertIn("workday_repeatables_fill", workday_repeatables)
        self.assertIn("workday_repeatables_clear", workday_repeatables)
        self.assertIn("normalizeWork", workday_repeatables)
        self.assertIn("[data-automation-id='formField']", workday_repeatables)
        self.assertIn("resumeUploadedText", workday_repeatables)
        self.assertIn("clearResumeUpload", workday_repeatables)
        self.assertIn('"button,[role=\'button\'],a,[tabindex]"', workday_repeatables)
        self.assertIn("skillOptionCommitTarget", workday_repeatables)
        self.assertIn("waitForSkillOption", workday_repeatables)
        self.assertIn("fillSkill", workday_repeatables)
        self.assertIn("skills_not_committed", workday_repeatables)
        self.assertIn("skillOptionIsChecked", workday_repeatables)
        self.assertIn("typeSearchTextLikeUser", workday_repeatables)

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
