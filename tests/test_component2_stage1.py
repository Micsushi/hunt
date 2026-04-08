import tempfile
import unittest
from pathlib import Path

from fletcher.parser import parse_resume_file, parse_resume_tex
from fletcher.renderer import render_resume_tex

REPO_ROOT = Path(__file__).resolve().parent.parent
MAIN_TEX = REPO_ROOT / "main.tex"


class Component2Stage1Tests(unittest.TestCase):
    def test_parse_main_resume_extracts_expected_sections(self):
        doc = parse_resume_file(MAIN_TEX)

        self.assertEqual(doc.header.name, "Michael Shi")
        self.assertEqual(
            doc.section_order, ["Education", "Experience", "Projects", "Technical Skills"]
        )
        self.assertEqual(doc.education.entry.entry_id, "edu_primary")
        self.assertEqual(len(doc.experience), 3)
        self.assertEqual(len(doc.projects), 1)
        self.assertIn("Python", doc.skills.languages)
        self.assertIn("FastAPI", doc.skills.frameworks)
        self.assertIn("Docker", doc.skills.developer_tools)

    def test_renderer_round_trip_preserves_parsed_structure(self):
        original = parse_resume_file(MAIN_TEX)
        rendered_tex = render_resume_tex(original)
        reparsed = parse_resume_tex(rendered_tex, source_path="<roundtrip>")

        self.assertEqual(reparsed.header, original.header)
        self.assertEqual(reparsed.education, original.education)
        self.assertEqual(reparsed.experience, original.experience)
        self.assertEqual(reparsed.projects, original.projects)
        self.assertEqual(reparsed.skills, original.skills)

    def test_cli_roundtrip_outputs_files(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            json_path = Path(tmpdir) / "resume.json"
            tex_path = Path(tmpdir) / "roundtrip.tex"

            import subprocess
            import sys

            result = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "fletcher.cli",
                    "parse-resume",
                    "--resume",
                    str(MAIN_TEX),
                    "--output-json",
                    str(json_path),
                    "--roundtrip-tex",
                    str(tex_path),
                ],
                cwd=REPO_ROOT,
                capture_output=True,
                text=True,
            )

            self.assertEqual(result.returncode, 0, msg=result.stderr)
            self.assertTrue(json_path.exists())
            self.assertTrue(tex_path.exists())
            self.assertIn("\\section{Experience}", tex_path.read_text(encoding="utf-8"))
