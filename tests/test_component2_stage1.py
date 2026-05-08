import tempfile
import unittest
from pathlib import Path

from fletcher.jobs.classifier import classify_job
from fletcher.resume.parser import parse_resume_file, parse_resume_tex
from fletcher.resume.renderer import render_resume_tex

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

    def test_parse_twocolentry_preserves_nested_inline_latex(self):
        doc = parse_resume_file(MAIN_TEX)

        self.assertEqual(
            doc.education.entry.date_text,
            "Expected Graduation: \\textbf{Sep 2026}",
        )
        self.assertEqual(
            doc.projects[0].date_or_link_text,
            "\\href{https://github.com/NatRunners/StudyAmp}{github.com/NatRunners/StudyAmp}",
        )

    def test_renderer_round_trip_preserves_parsed_structure(self):
        original = parse_resume_file(MAIN_TEX)
        rendered_tex = render_resume_tex(original)
        reparsed = parse_resume_tex(rendered_tex, source_path="<roundtrip>")

        self.assertEqual(reparsed.header, original.header)
        self.assertEqual(reparsed.summary, original.summary)
        self.assertEqual(reparsed.education, original.education)
        self.assertEqual(reparsed.experience, original.experience)
        self.assertEqual(reparsed.projects, original.projects)
        self.assertEqual(reparsed.skills, original.skills)

    def test_parse_optional_summary_section(self):
        tex = MAIN_TEX.read_text(encoding="utf-8").replace(
            "    \\section{Education}",
            (
                "    \\section{Summary}\n\n"
                "    \\begin{onecolentry}\n"
                "        Backend developer with Python and React experience.\n"
                "    \\end{onecolentry}\n\n"
                "    \\section{Education}"
            ),
            1,
        )

        doc = parse_resume_tex(tex, source_path="<summary>")

        self.assertEqual(doc.summary, "Backend developer with Python and React experience.")

    def test_renderer_omits_empty_experience_and_project_sections(self):
        doc = parse_resume_file(MAIN_TEX)
        doc.experience = []
        doc.projects = []

        rendered = render_resume_tex(doc)

        self.assertNotIn("\\section{Experience}", rendered)
        self.assertNotIn("\\section{Projects}", rendered)

    def test_parse_resume_accepts_missing_projects_and_skills(self):
        tex = MAIN_TEX.read_text(encoding="utf-8")
        tex = tex.replace(
            tex[
                tex.index("    \\section{Projects}") : tex.index("    \\section{Technical Skills}")
            ],
            "",
        )
        tex = tex.replace(
            tex[tex.index("    \\section{Technical Skills}") : tex.index("\\end{document}")],
            "",
        )

        doc = parse_resume_tex(tex, source_path="<work-only>")
        rendered = render_resume_tex(doc)

        self.assertGreater(len(doc.experience), 0)
        self.assertEqual(doc.projects, [])
        self.assertEqual(doc.skills.categories, {})
        self.assertNotIn("\\section{Projects}", rendered)
        self.assertNotIn("\\section{Technical Skills}", rendered)

    def test_parse_resume_accepts_project_only_and_section_aliases(self):
        tex = MAIN_TEX.read_text(encoding="utf-8")
        experience_start = tex.index("    \\section{Experience}")
        projects_start = tex.index("    \\section{Projects}")
        skills_start = tex.index("    \\section{Technical Skills}")
        tex = tex[:experience_start] + tex[projects_start:skills_start] + tex[skills_start:]
        tex = tex.replace("\\section{Projects}", "\\section{Selected Projects}", 1)
        tex = tex.replace("\\section{Technical Skills}", "\\section{Skills}", 1)

        doc = parse_resume_tex(tex, source_path="<projects-only>")

        self.assertEqual(doc.experience, [])
        self.assertGreater(len(doc.projects), 0)
        self.assertIn("Python", doc.skills.languages)

    def test_parse_resume_accepts_professional_summary_alias_and_no_education(self):
        tex = MAIN_TEX.read_text(encoding="utf-8")
        education_start = tex.index("    \\section{Education}")
        experience_start = tex.index("    \\section{Experience}")
        tex = (
            tex[:education_start]
            + "    \\section{Professional Summary}\n\n"
            + "    \\begin{onecolentry}\n"
            + "        Builder with Python systems experience.\n"
            + "    \\end{onecolentry}\n\n"
            + tex[experience_start:]
        )

        doc = parse_resume_tex(tex, source_path="<summary-no-education>")
        rendered = render_resume_tex(doc)

        self.assertEqual(doc.summary, "Builder with Python systems experience.")
        self.assertEqual(doc.education.entry.institution_and_degree, "")
        self.assertIn("\\section{Summary}", rendered)

    def test_mentor_interns_does_not_make_role_intern(self):
        result = classify_job(
            title="Software Engineer",
            description=(
                "This position is for an engineer with a few years of professional experience. "
                "You will mentor IC1 engineers and interns."
            ),
        )

        self.assertEqual(result["job_level"], "mid")

    def test_actual_intern_title_still_intern(self):
        result = classify_job(
            title="Software Developer Intern",
            description="Summer internship role.",
        )

        self.assertEqual(result["job_level"], "intern")

    def test_network_engineer_is_infrastructure_family(self):
        result = classify_job(
            title="Network Engineer",
            description="Cloud infrastructure role with LAN/WAN, firewalls, BGP, and OSPF.",
        )

        self.assertEqual(result["role_family"], "infrastructure")

    def test_electrical_traffic_signal_engineer_is_infrastructure_family(self):
        result = classify_job(
            title="Intermediate Electrical Engineer (Traffic Signal)",
            description="Traffic Signal Design and Highway Lighting Design role.",
        )

        self.assertEqual(result["role_family"], "infrastructure")

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
