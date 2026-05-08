import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(relative: str) -> str:
    return (ROOT / relative).read_text(encoding="utf-8")


def test_jobs_filters_do_not_expose_operator_tag_filter():
    filters = read("frontend/src/components/Filters/index.tsx")

    assert "Tag filter" not in filters
    assert "tagInput" not in filters
    assert "Filter by tag" not in filters


def test_jobs_table_keeps_id_on_one_line_and_truncates_long_titles():
    page = read("frontend/src/pages/Jobs/index.tsx")
    styles = read("frontend/src/pages/Jobs/Jobs.module.css")

    assert "Tag:" not in page
    assert "styles.tagCell" not in page
    assert "className={styles.idCell}" in page
    assert "className={styles.titleCell}" in page
    assert ".idCell" in styles and "white-space: nowrap" in styles
    id_link_block = re.search(r"\.idCell a \{(?P<body>.*?)\}", styles, re.S)
    assert id_link_block is not None
    assert "text-overflow" not in id_link_block.group("body")
    assert ".titleCell" in styles and "text-overflow: ellipsis" in styles


def test_dark_theme_controls_keep_readable_text_colors():
    filters = read("frontend/src/components/Filters/Filters.module.css")

    assert "color: var(--ink);" in re.search(r"\.limitBtn \{(?P<body>.*?)\}", filters, re.S).group(
        "body"
    )


def test_job_detail_dark_theme_does_not_use_light_theme_text_assumptions():
    detail = read("frontend/src/pages/Jobs/JobDetail.module.css")

    assert "background: #faf5ec" not in detail
    assert "color: white" not in detail
    assert "color: var(--accent-ink);" not in re.search(
        r"\.backBtn \{(?P<body>.*?)\}", detail, re.S
    ).group("body")
    assert "color: var(--accent-ink);" not in re.search(
        r"\.artifactBtn \{(?P<body>.*?)\}", detail, re.S
    ).group("body")
    assert "color: var(--accent-ink);" in re.search(
        r"\.artifactBtnPrimary \{(?P<body>.*?)\}", detail, re.S
    ).group("body")


def test_dark_theme_accent_uses_muted_green_instead_of_bright_neon():
    tokens = read("frontend/src/styles/tokens.css")

    assert re.search(r"--accent:\s*#59a96a;", tokens)
    assert "#3ecf6e" not in tokens


def test_settings_exposes_resume_done_windows_notification_toggle():
    settings = read("frontend/src/pages/Settings/index.tsx")
    notifications = read("frontend/src/utils/notifications.ts")

    assert "AppNotificationSettings" in settings
    assert "Windows notification when Fletcher finishes a resume" in settings
    assert "resume_done_windows_notification_enabled" in notifications


def test_settings_exposes_c2_job_metadata_values():
    settings = read("frontend/src/pages/Settings/index.tsx")

    assert "C2 job metadata" in settings
    assert "job_metadata_role_families" in settings
    assert "job_metadata_job_levels" in settings
    assert "target_lane_policy" in settings
    assert "unsupported_target_examples" in settings
    assert "blocked_keywords" in settings
    assert "keyword_keep_policy" in settings
    assert "keyword_ignore_policy" in settings
    assert "summary_keyword_policy" in settings
    assert "skill_addition_policy" in settings
    assert "summary_good_example" in settings
    assert "summary_banned_phrases" in settings
    assert "rewrite_strategy" in settings
    assert "rewrite_keyword_fit_policy" in settings
    assert "rewrite_bullet_policy" in settings
    assert "rewrite_length_policy" in settings
    assert "rewrite_action_keyword_policy" in settings
    assert "default_target_title" in settings
    assert "keyword_selection_max_keywords" in settings
    assert "keyword_selection_min_words" in settings
    assert "keyword_selection_max_words" in settings
    assert "job_metadata_prompt_max_chars" in settings
    assert "job_metadata_min_confidence" in settings
    assert "skill_addition_limit" in settings


def test_fletcher_option_a_queues_by_job_id():
    fletcher = read("frontend/src/pages/Fletcher/index.tsx")
    control = read("frontend/src/api/control.ts")

    assert "enqueueFletcherJob({ jobId: id })" in fletcher
    assert "Queue resume run" in fletcher
    assert "Fletcher job queued" in fletcher
    assert "jobId?: number" in control
    assert "job_id: payload.jobId" in control


def test_job_detail_resume_actions_use_queue_and_resume_workspace_label():
    detail = read("frontend/src/pages/Jobs/JobDetail.tsx")
    review_page = read("frontend/src/pages/Fletcher/ReviewPage.tsx")

    assert "enqueueFletcherJob({ jobId })" in detail
    assert "triggerC2Generate" not in detail
    assert "Queue resume run" in detail
    assert "Resume run queued" in detail
    assert "Resume workspace" in detail
    assert "Review diff" not in detail
    assert "Resume workspace" in review_page
    assert "Fletcher review" not in review_page


