"""C2 (Fletcher) package home for resume-tailoring prompts, schemas, templates, and runtime code."""

from .parser import parse_resume_file, parse_resume_tex
from .renderer import render_resume_tex

__all__ = [
    "parse_resume_file",
    "parse_resume_tex",
    "render_resume_tex",
]
