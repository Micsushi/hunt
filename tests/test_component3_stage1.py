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
        self.assertEqual(profile["education"][0]["degree"], "BSc")
        self.assertEqual(profile["education"][0]["degreeLevel"], "Bachelors")
        self.assertEqual(profile["education"][0]["fieldOfStudy"], "Computer Science")
        self.assertEqual(profile["degreeLevel"], "Bachelors")
        self.assertEqual(profile["highestEducation"], "Bachelor's Degree")
        self.assertIn("Computer Science", profile["education"][0]["educationTitle"])
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
        no_degree_resume_text = """
Michael Shi
Edmonton, AB | wenjian2@ualberta.ca | https://mshi.ca

Education
University of Alberta, Computer Science with Specialization
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
            const noDegreeProfile = parseResumeText({json.dumps(no_degree_resume_text)});
            console.log(JSON.stringify({{ textProfile, pdfProfile, longTextProfile, longPdfProfile, inlineTextProfile, inlinePdfProfile, noDegreeProfile }}));
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
            self.assertEqual(profile["education"][0]["degree"], "BSc")
            self.assertEqual(profile["education"][0]["degreeLevel"], "Bachelors")
            self.assertEqual(profile["education"][0]["fieldOfStudy"], "Computer Science")
            self.assertEqual(profile["degreeLevel"], "Bachelors")
            self.assertEqual(profile["highestEducation"], "Bachelor's Degree")
            self.assertIn("Computer Science", profile["education"][0]["educationTitle"])
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

        no_degree_education = payload["noDegreeProfile"]["education"][0]
        self.assertEqual(no_degree_education["school"], "University of Alberta")
        self.assertEqual(no_degree_education["degree"], "")
        self.assertEqual(no_degree_education["degreeLevel"], "")
        self.assertEqual(no_degree_education["fieldOfStudy"], "Computer Science")
        self.assertIn("Computer Science", no_degree_education["educationTitle"])

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
                staleGenericWorkday: selectFillRoute({{
                    activeApplyContext: {{ jobId: "old", sourceMode: "db", atsType: "generic" }},
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
        self.assertEqual(routes["staleGenericWorkday"]["routeName"], "db_ats_filler")
        self.assertEqual(routes["staleGenericWorkday"]["adapterName"], "workday")

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
        settings = (REPO_ROOT / "executioner" / "src" / "shared" / "settings.js").read_text(
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
        options_js = (REPO_ROOT / "executioner" / "src" / "options" / "options.js").read_text(
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
        self.assertIn("runtimeConfig", settings)
        self.assertIn("unknownQuestionDefaults", settings)
        self.assertIn("DEFAULT_BROWSER_CONTEXT", settings)
        self.assertIn("DEFAULT_RUNTIME_CONFIG", settings)
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
        self.assertIn("sanitizeRuntimeConfig", storage)
        self.assertIn("sanitizeUnknownQuestionDefault", storage)
        self.assertIn("appendUnknownQuestionDefaults", storage)
        self.assertIn("applyRuntimeConfig", storage)
        self.assertIn("STORAGE_KEYS.browserContext", storage)
        self.assertIn("STORAGE_KEYS.runtimeConfig", storage)
        self.assertIn("STORAGE_KEYS.unknownQuestionDefaults", storage)
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
        self.assertIn("fillVisibleAuthFields", background)
        self.assertIn("filledAuthFields", background)
        self.assertIn("V2_AUTH_FLOW_MAX_STEPS", background)
        self.assertIn("V2_AUTH_SAME_PAGE_MAX_ATTEMPTS", background)
        self.assertIn("auth_flow_limit_reached", background)
        self.assertIn("auth_same_page_attempt_limit_reached", background)
        self.assertIn("auth attempt ${authStepCount}", background)
        self.assertIn("noteAuthSamePageFailure", background)
        self.assertIn("auth_action_did_not_advance", background)
        self.assertIn('kind: "auth_chain_continue"', background)
        self.assertIn('reason: "still_on_auth_page"', background)
        self.assertIn("mainFrameApplication", background)
        self.assertIn("currentStepLooksAuth", background)
        self.assertIn("application_fields_ready", background)
        self.assertIn("currentStepIsAuth ||", background)
        self.assertIn('var wantsLandingChoice = authUiState === "landing_choice"', background)
        self.assertIn("exactEmailSignin", background)
        self.assertIn("\\bsign in with email\\b", background)
        self.assertIn("signinwithemailbutton", background)
        self.assertIn("score = 135", background)
        self.assertIn("(startApplication && /\\/apply\\/applyManually/i.test(label))", background)
        self.assertIn("createClickWorkdayApplyManuallyFunction", background)
        self.assertIn("isWorkdayDetailsApplyItem", background)
        self.assertIn("visibleText: visibleText", background)
        self.assertIn('"no_job_fill_surface"', background)
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
        self.assertIn('id="profile-name-prefix"', options)
        self.assertIn('id="profile-name-suffix"', options)
        self.assertIn('id="export-logs-now"', options)
        self.assertIn('id="test-debug-log-sink"', options)
        self.assertIn('id="activity-log-count"', options)
        self.assertIn('data-tab-target="experience"', options)
        self.assertIn('id="work-experience-list"', options)
        self.assertIn('id="education-list"', options)
        self.assertIn('id="profile-skills"', options)
        self.assertIn('id="profile-salary-expectation"', options)
        self.assertIn('id="profile-hourly-pay-expectation"', options)
        self.assertIn('id="profile-compensation-offer-factors"', options)
        self.assertIn("updateCalculatedHourlyPay", options_js)
        self.assertIn("HOURS_PER_YEAR = 2080", options_js)
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
        self.assertIn('id="profile-accommodation-request"', options)
        self.assertIn('id="profile-conflict-of-interest-relationship"', options)
        self.assertIn('id="profile-hhs-oig-excluded"', options)
        self.assertIn('id="profile-gsa-federal-program-excluded"', options)
        self.assertIn('id="profile-generic-drug-debarred"', options)
        self.assertIn('id="profile-debarment-proceedings-pending"', options)
        self.assertIn('id="profile-us-licensed-physician"', options)
        self.assertIn('id="profile-fda-hhs-investigational-drug-restricted"', options)
        self.assertIn('id="profile-governmental-licensing-inquiry"', options)
        self.assertIn('id="profile-degree-level"', options)
        self.assertIn('id="profile-highest-education"', options)
        self.assertIn('id="profile-highest-education"', options)
        self.assertIn('name="highestEducation"', options)
        self.assertIn('value="Bachelor\'s Degree"', options)
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
        self.assertIn("preselected_workday_source", workday_drivers_v2)
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
        self.assertIn('const RUNTIME_CONFIG_KEY = "hunt.apply.runtimeConfig"', configure_debug)
        self.assertIn("chrome.storage.local.set({ [", configure_debug)
        self.assertNotIn("chrome.storage.sync.set({ [${js(SETTINGS_KEY)}]", configure_debug)
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

    def test_v2_open_work_permit_defaults_no(self):
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
                fieldLabel: "Are you currently on an open work permit?*"
              }},
              fieldId: "primaryQuestionnaire--openPermit",
              descriptor: "Are you currently on an open work permit?* Select One"
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
                "type": "open_work_permit",
                "source": "alias",
                "value": "No",
                "valueSource": "default:open_work_permit",
            },
        )

    def test_v2_basic_requirements_and_hourly_expectations_are_supported(self):
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
            function resolve(label, profile = {{}}) {{
              const field = {{
                workday: {{ fieldLabel: label }},
                descriptor: `${{label}} Select One`,
                uiModel: "button_listbox",
                required: true
              }};
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
                source: answer.source,
                answerType: answer.answerType
              }};
            }}
            console.log(JSON.stringify({{
              basicRequirements: resolve(
                "Do you meet all the basic requirements/qualifications for this role?"
              ),
              hourlyProfile: resolve(
                "What are your Hourly expectations for the Position",
                {{ salaryExpectation: "97500", salaryExpectationRange: "90,000 - 105,000" }}
              ),
              hourlyExplicit: resolve(
                "What is your expected hourly rate?",
                {{ salaryExpectation: "97500", hourlyPayExpectation: "46.88" }}
              ),
              hourlyDefault: resolve(
                "What are your Hourly expectations for the Position",
                {{ salaryExpectation: "", salaryExpectationRange: "" }}
              )
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
                "basicRequirements": {
                    "type": "basic_requirements_qualified",
                    "value": "Yes",
                    "source": "default:basic_requirements_qualified",
                    "answerType": "yes_no",
                },
                "hourlyProfile": {
                    "type": "salary_expectation",
                    "value": "25.00",
                    "source": "default:hourlyPayExpectation",
                    "answerType": "text",
                },
                "hourlyExplicit": {
                    "type": "salary_expectation",
                    "value": "46.88",
                    "source": "profile:hourlyPayExpectation",
                    "answerType": "text",
                },
                "hourlyDefault": {
                    "type": "salary_expectation",
                    "value": "25.00",
                    "source": "default:hourlyPayExpectation",
                    "answerType": "text",
                },
            },
        )

    def test_v2_phone_device_type_uses_cell_then_progress_fallback(self):
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
            function resolve(options) {{
              const field = {{
                workday: {{ fieldLabel: "Phone Device Type*" }},
                descriptor: "Phone Device Type* Select One",
                fieldId: "phoneNumber--phoneType",
                required: true,
                uiModel: "button_listbox"
              }};
              const question = root.questionIdentifier.identifyQuestion(field, null, null);
              const answer = root.answerResolver.resolveAnswer({{ question, field, profile: {{}}, audit: null, fieldAudit: null }});
              const match = root.optionMatcher.matchOption({{
                options: options.map((label) => ({{ label, value: label }})),
                answer,
                field,
                audit: null,
                fieldAudit: null
              }});
              return {{
                type: question.type,
                value: answer.value,
                source: answer.source,
                selected: match.option && match.option.label,
                matchSource: match.source
              }};
            }}
            console.log(JSON.stringify({{
              cellFirst: resolve(["Select One", "Home", "Work", "Cell"]),
              workFallback: resolve(["Select One", "Home", "Work"]),
              homeFallback: resolve(["Select One", "Home"])
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
            self.skipTest("node is required to test the C3 V2 phone-device answer")

        results = json.loads(result.stdout)
        self.assertEqual(results["cellFirst"]["type"], "phone_device_type")
        self.assertEqual(results["cellFirst"]["value"], "Mobile")
        self.assertEqual(results["cellFirst"]["source"], "default:phone_device_type")
        self.assertEqual(results["cellFirst"]["selected"], "Cell")
        self.assertEqual(results["workFallback"]["selected"], "Home")
        self.assertEqual(results["workFallback"]["matchSource"], "phone_device_first_real_fallback")
        self.assertEqual(results["homeFallback"]["selected"], "Home")
        self.assertEqual(results["homeFallback"]["matchSource"], "phone_device_first_real_fallback")

    def test_v2_bird_work_auth_preferred_contact_and_start_date_defaults(self):
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
            function resolve(field, profile = {{}}, options = []) {{
              const question = root.questionIdentifier.identifyQuestion(field, null, null);
              const answer = root.answerResolver.resolveAnswer({{
                question,
                field,
                profile,
                audit: null,
                fieldAudit: null
              }});
              const match = options.length ? root.optionMatcher.matchOption({{
                options,
                answer,
                field,
                audit: null,
                fieldAudit: null
              }}) : {{ option: null, source: "" }};
              return {{
                type: question.type,
                value: answer.value,
                source: answer.source,
                selectedOption: match.option && match.option.label,
                optionSource: match.source
              }};
            }}
            const legallyPermitted = {{
              workday: {{ fieldLabel: "Are you legally permitted to work in the country where this job is located?" }},
              descriptor: "Are you legally permitted to work in the country where this job is located?* Select One",
              uiModel: "button_listbox",
              required: true
            }};
            const preferredContact = {{
              workday: {{ fieldLabel: "What is your preferred method of communication should we want to contact you?" }},
              descriptor: "What is your preferred method of communication should we want to contact you?* Personal Mobile Personal Home Work Personal Email",
              uiModel: "checkbox",
              required: true
            }};
            const startDate = {{
              workday: {{ fieldLabel: "If hired, what is the earliest date you can start?" }},
              descriptor: "If hired, what is the earliest date you can start?* MM/DD/YYYY",
              uiModel: "text",
              required: true
            }};
            console.log(JSON.stringify({{
              legallyPermitted: resolve(legallyPermitted, {{ workAuthorized: true }}, [
                {{ label: "Select One" }},
                {{ label: "Yes" }},
                {{ label: "No" }}
              ]),
              preferredContact: resolve(preferredContact, {{}}, [
                {{ label: "Personal Mobile" }},
                {{ label: "Personal Home" }},
                {{ label: "Work" }},
                {{ label: "Personal Email" }}
              ]),
              startDate: resolve(startDate, {{}})
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
            self.skipTest("node is required to test the C3 V2 question mappings")

        parsed = json.loads(result.stdout)
        self.assertEqual(
            parsed["legallyPermitted"],
            {
                "type": "work_authorized",
                "value": "Yes",
                "source": "profile:workAuthorized",
                "selectedOption": "Yes",
                "optionSource": "exact",
            },
        )
        self.assertEqual(
            parsed["preferredContact"],
            {
                "type": "preferred_communication_channel",
                "value": "Email",
                "source": "default:preferred_communication_channel",
                "selectedOption": "Personal Email",
                "optionSource": "alias",
            },
        )
        self.assertEqual(parsed["startDate"]["type"], "desired_start_date")
        self.assertEqual(parsed["startDate"]["source"], "default:desired_start_date")
        self.assertRegex(parsed["startDate"]["value"], r"^\d{2}/\d{2}/\d{4}$")

    def test_v2_orion_review_answer_regressions(self):
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
            function resolve(field, profile = {{}}, options = []) {{
              const question = root.questionIdentifier.identifyQuestion(field, null, null);
              const answer = root.answerResolver.resolveAnswer({{
                question,
                field,
                profile,
                audit: null,
                fieldAudit: null
              }});
              const match = options.length ? root.optionMatcher.matchOption({{
                options,
                answer,
                field,
                audit: null,
                fieldAudit: null
              }}) : {{ option: null, source: "" }};
              return {{
                type: question.type,
                value: answer.value,
                source: answer.source,
                selectedOption: match.option && match.option.label,
                optionSource: match.source
              }};
            }}
            const profile = {{
              education: [{{ degree: "BSc Computer Science", degreeLevel: "Bachelors" }}],
              salaryExpectationRange: "90,000 - 105,000",
              willingToRelocate: true,
              interestedTemporaryShortContract: "yes"
            }};
            const legalAge = {{
              workday: {{ fieldLabel: "Are you at least 18 years of age? (If not, your employer is subject to verification that you are of at least legal age and that you are able to supply any required work permit).*" }},
              descriptor: "Are you at least 18 years of age? (If not, your employer is subject to verification that you are of at least legal age and that you are able to supply any required work permit).* Yes No",
              uiModel: "button_listbox",
              required: true
            }};
            const highestEducation = {{
              workday: {{ fieldLabel: "What is the highest level of education you have completed?*" }},
              descriptor: "What is the highest level of education you have completed?* Not Applicable Bachelor's Degree",
              uiModel: "button_listbox",
              required: true
            }};
            const desiredPay = {{
              workday: {{ fieldLabel: "What is your desired pay?" }},
              descriptor: "What is your desired pay?",
              uiModel: "text",
              required: false
            }};
            const finningHighestEducation = {{
              workday: {{ fieldLabel: "What is your highest level of completed education?*" }},
              descriptor: "What is your highest level of completed education?* Select One High School Diploma College/Technical School University",
              uiModel: "button_listbox",
              required: true
            }};
            const microsoftOffice = {{
              workday: {{ fieldLabel: "What is your level of computer proficiency in Microsoft Office?*" }},
              descriptor: "What is your level of computer proficiency in Microsoft Office?* Beginner Intermediate Expert",
              uiModel: "button_listbox",
              required: true
            }};
            const travelAvailability = {{
              workday: {{ fieldLabel: "If travel is required for the role you have applied to, what is your availability?*" }},
              descriptor: "If travel is required for the role you have applied to, what is your availability?* 0 - 10% 10 - 20% 20% plus Not Applicable",
              uiModel: "button_listbox",
              required: true
            }};
            const computerPrograms = {{
              workday: {{ fieldLabel: "What other computer programs have you worked in?" }},
              descriptor: "What other computer programs have you worked in?",
              uiModel: "textarea",
              required: false
            }};
            const temporaryShortContract = {{
              workday: {{ fieldLabel: "Are you interested in working on a temporary / short-contract basis?*" }},
              descriptor: "Are you interested in working on a temporary / short-contract basis?* Yes No",
              uiModel: "button_listbox",
              required: true
            }};
            const highSchoolDiploma = {{
              workday: {{ fieldLabel: "Did you receive your high school diploma?*" }},
              descriptor: "Did you receive your high school diploma?* Yes No",
              uiModel: "button_listbox",
              required: true
            }};
            const conditionalRelocation = {{
              workday: {{ fieldLabel: "If this position is not located in the city that you reside in, would you be willing to relocate?*" }},
              descriptor: "If this position is not located in the city that you reside in, would you be willing to relocate?* Yes No",
              uiModel: "button_listbox",
              required: true
            }};
            const relocationLongOption = {{
              workday: {{ fieldLabel: "Would you consider relocating for this role?*" }},
              descriptor: "Would you consider relocating for this role?* Yes, I would consider relocating for this role No, I would not consider relocating for this role",
              uiModel: "button_listbox",
              required: true
            }};
            const shiftwork = {{
              workday: {{ fieldLabel: "If applicable to the position, are you available to work shiftwork (days, nights, weekends)?" }},
              descriptor: "If applicable to the position, are you available to work shiftwork (days, nights, weekends)? Yes No",
              uiModel: "button_listbox",
              required: false
            }};
            console.log(JSON.stringify({{
              legalAge: resolve(legalAge, {{}}, [{{ label: "Yes" }}, {{ label: "No" }}]),
              highestEducation: resolve(highestEducation, profile, [
                {{ label: "Not Applicable" }},
                {{ label: "High School" }},
                {{ label: "Bachelor's" }}
              ]),
              desiredPay: resolve(desiredPay, profile),
              finningHighestEducation: resolve(finningHighestEducation, profile, [
                {{ label: "Select One", placeholder: true }},
                {{ label: "High School Diploma" }},
                {{ label: "College/Technical School" }},
                {{ label: "University" }}
              ]),
              microsoftOffice: resolve(microsoftOffice, {{}}, [
                {{ label: "Beginner" }},
                {{ label: "Intermediate" }},
                {{ label: "Expert" }}
              ]),
              travelAvailability: resolve(travelAvailability, {{}}, [
                {{ label: "0 - 10%" }},
                {{ label: "10 - 20%" }},
                {{ label: "20% plus" }},
                {{ label: "Not Applicable" }}
              ]),
              travelAvailabilityWith100: resolve(travelAvailability, {{}}, [
                {{ label: "0 - 10%" }},
                {{ label: "20% plus" }},
                {{ label: "100%" }}
              ]),
              travelAvailabilityTie: resolve(travelAvailability, {{}}, [
                {{ label: "10 - 20%" }},
                {{ label: "15 - 20%" }},
                {{ label: "0 - 20%" }}
              ]),
              computerPrograms: resolve(computerPrograms, {{
                skills: ["Python", "TypeScript", "React", "SQL"]
              }}),
              temporaryShortContract: resolve(temporaryShortContract, profile, [{{ label: "Yes" }}, {{ label: "No" }}]),
              highSchoolDiploma: resolve(highSchoolDiploma, profile, [{{ label: "Yes" }}, {{ label: "No" }}]),
              conditionalRelocation: resolve(conditionalRelocation, profile, [{{ label: "Yes" }}, {{ label: "No" }}]),
              relocationLongOption: resolve(relocationLongOption, profile, [
                {{ label: "Yes, I would consider relocating for this role" }},
                {{ label: "No, I would not consider relocating for this role" }}
              ]),
              shiftwork: resolve(shiftwork, {{}}, [{{ label: "Yes" }}, {{ label: "No" }}])
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
            self.skipTest("node is required to test the C3 V2 Orion mappings")

        parsed = json.loads(result.stdout)
        self.assertEqual(parsed["legalAge"]["type"], "age_at_least_18")
        self.assertEqual(parsed["legalAge"]["value"], "Yes")
        self.assertEqual(parsed["legalAge"]["selectedOption"], "Yes")
        self.assertEqual(parsed["highestEducation"]["type"], "highest_education")
        self.assertEqual(parsed["highestEducation"]["value"], "Bachelor's Degree")
        self.assertEqual(parsed["highestEducation"]["selectedOption"], "Bachelor's")
        self.assertEqual(parsed["desiredPay"]["type"], "salary_expectation")
        self.assertEqual(parsed["desiredPay"]["value"], "97500")
        self.assertEqual(parsed["finningHighestEducation"]["type"], "highest_education")
        self.assertEqual(parsed["finningHighestEducation"]["value"], "Bachelor's Degree")
        self.assertEqual(parsed["finningHighestEducation"]["selectedOption"], "University")
        self.assertEqual(parsed["microsoftOffice"]["type"], "microsoft_office_proficiency")
        self.assertEqual(parsed["microsoftOffice"]["value"], "Expert")
        self.assertEqual(parsed["microsoftOffice"]["selectedOption"], "Expert")
        self.assertEqual(parsed["travelAvailability"]["type"], "travel_availability")
        self.assertEqual(parsed["travelAvailability"]["value"], "highest")
        self.assertEqual(parsed["travelAvailability"]["selectedOption"], "20% plus")
        self.assertEqual(parsed["travelAvailability"]["optionSource"], "highest_travel_numeric")
        self.assertEqual(parsed["travelAvailabilityWith100"]["selectedOption"], "100%")
        self.assertEqual(parsed["travelAvailabilityTie"]["selectedOption"], "15 - 20%")
        self.assertEqual(parsed["computerPrograms"]["type"], "computer_programs")
        self.assertEqual(parsed["computerPrograms"]["value"], "Python, TypeScript, React, SQL")
        self.assertEqual(
            parsed["temporaryShortContract"]["type"],
            "temporary_short_contract_interest",
        )
        self.assertEqual(parsed["temporaryShortContract"]["selectedOption"], "Yes")
        self.assertEqual(parsed["highSchoolDiploma"]["type"], "high_school_diploma_or_higher")
        self.assertEqual(parsed["highSchoolDiploma"]["selectedOption"], "Yes")
        self.assertEqual(parsed["conditionalRelocation"]["type"], "relocation_willingness")
        self.assertEqual(parsed["conditionalRelocation"]["selectedOption"], "Yes")
        self.assertEqual(parsed["relocationLongOption"]["type"], "relocation_consideration")
        self.assertEqual(
            parsed["relocationLongOption"]["selectedOption"],
            "Yes, I would consider relocating for this role",
        )
        self.assertEqual(parsed["shiftwork"]["type"], "shift_availability")
        self.assertEqual(parsed["shiftwork"]["selectedOption"], "Yes")

    def test_v2_orion_optional_policy_fields_are_not_skipped_by_required_filter(self):
        field_pipeline_v2 = (
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "field-pipeline.js"
        ).read_text(encoding="utf-8")
        self.assertIn('signal.includes("desired start date")', field_pipeline_v2)
        self.assertIn('signal.includes("desired pay")', field_pipeline_v2)
        self.assertIn('signal.includes("previously worked")', field_pipeline_v2)

    def test_v2_canadian_citizenship_status_uses_terminal_workday_option(self):
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
                fieldLabel: "Please provide your Canadian citizenship status to assist us in evaluating your application for employment.*"
              }},
              fieldId: "personalInfoPerson--citizenshipStatus",
              descriptor: "Please provide your Canadian citizenship status to assist us in evaluating your application for employment.*"
            }};
            const question = root.questionIdentifier.identifyQuestion(field, null, null);
            const answer = root.answerResolver.resolveAnswer({{
              question,
              field,
              profile: {{ canadianCitizenOrPermanentResident: "yes", country: "Canada" }},
              audit: null,
              fieldAudit: null
            }});
            console.log(JSON.stringify({{
              type: question.type,
              source: question.source,
              value: answer.value,
              valueSource: answer.source,
              answerType: answer.answerType
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
                "type": "canadian_citizenship_status",
                "source": "alias",
                "value": "Citizen (Canada)",
                "valueSource": "profile:canadianCitizenOrPermanentResident",
                "answerType": "text",
            },
        )

    def test_workday_canadian_citizenship_status_requires_trusted_terminal_commit(
        self,
    ):
        workday_drivers = (
            REPO_ROOT / "executioner" / "src" / "ats" / "workday" / "workday-drivers-v2.js"
        ).read_text(encoding="utf-8")

        self.assertIn("citizenship_status_keyboard", workday_drivers)
        self.assertIn("trustedKeyboardSequenceForOption(target, field)", workday_drivers)
        self.assertIn(
            "Clicked citizenship status but Workday did not clear the required validation state.",
            workday_drivers,
        )
        self.assertNotIn(
            "var ok =\n      !invalid ||\n      optionMatches({ label: state.text }, target.label)",
            workday_drivers,
        )

    def test_v2_intel_age_and_sponsorship_prompts_are_disambiguated(self):
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
            function resolve(descriptor, profile, options) {{
              const field = {{
                workday: {{ fieldLabel: descriptor }},
                fieldId: descriptor.slice(0, 50),
                descriptor
              }};
              const question = root.questionIdentifier.identifyQuestion(field, null, null);
              const answer = root.answerResolver.resolveAnswer({{
                question,
                field,
                profile: profile || {{}},
                options: options || [{{ label: "Yes" }}, {{ label: "No" }}],
                audit: null,
                fieldAudit: null
              }});
              return {{
                type: question.type,
                value: answer.value,
                answerType: answer.answerType,
                valueSource: answer.source
              }};
            }}
            console.log(JSON.stringify({{
              legalAge: resolve(
                "As of today's date, are you 18 years of age or older?* Select One",
                {{ atLeast18: true }}
              ),
              currentDate: resolve(
                "Please enter today's date:* Month",
                {{}},
                []
              ),
              sponsorship: resolve(
                "Do you now, or will you in the future, require Intel to sponsor a visa petition or other work authorization application in order to legally work in the United States? This includes H-1B, TN, O-1, E-3, or permanent resident applications.",
                {{ sponsorshipRequired: false, canadianCitizenOrPermanentResident: "yes" }}
              ),
              canadianStatus: resolve(
                "Please provide your Canadian citizenship status to assist us in evaluating your application for employment.*",
                {{ canadianCitizenOrPermanentResident: "yes", country: "Canada" }},
                [{{ label: "Citizen (Canada)" }}, {{ label: "Permanent Resident (Canada)" }}]
              )
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
            self.skipTest("node is required to test the C3 V2 Intel mappings")

        parsed = json.loads(result.stdout)
        self.assertEqual(parsed["legalAge"]["type"], "age_at_least_18")
        self.assertEqual(parsed["legalAge"]["value"], "Yes")
        self.assertEqual(parsed["legalAge"]["answerType"], "yes_no")
        self.assertEqual(parsed["currentDate"]["type"], "current_date")
        self.assertEqual(parsed["sponsorship"]["type"], "sponsorship_required")
        self.assertEqual(parsed["sponsorship"]["value"], "No")
        self.assertEqual(parsed["sponsorship"]["answerType"], "yes_no")
        self.assertEqual(parsed["sponsorship"]["valueSource"], "profile:sponsorshipRequired")
        self.assertEqual(parsed["canadianStatus"]["type"], "canadian_citizenship_status")
        self.assertEqual(parsed["canadianStatus"]["value"], "Citizen (Canada)")

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

    def test_v2_comcast_application_questions_are_cataloged(self):
        paths = [
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "field-catalog.js",
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "question-identifier.js",
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "answer-resolver.js",
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "option-matcher.js",
        ]
        cases = [
            {
                "key": "degree",
                "descriptor": "Highest degree attained?* Select One",
                "options": [
                    "High School Diploma/GED",
                    "Bachelor's Degree",
                    "Master's Degree",
                ],
            },
            {
                "key": "priorApplication",
                "descriptor": "Have you ever applied for employment with this company?* Select One",
                "options": [
                    "Yes, I have applied previously",
                    "No, I have not applied previously",
                ],
            },
            {
                "key": "contractual",
                "descriptor": "Are there any contractual restrictions on your ability to work at Comcast or any of its affiliates?* Select One",
                "options": [
                    "Yes, contractual restrictions exist",
                    "No contractual restrictions exist",
                ],
            },
            {
                "key": "nonSolicitation",
                "descriptor": "Are you bound by any non-solicitation agreements which would restrict your ability to prospect for business?* Select One",
                "options": [
                    "Yes, non-solicitation agreements exist",
                    "No non-solicitation agreements exist",
                ],
            },
            {
                "key": "outsideConflict",
                "descriptor": "Are you involved in any outside activities (for example, trade groups or board memberships) that could be considered as competitive to or in competition with Comcast or any of its affiliates?* Select One",
                "options": [
                    "Yes, I am involved in possible conflicting outside activities",
                    "No, I am not involved in conflicting outside activities",
                ],
            },
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
            const profile = {{ highestEducation: "Bachelor's Degree" }};
            const results = {{}};
            for (const item of {json.dumps(cases)}) {{
              const field = {{
                descriptor: item.descriptor,
                required: true,
                uiModel: "button_listbox"
              }};
              const question = root.questionIdentifier.identifyQuestion(field, null, null);
              const answer = root.answerResolver.resolveAnswer({{
                question,
                field,
                profile,
                audit: null,
                fieldAudit: null
              }});
              const match = root.optionMatcher.matchOption({{
                options: item.options.map((label) => ({{ label }})),
                answer,
                field,
                audit: null,
                fieldAudit: null
              }});
              results[item.key] = {{
                type: question.type,
                answerType: answer.answerType,
                value: answer.value,
                valueSource: answer.source,
                option: match.option && match.option.label,
                source: match.source,
              }};
            }}
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
            self.skipTest("node is required to test the C3 V2 question identifier")

        parsed = json.loads(result.stdout)
        self.assertEqual(parsed["degree"]["type"], "highest_education")
        self.assertEqual(parsed["degree"]["option"], "Bachelor's Degree")
        self.assertEqual(parsed["priorApplication"]["type"], "previous_application")
        self.assertEqual(parsed["priorApplication"]["option"], "No, I have not applied previously")
        self.assertEqual(parsed["contractual"]["type"], "non_compete_restriction")
        self.assertEqual(parsed["contractual"]["option"], "No contractual restrictions exist")
        self.assertEqual(parsed["nonSolicitation"]["type"], "non_compete_restriction")
        self.assertEqual(
            parsed["nonSolicitation"]["option"], "No non-solicitation agreements exist"
        )
        self.assertEqual(parsed["outsideConflict"]["type"], "outside_conflict_activities")
        self.assertEqual(
            parsed["outsideConflict"]["option"],
            "No, I am not involved in conflicting outside activities",
        )
        self.assertNotIn(
            "fallback",
            " ".join(entry["source"] for entry in parsed.values()),
        )

    def test_v2_application_source_prefers_safe_flat_option(self):
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
              fieldId: "source--source",
              descriptor: "How Did You Hear About Us?* Select One",
              required: true,
              uiModel: "button_listbox"
            }};
            const question = root.questionIdentifier.identifyQuestion(field, null, null);
            const answer = root.answerResolver.resolveAnswer({{
              question,
              field,
              profile: {{
                applicationSourceCategory: "Job Board",
                applicationSource: "LinkedIn",
                applicationSourceDetail: "LinkedIn"
              }},
              audit: null,
              fieldAudit: null
            }});
            const match = root.optionMatcher.matchOption({{
              options: [
                {{ label: "Capital One Event" }},
                {{ label: "Employee Referral" }},
                {{ label: "Internet" }}
              ],
              answer,
              field,
              audit: null,
              fieldAudit: null
            }});
            console.log(JSON.stringify({{
              type: question.type,
              value: answer.value,
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
                "type": "application_source",
                "value": "Job Board",
                "option": "Internet",
                "source": "application_source_safe_fallback",
                "fallback": True,
            },
        )

    def test_v2_application_source_uses_blocklist_before_fallback(self):
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
              fieldId: "source--source",
              descriptor: "How Did You Hear About Us?* Select One",
              required: true,
              uiModel: "button_listbox"
            }};
            const question = root.questionIdentifier.identifyQuestion(field, null, null);
            const answer = root.answerResolver.resolveAnswer({{
              question,
              field,
              profile: {{
                applicationSourceCategory: "Job Board",
                applicationSource: "LinkedIn",
                applicationSourceDetail: "LinkedIn"
              }},
              audit: null,
              fieldAudit: null
            }});
            const match = root.optionMatcher.matchOption({{
              options: [
                {{ label: "Select One" }},
                {{ label: "Employee Referral" }},
                {{ label: "Referred by Employee" }},
                {{ label: "Naukri" }},
                {{ label: "Corporate Careers Website" }}
              ],
              answer,
              field,
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
                "option": "Naukri",
                "source": "application_source_safe_fallback",
                "fallback": True,
            },
        )

    def test_v2_workday_source_preselected_requires_safe_value(self):
        drivers = (
            REPO_ROOT / "executioner" / "src" / "ats" / "workday" / "workday-drivers-v2.js"
        ).read_text(encoding="utf-8")

        self.assertIn("committedApplicationSourceMatches", drivers)
        self.assertNotIn(
            "isApplicationSourceField(field.element, field.descriptor) && committedLabel)",
            drivers,
        )
        self.assertIn('"source_category_keyboard"', drivers)

    def test_v2_workday_source_category_children_scroll_for_safe_option(self):
        drivers = (
            REPO_ROOT / "executioner" / "src" / "ats" / "workday" / "workday-drivers-v2.js"
        ).read_text(encoding="utf-8")

        self.assertIn("shouldScanForBetterSourceOption", drivers)
        self.assertIn(
            "sourceFallbackScore(target, answerTexts(answer, null)) < 80",
            drivers,
        )
        self.assertIn("childScrollResult = childOptions.length", drivers)
        self.assertIn(
            "collectPreferredWorkdayOptionsWithScroll(\n"
            "            field,\n"
            "            answer,\n"
            "            childOptions,",
            drivers,
        )

    def test_v2_capital_one_degree_age_and_essential_functions_are_cataloged(self):
        paths = [
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "field-catalog.js",
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "question-identifier.js",
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "answer-resolver.js",
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "option-matcher.js",
        ]
        cases = [
            {
                "key": "bachelors",
                "descriptor": "Do you have a Bachelor's Degree?* Yes No",
            },
            {
                "key": "age",
                "descriptor": "Are you age 18 or over?* Yes No",
            },
            {
                "key": "essential",
                "descriptor": "Are you able to perform the essential functions of the position for which you are applying with or without reasonable accommodation?* Yes No",
            },
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
            const profile = {{
              highestEducation: "Bachelor's Degree",
              degreeLevel: "Bachelors",
              atLeast18: true
            }};
            const results = {{}};
            for (const item of {json.dumps(cases)}) {{
              const field = {{
                descriptor: item.descriptor,
                workday: {{ fieldLabel: item.descriptor }},
                required: true,
                uiModel: "button_listbox"
              }};
              const question = root.questionIdentifier.identifyQuestion(field, null, null);
              const answer = root.answerResolver.resolveAnswer({{
                question,
                field,
                profile,
                audit: null,
                fieldAudit: null
              }});
              const match = root.optionMatcher.matchOption({{
                options: [{{ label: "Yes" }}, {{ label: "No" }}],
                answer,
                field,
                audit: null,
                fieldAudit: null
              }});
              results[item.key] = {{
                type: question.type,
                value: answer.value,
                valueSource: answer.source,
                answerType: answer.answerType,
                option: match.option && match.option.label,
                source: match.source
              }};
            }}
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
            self.skipTest("node is required to test the C3 V2 question identifier")

        parsed = json.loads(result.stdout)
        self.assertEqual(parsed["bachelors"]["type"], "has_bachelors_degree")
        self.assertEqual(parsed["bachelors"]["value"], "Yes")
        self.assertEqual(parsed["bachelors"]["option"], "Yes")
        self.assertEqual(parsed["bachelors"]["valueSource"], "profile:highestEducation")
        self.assertEqual(parsed["age"]["type"], "age_at_least_18")
        self.assertEqual(parsed["age"]["value"], "Yes")
        self.assertEqual(parsed["age"]["option"], "Yes")
        self.assertEqual(parsed["essential"]["type"], "essential_functions")
        self.assertEqual(parsed["essential"]["value"], "Yes")
        self.assertEqual(parsed["essential"]["option"], "Yes")

    def test_v2_ethnicity_disclosure_without_neutral_uses_progress_fallback(self):
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
              fieldId: "personalInfoPerson--ethnicities",
              descriptor: "Please select your ethnicity.",
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
                {{ label: "Asian (Not Hispanic or Latino) (United States of America)" }},
                {{ label: "White (Not Hispanic or Latino) (United States of America)" }}
              ],
              answer,
              field,
              audit: null,
              fieldAudit: null
            }});
            console.log(JSON.stringify({{
              type: question.type,
              answerType: answer.answerType,
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
                "type": "ethnicity_disclosure_neutral",
                "answerType": "non_disclosure",
                "option": "Asian (Not Hispanic or Latino) (United States of America)",
                "source": "non_disclosure_first_real_fallback",
                "fallback": True,
            },
        )

    def test_v2_workday_us_disclosure_neutral_aliases_are_matched(self):
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
            function resolve(fieldId, descriptor, options) {{
              const field = {{
                fieldId,
                descriptor,
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
                options: options.map((label) => ({{ label }})),
                answer,
                field,
                audit: null,
                fieldAudit: null
              }});
              return {{
                type: question.type,
                answerType: answer.answerType,
                option: match.option && match.option.label,
                source: match.source,
                fallback: match.fallback
              }};
            }}
            console.log(JSON.stringify({{
              autodeskEthnicity: resolve(
                "personalInfoUS--ethnicity",
                "What is your ethnicity?",
                [
                  "Asian (Not Hispanic or Latino) (United States of America)",
                  "Declined to State (United States of America)"
                ]
              ),
              boeingEthnicity: resolve(
                "personalInfoUS--ethnicity",
                "What is your ethnicity?",
                [
                  "American Indian/Alaskan Native (Not Hispanic or Latino) (United States of America)",
                  "Declined to Identify (United States of America)"
                ]
              ),
              boeingVeteran: resolve(
                "personalInfoUS--veteranStatus",
                "Are you a veteran?",
                [
                  "I IDENTIFY AS ONE OR MORE OF THE CLASSIFICATIONS OF PROTECTED VETERAN",
                  "I DO NOT WISH TO SELF-IDENTIFY"
                ]
              )
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
                "autodeskEthnicity": {
                    "type": "ethnicity_disclosure_neutral",
                    "answerType": "non_disclosure",
                    "option": "Declined to State (United States of America)",
                    "source": "neutral_fallback",
                    "fallback": True,
                },
                "boeingEthnicity": {
                    "type": "ethnicity_disclosure_neutral",
                    "answerType": "non_disclosure",
                    "option": "Declined to Identify (United States of America)",
                    "source": "neutral_fallback",
                    "fallback": True,
                },
                "boeingVeteran": {
                    "type": "veteran_disclosure_neutral",
                    "answerType": "non_disclosure",
                    "option": "I DO NOT WISH TO SELF-IDENTIFY",
                    "source": "neutral_fallback",
                    "fallback": True,
                },
            },
        )

    def test_v2_bms_and_amgen_disclosure_options_are_safe(self):
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
            function resolve(fieldId, descriptor, options) {{
              const field = {{ fieldId, descriptor, required: true, uiModel: "button_listbox" }};
              const question = root.questionIdentifier.identifyQuestion(field, null, null);
              const answer = root.answerResolver.resolveAnswer({{
                question,
                field,
                profile: {{}},
                audit: null,
                fieldAudit: null
              }});
              const match = root.optionMatcher.matchOption({{
                options: options.map((label) => ({{ label }})),
                answer,
                field,
                audit: null,
                fieldAudit: null
              }});
              return {{
                type: question.type,
                answerType: answer.answerType,
                option: match.option && match.option.label,
                source: match.source,
                fallback: match.fallback
              }};
            }}
            console.log(JSON.stringify({{
              bmsVeteran: resolve(
                "personalInfoUS--veteranStatus",
                "What is your veteran status?",
                ["I AM A VETERAN", "I DON'T WISH TO ANSWER"]
              ),
              amgenEthnicity: resolve(
                "personalInfoUS--ethnicity",
                "Please select the ethnicity which most accurately describes you.",
                ["Asian (Not Hispanic or Latino) (United States of America)", "Not Specified (United States of America)"]
              ),
              amgenVeteran: resolve(
                "personalInfoUS--veteranStatus",
                "Protected Veteran: Please indicate your classifications of protected veterans.",
                ["I IDENTIFY AS ONE OR MORE OF THE CLASSIFICATIONS OF PROTECTED VETERAN", "I AM NOT A VETERAN"]
              )
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
            self.skipTest("node is required to test the C3 V2 disclosure options")

        self.assertEqual(
            json.loads(result.stdout),
            {
                "bmsVeteran": {
                    "type": "veteran_disclosure_neutral",
                    "answerType": "non_disclosure",
                    "option": "I DON'T WISH TO ANSWER",
                    "source": "alias",
                    "fallback": False,
                },
                "amgenEthnicity": {
                    "type": "ethnicity_disclosure_neutral",
                    "answerType": "non_disclosure",
                    "option": "Not Specified (United States of America)",
                    "source": "alias",
                    "fallback": False,
                },
                "amgenVeteran": {
                    "type": "veteran_disclosure_neutral",
                    "answerType": "non_disclosure",
                    "option": "I AM NOT A VETERAN",
                    "source": "veteran_not_veteran_safe_fallback",
                    "fallback": True,
                },
            },
        )

    def test_v2_thermo_sanctioned_country_checkbox_selects_none(self):
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
              descriptor: "Please indicate which, if any, where you are a citizen. None of these",
              required: true,
              uiModel: "checkbox"
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
              options: [{{ label: "None of these", value: "None of these" }}],
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
            self.skipTest("node is required to test the C3 V2 sanctioned-country answer")

        self.assertEqual(
            json.loads(result.stdout),
            {
                "type": "sanctioned_country_citizenship",
                "value": "None of these",
                "valueSource": "default:sanctioned_country_citizenship",
                "option": "None of these",
                "source": "exact",
                "fallback": False,
            },
        )

    def test_v2_citizenship_and_secondary_citizenship_are_cataloged(self):
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
            function resolve(descriptor, options, profile = {{ country: "Canada" }}) {{
              const field = {{ descriptor, required: true, uiModel: "button_listbox" }};
              const question = root.questionIdentifier.identifyQuestion(field, null, null);
              const answer = root.answerResolver.resolveAnswer({{
                question,
                field,
                profile,
                audit: null,
                fieldAudit: null
              }});
              const match = root.optionMatcher.matchOption({{
                options: options.map((label) => ({{ label }})),
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
            console.log(JSON.stringify({{
              primary: resolve(
                "Country of citizenship",
                ["United States", "Canada", "Mexico"]
              ),
              secondary: resolve(
                "Secondary country of citizenship",
                ["United States", "Canada", "None of these"]
              ),
              sanctionedStillSpecific: resolve(
                "Please indicate which, if any, where you are a citizen.",
                ["Cuba", "Syria", "None of these"],
                {{}}
              )
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
            self.skipTest("node is required to test the C3 V2 citizenship answers")

        self.assertEqual(
            json.loads(result.stdout),
            {
                "primary": {
                    "type": "citizenship",
                    "value": "Canada",
                    "valueSource": "profile:country",
                    "option": "Canada",
                    "source": "exact",
                    "fallback": False,
                },
                "secondary": {
                    "type": "secondary_citizenship",
                    "value": "None of these",
                    "valueSource": "default:secondary_citizenship",
                    "option": "None of these",
                    "source": "exact",
                    "fallback": False,
                },
                "sanctionedStillSpecific": {
                    "type": "sanctioned_country_citizenship",
                    "value": "None of these",
                    "valueSource": "default:sanctioned_country_citizenship",
                    "option": "None of these",
                    "source": "exact",
                    "fallback": False,
                },
            },
        )

    def test_v2_cox_policy_questions_are_deterministic(self):
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
            function resolve(descriptor, options) {{
              const field = {{ descriptor, required: true, uiModel: "button_listbox" }};
              const question = root.questionIdentifier.identifyQuestion(field, null, null);
              const answer = root.answerResolver.resolveAnswer({{
                question,
                field,
                profile: {{}},
                audit: null,
                fieldAudit: null
              }});
              const match = root.optionMatcher.matchOption({{
                options: options.map((label) => ({{ label }})),
                answer,
                field,
                audit: null,
                fieldAudit: null
              }});
              return {{
                type: question.type,
                value: answer.value,
                option: match.option && match.option.label,
                source: match.source,
                fallback: match.fallback
              }};
            }}
            console.log(JSON.stringify({{
              restrictive: resolve("Are you subject to any restrictive agreement that may limit your ability to work for Cox?", ["Yes", "No"]),
              termination: resolve("Have you ever been terminated or asked to resign from employment?", ["Yes", "No"]),
              consent: resolve("I understand and consent to background screening, identity verification, and drug testing.", ["I understand and consent", "I do not consent"])
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
            self.skipTest("node is required to test the C3 V2 Cox policy answers")

        self.assertEqual(
            json.loads(result.stdout),
            {
                "restrictive": {
                    "type": "non_compete_restriction",
                    "value": "No",
                    "option": "No",
                    "source": "exact",
                    "fallback": False,
                },
                "termination": {
                    "type": "prior_termination_or_resignation",
                    "value": "No",
                    "option": "No",
                    "source": "exact",
                    "fallback": False,
                },
                "consent": {
                    "type": "background_check_consent",
                    "value": "Yes",
                    "option": "I understand and consent",
                    "source": "affirmative_agreement",
                    "fallback": False,
                },
            },
        )

    def test_auth_primary_action_accepts_email_signin_when_state_unknown(self):
        background = (REPO_ROOT / "executioner" / "src" / "background" / "index.js").read_text(
            encoding="utf-8"
        )
        self.assertIn('exactEmailSignin && (!authState || authState === "unknown")', background)

    def test_v2_ethno_racial_checkbox_selects_non_disclosure(self):
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
                fieldLabel: "Please indicate which of the following terms best describe your ethno-racial identity. Please check all that apply. If you choose not to disclose, text entry and all other options selected in response to this question will be disregarded."
              }},
              fieldId: "primaryQuestionnaire--ethnoRacialIdentity",
              descriptor: "Please indicate which of the following terms best describe your ethno-racial identity. Please check all that apply.",
              required: true,
              uiModel: "checkbox"
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
                {{ label: "White" }},
                {{ label: "Multiracial/ethnic" }},
                {{ label: "Prefer to self-identify (please specify in the text box below)" }},
                {{ label: "I choose not to disclose" }}
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
              source: match.source
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
                "option": "I choose not to disclose",
                "source": "neutral_disclosure_checkbox",
            },
        )

    def test_v2_ethno_racial_checkbox_selects_i_do_not_wish_to_answer(self):
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
                fieldLabel: "What is / are your race(s) / ethnicity(ies)?"
              }},
              fieldId: "primaryQuestionnaire--raceEthnicity",
              descriptor: "What is / are your race(s) / ethnicity(ies)?",
              required: true,
              uiModel: "checkbox"
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
                {{ label: "Asian (United States of America)" }},
                {{ label: "White (United States of America)" }},
                {{ label: "I do not wish to answer. (United States of America)" }}
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
              source: match.source
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
                "option": "I do not wish to answer. (United States of America)",
                "source": "neutral_disclosure_checkbox",
            },
        )

    def test_v2_workday_disability_checkbox_neutral_option_is_safe(self):
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
              fieldId: "64cbff5f364f10000af3af293a050000-disabilityStatus",
              descriptor: "I do not want to answer",
              required: true,
              uiModel: "checkbox"
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
              options: [{{ label: "I do not want to answer" }}],
              answer,
              field,
              audit: null,
              fieldAudit: null
            }});
            console.log(JSON.stringify({{
              type: question.type,
              value: answer.value,
              option: match.option && match.option.label,
              source: match.source
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
                "type": "disclosure_neutral",
                "value": "I choose not to disclose",
                "option": "I do not want to answer",
                "source": "neutral_disclosure_checkbox",
            },
        )

    def test_v2_ethnicity_decline_to_state_is_neutral_disclosure(self):
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
              fieldId: "personalInfoUS--ethnicity",
              descriptor: "What is your ethnicity?",
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
                {{ label: "American Indian or Alaska Native (Not Hispanic or Latino) (United States of America)" }},
                {{ label: "Decline to State (United States of America)" }},
                {{ label: "White (Not Hispanic or Latino) (United States of America)" }}
              ],
              answer,
              field,
              audit: null,
              fieldAudit: null
            }});
            console.log(JSON.stringify({{
              type: question.type,
              value: answer.value,
              option: match.option && match.option.label,
              source: match.source
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
                "type": "ethnicity_disclosure_neutral",
                "value": "I decline to disclose",
                "option": "Decline to State (United States of America)",
                "source": "alias",
            },
        )

    def test_v2_indigenous_checkbox_selects_non_disclosure(self):
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
                fieldLabel: "Do you identify as an Indigenous person from outside of Canada? Please check all that apply. If you select No or I choose not to disclose, text entry and all other options selected in response to this question will be disregarded."
              }},
              fieldId: "primaryQuestionnaire--indigenousOutsideCanada",
              descriptor: "Do you identify as an Indigenous person from outside of Canada?",
              required: true,
              uiModel: "checkbox"
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
                {{ label: "No" }},
                {{ label: "Prefer to self-identify" }},
                {{ label: "I choose not to disclose" }}
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
              source: match.source
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
                "type": "disclosure_neutral",
                "value": "I choose not to disclose",
                "valueSource": "default:disclosure_neutral",
                "option": "I choose not to disclose",
                "source": "exact",
            },
        )

    def test_v2_sun_life_fallback_questions_are_deterministic(self):
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
            function resolve(label, options, profile = {{}}, required = true) {{
              const issues = [];
              const audit = {{ pushIssue: (_audit, _fieldAudit, issue) => issues.push(issue), pushFieldStep: () => null }};
              root.audit = audit;
              const field = {{
                workday: {{ fieldLabel: label }},
                descriptor: label,
                fieldId: "primaryQuestionnaire--test",
                required,
                uiModel: "button_listbox"
              }};
              const question = root.questionIdentifier.identifyQuestion(field, null, null);
              const answer = root.answerResolver.resolveAnswer({{ question, field, profile, audit: null, fieldAudit: null }});
              const match = root.optionMatcher.matchOption({{
                options: options.map((label) => ({{ label, value: label }})),
                answer,
                field,
                audit: null,
                fieldAudit: null
              }});
              return {{
                type: question.type,
                value: answer.value,
                answerType: answer.answerType,
                source: answer.source,
                selected: match.option && match.option.label,
                matchSource: match.source,
                issueKinds: issues.map((issue) => issue.kind)
              }};
            }}
            const results = {{
              prefix: resolve("Prefix Select One", ["Select One", "Dr", "Mr", "Mrs", "Ms", "Not Mapped", "Prof"]),
              prefixFromProfile: resolve("Prefix Select One", ["Select One", "No Prefix", "Dr", "Mr", "Mrs", "Ms", "Not Mapped", "Prof"], {{ namePrefix: "No Prefix" }}),
              suffixBlank: resolve("Suffix Select One", ["Select One", "Fr.", "Jr", "Sr"], {{}}, false),
              suffixFromProfile: resolve("Suffix Select One", ["Select One", "Fr.", "Jr", "Sr"], {{ nameSuffix: "Jr" }}, false),
              workEligibility: resolve("Are you legally eligible to work in Canada?*", ["Select One", "Yes, I am a citizen or permanent resident of Canada", "No"]),
              canadianCitizenPr: resolve("Are you a Canadian Citizen or have Permanent Resident status?*", ["Select One", "Yes", "No"]),
              sinStartsWithNine: resolve("Do you have a Social Insurance Number (SIN) that begins with the number 9?*", ["Select One", "Yes", "No"]),
              temporaryContract: resolve("Are you interested in working on a temporary / short-contract basis?*", ["Select One", "Yes", "No"]),
              peopleRelatives: resolve("Do you have any relatives currently employed by People Inc. or any of its subsidiaries?", ["Select One", "Yes", "No"]),
              priorEmployer: resolve("Have you been employed by Ernst & Young within the last 2 years, or employed by Deloitte LLP at any time?*", ["Select One", "Yes", "No, I have not worked at either Deloitte LLP or Ernst & Young."]),
              governmentOfficial: resolve("Are you (or have you been within the last 12 months) a Government Official?", ["Select One", "Yes", "No"]),
              politicallyExposed: resolve("Are you or any close associate a politically exposed person (PEP)?", ["Select One", "Yes", "No"]),
              familyGovernmentOfficial: resolve("Are any of your immediate family members Government Officials (Any Official or Employee of any government department/agency; Company or Organization owned fully or partially by government or public institution)?", ["Select One", "Yes", "No"]),
              shellEyFinancial: resolve("Do you have any financial arrangements (including retirement funds or shares) with Shell's auditor EY? (A financial interest can be anything of monetary value, whether the value is readily ascertainable, which is held by an individual).", ["Select One", "Yes", "No"]),
              unknownGenericNo: resolve("Some unknown yes or no screening question?", ["Select One", "Yes", "No"]),
              shellAccommodation: resolve("Do you require accessibility accommodations or adjustments?", ["Select One", "Yes, I will require accessibility accommodations or adjustments", "No, I do not require accessibility accommodations or adjustments"]),
              shellAccommodationFromProfile: resolve("Do you require accessibility accommodations or adjustments?", ["Select One", "Yes, I will require accessibility accommodations or adjustments", "No, I do not require accessibility accommodations or adjustments"], {{ accommodationRequest: "yes" }}),
              bmsCompFactors: resolve("In the event an offer of employment is made, are there any factors BMS should consider when creating a compensation offer? Please note that applicants are not required to disclose salary or compensation history.", ["Select One", "Yes", "No"]),
              bmsCompFactorsFromProfile: resolve("In the event an offer of employment is made, are there any factors BMS should consider when creating a compensation offer? Please note that applicants are not required to disclose salary or compensation history.", ["Select One", "Yes", "No"], {{ compensationOfferFactors: true }}),
              bmsConflict: resolve("BMS seeks to avoid conflicts of interest. Do you have relatives, romantic partners, people with whom you share a dwelling or have a business relationship with who work in any capacity at BMS?*", ["Select One", "Yes", "No"]),
              bmsHhsOig: resolve("Are you or have you ever appeared on the HHS/OIG List of Excluded Individuals/Entities?", ["Select One", "Yes", "No"], {{ hhsOigExcluded: false }}),
              bmsGsa: resolve("Are you or have you ever appeared on the General Services Administration's List of Parties Excluded from Federal Programs?", ["Select One", "Yes", "No"]),
              bmsDebarred: resolve("Are you debarred under the Generic Drug Enforcement Act of 1992?", ["Select One", "Yes", "No"]),
              bmsDebarmentPending: resolve("Are debarment proceedings pending or to your knowledge threatened?", ["Select One", "Yes", "No"]),
              bmsPhysician: resolve("Are you a US licensed physician?", ["Select One", "Yes", "No"]),
              bmsInvestigationalDrug: resolve("Have you ever been investigated for or disqualified or restricted by the FDA or HHS from receiving investigational drugs?", ["Select One", "Yes", "No"]),
              bmsLicensingInquiry: resolve("Are you currently the subject of any pending inquiry by any governmental entity or licensing association or has administrative action been imposed upon you by any governmental entity or licensing association?", ["Select One", "Yes", "No"]),
              bmsHhsOigFromProfile: resolve("Are you or have you ever appeared on the HHS/OIG List of Excluded Individuals/Entities?", ["Select One", "Yes", "No"], {{ hhsOigExcluded: true }}),
              aboriginalDisclosure: resolve("Are you a member of an Aboriginal People based on the definition in the information box?*", ["Select One", "Yes", "No", "I prefer not to respond"]),
              visibleMinority: resolve("Are you a member of an visible minority based on the definition in the information box?*", ["Select One", "Yes", "No", "I prefer not to respond"]),
              disability: resolve("Do you have a disability based on the definition in the information box?*", ["Select One", "Yes", "No", "I prefer not to respond"])
            }};
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
            self.skipTest("node is required to test the C3 V2 question identifier")

        results = json.loads(result.stdout)
        self.assertEqual(results["prefix"]["type"], "name_prefix")
        self.assertEqual(results["prefix"]["value"], "")
        self.assertEqual(results["prefix"]["selected"], "Dr")
        self.assertEqual(results["prefix"]["matchSource"], "missing_profile_first_real_fallback")
        self.assertEqual(results["prefixFromProfile"]["type"], "name_prefix")
        self.assertEqual(results["prefixFromProfile"]["value"], "No Prefix")
        self.assertEqual(results["prefixFromProfile"]["source"], "profile:namePrefix")
        self.assertEqual(results["prefixFromProfile"]["selected"], "No Prefix")
        self.assertEqual(results["suffixBlank"]["type"], "name_suffix")
        self.assertEqual(results["suffixBlank"]["value"], "")
        self.assertIsNone(results["suffixBlank"]["selected"])
        self.assertEqual(
            results["suffixBlank"]["matchSource"],
            "optional_profile_field_blank",
        )
        self.assertEqual(results["suffixFromProfile"]["type"], "name_suffix")
        self.assertEqual(results["suffixFromProfile"]["value"], "Jr")
        self.assertEqual(results["suffixFromProfile"]["source"], "profile:nameSuffix")
        self.assertEqual(results["suffixFromProfile"]["selected"], "Jr")
        self.assertEqual(results["workEligibility"]["type"], "work_authorized")
        self.assertEqual(results["workEligibility"]["value"], "Yes")
        self.assertEqual(results["workEligibility"]["source"], "default:work_authorized")
        self.assertEqual(
            results["workEligibility"]["selected"],
            "Yes, I am a citizen or permanent resident of Canada",
        )
        self.assertEqual(results["canadianCitizenPr"]["type"], "canadian_citizen_pr")
        self.assertEqual(results["canadianCitizenPr"]["value"], "Yes")
        self.assertEqual(results["canadianCitizenPr"]["selected"], "Yes")
        self.assertEqual(results["sinStartsWithNine"]["type"], "sin_starts_with_nine")
        self.assertEqual(results["sinStartsWithNine"]["value"], "No")
        self.assertEqual(results["sinStartsWithNine"]["selected"], "No")
        self.assertEqual(
            results["temporaryContract"]["type"],
            "temporary_short_contract_interest",
        )
        self.assertEqual(results["temporaryContract"]["value"], "No")
        self.assertEqual(results["temporaryContract"]["selected"], "No")
        self.assertEqual(results["peopleRelatives"]["type"], "referral_or_family")
        self.assertEqual(results["peopleRelatives"]["value"], "No")
        self.assertEqual(results["peopleRelatives"]["selected"], "No")
        self.assertEqual(results["priorEmployer"]["type"], "previous_employer")
        self.assertEqual(results["priorEmployer"]["value"], "No")
        self.assertEqual(
            results["priorEmployer"]["selected"],
            "No, I have not worked at either Deloitte LLP or Ernst & Young.",
        )
        self.assertEqual(results["governmentOfficial"]["type"], "government_official")
        self.assertEqual(results["governmentOfficial"]["value"], "No")
        self.assertEqual(results["governmentOfficial"]["selected"], "No")
        self.assertEqual(results["politicallyExposed"]["type"], "politically_exposed_person")
        self.assertEqual(results["politicallyExposed"]["value"], "No")
        self.assertEqual(results["politicallyExposed"]["selected"], "No")
        self.assertEqual(
            results["familyGovernmentOfficial"]["type"],
            "related_customer_or_government_official",
        )
        self.assertEqual(results["familyGovernmentOfficial"]["value"], "No")
        self.assertEqual(results["familyGovernmentOfficial"]["selected"], "No")
        self.assertEqual(results["shellEyFinancial"]["type"], "unknown")
        self.assertEqual(results["shellEyFinancial"]["selected"], "No")
        self.assertEqual(
            results["shellEyFinancial"]["matchSource"],
            "unknown_no_fallback",
        )
        self.assertEqual(results["unknownGenericNo"]["type"], "unknown")
        self.assertEqual(results["unknownGenericNo"]["selected"], "No")
        shell_accommodation = results["shellAccommodation"]
        self.assertEqual(shell_accommodation["type"], "accommodation_request")
        self.assertEqual(shell_accommodation["value"], "No")
        self.assertEqual(shell_accommodation["source"], "default:accommodation_request")
        self.assertEqual(
            shell_accommodation["selected"],
            "No, I do not require accessibility accommodations or adjustments",
        )
        shell_accommodation_profile = results["shellAccommodationFromProfile"]
        self.assertEqual(shell_accommodation_profile["type"], "accommodation_request")
        self.assertEqual(shell_accommodation_profile["value"], "Yes")
        self.assertEqual(
            shell_accommodation_profile["source"],
            "profile:accommodationRequest",
        )
        self.assertEqual(
            shell_accommodation_profile["selected"],
            "Yes, I will require accessibility accommodations or adjustments",
        )
        self.assertEqual(results["bmsCompFactors"]["type"], "compensation_offer_factors")
        self.assertEqual(results["bmsCompFactors"]["value"], "No")
        self.assertEqual(results["bmsCompFactors"]["source"], "default:compensation_offer_factors")
        self.assertEqual(results["bmsCompFactors"]["selected"], "No")
        self.assertNotEqual(results["bmsCompFactors"]["matchSource"], "salary_no_safe_match")
        self.assertEqual(
            results["bmsCompFactorsFromProfile"]["type"],
            "compensation_offer_factors",
        )
        self.assertEqual(results["bmsCompFactorsFromProfile"]["value"], "Yes")
        self.assertEqual(
            results["bmsCompFactorsFromProfile"]["source"],
            "profile:compensationOfferFactors",
        )
        self.assertEqual(results["bmsCompFactorsFromProfile"]["selected"], "Yes")
        bms_expected = {
            "bmsConflict": "conflict_of_interest_relationship",
            "bmsHhsOig": "hhs_oig_exclusion",
            "bmsGsa": "gsa_federal_program_exclusion",
            "bmsDebarred": "generic_drug_enforcement_debarment",
            "bmsDebarmentPending": "debarment_proceedings_pending",
            "bmsPhysician": "us_licensed_physician",
            "bmsInvestigationalDrug": "fda_hhs_investigational_drug_restriction",
            "bmsLicensingInquiry": "governmental_or_licensing_inquiry",
        }
        for key, question_type in bms_expected.items():
            self.assertEqual(results[key]["type"], question_type)
            expected_value = "Yes" if key == "bmsPhysician" else "No"
            self.assertEqual(results[key]["value"], expected_value)
            self.assertEqual(results[key]["selected"], expected_value)
            self.assertNotEqual(results[key]["matchSource"], "unknown_no_fallback")
        self.assertEqual(results["bmsHhsOig"]["source"], "profile:hhsOigExcluded")
        self.assertEqual(results["bmsHhsOigFromProfile"]["type"], "hhs_oig_exclusion")
        self.assertEqual(results["bmsHhsOigFromProfile"]["value"], "Yes")
        self.assertEqual(results["bmsHhsOigFromProfile"]["source"], "profile:hhsOigExcluded")
        self.assertEqual(results["bmsHhsOigFromProfile"]["selected"], "Yes")
        self.assertEqual(
            results["unknownGenericNo"]["matchSource"],
            "unknown_no_fallback",
        )
        for key in ["aboriginalDisclosure", "visibleMinority", "disability"]:
            self.assertEqual(results[key]["answerType"], "non_disclosure")
            self.assertEqual(results[key]["value"], "I choose not to disclose")
            self.assertEqual(results[key]["selected"], "I prefer not to respond")

    def test_v2_current_40_profile_gap_mappings_use_profile_or_safe_defaults(self):
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
            function resolve(label, options, profile = {{}}) {{
              const field = {{
                workday: {{ fieldLabel: label }},
                descriptor: label,
                fieldId: "primaryQuestionnaire--test",
                required: true,
                uiModel: "button_listbox"
              }};
              const question = root.questionIdentifier.identifyQuestion(field, null, null);
              const answer = root.answerResolver.resolveAnswer({{
                question,
                field,
                profile,
                audit: null,
                fieldAudit: null
              }});
              const match = root.optionMatcher.matchOption({{
                options: options.map((label) => ({{ label, value: label }})),
                answer,
                field,
                audit: null,
                fieldAudit: null
              }});
              return {{
                type: question.type,
                value: answer.value,
                source: answer.source,
                selected: match.option && match.option.label,
                matchSource: match.source
              }};
            }}
            console.log(JSON.stringify({{
              criminal: resolve("Have you ever been convicted of a criminal offence for which a pardon has not been granted?", ["Select One", "Yes", "No"]),
              relatedYears: resolve("How many years of related experience do you have?", ["Select One", "0-1 years", "2-5 years", "7-10 years", "More than 10 years"]),
              cannabisLicense: resolve("Do you hold a valid license to sell Cannabis/Liquor in Canada?", ["Select One", "Yes", "No"]),
              licenseDiscipline: resolve("Have you ever had disciplinary action taken on your professional license, certification, or credentials?", ["Select One", "Yes", "No"]),
              insuranceLicenseHistory: resolve("Has your insurance license ever been refused, revoked, or suspended?", ["Select One", "Yes", "No"]),
              commute: resolve("If applicable, are you willing to commute to the area where this position is located?", ["Select One", "Yes", "No"]),
              aiConsent: resolve("Do you consent to the use of AI-enabled recruiting tools?", ["Select One", "Yes", "No"]),
              activeClearance: resolve("Do you have an active clearance?", ["Select One", "Yes", "No"]),
              usCitizen: resolve("Are you a citizen of the United States?", ["Select One", "Yes", "No"]),
              federalCurrent: resolve("Are you a CURRENT U.S. federal government civilian or military employee?", ["Select One", "Yes", "No"]),
              communication: resolve("Please select your preferred communication channel", ["Select One", "Email", "SMS", "WhatsApp"]),
              preferredLanguage: resolve("Preferred interview language", ["Select One", "English", "French"])
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
            self.skipTest("node is required to test C3 V2 profile-gap mappings")

        parsed = json.loads(result.stdout)
        expected = {
            "criminal": ("criminal_conviction_unpardoned", "No"),
            "relatedYears": ("related_experience_years", "2-5 years"),
            "cannabisLicense": ("regulated_cannabis_liquor_license", "Yes"),
            "licenseDiscipline": ("professional_license_discipline", "No"),
            "insuranceLicenseHistory": ("professional_license_discipline", "No"),
            "commute": ("commute_willingness", "Yes"),
            "aiConsent": ("ai_recruiting_tools_consent", "Yes"),
            "activeClearance": ("active_security_clearance", "No"),
            "usCitizen": ("us_citizen", "No"),
            "federalCurrent": ("us_federal_employment_current", "No"),
            "communication": ("preferred_communication_channel", "Email"),
            "preferredLanguage": ("preferred_language", "English"),
        }
        for key, (question_type, selected) in expected.items():
            self.assertEqual(parsed[key]["type"], question_type)
            self.assertEqual(parsed[key]["selected"], selected)
            self.assertNotEqual(
                parsed[key]["matchSource"],
                "unknown_first_real_fallback",
            )

    def test_v2_optional_preferred_name_checkbox_is_quietly_skipped(self):
        field_pipeline = (
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "field-pipeline.js"
        ).read_text(encoding="utf-8")
        self.assertIn("quietOptionalCheckboxNoOption", field_pipeline)
        self.assertIn("quietCommittedButtonNoOption", field_pipeline)
        self.assertIn('field.uiModel === "checkbox"', field_pipeline)
        self.assertIn('"checkbox_no_safe_match"', field_pipeline)
        self.assertIn("!quietOptionalCheckboxNoOption", field_pipeline)

    def test_clean_final_submit_page_walk_does_not_add_review_noise(self):
        background = (REPO_ROOT / "executioner" / "src" / "background" / "index.js").read_text(
            encoding="utf-8"
        )
        self.assertIn('result.pageWalk.stoppedReason !== "final_submit_visible"', background)
        self.assertIn('"c3_v2_page_walk_review_items"', background)

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
            function resolve(label, options) {{
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
                options: options || [
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
              resolve(
                "I agree that Comcast may reach out to me via SMS regarding my application and candidate experience. Message and data rates may apply. I can opt-out at any time.*",
                [
                  {{ label: "Yes, I opt-in to receive SMS/Text messages" }},
                  {{ label: "No, I do not wish to receive SMS/Text messages" }}
                ]
              ),
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
                    "type": "sms_application_contact_opt_out",
                    "value": "Opt-Out",
                    "valueSource": "default:sms_application_contact_opt_out",
                    "option": "No, I do not wish to receive SMS/Text messages",
                    "source": "alias",
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

    def test_v2_gender_disclosure_neutral_aliases_match(self):
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
              profile: {{ disclosureGender: "Female" }},
              audit: null,
              fieldAudit: null
            }});
            function matchFor(options) {{
              return root.optionMatcher.matchOption({{
                options,
                answer,
                field,
                audit: null,
                fieldAudit: null
              }});
            }}
            const notDeclared = matchFor([
              {{ label: "Select One", placeholder: true }},
              {{ label: "Female" }},
              {{ label: "Male" }},
              {{ label: "Not Declared" }}
            ]);
            const thermoUndisclosed = matchFor([
              {{ label: "Select One", placeholder: true }},
              {{ label: "Female" }},
              {{ label: "Male" }},
              {{ label: "Non-Binary (United States of America)" }},
              {{ label: "Undisclosed (United States of America)" }}
            ]);
            const doNotWish = matchFor([
              {{ label: "Select One", placeholder: true }},
              {{ label: "Female" }},
              {{ label: "Male" }},
              {{ label: "I DO NOT WISH TO ANSWER" }}
            ]);
            const dontWish = matchFor([
              {{ label: "Select One", placeholder: true }},
              {{ label: "Female" }},
              {{ label: "Male" }},
              {{ label: "I DON'T WISH TO ANSWER" }}
            ]);
            const notSpecified = matchFor([
              {{ label: "Select One", placeholder: true }},
              {{ label: "Female" }},
              {{ label: "Male" }},
              {{ label: "Not Specified (United States of America)" }}
            ]);
            const noneOfThese = matchFor([
              {{ label: "Select One", placeholder: true }},
              {{ label: "Female" }},
              {{ label: "Male" }},
              {{ label: "None of these" }}
            ]);
            console.log(JSON.stringify({{
              type: question.type,
              value: answer.value,
              valueSource: answer.source,
              notDeclared: {{
                option: notDeclared.option && notDeclared.option.label,
                source: notDeclared.source,
                fallback: notDeclared.fallback
              }},
              thermoUndisclosed: {{
                option: thermoUndisclosed.option && thermoUndisclosed.option.label,
                source: thermoUndisclosed.source,
                fallback: thermoUndisclosed.fallback
              }},
              doNotWish: {{
                option: doNotWish.option && doNotWish.option.label,
                source: doNotWish.source,
                fallback: doNotWish.fallback
              }},
              dontWish: {{
                option: dontWish.option && dontWish.option.label,
                source: dontWish.source,
                fallback: dontWish.fallback
              }},
              notSpecified: {{
                option: notSpecified.option && notSpecified.option.label,
                source: notSpecified.source,
                fallback: notSpecified.fallback
              }},
              noneOfThese: {{
                option: noneOfThese.option && noneOfThese.option.label,
                source: noneOfThese.source,
                fallback: noneOfThese.fallback
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
            self.skipTest("node is required to test the C3 V2 gender answer")

        self.assertEqual(
            json.loads(result.stdout),
            {
                "type": "disclosure_neutral",
                "value": "I choose not to disclose",
                "valueSource": "default:disclosure_neutral",
                "notDeclared": {
                    "option": "Not Declared",
                    "source": "neutral_fallback",
                    "fallback": True,
                },
                "thermoUndisclosed": {
                    "option": "Undisclosed (United States of America)",
                    "source": "neutral_fallback",
                    "fallback": True,
                },
                "doNotWish": {
                    "option": "I DO NOT WISH TO ANSWER",
                    "source": "neutral_fallback",
                    "fallback": True,
                },
                "dontWish": {
                    "option": "I DON'T WISH TO ANSWER",
                    "source": "neutral_fallback",
                    "fallback": True,
                },
                "notSpecified": {
                    "option": "Not Specified (United States of America)",
                    "source": "neutral_fallback",
                    "fallback": True,
                },
                "noneOfThese": {
                    "option": "None of these",
                    "source": "neutral_fallback",
                    "fallback": True,
                },
            },
        )

    def test_v2_required_unknown_options_use_progress_first_fallback(self):
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
                "option": "No",
                "source": "unknown_no_fallback",
                "fallback": True,
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

    def test_v2_sndl_age_and_transportation_questions_default_yes(self):
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
            function resolve(descriptor) {{
              const field = {{
                workday: {{ fieldLabel: descriptor.replace("*", "") }},
                descriptor,
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
              return {{
                type: question.type,
                value: answer.value,
                source: answer.source
              }};
            }}
            console.log(JSON.stringify({{
              legalAge: resolve("Are you of legal age to work in the Cannabis/Liquor Industry*"),
              transportation: resolve("Do you hold a valid Driver’s License or have reliable transportation to report to work*")
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
            self.skipTest("node is required to test the C3 V2 question mappings")

        self.assertEqual(
            json.loads(result.stdout),
            {
                "legalAge": {
                    "type": "legal_age_industry_eligibility",
                    "value": "Yes",
                    "source": "default:legal_age_industry_eligibility",
                },
                "transportation": {
                    "type": "reliable_transportation",
                    "value": "Yes",
                    "source": "default:reliable_transportation",
                },
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
              ]),
              bmsEngagement: resolve("Have you previously or are you currently engaged with BMS as a contractor, consultant, former employee, or any other role that required/requires you to have access to BMS systems? If yes, please answer the questions below. If not, please continue to the next item.", [
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
                "bmsEngagement": {
                    "type": "previous_employer",
                    "value": "No",
                    "selectedOption": "No",
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
              }},
              {{
                workday: {{
                  fieldLabel: "Candidate acknowledgment"
                }},
                fieldId: "input-9",
                descriptor: "Candidate acknowledgment input-9 checkbox createAccountCheckbox",
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

    def test_v2_salary_textarea_uses_profile_number_before_fallback(self):
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
                fieldLabel: "Please indicate your annual salary amount (e.g. 25000).*"
              }},
              fieldId: "primaryQuestionnaire--salary",
              descriptor: "Please indicate your annual salary amount (e.g. 25000).*",
              tagName: "TEXTAREA",
              uiModel: "textarea",
              required: true
            }};
            const question = root.questionIdentifier.identifyQuestion(field, null, null);
            const answer = root.answerResolver.resolveAnswer({{
              question,
              field,
              profile: {{ salaryExpectation: "95000", salaryExpectationRange: "90,000 - 105,000" }},
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
                "value": "95000",
                "valueSource": "profile:salaryExpectation",
            },
        )

    def test_v2_salary_textarea_has_numeric_default_when_profile_is_blank(self):
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
                "value": "100000",
                "valueSource": "default:salaryExpectation",
                "confidence": 0.72,
            },
        )

    def test_v2_salary_textarea_uses_range_midpoint_when_only_range_is_set(self):
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
                "value": "97500",
                "valueSource": "profile:salaryExpectationRange",
            },
        )

    def test_v2_salary_dropdown_uses_closest_numeric_option(self):
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
              profile: {{ salaryExpectation: "100000" }},
              audit: null,
              fieldAudit: null
            }});
            const match = root.optionMatcher.matchOption({{
              options: [
                {{ label: "$30000 - $35000", value: "$30000 - $35000" }},
                {{ label: "$85000 - $95000", value: "$85000 - $95000" }}
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
              issueCount: issues.length
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
                "valueSource": "profile:salaryExpectation",
                "option": "$85000 - $95000",
                "source": "salary_numeric_closest",
                "fallback": False,
                "issueCount": 0,
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
              profile: {{ salaryExpectation: "95000", salaryExpectationRange: "90,000 - 105,000" }},
              audit: null,
              fieldAudit: null
            }});
            const match = root.optionMatcher.matchOption({{
              options: [
                {{ label: "$30000 - $35000", value: "$30000 - $35000" }},
                {{ label: "$90,000 - $105,000", value: "$90,000 - $105,000" }}
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
                "option": "$90,000 - $105,000",
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
        self.assertIn("Detected account page", content)
        self.assertIn("Detected job application", content)
        self.assertIn("Open the email sign-in choice, then continue the account flow.", content)
        self.assertIn("No credential fields are visible yet.", content)
        self.assertIn("Hunt is moving through the account sign-in step.", content)
        self.assertIn("Create account and apply", content)
        self.assertIn("Log in and apply", content)
        self.assertIn("Fill application", content)
        self.assertIn("hunt.apply.fill_current_page", content)
        self.assertIn("hunt.apply.show_toast", content)
        self.assertIn("hunt-apply-page-toasts", content)
        self.assertIn("hunt.apply.show_fill_progress", content)
        self.assertIn("hunt.apply.show_fill_summary", content)
        self.assertIn("hunt-apply-fill-summary", content)
        self.assertIn("activeFillProgressRunId", content)
        self.assertIn('host.style.pointerEvents = "none"', content)
        self.assertIn("pointer-events: auto;", content)
        self.assertIn("ui.fill_summary.suppressed_active_progress", content)
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
        self.assertIn(
            "fieldIdentityKey",
            (REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "field-pipeline.js").read_text(
                encoding="utf-8"
            ),
        )
        self.assertIn(
            "skills_not_committed",
            (
                REPO_ROOT / "executioner" / "src" / "ats" / "workday" / "workday-repeatables-v2.js"
            ).read_text(encoding="utf-8"),
        )
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
        final_ui_capture = (REPO_ROOT / "scripts" / "c3_capture_final_ui.js").read_text(
            encoding="utf-8"
        )
        issue_registry = (REPO_ROOT / "scripts" / "lib" / "c3_issue_registry.js").read_text(
            encoding="utf-8"
        )
        configure_sink = (REPO_ROOT / "scripts" / "configure_c3_debug_sink.js").read_text(
            encoding="utf-8"
        )
        p_chrome_defaults = (REPO_ROOT / "scripts" / "c3_p_chrome_defaults.js").read_text(
            encoding="utf-8"
        )
        p_chrome_launcher = (REPO_ROOT / "scripts" / "launch_c3_chrome.ps1").read_text(
            encoding="utf-8"
        )
        background = (REPO_ROOT / "executioner" / "src" / "background" / "index.js").read_text(
            encoding="utf-8"
        )
        answer_resolver = (
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "answer-resolver.js"
        ).read_text(encoding="utf-8")
        workday_repeatables = (
            REPO_ROOT / "executioner" / "src" / "ats" / "workday" / "workday-repeatables-v2.js"
        ).read_text(encoding="utf-8")
        field_drivers = (
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "field-drivers.js"
        ).read_text(encoding="utf-8")
        manifest = (REPO_ROOT / "executioner" / "manifest.json").read_text(encoding="utf-8")

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
        self.assertIn("HUNT_C3_MAIL_MAX_SEARCH_MESSAGES", bridge)
        self.assertIn("maxSearchMessages", bridge)
        self.assertIn("Buffer.alloc(0)", bridge)
        self.assertIn("Buffer.concat([socket.__huntBuffer, chunk])", bridge)
        self.assertIn("Search one day wider", bridge)
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
        self.assertIn("resend account verification", smoke)
        self.assertIn("request_email_verification", smoke)
        self.assertIn('clickSafeAccountAction(pageClient, "verify")', smoke)
        self.assertIn("codeEntry", smoke)
        self.assertIn("HUNT_C3_TEST_WORKDAY_URL", smoke)
        self.assertIn("loadDotEnv", smoke)
        self.assertIn("checkMailAuth", smoke)
        self.assertIn("clickSafeAccountAction", smoke)
        self.assertIn("createAccountSubmitButton", smoke)
        self.assertIn("SignInWithEmailButton", smoke)
        self.assertIn("emailSignInPattern", smoke)
        self.assertIn("(?=.*\\\\bsign\\\\b)(?=.*\\\\bemail\\\\b)", smoke)
        self.assertIn("google|apple|linkedin|facebook|sso|oauth", smoke)
        self.assertIn("informationalBlurbButton", smoke)
        self.assertIn("trustedCdpClick", smoke)
        self.assertIn("Input.dispatchMouseEvent", smoke)
        self.assertNotIn("clickedInPage", smoke)
        self.assertIn("--reset-site-data", smoke)
        self.assertIn("resetBrowserSiteData", smoke)
        self.assertIn("clickSignInAction", smoke)
        self.assertIn("recordWorkflowEvent", smoke)
        self.assertIn("detect_account_state", smoke)
        workday_identifier = (REPO_ROOT / "scripts" / "lib" / "c3_workday_identifier.js").read_text(
            encoding="utf-8"
        )
        auth_workflow = (REPO_ROOT / "scripts" / "lib" / "c3_workday_auth_workflow.js").read_text(
            encoding="utf-8"
        )
        self.assertIn("WorkdayWorkflowIdentifier", live_smoke)
        self.assertIn("workdayPageKindExpression", workday_identifier)
        self.assertIn("blankWorkdayShell", workday_identifier)
        self.assertIn("blankShellReloaded", workday_identifier)
        self.assertIn('this.pageClient.send("Page.reload"', workday_identifier)
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
        self.assertIn("--close-other-workday-tabs", fresh_apply)
        self.assertNotIn('"--preserve-current"', fresh_apply)
        self.assertIn("--reset-site-data", fresh_apply)
        self.assertIn("--clear-before-fill", fresh_apply)
        self.assertIn("--keep-existing-workday-tabs", fresh_apply)
        self.assertIn("visibleValidationErrors", live_smoke)
        self.assertIn("progressBarActiveStep", live_smoke)
        self.assertIn("workday_catalog_after_auth", background)
        self.assertIn("detectWorkdayCatalogPageForTab", background)
        self.assertIn("hasVisibleAuthChoice", background)
        self.assertIn("isWorkdayLoginPath", background)
        self.assertIn("auth_landing_choice_clicked", background)
        self.assertIn("auth_landing_choice_not_clicked", background)
        self.assertIn("Opening email sign-in choice", background)
        self.assertIn('authUiState === "landing_choice"', background)
        self.assertIn("primaryActionSelectors.push", background)
        self.assertIn('"div"', background)
        self.assertIn('"span"', background)
        self.assertIn("seenPrimaryActionElements", background)
        self.assertIn('desiredAuthUiState === "landing_choice"', auth_workflow)
        self.assertIn("controlSelectors.push", auth_workflow)
        self.assertIn("seenControls", auth_workflow)
        self.assertIn("checkboxCommitTrace", auth_workflow)
        self.assertIn("auth_checkbox_not_committed", auth_workflow)
        self.assertIn("auth_no_captcha_gate", auth_workflow)
        self.assertIn("noCaptchaWrapperPresent", auth_workflow)
        self.assertIn("noCaptchaWrapperInfo", auth_workflow)
        self.assertIn("hasPasswordInput", auth_workflow)
        self.assertIn("hasLandingChoiceButton", auth_workflow)
        self.assertIn("isCredentialGate", auth_workflow)
        self.assertIn("credentialsFilled", auth_workflow)
        self.assertIn("authSubmitTrace", auth_workflow)
        self.assertIn("targetOverlapsAuthCheckbox", auth_workflow)
        self.assertIn("shouldPrimeNoCaptchaSubmit", auth_workflow)
        self.assertIn("shouldBringAuthPageToFront", auth_workflow)
        self.assertIn('Page.bringToFront"', auth_workflow)
        self.assertIn("broughtToFrontBeforeAuthSubmit", auth_workflow)
        self.assertIn("refill_credentials_after_nocaptcha_prime", auth_workflow)
        self.assertIn("native_checked_setter_after_nocaptcha_prime", auth_workflow)
        self.assertIn("shouldSettleAfterFormRequestSubmit", auth_workflow)
        self.assertIn("hidden_submit_after_form_no_progress", auth_workflow)
        self.assertIn("hidden_submit_request_submit", auth_workflow)
        self.assertIn("target_form_submit", auth_workflow)
        self.assertIn("shouldDeferPrimaryCdpClick", auth_workflow)
        self.assertIn("isCreateAccountSubmit", auth_workflow)
        self.assertIn("credentialFieldsAppeared", auth_workflow)
        self.assertIn('"nocaptcha_wrapper_cdp"', auth_workflow)
        self.assertIn('"nocaptcha_wrapper_dom_click"', auth_workflow)
        self.assertIn("dom_pointer_click_filter_after_no_progress", auth_workflow)
        self.assertIn("blur_settle_dom_pointer_click_filter_after_no_progress", auth_workflow)
        self.assertIn("delayed_click_filter_cdp_after_no_progress", auth_workflow)
        self.assertIn("isNoCaptchaAuthSubmit", auth_workflow)
        self.assertIn("authBadCredentialErrors", live_smoke)
        self.assertIn("fallbackAccountEmail", live_smoke)
        self.assertIn("clickCreateAccountAfterBadCredentials", live_smoke)
        self.assertIn("bad_credentials_try_fresh_create_account", live_smoke)
        self.assertIn("badCredentialCreateAccountAttemptsByScope", live_smoke)
        self.assertIn("verifiedAccountLoginRequiredByScope", live_smoke)
        self.assertIn("noteVerifiedAccountNeedsLogin", live_smoke)
        self.assertIn("verified_account_returned_to_auth_require_login", live_smoke)
        self.assertIn("verifiedAccountRetryAsLogin", live_smoke)
        self.assertIn("auth_no_captcha_gate", live_smoke)
        self.assertIn("manualAuthTimeoutMs", live_smoke)
        self.assertIn("--manual-auth-timeout-ms", live_smoke)
        self.assertIn('authNext.reason === "auth_primary_cdp_clicked"', live_smoke)
        self.assertIn("injectManualAuthPrompt", live_smoke)
        self.assertIn("waitForManualAuth", live_smoke)
        self.assertIn("hunt-manual-auth-prompt", live_smoke)
        self.assertIn("manualAuthResult", live_smoke)
        self.assertIn("manualAuthResultNoProgress", live_smoke)
        self.assertIn("auth_no_progress", live_smoke)
        self.assertIn('"native_checked_setter"', auth_workflow)
        self.assertIn("native_checked_setter_after_checked_readback", auth_workflow)
        self.assertIn('mode: "manual"', live_smoke)
        self.assertIn("clickApplyManuallyEntry", live_smoke)
        self.assertIn("logWorkflowPhase", live_smoke)
        self.assertIn("waitForWorkdayPageReady", live_smoke)
        wait_after_auth = background[
            background.index("async function waitForApplicationFieldsReadyAfterAuth") :
        ]
        self.assertLess(
            wait_after_auth.index("const workflowDetection = await detectWorkflowForTab(tabId);"),
            wait_after_auth.index('reason: "application_fields_ready"'),
        )
        self.assertIn("Workday page reached a classified state", live_smoke)
        self.assertIn("posting_not_found", live_smoke)
        self.assertIn("the page you are looking for", workday_identifier)
        self.assertIn("Detected start-application page and clicked Apply Manually", live_smoke)
        self.assertIn('phase: "apply_entry"', live_smoke)
        self.assertIn('phase: "job_fill"', live_smoke)
        self.assertIn("already_on_application_step", live_smoke)
        self.assertIn("allowLlmAnswers", live_smoke)
        self.assertIn('require("./lib/c3_cdp")', live_smoke)
        self.assertNotIn("class CdpClient", live_smoke)
        self.assertIn("--no-llm-answers", live_smoke)
        self.assertIn("--preserve-current is disabled", live_smoke)
        self.assertIn("Use --job-url with --close-other-workday-tabs", live_smoke)
        self.assertIn("sameWorkdayLoginRedirect", live_smoke)
        self.assertIn('url.searchParams.get("redirect")', live_smoke)
        self.assertIn("--audit-json", live_smoke)
        self.assertIn("buildFillAudit", live_smoke)
        self.assertIn("writeAuditJson", live_smoke)
        self.assertIn("recordAuditIssues", live_smoke)
        workday_audit = (REPO_ROOT / "scripts" / "lib" / "c3_workday_audit.js").read_text(
            encoding="utf-8"
        )
        self.assertIn("unknown_question_defaulted", issue_registry)
        self.assertIn("unsupported_or_empty_option_set", issue_registry)
        self.assertIn("required_field_unfilled", issue_registry)
        self.assertIn("review_profile_section_no_response", issue_registry)
        self.assertIn("no_safe_next_button", issue_registry)
        self.assertIn("auth_primary_action_not_found", issue_registry)
        self.assertIn("posting_not_found", issue_registry)
        self.assertIn("site_or_posting_state", issue_registry)
        self.assertIn("issues.jsonl", issue_registry)
        self.assertIn('path.join("logs", "c3-issues")', issue_registry)
        self.assertNotIn('path.join("docs", "c3-issues")', issue_registry)
        self.assertIn("valuePut", workday_audit)
        self.assertIn("visible_validation_errors", live_smoke)
        self.assertIn("reconcilePageFillTimeoutToReview", live_smoke)
        self.assertIn("timeout_reconciled_to_review", live_smoke)
        self.assertIn("terminalReconciliation", live_smoke)
        self.assertIn("35_000", live_smoke)
        self.assertIn("reviewCoverage", live_smoke)
        self.assertIn("reviewNoResponseLabels", live_smoke)
        self.assertIn("pageReachedReview", live_smoke)
        self.assertIn("normalizeSubmitText", final_ui_capture)
        self.assertIn("makeWorkdayProfileDefaults", live_smoke)
        self.assertIn("makeWorkdayProfileDefaults", configure_sink)
        self.assertIn("makeDefaultSecondWorkExperience", p_chrome_defaults)
        self.assertIn("Research Assistant", p_chrome_defaults)
        self.assertIn("topUpRepeatables", configure_sink)
        self.assertIn("repeatableKey(entry, kind)", configure_sink)
        self.assertIn("Social Network URLs", workday_repeatables)
        self.assertIn("socialWebsites", workday_repeatables)
        self.assertIn("selectedSkillMatches", workday_repeatables)
        self.assertIn("skillOptionText", workday_repeatables)
        self.assertIn("waitForGroupCount", workday_repeatables)
        self.assertIn("fillWebsiteUrlInputs(section, entries)", workday_repeatables)
        self.assertIn("deleteInvalidWebsiteRows(section)", workday_repeatables)
        self.assertIn("hunt.apply.runtimeConfig", live_smoke)
        self.assertIn("hunt.apply.runtimeConfig", smoke)
        self.assertIn("RUNTIME_CONFIG_KEY", configure_sink)
        self.assertIn("withWorkdayProfileAliases", live_smoke)
        self.assertIn("7804923111", p_chrome_defaults)
        self.assertIn("phoneDeviceType", p_chrome_defaults)
        self.assertIn("applicationSource", p_chrome_defaults)
        self.assertIn("applicationSourceCategory", p_chrome_defaults)
        self.assertIn("Job Board", p_chrome_defaults)
        self.assertIn('"privacy"', manifest)
        self.assertIn("ensurePasswordSavingDisabled", background)
        self.assertIn("chrome.privacy?.services?.passwordSavingEnabled", background)
        self.assertIn('"password_saving.disable_failed"', background)
        self.assertIn("suppressPasswordManagerForAuthInput", background)
        self.assertIn("data-hunt-password-manager-suppressed", background)
        self.assertIn("data-hunt-password-manager-suppressed", field_drivers)
        self.assertIn("Disable-PasswordManagerForProfile", p_chrome_launcher)
        self.assertIn("credentials_enable_service", p_chrome_launcher)
        self.assertIn("password_manager_enabled", p_chrome_launcher)
        self.assertIn("--disable-save-password-bubble", p_chrome_launcher)
        self.assertIn('entry.id === "application_source"', answer_resolver)
        self.assertIn("applicationSourceDetail", answer_resolver)
        self.assertIn("Social Media", answer_resolver)
        self.assertIn("Job Sites", answer_resolver)
        self.assertIn("hunt.apply.await_email_verification", background)
        self.assertIn("progressBarActiveStep", background)
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
        self.assertIn("nextRuntimeConfig", configure_sink)
        self.assertIn("class CdpClient", cdp_lib)
        self.assertIn("function httpJson", cdp_lib)
        self.assertIn("function tokenPathFor", gmail_oauth_lib)
        self.assertIn("async function gmailAuthorizedToken", gmail_oauth_lib)

    def test_workday_prompt_driver_has_trusted_input_bridge(self):
        manifest = json.loads(
            (REPO_ROOT / "executioner" / "manifest.json").read_text(encoding="utf-8")
        )
        background = (REPO_ROOT / "executioner" / "src" / "background" / "index.js").read_text(
            encoding="utf-8"
        )
        driver = (
            REPO_ROOT / "executioner" / "src" / "ats" / "workday" / "workday-drivers-v2.js"
        ).read_text(encoding="utf-8")

        self.assertIn("debugger", manifest["permissions"])
        self.assertIn('"hunt.apply.trusted_input"', background)
        self.assertIn("chrome.debugger.attach", background)
        self.assertIn("requestTrustedWorkdayClick", driver)
        self.assertIn('"category"', driver)
        self.assertIn('"option"', driver)

    def test_c3_email_verification_rejects_cross_tenant_workday_links(self):
        script = f"""
            const bridge = require({json.dumps(str(REPO_ROOT / "scripts" / "c3_mail_verify_bridge.js"))});
            const request = {{
              expectedDomains: ["myworkdayjobs.com", "capitalone.wd12.myworkdayjobs.com"],
              jobUrl: "https://capitalone.wd12.myworkdayjobs.com/Capital_One/job/Plainfield-NJ/Part-Time-Branch-Ambassador---New-Jersey-Market_R237537-2",
              expectedApplyUrl: "https://capitalone.wd12.myworkdayjobs.com/Capital_One/job/Plainfield-NJ/Part-Time-Branch-Ambassador---New-Jersey-Market_R237537-2/apply/applyManually?source=LinkedIn"
            }};
            const staleRtx = "https://globalhr.wd5.myworkdayjobs.com/REC_RTX_Ext_Gateway/activate/old-token";
            const capitalOne = "https://capitalone.wd12.myworkdayjobs.com/Capital_One/activate/new-token?redirect=%2FCapital_One%2Fjob%2FPlainfield-NJ%2FPart-Time-Branch-Ambassador---New-Jersey-Market_R237537-2%2Fapply%2FapplyManually%3Fsource%3DLinkedIn";
            const links = bridge.safeVerificationLinks(
              `Please verify your account ${{staleRtx}}. Please verify your account ${{capitalOne}}.`,
              request
            );
            console.log(JSON.stringify({{
              links,
              staleAllowed: bridge.workdayLinkAllowed(staleRtx, request),
              capitalAllowed: bridge.workdayLinkAllowed(capitalOne, request)
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
            self.skipTest("node is required to test the C3 mail bridge")

        parsed = json.loads(result.stdout)
        self.assertEqual(
            parsed["links"],
            [
                "https://capitalone.wd12.myworkdayjobs.com/Capital_One/activate/new-token?redirect=%2FCapital_One%2Fjob%2FPlainfield-NJ%2FPart-Time-Branch-Ambassador---New-Jersey-Market_R237537-2%2Fapply%2FapplyManually%3Fsource%3DLinkedIn"
            ],
        )
        self.assertFalse(parsed["staleAllowed"])
        self.assertTrue(parsed["capitalAllowed"])

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
        workday_repeatables = (
            REPO_ROOT / "executioner" / "src" / "ats" / "workday" / "workday-repeatables-v2.js"
        ).read_text(encoding="utf-8")
        field_catalog = (
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "field-catalog.js"
        ).read_text(encoding="utf-8")
        answer_resolver = (
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "answer-resolver.js"
        ).read_text(encoding="utf-8")
        shared_utils = (REPO_ROOT / "executioner" / "src" / "shared" / "injected.js").read_text(
            encoding="utf-8"
        )
        fill_runner = (
            REPO_ROOT / "executioner" / "src" / "background" / "fill-runner.js"
        ).read_text(encoding="utf-8")
        storage = (REPO_ROOT / "executioner" / "src" / "shared" / "storage.js").read_text(
            encoding="utf-8"
        )
        settings = (REPO_ROOT / "executioner" / "src" / "shared" / "settings.js").read_text(
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
        self.assertIn("salaryExpectation", settings)
        self.assertIn("hourlyPayExpectation", settings)
        self.assertIn("compensationOfferFactors", settings)
        self.assertIn("namePrefix", settings)
        self.assertIn("nameSuffix", settings)
        self.assertIn("accommodationRequest", settings)
        self.assertIn("conflictOfInterestRelationship", settings)
        self.assertIn("hhsOigExcluded", settings)
        self.assertIn("gsaFederalProgramExcluded", settings)
        self.assertIn("genericDrugDebarred", settings)
        self.assertIn("debarmentProceedingsPending", settings)
        self.assertIn("usLicensedPhysician", settings)
        self.assertIn("fdaHhsInvestigationalDrugRestricted", settings)
        self.assertIn("governmentalLicensingInquiry", settings)
        self.assertIn("calculateHourlyPayExpectation", storage)
        self.assertIn("2080", storage)
        self.assertIn("background security check", field_catalog)
        self.assertIn("automated tools such as ai", field_catalog)
        self.assertIn("inferWorkdayLocationFromApplyContext", shared_utils)
        self.assertIn("All Canada Employers", shared_utils)
        self.assertIn("nameParts", answer_resolver)
        self.assertIn("salaryExpectationRange", field_catalog)
        self.assertIn("hourlyPayExpectation", field_catalog)
        self.assertIn('profilePaths: ["namePrefix"]', field_catalog)
        self.assertIn('profilePaths: ["accommodationRequest"]', field_catalog)
        self.assertIn("Undeclared/Diverse", field_catalog)
        self.assertIn("accommodation_request", field_catalog)
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
        self.assertIn("email address*", shared_utils)
        self.assertIn("create account email", shared_utils)
        self.assertIn("shouldFillAuthConsentCheckbox", field_pipeline)
        self.assertIn("auth_page_checkbox_consent", field_pipeline)
        self.assertIn("createaccountcheckbox", field_catalog)
        self.assertIn("current password", shared_utils)
        self.assertIn("profile:middleName", shared_utils)
        self.assertIn('desc.includes("middlename")', shared_utils)
        self.assertIn("I choose not to disclose", shared_utils)
        self.assertIn("resume_already_uploaded", field_drivers)
        self.assertIn("not_resume_input", field_drivers)
        self.assertIn("resume/cv", field_catalog)
        self.assertIn("drop files", field_catalog)
        self.assertIn("fileInput", field_drivers)

    def test_workday_first20_batch_section_fix_guards(self):
        workday_ui = (
            REPO_ROOT / "executioner" / "src" / "ats" / "workday" / "workday-ui-v2.js"
        ).read_text(encoding="utf-8")
        safe_next = (REPO_ROOT / "executioner" / "src" / "background" / "safe-next.js").read_text(
            encoding="utf-8"
        )
        background = (REPO_ROOT / "executioner" / "src" / "background" / "index.js").read_text(
            encoding="utf-8"
        )
        field_drivers = (
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "field-drivers.js"
        ).read_text(encoding="utf-8")

        self.assertIn('button[data-automation-id*="select-files"]', workday_ui)
        self.assertIn('kind === "resume_file"', workday_ui)
        self.assertRegex(workday_ui, r"uiModel:\s+kind === \"resume_file\"\s+\?\s+\"file\"")
        self.assertIn("forceWorkdayDomClickFallback", safe_next)
        self.assertIn("forceWorkdayEnterFallback", safe_next)
        self.assertIn("safe_next_dom_fallback_after_noop", background)
        self.assertIn("safe_next_enter_fallback_after_noop", background)
        self.assertIn("clicked_safe_next_dom_fallback", safe_next)
        self.assertIn("clicked_safe_next_enter_fallback", safe_next)
        self.assertIn("commitDatePartWithKeyboard", field_drivers)
        self.assertIn("date_part_keyboard_commit", field_drivers)
        workday_drivers = (
            REPO_ROOT / "executioner" / "src" / "ats" / "workday" / "workday-drivers-v2.js"
        ).read_text(encoding="utf-8")
        workday_repeatables = (
            REPO_ROOT / "executioner" / "src" / "ats" / "workday" / "workday-repeatables-v2.js"
        ).read_text(encoding="utf-8")
        self.assertIn("settleWorkdayCommit", workday_drivers)
        self.assertIn("workdayFieldHasValidationError", workday_drivers)
        self.assertIn("technical_skills_partially_selected", workday_drivers)
        self.assertIn("clearWorkdaySearchText", workday_drivers)
        self.assertIn("maxSkillAttempts = field.required ? 10 : 5", workday_drivers)
        self.assertIn("genericSkillFallbacks", workday_drivers)
        self.assertIn("required_catalog_no_match", workday_drivers)
        self.assertIn("skill_option_not_loaded_within_2s", workday_drivers)
        self.assertIn("workday_skill_first_five_no_match", workday_drivers)
        self.assertIn("isSkillsSearch ? 2000", workday_drivers)
        self.assertIn('keyOn(siblingInput, "Enter")', workday_drivers)
        self.assertIn('keyOn(el, "Enter")', workday_drivers)
        self.assertIn('keyOn(input, "Enter")', workday_repeatables)
        self.assertIn("workday_skill_attempt_start", workday_repeatables)
        self.assertIn("workday_skill_attempt_result", workday_repeatables)
        self.assertIn("skillsBudgetMs = 25000", workday_repeatables)
        self.assertIn("workday_skills_time_budget_exceeded", workday_repeatables)
        self.assertIn("requiredSkillFallbacks", workday_repeatables)
        self.assertIn('"Sales"', workday_repeatables)
        self.assertIn("values = values.concat(requiredSkillFallbacks)", workday_repeatables)
        self.assertIn("allowVisibleFallback", workday_repeatables)
        self.assertIn("selectedSkillMatches(query) || hasAnySelectedSkill()", workday_repeatables)
        self.assertIn("workday_skills_already_selected", workday_repeatables)
        self.assertIn("promptAriaInstruction", workday_repeatables)
        self.assertIn("repairVisibleValidationTexts", workday_repeatables)
        self.assertIn("repeatableFillScope", workday_repeatables)
        self.assertIn("repeatableRepairScopes", workday_repeatables)
        self.assertIn('scopeSet.has("skills")', workday_repeatables)
        self.assertIn("repairSectionForValidation", workday_repeatables)
        self.assertIn("controlNeedsRepair", workday_repeatables)
        self.assertIn("Bachelor Degree", workday_repeatables)
        self.assertIn("Bachelors Degree or University", workday_repeatables)
        self.assertNotIn("Boolean(button.value)", workday_repeatables)
        self.assertIn('field?.uiModel === "button_listbox"', workday_drivers)
        self.assertIn("option_keyboard", workday_drivers)
        self.assertIn("settleWorkdayCommit", workday_drivers)
        self.assertIn("workday_validation_not_cleared", workday_drivers)
        self.assertIn("committedApplicationSourceMatches", workday_drivers)
        self.assertIn("selectedTechnicalSkillMatches", workday_drivers)
        self.assertIn("Bachelors Degree or University", workday_repeatables)
        self.assertIn("repairMissingRequiredRows", workday_repeatables)
        self.assertIn("targetKey && !afterKeys.includes(targetKey)", workday_repeatables)
        self.assertIn("activeListboxFor(button)", workday_repeatables)
        self.assertIn("[role='radio']", background)
        self.assertIn("external_assessment_required", safe_next)
        self.assertIn("Take Assessment", safe_next)
        self.assertIn("[data-uxi-widget-type='multiselectlist']", safe_next)
        self.assertIn("disabledFooterCandidates", safe_next)
        self.assertIn("ariaDisabledBypass", safe_next)
        self.assertIn("[data-automation-id='pageFooterNextButton']", safe_next)
        self.assertIn("safe_next_space_fallback_after_noop", background)
        self.assertIn("auth_create_account_to_signin_sink", background)
        field_pipeline = (
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "field-pipeline.js"
        ).read_text(encoding="utf-8")
        self.assertIn("normalizedRepairErrors", field_pipeline)
        self.assertIn("hasValidationState(field)", field_pipeline)
        self.assertIn("not_in_visible_validation_errors", field_pipeline)
        self.assertNotIn("genericRequiredError", field_pipeline)
        self.assertIn("auth_no_progress", background)
        self.assertIn("authShellStillSettling", background)
        self.assertIn("stillLoading", background)
        live_identifier = (REPO_ROOT / "scripts" / "lib" / "c3_workday_identifier.js").read_text(
            encoding="utf-8"
        )
        live_smoke = (REPO_ROOT / "scripts" / "c3_workday_live_smoke.js").read_text(
            encoding="utf-8"
        )
        self.assertIn("authShellStillSettling", live_identifier)
        self.assertIn("timeout_reconciled_to_later_step", live_smoke)
        self.assertIn("continue pageLoop", live_smoke)
        self.assertIn("workdaySourceStateErrors", live_smoke)
        self.assertIn("workday_source_query_state", live_smoke)
        self.assertIn("pageFooterNextButton", safe_next)
        repeatables = (
            REPO_ROOT / "executioner" / "src" / "ats" / "workday" / "workday-repeatables-v2.js"
        ).read_text(encoding="utf-8")
        self.assertIn("firstYearAttended", repeatables)
        self.assertIn("lastYearAttended", repeatables)
        field_catalog = (
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "field-catalog.js"
        ).read_text(encoding="utf-8")
        option_matcher = (
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "option-matcher.js"
        ).read_text(encoding="utf-8")
        self.assertIn("I do not wish to share", field_catalog)
        self.assertIn("experience_affirmation", field_catalog)
        self.assertIn("us_person_export_control", field_catalog)
        self.assertIn("how soon can you start", field_catalog)
        self.assertIn("not to respond", option_matcher)
        self.assertIn("do not wish", option_matcher)

    def test_workday_review_fixes_have_regression_guards(self):
        field_pipeline = (
            REPO_ROOT / "executioner" / "src" / "shared" / "v2" / "field-pipeline.js"
        ).read_text(encoding="utf-8")
        workday_drivers = (
            REPO_ROOT / "executioner" / "src" / "ats" / "workday" / "workday-drivers-v2.js"
        ).read_text(encoding="utf-8")
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
        ).read_text(encoding="utf-8")

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
        self.assertIn("normUrl", workday_repeatables)
        self.assertIn("deleteBlankRequiredRows", workday_repeatables)
        self.assertIn("groupLooksBlank", workday_repeatables)
        self.assertIn("[data-automation-id='formField']", workday_repeatables)
        self.assertIn("resumeUploadedText", workday_repeatables)
        self.assertIn("clearResumeUpload", workday_repeatables)
        self.assertIn("\"button,[role='button'],a,[tabindex]\"", workday_repeatables)
        self.assertIn("skillOptionCommitTarget", workday_repeatables)
        self.assertIn("waitForSkillOption", workday_repeatables)
        self.assertIn("fillSkill", workday_repeatables)
        self.assertIn("requestTrustedMouseClick", workday_repeatables)
        self.assertIn('"repeatable_skill_option"', workday_repeatables)
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
