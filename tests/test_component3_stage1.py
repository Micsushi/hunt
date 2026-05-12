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
        self.assertEqual(profile["education"][0]["endYear"], "2026")
        self.assertEqual(profile["workExperience"][0]["company"], "INVIDI Technologies")
        self.assertEqual(profile["workExperience"][0]["jobTitle"], "Junior Software Developer (Part-time)")
        self.assertIn("Kotlin microservices", profile["workExperience"][0]["description"])
        self.assertIn("Python", profile["skills"])
        self.assertIn("Kubernetes", profile["skills"])
        self.assertIn("Phone", payload["missing"])

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
        self.assertEqual(payload["taleo"], "taleo")
        self.assertIn("greenhouse", payload["genericBacked"])
        self.assertIn("lever", payload["genericBacked"])
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
        options = (REPO_ROOT / "executioner" / "src" / "options" / "options.html").read_text(
            encoding="utf-8"
        )

        self.assertIn("alarms", manifest["permissions"])
        self.assertIn("downloads", manifest["permissions"])
        self.assertEqual(manifest["host_permissions"], ["<all_urls>"])
        self.assertEqual(manifest["content_scripts"][0]["matches"], ["<all_urls>"])
        self.assertIn("c4PollingEnabled", settings)
        self.assertIn("autoPromptEnabled", settings)
        self.assertIn("autoClickNextAfterFill", settings)
        self.assertIn("fillRequiredOnly", settings)
        self.assertIn("settingsVersion", settings)
        self.assertIn("autoExportLogs", settings)
        self.assertIn("debugLogSinkEnabled", settings)
        self.assertIn("coOpTermsCompleted", settings)
        self.assertIn("workExperience", settings)
        self.assertIn("education", settings)
        self.assertIn("skills", settings)
        self.assertIn("llmAnswerFallbackEnabled", settings)
        self.assertIn("autoExportLogPrefix", settings)
        self.assertIn("backendUrl", settings)
        self.assertIn("serviceToken", settings)
        self.assertIn("pollIntervalSeconds", storage)
        self.assertIn("autoClickNextAfterFill", storage)
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
        self.assertIn('id="c4-polling-enabled"', options)
        self.assertIn('id="poll-c4-once"', options)
        self.assertIn('id="auto-prompt-enabled"', options)
        self.assertIn('id="auto-click-next-after-fill"', options)
        self.assertIn('id="fill-required-only"', options)
        self.assertIn('id="auto-export-logs"', options)
        self.assertIn('id="debug-log-sink-enabled"', options)
        self.assertIn('id="auto-export-log-prefix"', options)
        self.assertIn('id="export-logs-now"', options)
        self.assertIn('id="test-debug-log-sink"', options)
        self.assertIn('id="activity-log-count"', options)
        self.assertIn('data-tab-target="experience"', options)
        self.assertIn('id="work-experience-list"', options)
        self.assertIn('id="education-list"', options)
        self.assertIn('id="profile-skills"', options)
        self.assertIn("max-height: min(420px, 52vh)", options)
        options_js = (
            REPO_ROOT / "executioner" / "src" / "options" / "options.js"
        ).read_text(encoding="utf-8")
        self.assertIn("const currentProfile = readFullProfileForm()", options_js)
        self.assertIn("mergeProfileFromResume(currentProfile, parsedProfile)", options_js)
        self.assertIn("hunt.apply.export_logs", background)
        self.assertIn("hunt.apply.test_debug_log_sink", background)
        self.assertIn("chrome.downloads.download", background)
        self.assertIn("data:application/json;base64", background)
        self.assertIn("utf8Base64", background)
        self.assertNotIn("URL.createObjectURL", background)
        self.assertIn("showPageToast", background)
        self.assertIn("looksLikeUploadedFile", background)
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
        self.assertIn("realisticOptionClick", fill_runner)
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
        self.assertIn("showLlmConfirm", popup_js)
        generic_fill = (
            REPO_ROOT / "executioner" / "src" / "ats" / "generic" / "fill.js"
        ).read_text(encoding="utf-8")
        self.assertIn('[role="combobox"][aria-expanded="true"]', generic_fill)
        self.assertIn('key: "Escape"', generic_fill)
        self.assertIn("realisticOptionClick", shared_utils)
        self.assertIn("pointerdown", shared_utils)
        self.assertIn('key("Enter")', shared_utils)
        self.assertIn('state.source === "input"', shared_utils)
        self.assertNotIn("window.confirm", popup_js)
        self.assertIn("postDebugLog", background)
        self.assertIn("fill_result", background)
        self.assertIn("No default resume is saved", background)
        self.assertIn('@app.post("/api/c3/debug-log")', backend_app)
        self.assertIn('@app.post("/api/c3/answer-decision")', backend_app)
        self.assertIn('@app.get("/api/c3/llm-status")', backend_app)
        self.assertIn("c3_extension_debug.jsonl", backend_app)

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

        self.assertIn("detectPageKind", content)
        self.assertIn("ATS_HOST_PATTERNS", content)
        self.assertIn("job-boards.greenhouse.io", content)
        self.assertIn("EMBEDDED_ATS_SELECTORS", content)
        self.assertIn("#grnhse_app", content)
        self.assertIn("SIGNUP_TERMS", content)
        self.assertIn("hunt.apply.fill_current_page", content)
        self.assertIn("hunt.apply.show_toast", content)
        self.assertIn("hunt-apply-page-toasts", content)
        self.assertIn("hunt.apply.show_fill_progress", content)
        self.assertIn("hunt.apply.hide_fill_progress", content)
        self.assertIn("hunt.apply.dismiss_transient_ui", content)
        self.assertIn("MutationObserver", content)
        self.assertIn("schedulePromptCheck", content)
        self.assertIn("navigation_click", content)
        self.assertIn("dom_change", content)
        self.assertIn("dismissedPromptSignatures", content)
        self.assertIn("hunt-apply-fill-progress-spinner", content)
        self.assertIn("Filling page", content)
        self.assertIn("detected_page_prompt", content)
        self.assertIn(
            "Prompt on signup/ATS pages",
            (REPO_ROOT / "executioner" / "src" / "options" / "options.html").read_text(
                encoding="utf-8"
            ),
        )
        self.assertIn('id="auto-prompt"', popup)
        self.assertIn('id="llm-confirm"', popup)
        self.assertIn('id="llm-use"', popup)
        self.assertIn('id="llm-skip"', popup)
        self.assertIn('id="next-confirm"', popup)
        self.assertIn('id="next-go"', popup)
        self.assertIn('id="next-always"', popup)
        self.assertIn('id="clear-page"', popup)
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
        self.assertIn("window.close()", popup_js)
        self.assertIn("page.clear", background)
        self.assertIn("allFrames: true", background)
        self.assertIn('[role="combobox"], [aria-autocomplete="list"]', background)
        self.assertIn("clearDatasetSelection", background)
        self.assertIn("select__single-value", background)
        self.assertIn("select__indicators button", background)
        self.assertIn("clickSelectClearIndicators", background)
        self.assertIn(".select__indicators > *", background)
        self.assertIn("clickableIndicators.slice(0, -1)", background)
        self.assertIn("isDropdownToggleLabel", background)
        self.assertIn("closeOpenDropdowns", background)
        self.assertIn("closedDropdowns", background)
        self.assertIn("remainingOpenDropdowns", background)
        self.assertIn("remainingFilledControls", background)
        self.assertIn("clearIndicatorClicks", background)
        self.assertIn("hiddenDropdownMenus", background)
        self.assertIn("withTimeout", background)
        self.assertIn("safe_next_probe_timeout", background)
        self.assertIn("Safe Next check timed out.", background)
        self.assertIn("Fill timed out before the page responded.", background)
        self.assertIn("fill_timeout", background)
        self.assertIn("hideTransientDropdownMenus", background)
        self.assertIn("clearWorkdayButtonDropdowns", background)
        self.assertIn("clearWorkdayMultiselects", background)
        self.assertIn("countRemainingWorkdayButtonValues", background)
        self.assertIn("countRemainingWorkdayMultiselectValues", background)
        self.assertIn('button[aria-haspopup="listbox"]', background)
        self.assertIn("press delete to clear value", background)
        self.assertIn("workdaySelectedItems", background)
        self.assertIn("workdayButtonClears", background)
        self.assertIn("workdayMultiselectClears", background)
        self.assertIn("clickClearControl", background)
        self.assertIn("fieldHasSelectedValue", background)
        self.assertIn("realisticClick", background)
        self.assertIn("setNativeValue", background)
        self.assertIn('new InputEvent("input"', injected)
        self.assertIn('new InputEvent("beforeinput"', injected)
        self.assertIn('[aria-expanded="true"]', background)
        self.assertIn('el.setAttribute("aria-expanded", "false")', background)
        self.assertIn("select__menu--is-open", background)
        self.assertIn("buttons.length > 1 && index === 0", background)
        self.assertIn("input[aria-hidden='true'], input[tabindex='-1']", background)
        self.assertIn("aria-activedescendant", background)
        self.assertIn(".select__container, .select-shell", background)
        self.assertNotIn("[class*='select'], [role='group']", background)

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
        self.assertIn('type: "hunt.apply.save_settings"', options)
        self.assertIn('type: "hunt.apply.save_profile"', options)
        self.assertIn('"settings-form"', options)
        self.assertIn('"profile-form"', options)
        self.assertIn("Settings autosaved.", options)
        self.assertIn("Profile autosaved.", options)
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
        two_step = (fixture_dir / "two_step_application.html").read_text(encoding="utf-8")
        custom_selects = (fixture_dir / "greenhouse_custom_selects.html").read_text(
            encoding="utf-8"
        )

        self.assertIn("Username", signup)
        self.assertIn("Password", signup)
        self.assertIn("Position applied for", two_step)
        self.assertIn("Why are you interested?", two_step)
        self.assertIn('role="combobox"', custom_selects)
        self.assertIn("legally eligible to work", custom_selects)
        self.assertIn("expected graduation date", custom_selects)

    def test_workday_adapter_handles_hidden_file_inputs_and_missing_resume_logging(self):
        workday = (REPO_ROOT / "executioner" / "src" / "ats" / "workday" / "fill.js").read_text(
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

        self.assertIn("document.querySelectorAll('input[type=\"file\"]')", workday)
        self.assertIn("resume_upload:missing_resume_data", workday)
        self.assertIn("pageLooksLikeResumeUpload", workday)
        self.assertIn("fieldInventory", workday)
        self.assertIn("interactionTrace", workday)
        self.assertIn('traceInteraction("hover"', workday)
        self.assertIn('traceInteraction("click"', workday)
        self.assertIn('traceInteraction("already_filled"', workday)
        self.assertIn("u.traceInteraction = traceInteraction", workday)
        self.assertIn("traceHoverAndClick", shared_utils)
        self.assertIn("select_radio_option", shared_utils)
        self.assertIn("select_combobox_option", shared_utils)
        self.assertIn("sanitizeInteractionTrace", storage)
        self.assertIn("sanitizeWorkExperience", storage)
        self.assertIn("sanitizeEducation", storage)
        self.assertIn('"manual_review"', fill_runner)
        self.assertIn("manual review needed", fill_runner)
        self.assertIn("allFrames: true", fill_runner)
        self.assertIn("chooseBestFrameResult", fill_runner)
        self.assertIn("frameResults", fill_runner)
        self.assertIn("frameUrl", fill_runner)
        self.assertIn("shouldSkipProfileFill", workday)
        self.assertIn("unsafe_profile_context", workday)
        self.assertIn("unsafe_generated_answer_context", workday)
        self.assertIn("isExactCityField", workday)
        self.assertIn("isExactProvinceField", workday)
        self.assertIn("applicationSource", workday)
        self.assertIn("fillComboboxElement", workday)
        self.assertIn('button[aria-haspopup="listbox"]', workday)
        self.assertIn("fillWorkdayButtonDropdown", workday)
        self.assertIn("buttonValueMatchesChoice", workday)
        self.assertIn("forceSetWorkdayButtonChoice", workday)
        self.assertIn("workday_button_force_commit_after_click", workday)
        self.assertIn("clearWorkdayButtonSelection", workday)
        self.assertIn('[role="listbox"]', workday)
        self.assertIn('el.style.pointerEvents = "none"', workday)
        self.assertIn("primeCountryDependentFields", workday)
        self.assertIn("isPhoneCountryCodeField", workday)
        self.assertIn("countryCodeLooksCorrect", workday)
        self.assertIn("scrollAttempt", workday)
        self.assertIn('[id^="pill-"]', workday)
        self.assertIn("press delete to clear value", workday)
        self.assertIn("clearCountryCodeSelection", workday)
        self.assertIn("required_terms_checkbox", workday)
        self.assertIn("addWorkExperienceEntries", workday)
        self.assertIn("addEducationEntries", workday)
        self.assertIn("fillWorkdaySkills", workday)
        self.assertIn("addWebsiteEntries", workday)
        self.assertIn("processMyExperienceSections", workday)
        self.assertIn("chooseStructuredChoice", shared_utils)
        self.assertIn("optionScoreForChoice", shared_utils)
        self.assertIn("phone device type", shared_utils)
        self.assertIn("countryParts.country", shared_utils)
        self.assertIn("how did you hear", shared_utils)
        self.assertIn("knownProvinces", shared_utils)
        self.assertIn("resume_already_uploaded", workday)
        self.assertIn("not_resume_input", workday)
        self.assertIn('"drop file"', workday)
        self.assertIn('"file-upload"', workday)

    def test_workday_review_fixes_have_regression_guards(self):
        workday = (REPO_ROOT / "executioner" / "src" / "ats" / "workday" / "fill.js").read_text(
            encoding="utf-8"
        )
        fill_runner = (
            REPO_ROOT / "executioner" / "src" / "background" / "fill-runner.js"
        ).read_text(encoding="utf-8")
        storage = (REPO_ROOT / "executioner" / "src" / "shared" / "storage.js").read_text(
            encoding="utf-8"
        )

        self.assertIn("try {", workday)
        self.assertIn("finally {", workday)
        self.assertIn("traceTruncated", workday)
        self.assertIn("finalizeRequiredFieldReview", workday)
        self.assertIn('buttonResult.reason === "already_filled"', workday)
        self.assertIn('phoneCountryResult.reason === "already_filled"', workday)
        self.assertIn('"required_field_unresolved:"', workday)
        self.assertIn("clear_failed", workday)
        self.assertIn("traceTruncated", fill_runner)
        self.assertIn("traceTruncated", storage)

    def test_workday_my_experience_live_regression_guards(self):
        workday = (REPO_ROOT / "executioner" / "src" / "ats" / "workday" / "fill.js").read_text(
            encoding="utf-8"
        )

        self.assertIn("isWorkdayAddButtonLabel", workday)
        self.assertIn("add another", workday)
        self.assertIn("visibleInSection", workday)
        self.assertIn("waitForSectionFieldCountIncrease", workday)
        self.assertIn("emptyUrlInputs", workday)
        self.assertIn("hasExistingResumeUpload", workday)
        self.assertIn("resume_upload_existing", workday)
        self.assertIn("existing_resume_upload_detected", workday)
        self.assertIn('button, [role="button"], a, [tabindex]', workday)
        self.assertIn("missing_profile_entries", workday)
        self.assertIn("workday_my_experience_profile_counts", workday)
        self.assertIn("visibleStepHeadings", workday)

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
