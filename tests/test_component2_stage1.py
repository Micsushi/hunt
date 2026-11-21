import unittest
from pathlib import Path

from fletcher.resume.parser import parse_resume_tex
from fletcher.resume.renderer import render_resume_tex

REPO_ROOT = Path(__file__).resolve().parent.parent
MAIN_TEX = REPO_ROOT / "main.tex"


class Component2Stage1Tests(unittest.TestCase):
    def test_renderer_round_trip_preserves_present_and_absent_sections(self):
        full = MAIN_TEX.read_text(encoding="utf-8")
        work_only = (
            full[: full.index("    \\section{Projects}")] + full[full.index("\\end{document}") :]
        )
        for text, work_only_case in ((full, False), (work_only, True)):
            with self.subTest(work_only=work_only_case):
                original = parse_resume_tex(text, source_path="<source>")
                rendered = render_resume_tex(original)
                reparsed = parse_resume_tex(rendered, source_path="<roundtrip>")
                for field in ("header", "summary", "education", "experience", "projects", "skills"):
                    self.assertEqual(getattr(reparsed, field), getattr(original, field), field)
                if work_only_case:
                    self.assertGreater(len(original.experience), 0)
                    self.assertEqual(original.projects, [])
                    self.assertEqual(original.skills.categories, {})
                    self.assertNotIn("\\section{Projects}", rendered)
                    self.assertNotIn("\\section{Technical Skills}", rendered)
