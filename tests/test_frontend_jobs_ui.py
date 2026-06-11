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


def test_frontend_human_command_logger_posts_fail_open_ledger_events():
    helper = read("frontend/src/api/humanCommandLog.ts")
    control = read("frontend/src/api/control.ts")
    jobs = read("frontend/src/api/jobs.ts")
    ops = read("frontend/src/api/ops.ts")
    detail = read("frontend/src/pages/Jobs/JobDetail.tsx")

    assert "export async function logHumanCommand" in helper
    assert "fetch('/api/ledger/events'" in helper
    assert "component?: string" in helper
    assert "laneId?: string" in helper
    assert "sessionId?: string" in helper
    assert "commandId?: string" in helper
    assert "traceId?: string" in helper
    assert "const component = payload.component || 'c0'" in helper
    assert "event_type: 'human.command'" in helper
    assert "actor: { type: 'human', id: 'human_local', surface: payload.surface || 'c0_ui' }" in helper
    assert "lane_id: laneId" in helper
    assert "session_id: sessionId" in helper
    assert "command_id: commandId" in helper
    assert "trace_id: traceId" in helper
    assert "eventContext" in helper
    assert "redaction: { applied: true" in helper
    assert "human_command_no_form_values" in helper
    assert "catch {" in helper
    assert "logHumanCommand" in control
    assert "action: 'c0.settings.save'" in control
    assert "action: 'c0.linkedin_account.save'" in control
    assert "action: 'c1.scrape'" in control
    assert "action: 'c2.fletcher.queue_resume'" in control
    assert "action: 'c4.run'" in control
    assert "action: 'c3.verify_easy_apply'" in control
    assert "component: 'c3'" in control
    assert "surface: 'c3_ui'" in control
    assert "action: 'c0.job.patch'" in jobs
    assert "fields: Object.keys(fields)" in jobs
    assert "action: 'c0.job.requeue'" in jobs
    assert "action: 'c0.job.delete'" in jobs
    assert "action: `c0.jobs.bulk_${payload.action}`" in jobs
    assert "action: 'c0.ops.requeue_errors'" in ops
    assert "action: payload.dry_run ? 'c0.ops.bulk_requeue_count' : 'c0.ops.bulk_requeue'" in ops
    assert "action: 'c0.ops.requeue_stale_processing'" in ops
    assert "action: 'c3.open_apply_page'" in detail
    assert "buttonId: 'open-apply-page'" in detail
    assert "onClick={logOpenApplyPage}" in detail


def test_human_command_logger_records_available_event_context():
    script = r"""
const fs = require('fs');
const vm = require('vm');
const ts = require('typescript');
const source = fs.readFileSync('src/api/humanCommandLog.ts', 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
});
const moduleObj = { exports: {} };
let posted = null;
vm.runInNewContext(compiled.outputText, {
  module: moduleObj,
  exports: moduleObj.exports,
  fetch: async (url, init) => {
    posted = { url, init, body: JSON.parse(init.body) };
    return { ok: true };
  },
  location: { pathname: '/executioner' },
  document: { title: 'Executioner' },
  crypto: { randomUUID: () => '12345678-1234-1234-1234-123456789abc' },
  Date,
  Math,
});
(async () => {
  await moduleObj.exports.logHumanCommand({
    action: 'c3.open_apply_page',
    buttonId: 'open-apply-page',
    component: 'c3',
    surface: 'c3_ui',
    laneId: 'lane-1',
    sessionId: 'session-1',
    commandId: 'cmd-1',
    traceId: 'trace-1',
    details: { jobId: 42 },
  });
  console.log(JSON.stringify(posted.body));
})();
"""
    result = subprocess.run(
        ["node", "-e", script],
        cwd=ROOT / "frontend",
        check=True,
        capture_output=True,
        text=True,
    )
    payload = json.loads(result.stdout)

    assert payload["component"] == "c3"
    assert payload["event_type"] == "human.command"
    assert payload["actor"] == {"type": "human", "id": "human_local", "surface": "c3_ui"}
    assert payload["lane_id"] == "lane-1"
    assert payload["session_id"] == "session-1"
    assert payload["command_id"] == "cmd-1"
    assert payload["trace_id"] == "trace-1"
    assert payload["payload"]["eventContext"] == {
        "component": "c3",
        "route": "/executioner",
        "page": "Executioner",
        "laneId": "lane-1",
        "sessionId": "session-1",
        "commandId": "cmd-1",
        "traceId": "trace-1",
    }
    assert payload["payload"]["action"] == "c3.open_apply_page"
    assert payload["payload"]["buttonId"] == "open-apply-page"
    assert payload["payload"]["details"] == {"jobId": 42}


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
    assert "moreMenu" in fletcher
    assert "moreMenuPanel" in fletcher
    assert "More actions for" in fletcher
    assert "PDF" in fletcher
    assert "TeX" in fletcher
    assert "Download log" in fletcher
    assert "Delete selected" in fletcher
    assert "Delete" in fletcher
    assert "FletcherJobDetailModal" in fletcher
    assert 'role="dialog"' in fletcher
    assert "detailBody" in fletcher
    assert "detailMetaPanel" in fletcher
    assert "detailContentPanel" in fletcher
    assert "fletcherSourceLabel" in fletcher
    assert "Job description" in fletcher
    assert "Job details" in fletcher
    assert "queueTitleButton" in styles
    assert "text-overflow: ellipsis" in styles
    assert "height: 112px" in styles
    assert "height: 78px" in styles
    assert "grid-template-columns: repeat(3" in styles
    assert "historyActions" in styles
    assert ".moreMenu" in styles
    assert "modalBackdrop" in styles
    assert "width: min(1500px, calc(100vw - 56px))" in styles
    assert "grid-template-columns: minmax(250px, 0.28fr) minmax(0, 1fr)" in styles


