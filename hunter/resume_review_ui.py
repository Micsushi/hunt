"""
Build Jobright-style resume review HTML from Fletcher structured output + keywords JSON.

Keyword highlights: longest-match-first over must-have / nice-to-have / tools lists.
"""

from __future__ import annotations

import html
import json
import re
from pathlib import Path
from typing import Any


def load_json_file(path: str | Path | None) -> dict[str, Any] | None:
    if not path:
        return None
    p = Path(path).expanduser()
    if not p.is_file():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        return None


def collect_highlight_terms(keywords: dict[str, Any] | None) -> list[str]:
    if not keywords:
        return []
    keys = (
        "must_have_terms",
        "nice_to_have_terms",
        "tools_and_technologies",
        "domain_terms",
    )
    seen: set[str] = set()
    terms: list[str] = []
    for key in keys:
        for raw in keywords.get(key) or []:
            if not isinstance(raw, str):
                continue
            t = raw.strip()
            if len(t) < 2:
                continue
            low = t.lower()
            if low in seen:
                continue
            seen.add(low)
            terms.append(t)
    terms.sort(key=len, reverse=True)
    return terms


def highlight_terms(text: str, terms: list[str]) -> str:
    """Return HTML-safe string with <mark class=\"resume-kw\"> around term hits."""
    if not text:
        return ""
    if not terms:
        return html.escape(text)
    lowered_full = text.lower()
    out: list[str] = []
    pos = 0
    n = len(text)
    while pos < n:
        best_start = -1
        best_end = -1
        for term in terms:
            lt = term.lower()
            if not lt:
                continue
            i = lowered_full.find(lt, pos)
            if i == -1:
                continue
            end = i + len(term)
            if best_start == -1 or i < best_start or (i == best_start and end > best_end):
                best_start = i
                best_end = end
        if best_start == -1:
            out.append(html.escape(text[pos:]))
            break
        if best_start > pos:
            out.append(html.escape(text[pos:best_start]))
        chunk = text[best_start:best_end]
        out.append(f'<mark class="resume-kw">{html.escape(chunk)}</mark>')
        pos = best_end
    return "".join(out)