def test_fletcher_option_b_history_actions_are_visible():
    fletcher = read("frontend/src/pages/Fletcher/index.tsx")
    styles = read("frontend/src/pages/Fletcher/Fletcher.module.css")

    assert "Fletcher history" in fletcher
    assert "Search history" in fletcher
    assert "visibleHistoryJobs" in fletcher
    assert "runTimeMillis(b.finished_at) - runTimeMillis(a.finished_at)" in fletcher
    assert "historySearchText(job)" in fletcher
    assert "historyFilterBar" in styles
    assert "Started" in fletcher
    assert "Open workspace" in fletcher
    assert "Starting PDF" in fletcher
    assert "Starting TeX" in fletcher
    assert "PDF" in fletcher
    assert "TeX" in fletcher
    assert "Download log" in fletcher
    assert "Delete selected" in fletcher
    assert "Delete" in fletcher
    assert "FletcherJobDetailModal" in fletcher
    assert 'role="dialog"' in fletcher
    assert "fletcherSourceLabel" in fletcher
    assert "Job description" in fletcher
    assert "Job details" in fletcher
    assert "queueTitleButton" in styles
    assert "text-overflow: ellipsis" in styles
    assert "height: 112px" in styles
    assert "grid-template-columns: repeat(3" in styles
    assert "modalBackdrop" in styles


def test_fletcher_active_queue_shows_progress_bar_and_percent():
    fletcher = read("frontend/src/pages/Fletcher/index.tsx")
    styles = read("frontend/src/pages/Fletcher/Fletcher.module.css")
    types = read("frontend/src/pages/Fletcher/review/types.ts")

    assert "fletcherProgressPercent" in fletcher
    assert 'role="progressbar"' in fletcher
    assert "{progressPercent}%" in fletcher
    assert "displayedProgress" in fletcher
    assert "nextSmoothedProgress" in fletcher
    assert "window.setInterval" in fletcher
    assert "200)" in fletcher
    assert "FLETCHER_QUEUE_ACTIVE_REFETCH_MS = 5000" in fletcher
    assert "FLETCHER_QUEUE_IDLE_REFETCH_MS = 30000" in fletcher
    assert "fletcherQueueRefetchInterval" in fletcher
    assert "progressRow" in styles
    assert "progressTrack" in styles
    assert "progressFill" in styles
    assert "transition: width 220ms linear" in styles
    assert "prefers-reduced-motion" in styles
    assert "percent?: number" in types


def test_fletcher_log_downloads_use_readable_filenames():
    fletcher = read("frontend/src/pages/Fletcher/index.tsx")

    assert "fletcherLogFilename" in fletcher
    assert "log_resume_generation_${timestamp}.log" in fletcher
    assert "finished_at || job.started_at || job.created_at" in fletcher
    assert "_pipeline.log" not in fletcher
    assert "fletcher_queue_${job.queue_item_id}.log" not in fletcher


def test_fletcher_option_b_clears_jd_and_keeps_batch_download_controls():
    fletcher = read("frontend/src/pages/Fletcher/index.tsx")
    control = read("frontend/src/api/control.ts")
    store = read("frontend/src/store/ui.ts")

    assert "setJobDetails('')" in fletcher
    assert "Personal details" not in fletcher
    assert "personalDetails" not in fletcher
    assert "fletcherResumeFile" in store
    assert "Download selected" in fletcher
    assert "Starting PDF" in fletcher
    assert "starting_pdf" in control
    assert "starting_tex" in control
    assert "Resume PDF : no summary" in fletcher
    assert "batchDownloadFletcherJobs" in fletcher
    assert "deleteFletcherJob" in fletcher
    assert "/api/fletcher/tailor/jobs/batch-download" in control
    assert "DELETE" in read("frontend/src/api/client.ts")


def test_fletcher_option_b_resume_file_persists_across_reload():
    fletcher = read("frontend/src/pages/Fletcher/index.tsx")
    persisted = read("frontend/src/pages/Fletcher/persistedResumeFile.ts")

    assert "loadPersistedFletcherResumeFile" in fletcher
    assert "savePersistedFletcherResumeFile(resumeFile)" in fletcher
    assert "resumeStorageReady" in fletcher
    assert "useUiStore.getState().fletcherResumeFile" in fletcher
    assert "indexedDB.open" in persisted
    assert "new File([record.blob]" in persisted
    assert "store.put" in persisted
    assert "store.delete" in persisted


def test_fletcher_review_workspace_has_draft_undo_redo_save_guard():
    workspace = read("frontend/src/pages/Fletcher/review/ResumeReviewWorkspace.tsx")

    assert "Undo all" in workspace
    assert "Redo" in workspace
    assert "Save" in workspace
    assert "beforeunload" in workspace
    assert "unsaved draft" in workspace
    assert "saveFletcherReviewVersion" in workspace
    assert "saveMutation.mutateAsync" in workspace
    assert "revertFletcherReviewVersion" not in workspace