def test_fletcher_active_queue_shows_progress_bar_and_percent():
    fletcher = read("frontend/src/pages/Fletcher/index.tsx")
    styles = read("frontend/src/pages/Fletcher/Fletcher.module.css")
    types = read("frontend/src/pages/Fletcher/review/types.ts")

    assert "fletcherProgressPercent" in fletcher
    assert "Untitled pasted JD" in fletcher
    assert "Ad-hoc resume" not in fletcher
    assert 'role="progressbar"' in fletcher
    assert "{progressPercent}%" in fletcher
    assert "displayedProgress" in fletcher
    assert "fletcherStepProgressTarget" in fletcher
    assert "easeOutCubic" not in fletcher
    assert "FLETCHER_FAST_RAMP_MS" not in fletcher
    assert "FLETCHER_DISPLAY_PROGRESS_STORAGE_KEY" in fletcher
    assert "readDisplayedProgress" in fletcher
    assert "localStorage.setItem(FLETCHER_DISPLAY_PROGRESS_STORAGE_KEY" in fletcher
    assert "upsertFletcherJob" in fletcher
    assert "qc.setQueriesData<FletcherJobsCache>" in fletcher
    assert "FLETCHER_PROGRESS_CRUISE_STEP_MS = 500" in fletcher
    assert "FLETCHER_PROGRESS_FINAL_STEP_MS = 200" in fletcher
    assert "FLETCHER_PROGRESS_SLOW_DELAY_MULTIPLIER = 1.5" in fletcher
    assert "FLETCHER_PROGRESS_VERY_SLOW_DELAY_MULTIPLIER = 2" in fletcher
    assert "FLETCHER_PROGRESS_VERY_SLOW_AT = 95" in fletcher
    assert "FLETCHER_PROGRESS_CAP_MIN = 80" in fletcher
    assert "FLETCHER_PROGRESS_CAP_MAX = 90" in fletcher
    assert "FLETCHER_COMPLETION_HOLD_MS = 500" in fletcher
    assert "lastTickAt" in fletcher
    assert "currentTarget" in fletcher
    assert "nextDelayMs" in fletcher
    assert "preCompleteCap" in fletcher
    assert "progressBlockedByFinishingJob" in fletcher
    assert "completingProgressJobIds" in fletcher
    assert "historyBlockedJobIds" in fletcher
    assert "activeInCurrentView" in fletcher
    assert "aCompleting" in fletcher
    assert "bCompleting" in fletcher
    assert "return aCompleting ? -1 : 1" in fletcher
    assert "showProgressBar" in fletcher
    assert "const localProgress = displayedProgress[job.queue_item_id]?.value" in fletcher
    assert "typeof localProgress === 'number'" in fletcher
    assert "current + 1" in fletcher
    assert "const initialValue = existing ? existing.value : 1" in fletcher
    assert "job.status === 'queued' ? progressPercent : 1" in fletcher
    assert "value: initialValue" in fletcher
    assert "Math.min(initialValue, 1)" not in fletcher
    assert "displayedProgressJobIds" in fletcher
    assert "ACTIVE_FLETCHER_STATUSES.has(job.status)" in fletcher
    assert "displayedProgressJobIds.has(job.queue_item_id)" in fletcher
    assert "displayedProgress[job.queue_item_id]?.activeInCurrentView" in fletcher
    assert "target >= 100 || smoothed < currentProgress.preCompleteCap" in fletcher
    assert "fletcherProgressDelayMultiplier" in fletcher
    assert "currentProgress.nextDelayMs * fletcherProgressDelayMultiplier(smoothed)" in fletcher
    assert "nextSmoothedProgress" in fletcher
    assert "window.setInterval" in fletcher
    assert "FLETCHER_PROGRESS_TICK_MS = 50" in fletcher
    assert "FLETCHER_QUEUE_ACTIVE_REFETCH_MS = 5000" in fletcher
    assert "FLETCHER_QUEUE_IDLE_REFETCH_MS = 30000" in fletcher
    assert "fletcherQueueRefetchInterval" in fletcher
    assert "progressRow" in styles
    assert "progressTrack" in styles
    assert "progressFill" in styles
    assert "queueListScrollable" in styles
    assert "overflow-y: auto" in styles
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
    assert "Best resume bullet" in workspace
    assert "contextLabel" in workspace
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