def _norm_bullet(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").strip().lower())


def summarize_tailoring(structured: dict[str, Any] | None) -> tuple[list[str], dict[str, int]]:
    """Human-readable lines + counts for the sidebar."""
    lines: list[str] = []
    counts = {
        "experience_bullets": 0,
        "project_bullets": 0,
        "rewrites": 0,
        "reuses": 0,
        "rewritten_visible": 0,
    }
    if not structured:
        return lines, counts

    for entry in structured.get("experience_entries") or []:
        for b in entry.get("bullet_plan") or []:
            counts["experience_bullets"] += 1
            mode = (b.get("mode") or "").lower()
            if mode == "rewrite":
                counts["rewrites"] += 1
                ot = _norm_bullet(str(b.get("original_text") or ""))
                nt = _norm_bullet(str(b.get("text") or ""))
                if ot and nt and ot != nt:
                    counts["rewritten_visible"] += 1
            elif mode == "reuse":
                counts["reuses"] += 1

    for entry in structured.get("project_entries") or []:
        for b in entry.get("bullet_plan") or []:
            counts["project_bullets"] += 1
            mode = (b.get("mode") or "").lower()
            if mode == "rewrite":
                counts["rewrites"] += 1
                ot = _norm_bullet(str(b.get("original_text") or ""))
                nt = _norm_bullet(str(b.get("text") or ""))
                if ot and nt and ot != nt:
                    counts["rewritten_visible"] += 1
            elif mode == "reuse":
                counts["reuses"] += 1

    skills = structured.get("skills") or {}
    skill_n = sum(
        len(skills.get(k) or [])
        for k in ("languages", "frameworks", "developer_tools")
    )
    if counts["rewritten_visible"]:
        lines.append(f"Reworded {counts['rewritten_visible']} bullet(s) vs your base resume.")
    if counts["reuses"]:
        lines.append(f"Pulled in {counts['reuses']} bullet candidate(s) from your profile/library.")
    if skill_n:
        lines.append(f"Skills block lists {skill_n} entries (JD-weighted ordering).")
    if not lines:
        lines.append("No bullet-level diff metadata on this attempt (re-run Fletcher after upgrade).")
    return lines, counts


def _strip_latex_noise(s: str) -> str:
    t = re.sub(r"\\textbf\{([^}]*)\}", r"\1", s)
    t = re.sub(r"\\href\{[^}]*\}\{([^}]*)\}", r"\1", t)
    return t


def render_bullet_block(
    bullet: dict[str, Any],
    terms: list[str],
    *,
    entry_label: str,
) -> str:
    text = str(bullet.get("text") or "")
    original = str(bullet.get("original_text") or text)
    mode = (bullet.get("mode") or "").lower()
    changed = _norm_bullet(original) != _norm_bullet(text)
    row_cls = "resume-bullet resume-bullet--changed" if changed else "resume-bullet"
    label_esc = html.escape(_strip_latex_noise(entry_label)[:120])
    new_html = highlight_terms(text, terms)
    old_html = highlight_terms(original, terms)
    bid = html.escape(str(bullet.get("source_fact_id") or id(bullet)))
    mode_badge = html.escape(mode or "?")
    compare = ""
    if changed:
        compare = f"""
    <div class="resume-compare" data-state="new">
      <div class="resume-compare-row resume-compare-new"><span class="muted tiny">Tailored</span><p>{new_html}</p></div>
      <div class="resume-compare-row resume-compare-old is-hidden"><span class="muted tiny">Original</span><p>{old_html}</p></div>
      <button type="button" class="resume-compare-toggle" aria-expanded="false">Compare to original</button>
    </div>
    """
    else:
        compare = f'<div class="resume-compare-row"><p>{new_html}</p></div>'

    return f"""
    <div class="{row_cls}" data-bullet-id="{bid}">
      <div class="resume-bullet-meta"><span class="muted tiny">{label_esc}</span>
        <span class="resume-mode">{mode_badge}</span></div>
      {compare}
    </div>
    """


def build_resume_review_html(
    structured: dict[str, Any] | None,
    keywords: dict[str, Any] | None,
) -> str:
    if not structured:
        return '<p class="muted">No tailored resume JSON found for the latest attempt.</p>'
    terms = collect_highlight_terms(keywords)
    parts: list[str] = []

    parts.append('<div class="resume-review-shell">')
    parts.append('<div class="resume-review-doc">')
    parts.append(f'<p class="muted tiny">{len(terms)} keyword phrase(s) from the job description are highlighted below.</p>')

    for entry in structured.get("experience_entries") or []:
        eid = html.escape(str(entry.get("entry_id") or "experience"))
        parts.append(f'<h4 class="resume-section-h">Experience <span class="mono tiny">{eid}</span></h4>')
        for b in entry.get("bullet_plan") or []:
            parts.append(render_bullet_block(b, terms, entry_label=f"Experience {eid}"))

    for entry in structured.get("project_entries") or []:
        eid = html.escape(str(entry.get("entry_id") or "project"))
        parts.append(f'<h4 class="resume-section-h">Project <span class="mono tiny">{eid}</span></h4>')
        for b in entry.get("bullet_plan") or []:
            parts.append(render_bullet_block(b, terms, entry_label=f"Project {eid}"))

    skills = structured.get("skills") or {}
    if any(skills.get(k) for k in ("languages", "frameworks", "developer_tools")):
        parts.append('<h4 class="resume-section-h">Technical skills</h4><ul class="resume-skills">')
        for bucket, label in (
            ("languages", "Languages"),
            ("frameworks", "Frameworks"),
            ("developer_tools", "Tools"),
        ):
            for item in skills.get(bucket) or []:
                parts.append(f"<li>{highlight_terms(str(item), terms)} — {html.escape(label)}</li>")
        parts.append("</ul>")

    parts.append("</div>")

    summary_lines, _counts = summarize_tailoring(structured)
    parts.append('<aside class="resume-review-aside">')
    parts.append('<h3 class="resume-aside-h">What changed</h3>')
    parts.append("<ul class=\"resume-summary-list\">")
    for line in summary_lines:
        parts.append(f"<li>{html.escape(line)}</li>")
    parts.append("</ul>")

    parts.append('<h3 class="resume-aside-h">Tune next run (manual)</h3>')
    parts.append('<p class="muted tiny">Jobright-style quick prompts — copy one and use with your own LLM or a future Fletcher API.</p>')
    suggestions = [
        "Use stronger action verbs in the top experience bullets.",
        "Shorten bullets to free space for more JD keywords.",
        "Remove skills that do not appear in this job description.",
        "Add one metric (latency, cost, scale) where truthful.",
    ]
    for s in suggestions:
        parts.append(
            '<button type="button" class="resume-suggest-pill" '
            f'data-copy="{html.escape(s, quote=True)}">{html.escape(s)}</button>'
        )

    parts.append("</aside>")
    parts.append("</div>")
    return "\n".join(parts)


RESUME_REVIEW_STYLES = """
.resume-review-shell {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(260px, 320px);
  gap: 20px;
  align-items: start;
}
@media (max-width: 900px) {
  .resume-review-shell { grid-template-columns: 1fr; }
}
.resume-review-doc {
  background: #fffdf8;
  border: 1px solid var(--line);
  border-radius: 14px;
  padding: 18px 20px;
  box-shadow: var(--shadow);
  font-family: Georgia, "Times New Roman", serif;
  font-size: 0.95rem;
  line-height: 1.45;
}
.resume-review-aside {
  position: sticky;
  top: 88px;
  background: var(--panel-strong);
  border: 1px solid var(--line);
  border-radius: 14px;
  padding: 16px;
  box-shadow: var(--shadow);
}
.resume-aside-h { margin: 0 0 10px 0; font-size: 1rem; font-family: "Segoe UI", system-ui, sans-serif; }
.resume-section-h { font-family: "Segoe UI", system-ui, sans-serif; font-size: 0.95rem; margin: 18px 0 8px 0; color: var(--accent-ink); }
.resume-bullet { margin-bottom: 14px; padding-bottom: 12px; border-bottom: 1px solid rgba(221, 212, 199, 0.7); }
.resume-bullet--changed { border-left: 3px solid #3cb878; padding-left: 10px; margin-left: -4px; }
.resume-bullet-meta { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; margin-bottom: 6px; }
.resume-mode { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); font-family: system-ui, sans-serif; }
.tiny { font-size: 0.78rem; }
.resume-compare-row p { margin: 4px 0 0 0; }
.resume-compare-old.is-hidden { display: none; }
.resume-compare-toggle {
  margin-top: 8px;
  font-size: 0.8rem;
  padding: 6px 10px;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: #fff;
  cursor: pointer;
  font-family: system-ui, sans-serif;
}
.resume-compare-toggle:hover { background: var(--accent-soft); }
mark.resume-kw {
  background: linear-gradient(180deg, #d8f5e0 0%, #c8efd4 100%);
  color: inherit;
  padding: 0 2px;
  border-radius: 2px;
}
.resume-skills { margin: 0; padding-left: 1.2rem; }
.resume-skills li { margin: 4px 0; }
.resume-summary-list { margin: 0 0 16px 0; padding-left: 1.1rem; font-size: 0.9rem; }
.resume-suggest-pill {
  display: block;
  width: 100%;
  text-align: left;
  margin-bottom: 8px;
  padding: 10px 12px;
  border-radius: 12px;
  border: 1px solid var(--line);
  background: #1a1f1c;
  color: #f4f7f5;
  font-size: 0.82rem;
  cursor: pointer;
  font-family: system-ui, sans-serif;
  line-height: 1.35;
}
.resume-suggest-pill:hover { filter: brightness(1.08); }
"""


RESUME_REVIEW_SCRIPT = """
(function () {
  document.querySelectorAll(".resume-compare-toggle").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var root = btn.closest(".resume-compare");
      if (!root) return;
      var oldRow = root.querySelector(".resume-compare-old");
      var expanded = btn.getAttribute("aria-expanded") === "true";
      if (oldRow) {
        if (expanded) {
          oldRow.classList.add("is-hidden");
          btn.setAttribute("aria-expanded", "false");
          btn.textContent = "Compare to original";
        } else {
          oldRow.classList.remove("is-hidden");
          btn.setAttribute("aria-expanded", "true");
          btn.textContent = "Show tailored only";
        }
      }
    });
  });
  document.querySelectorAll(".resume-suggest-pill").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var t = btn.getAttribute("data-copy") || "";
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(t).then(function () {
          var prev = btn.textContent;
          btn.textContent = "Copied to clipboard";
          setTimeout(function () { btn.textContent = prev; }, 1600);
        });
      } else {
        window.prompt("Copy this prompt:", t);
      }
    });
  });
})();
"""