def test_fletcher_review_workspace_has_keyword_panel_and_block_selection():
    workspace = read("frontend/src/pages/Fletcher/review/ResumeReviewWorkspace.tsx")
    styles = read("frontend/src/pages/Fletcher/review/ResumeReviewWorkspace.module.css")
    types = read("frontend/src/pages/Fletcher/review/types.ts")

    assert "KeywordPanel" in workspace
    assert "normalizeKeywordScores" in workspace
    assert "Best bullet" in workspace
    assert "onClick={() => onSelect({ block })}" in workspace
    assert "selectedBlock" in workspace
    assert "selected?.segment?.id" in workspace
    assert ".keywordPanel" in styles
    assert ".selectedBlock" in styles
    assert "rag_scores?: KeywordScore[]" in types


def test_fletcher_diff_groups_replacement_clusters():
    script = r"""
const fs = require('fs');
const vm = require('vm');
const ts = require('typescript');
const source = fs.readFileSync('src/pages/Fletcher/review/diff.ts', 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
});
const moduleObj = { exports: {} };
vm.runInNewContext(compiled.outputText, {
  require,
  module: moduleObj,
  exports: moduleObj.exports,
});
const { buildDiffSegments, applySegmentRevert } = moduleObj.exports;
const original = 'Drove technical alignment by presenting completed features to stakeholders and leading design discussion meetings to gather feedback and refine system architecture.';
const current = 'Drove technical alignment by presenting completed features and leading design discussions for product progression projects, gathering stakeholder feedback and build new solutions.';
const segments = buildDiffSegments('block', original, current);
const changed = segments.filter((segment) => segment.kind !== 'same');
const groupedDeletion = changed.find((segment) => segment.kind === 'del' && segment.text.includes('discussion meetings to gather'));
const groupedAddition = changed.find((segment) => segment.kind === 'add' && segment.text.includes('discussions for product progression'));
const reverted = applySegmentRevert(original, current, groupedAddition);
console.log(JSON.stringify({
  changed,
  groupedPairAdjacent: changed.indexOf(groupedAddition) === changed.indexOf(groupedDeletion) + 1,
  reverted,
}));
"""
    result = subprocess.run(
        ["node", "-e", script],
        cwd=ROOT / "frontend",
        check=True,
        capture_output=True,
        text=True,
    )
    payload = json.loads(result.stdout)

    assert payload["groupedPairAdjacent"]
    assert "discussion meetings to gather feedback" in payload["reverted"]
    assert "build new solutions" in payload["reverted"]


def test_fletcher_workspace_tokenizes_inline_latex_formatting():
    script = r"""
const fs = require('fs');
const vm = require('vm');
const ts = require('typescript');
const source = fs.readFileSync('src/pages/Fletcher/review/latexInline.ts', 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
});
const moduleObj = { exports: {} };
vm.runInNewContext(compiled.outputText, {
  require,
  module: moduleObj,
  exports: moduleObj.exports,
});
const { latexInlineParts, humanizeLatex } = moduleObj.exports;
console.log(JSON.stringify({
  date: latexInlineParts('Expected Graduation: \\textbf{Sep 2026}'),
  truncatedDate: latexInlineParts('Expected Graduation: \\textbf{Sep 2026'),
  bullet: latexInlineParts('Reduced evaluation time by \\textbf{85\\%} using \\textbf{Python} automation.'),
  project: latexInlineParts('\\href{https://github.com/NatRunners/StudyAmp}{github.com/NatRunners/StudyAmp}'),
  truncatedProject: latexInlineParts('\\href{https://github.com/NatRunners/StudyAmp'),
  human: humanizeLatex('\\href{https://github.com/NatRunners/StudyAmp}{github.com/NatRunners/StudyAmp}'),
}));
"""
    result = subprocess.run(
        ["node", "-e", script],
        cwd=ROOT / "frontend",
        check=True,
        capture_output=True,
        text=True,
    )
    payload = json.loads(result.stdout)

    assert payload["date"] == [
        {"kind": "text", "text": "Expected Graduation: "},
        {"kind": "bold", "text": "Sep 2026"},
    ]
    assert payload["truncatedDate"] == [
        {"kind": "text", "text": "Expected Graduation: "},
        {"kind": "bold", "text": "Sep 2026"},
    ]
    assert {"kind": "bold", "text": "85%"} in payload["bullet"]
    assert {"kind": "bold", "text": "Python"} in payload["bullet"]
    assert payload["project"] == [
        {
            "kind": "link",
            "href": "https://github.com/NatRunners/StudyAmp",
            "text": "github.com/NatRunners/StudyAmp",
        }
    ]
    assert payload["truncatedProject"] == [
        {
            "kind": "link",
            "href": "https://github.com/NatRunners/StudyAmp",
            "text": "https://github.com/NatRunners/StudyAmp",
        }
    ]
    assert payload["human"] == "github.com/NatRunners/StudyAmp"