def test_fletcher_workspace_handles_flexible_skill_categories():
    script = r"""
const fs = require('fs');
const vm = require('vm');
const ts = require('typescript');
const source = fs.readFileSync('src/pages/Fletcher/review/documentBlocks.ts', 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
});
const moduleObj = { exports: {} };
vm.runInNewContext(compiled.outputText, {
  require,
  module: moduleObj,
  exports: moduleObj.exports,
  encodeURIComponent,
  decodeURIComponent,
});
const { buildReviewBlocks, setBlockText, skillRowsForDoc } = moduleObj.exports;
const doc = {
  source_path: 'test',
  preamble: '',
  header: { name: 'A', contact_line: 'a@example.com' },
  summary: '',
  education: { entry: { entry_id: 'edu', institution_and_degree: 'School', date_text: '2026' }, bullets: [] },
  experience: [],
  projects: [],
  skills: {
    languages: ['Python'],
    frameworks: ['FastAPI'],
    developer_tools: ['Git'],
    categories: {
      Languages: ['Python'],
      'Cloud & Data': ['AWS', 'PostgreSQL'],
      'Developer Tools': ['Git'],
    },
  },
};
const rows = skillRowsForDoc(doc);
const blocks = buildReviewBlocks(doc, doc, doc);
const cloudBlock = blocks.find((block) => block.label === 'Cloud & Data');
const updated = setBlockText(doc, cloudBlock.blockId, 'AWS, DynamoDB');
const updatedLanguage = setBlockText(doc, 'skills.categories.Languages', 'Python, TypeScript');
console.log(JSON.stringify({
  rowLabels: rows.map((row) => row.label),
  cloudCurrent: cloudBlock.current,
  updatedCloud: updated.skills.categories['Cloud & Data'],
  updatedLanguageCategory: updatedLanguage.skills.categories.Languages,
  updatedLanguageLegacy: updatedLanguage.skills.languages,
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

    assert payload["rowLabels"] == ["Languages", "Cloud & Data", "Developer Tools"]
    assert payload["cloudCurrent"] == "AWS, PostgreSQL"
    assert payload["updatedCloud"] == ["AWS", "DynamoDB"]
    assert payload["updatedLanguageCategory"] == ["Python", "TypeScript"]
    assert payload["updatedLanguageLegacy"] == ["Python", "TypeScript"]


def test_fletcher_workspace_uses_resume_global_bullet_numbers():
    script = r"""
const fs = require('fs');
const vm = require('vm');
const ts = require('typescript');
const source = fs.readFileSync('src/pages/Fletcher/review/documentBlocks.ts', 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
});
const moduleObj = { exports: {} };
vm.runInNewContext(compiled.outputText, {
  require,
  module: moduleObj,
  exports: moduleObj.exports,
  encodeURIComponent,
  decodeURIComponent,
});
const { buildReviewBlocks } = moduleObj.exports;
const doc = {
  source_path: 'test',
  preamble: '',
  header: { name: 'A', contact_line: 'a@example.com' },
  summary: '',
  education: { entry: { entry_id: 'edu', institution_and_degree: 'School', date_text: '2026' }, bullets: ['Dean list'] },
  experience: [
    { entry_id: 'exp1', title_company_location: 'Developer, Acme', date_text: '2025', bullets: ['A', 'B'] },
    { entry_id: 'exp2', title_company_location: 'Intern, Acme', date_text: '2024', bullets: ['C'] },
  ],
  projects: [
    { entry_id: 'proj1', project_title: 'Tool', date_or_link_text: 'github', bullets: ['D', 'E'] },
  ],
  skills: { languages: [], frameworks: [], developer_tools: [] },
};
const blocks = buildReviewBlocks(doc, doc, doc).filter((block) =>
  block.blockId.includes('.bullet.'),
);
console.log(JSON.stringify(blocks.map((block) => ({
  id: block.blockId,
  label: block.label,
  context: block.contextLabel || '',
}))));
"""
    result = subprocess.run(
        ["node", "-e", script],
        cwd=ROOT / "frontend",
        check=True,
        capture_output=True,
        text=True,
    )
    payload = json.loads(result.stdout)

    assert payload == [
        {"id": "education.edu.bullet.0", "label": "Education bullet 1", "context": ""},
        {
            "id": "experience.exp1.bullet.0",
            "label": "Resume bullet 1",
            "context": "Developer, Acme bullet 1",
        },
        {
            "id": "experience.exp1.bullet.1",
            "label": "Resume bullet 2",
            "context": "Developer, Acme bullet 2",
        },
        {
            "id": "experience.exp2.bullet.0",
            "label": "Resume bullet 3",
            "context": "Intern, Acme bullet 1",
        },
        {
            "id": "projects.proj1.bullet.0",
            "label": "Resume bullet 4",
            "context": "Tool bullet 1",
        },
        {
            "id": "projects.proj1.bullet.1",
            "label": "Resume bullet 5",
            "context": "Tool bullet 2",
        },
    ]
