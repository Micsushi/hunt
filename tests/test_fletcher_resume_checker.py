import hashlib
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

from fletcher.check_api import router
from fletcher.resume.importer import parse_resume_text
from fletcher.resume_checker import check_resume, validate_report


class PdfImportTests(unittest.TestCase):
    def test_wrapped_bullets_links_and_skill_categories_survive_import(self):
        text = """Example Candidate
candidate@example.com
Education
Example University
2026
Experience
Engineer, Example Company
2024 - 2026
• Built APIs handling requests
across multiple regions.
• Reduced cost by 20%.
Intern, Second Company
2023 - 2024
• Tested software.
Projects
Sample Project
github.com/example/project
• Built a service with
background processing.
Skills
Cloud: AWS (S3, EC2), Docker,
Kubernetes
Languages: Python, Go
"""
        document, _ = parse_resume_text(text, "sample.pdf")
        self.assertEqual(len(document.experience), 2)
        self.assertEqual(
            document.experience[0].bullets[0],
            "Built APIs handling requests across multiple regions.",
        )
        self.assertEqual(len(document.projects), 1)
        self.assertEqual(document.projects[0].date_or_link_text, "github.com/example/project")
        self.assertEqual(
            document.skills.categories["Cloud"], ["AWS (S3, EC2)", "Docker", "Kubernetes"]
        )


def sample_pdf(path, text="Education Experience Projects Skills engineer@example.com Python"):
    writer = PdfWriter()
    page = writer.add_blank_page(width=612, height=792)
    font = DictionaryObject(
        {
            NameObject("/Type"): NameObject("/Font"),
            NameObject("/Subtype"): NameObject("/Type1"),
            NameObject("/BaseFont"): NameObject("/Helvetica"),
        }
    )
    page[NameObject("/Resources")] = DictionaryObject(
        {NameObject("/Font"): DictionaryObject({NameObject("/F1"): writer._add_object(font)})}
    )
    stream = DecodedStreamObject()
    stream.set_data(f"BT /F1 10 Tf 30 700 Td ({text}) Tj ET".encode())
    page[NameObject("/Contents")] = writer._add_object(stream)
    writer.write(path)


@unittest.skipUnless(shutil.which("node"), "Node.js is required for Resume Cooker")
class ResumeCheckerTests(unittest.TestCase):
    def test_real_pdf_parsers_and_cooker_do_not_mutate_input(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "resume.pdf"
            sample_pdf(path)
            before = path.read_bytes()
            result = check_resume(path, job_description="Backend engineer Python Kubernetes AWS")
            self.assertEqual(path.read_bytes(), before)
            self.assertFalse(result["content_left_machine"])
            self.assertEqual(result["input_sha256"], hashlib.sha256(before).hexdigest())
            checks = {item["id"]: item for item in result["checks"]}
            self.assertEqual(checks["independent_parser_agreement"]["status"], "pass")
            self.assertIn("Kubernetes", checks["jd_keyword_coverage"]["metadata"]["missing_terms"])

    def test_empty_pdf_cannot_receive_passing_status(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "empty.pdf"
            sample_pdf(path, "")
            self.assertEqual(check_resume(path)["status"], "fail")

    def test_upload_api_actual_check_and_invalid_file(self):
        app = FastAPI()
        app.include_router(router)
        client = TestClient(app)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "sample.pdf"
            sample_pdf(path)
            response = client.post(
                "/check", files={"resume": ("../../sample.pdf", path.read_bytes())}
            )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIn("score", response.json())
        self.assertEqual(
            client.post("/check", files={"resume": ("x.pdf", b"invalid")}).status_code, 422
        )
        self.assertEqual(client.post("/check", files={"resume": ("x.exe", b"x")}).status_code, 422)

    def test_missing_checker_is_not_a_score(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "sample.tex"
            path.write_text("Education Experience Projects Skills")
            with patch.dict(
                "os.environ", {"HUNT_C2_RESUME_CHECK_COMMAND": "missing-cooker-executable"}
            ):
                with self.assertRaisesRegex(RuntimeError, "unavailable"):
                    check_resume(path)

    def test_report_privacy_and_exit_mismatch_fail_closed(self):
        report = {
            "schema_version": 1,
            "command": "check",
            "status": "pass",
            "run_id": "test",
            "content_left_machine": False,
            "checks": [],
        }
        self.assertIsNone(validate_report(report, "check", 0))
        self.assertIsNotNone(validate_report(report, "check", 2))
        self.assertIsNotNone(validate_report({**report, "content_left_machine": True}, "check", 0))


if __name__ == "__main__":
    unittest.main()
