# C2 Fletcher Design

Scope: `/fletcher`, Option B queue/history, review workspace, diff document, inspector, compile controls, PDF import warnings, and cloud provider privacy warnings.

## Current State: 2026-05-07

- Option B submits into a DB-backed background queue, not local synchronous UI state.
- Active queue rows show status, current step, started time, move/cancel actions for queued rows, and log actions.
- `Fletcher history` shows completed/failed/cancelled Option B rows from `fletcher_jobs`.
- History rows show inferred job title, status, started/finished time, workspace, PDF, TeX, view log, and download log actions.
- History rows can be selected for batch ZIP download with artifact choices for logs, no-summary PDFs, with-summary PDFs, no-summary TeX, and with-summary TeX.
- Option B enqueue clears the job description after the job is accepted and keeps the uploaded resume file in shared app state for repeated JD runs in the same browser session.
- Review workspace uses a light PDF-like resume paper surface inside the dark Hunt shell.
- Review document renders header, summary, education, experience, projects, and technical skills in resume order.
- Inline additions use muted green underline/highlight.
- Inline deletions use muted red strike/underline highlight.
- Replacement clusters render removed phrase groups first and added phrase groups second when the raw word diff alternates around whitespace-only boundaries.
- The inspector handles selected segment revert and block edit.
- Version toggle switches `no_summary` and `with_summary`.
- Toolbar exposes original/generated reset, compile, PDF, TeX, and log actions.

## Design Rules

- Use the dark Hunt shell for app chrome and the off-white resume paper only for the document preview.
- Keep the resume surface close to the generated PDF shape: centered paper, serif resume text, compact section headings, bullet indentation, and no debug field labels in the document body.
- Keep operational controls compact. No marketing hero treatment on Fletcher.
- Do not nest cards inside cards. Queue/history rows are repeated items; review paper is a document surface, not a card.
- Do not show raw LaTeX as the primary review experience. Convert common LaTeX markup to human-readable text in the diff layer.
- Do not edit PDFs directly. PDF is import input or compiled output; `ResumeDocument` JSON is the editable source.
- Show cloud provider warnings whenever the active provider can send resume/JD text off-machine.

## Interaction Rules

- Clicking an added segment selects it. Reverting removes that added current text.
- Clicking a deleted segment selects it. Reverting restores the original text.
- Clicking either side of a grouped replacement segment reverts the full replacement cluster so the text does not become half-old and half-new.
- Double-clicking a block opens manual block edit.
- Saving a block marks the version dirty until compile succeeds.
- Whole-version revert can reset current to original or generated.
- Queue input is editable only while `queued`; running and completed rows are locked.
- Batch download defaults to logs and no-summary PDFs because those are the most common review artifacts.

## Storage Signals

- Queue/history state comes from `fletcher_jobs`.
- Review state comes from `review_package.json`.
- Runtime settings come from `component_settings` with env fallback.
- Batch history download is generated on demand from `fletcher_jobs` plus safe review artifact lookup; it is not stored as a durable artifact.
