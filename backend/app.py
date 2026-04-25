import csv
import html
import io
import json
import os
import sqlite3
import sys
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional
from urllib.parse import parse_qs, parse_qsl, quote, urlencode, urlsplit, urlunsplit

import httpx
from fastapi import Body, Cookie, Depends, FastAPI, Form, HTTPException, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import (
    FileResponse,
    HTMLResponse,
    JSONResponse,
    PlainTextResponse,
    RedirectResponse,
)
from fastapi.staticfiles import StaticFiles

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from hunter.config import (  # noqa: E402
    HUNT_COORDINATOR_URL,
    HUNT_FLETCHER_URL,
    HUNT_HUNTER_URL,
    HUNT_SERVICE_TOKEN,
    REVIEW_APP_HOST,
    REVIEW_APP_PORT,
    REVIEW_OPS_TOKEN,
)
from backend.auth_session import (  # noqa: E402
    SESSION_COOKIE_NAME,
    ADMIN_PASSWORD,
    check_credentials,
    create_session,
    delete_session,
    init_sessions_table,
    purge_expired_sessions,
    validate_session,
)
from backend.db import (  # noqa: E402
    append_review_audit_entry,
    bulk_requeue_jobs_matching_review_filters,
    count_jobs_for_review,
    get_review_activity_summary,
    get_review_audit_entries,
    get_review_queue_summary,
    list_jobs_for_review,
    list_runtime_state_recent,
    set_job_priority,
    update_job_operator_meta,
)
from hunter.db import (  # noqa: E402
    bulk_requeue_jobs_by_ids,
    delete_jobs_by_ids,
    get_connection,
    get_job_by_id,
    init_db,
    manual_requeue_stale_processing_rows,
    requeue_enrichment_rows_by_error_codes,
    set_enrichment_status_for_job_ids,
)
from hunter.db import (  # noqa: E402
    requeue_job as requeue_review_job,
)
from hunter.failure_artifacts import resolve_artifact_path  # noqa: E402
from backend.resume_review_ui import (  # noqa: E402
    RESUME_REVIEW_SCRIPT,
    RESUME_REVIEW_STYLES,
    build_resume_review_html,
    load_json_file,
)

try:  # noqa: E402
    from fletcher.db import list_resume_attempts  # type: ignore

    RESUME_TAILOR_AVAILABLE = True
except ModuleNotFoundError:  # noqa: E402
    RESUME_TAILOR_AVAILABLE = False

    def list_resume_attempts(_job_id, limit=8):  # type: ignore
        return []


STATUS_OPTIONS = (
    "all",
    "ready",
    "pending",
    "processing",
    "done",
    "done_verified",
    "failed",
    "blocked",
    "blocked_verified",
)
SOURCE_OPTIONS = (
    "all",
    "linkedin",
    "indeed",
)

# Human-readable labels for enrichment values and filter chips.
ENRICHMENT_STATUS_LABELS = {
    "pending": "Pending enrichment",
    "processing": "Processing",
    "done": "Done",
    "done_verified": "Done (verified)",
    "failed": "Failed",
    "blocked": "Blocked",
    "blocked_verified": "Blocked (verified)",
}

STATUS_FILTER_LABELS = {
    "all": "All",
    "ready": "Ready",
    "pending": "Pending enrichment",
    "processing": "Processing",
    "done": "Done",
    "done_verified": "Done verified",
    "failed": "Failed",
    "blocked": "Blocked",
    "blocked_verified": "Blocked verified",
}


def enrichment_status_display(raw):
    if raw is None:
        return "Not set"
    s = str(raw).strip()
    if not s:
        return "Not set"
    return ENRICHMENT_STATUS_LABELS.get(s, s.replace("_", " "))

APP_ROUTE_PATHS = {
    "/",
    "/jobs",
    "/jobs/compare",
    "/health-view",
    "/ops",
}

OPS_ALLOWED_ERROR_CODES = frozenset({"auth_expired", "rate_limited"})

BULK_REQUEUE_STATUS_CHOICES = frozenset(
    {"failed", "blocked", "blocked_verified", "processing", "pending"}
)


def assert_review_ops_allowed(request: Request, form_ops_token: Optional[str] = None) -> None:
    expected = (REVIEW_OPS_TOKEN or "").strip()
    if _session_username(request):
        return
    if expected:
        if request.headers.get("x-review-ops-token", "").strip() == expected:
            return
        auth = request.headers.get("authorization") or ""
        if auth.lower().startswith("bearer ") and auth[7:].strip() == expected:
            return
        if form_ops_token and form_ops_token.strip() == expected:
            return
    raise HTTPException(
        status_code=401,
        detail="Missing or invalid review ops credential. Use header X-Review-Ops-Token or Authorization: Bearer, or ops_token on forms.",
    )


def review_ops_dependency(request: Request):
    assert_review_ops_allowed(request, None)


FRONTEND_DIST = Path(REPO_ROOT) / "frontend" / "dist"

@asynccontextmanager
async def lifespan(app):
    init_db(maintenance=False)
    init_sessions_table()
    purge_expired_sessions()
    if not ADMIN_PASSWORD:
        import warnings
        warnings.warn(
            "HUNT_ADMIN_PASSWORD is not set — all auth endpoints will reject logins. "
            "Set HUNT_ADMIN_PASSWORD in your environment to enable the web UI.",
            stacklevel=1,
        )
    yield


app = FastAPI(title="Hunt Control Plane", version="0.1.0", lifespan=lifespan)

from backend.gateway import router as _gateway_router  # noqa: E402
app.include_router(_gateway_router)

# CORS — only needed during local development (Vite on :5173, FastAPI on :8000)
_DEV_ORIGINS = [o.strip() for o in os.getenv("HUNT_CORS_ORIGINS", "http://localhost:5173").split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_DEV_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Serve built SPA assets at /assets/* if frontend/dist exists
if (FRONTEND_DIST / "assets").exists():
    app.mount("/assets", StaticFiles(directory=FRONTEND_DIST / "assets"), name="spa-assets")


def format_text(value):
    if value is None:
        return "None"
    return html.escape(str(value))


def _format_jd_usable_cell(value):
    """Human-readable JD usability from jobs.latest_resume_jd_usable (0/1/NULL)."""
    if value is None:
        return "—"
    try:
        v = int(value)
    except (TypeError, ValueError):
        return format_text(value)
    if v == 1:
        return "yes"
    if v == 0:
        return "no"
    return "—"


def truncate_text(value, *, max_chars=180):
    if not value:
        return ""
    value = str(value).replace("\n", " ")
    if len(value) <= max_chars:
        return value
    return value[: max_chars - 3] + "..."


def is_app_route_path(path):
    return path in APP_ROUTE_PATHS or path.startswith("/jobs/")


def normalize_return_to(value):
    if not value:
        return ""
    parts = urlsplit(str(value))
    path = parts.path or "/"
    if not is_app_route_path(path):
        return ""
    return urlunsplit(("", "", path, parts.query, ""))


def build_jobs_query(
    *,
    source="all",
    status="all",
    limit=50,
    page=1,
    q="",
    sort="date_scraped",
    direction="desc",
    tag="",
):
    pairs = [
        ("source", source),
        ("status", status),
        ("limit", str(limit)),
        ("page", str(page)),
        ("q", q),
        ("sort", sort),
        ("direction", direction),
    ]
    t = (tag or "").strip()
    if t:
        pairs.append(("tag", t))
    return urlencode(pairs, doseq=True)


def add_return_to(href, return_to):
    safe_return_to = normalize_return_to(return_to)
    if not safe_return_to:
        return href

    parts = urlsplit(href)
    params = parse_qsl(parts.query, keep_blank_values=True)
    params = [(key, value) for key, value in params if key != "return_to"]
    params.append(("return_to", safe_return_to))
    return urlunsplit(("", "", parts.path, urlencode(params, doseq=True), ""))


def request_path_with_query(request):
    query = request.url.query
    return f"{request.url.path}?{query}" if query else request.url.path


def _nav_link(label, href, *, current_path, exact=False):
    is_active = (
        current_path == href
        if exact
        else current_path == href or current_path.startswith(f"{href}/")
    )
    class_name = "nav-link active" if is_active else "nav-link"
    return f'<a class="{class_name}" href="{href}">{html.escape(label)}</a>'


def render_nav(current_path):
    return f"""
      <div class="nav">
        <div class="nav-group">
          {_nav_link("Overview", "/", current_path=current_path, exact=True)}
          {_nav_link("Jobs", "/jobs", current_path=current_path)}
          {_nav_link("Queue & health", "/health-view", current_path=current_path, exact=True)}
          {_nav_link("Ops", "/ops", current_path=current_path, exact=True)}
        </div>
        <div class="nav-group nav-group-secondary">
          <a class="nav-link nav-link-secondary" href="/health" data-no-app-nav="true">Raw health</a>
          <a class="nav-link nav-link-secondary" href="/api/summary" data-no-app-nav="true">Raw API</a>
        </div>
      </div>
    """


def render_layout(title, body, *, current_path="/"):
    styles = """
    :root {
      --bg: #f3efe7;
      --panel: #fffdf8;
      --panel-strong: #fff9ef;
      --ink: #1f2421;
      --muted: #65706c;
      --line: #ddd4c7;
      --accent: #245b4e;
      --accent-soft: #e2efe9;
      --accent-ink: #0f3e34;
      --warning: #845d00;
      --warning-soft: #fff3d6;
      --danger: #a93f31;
      --danger-soft: #ffe6e1;
      --good: #256b38;
      --good-soft: #dff3e5;
      --shadow: 0 10px 30px rgba(31, 36, 33, 0.06);
      font-family: "Segoe UI", system-ui, sans-serif;
    }
    html {
      min-height: 100%;
      background: linear-gradient(180deg, #f6f1e7 0%, #efe8db 100%);
    }
    body {
      margin: 0;
      min-height: 100vh;
      background: linear-gradient(180deg, #f6f1e7 0%, #efe8db 100%);
      color: var(--ink);
    }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .loading-bar {
      position: fixed;
      inset: 0 0 auto 0;
      height: 3px;
      background: linear-gradient(90deg, #245b4e 0%, #4e8c7c 100%);
      box-shadow: 0 8px 24px rgba(36, 91, 78, 0.2);
      opacity: 0;
      transform-origin: left center;
      transform: scaleX(0.08);
      transition: opacity 160ms ease;
      z-index: 40;
      pointer-events: none;
    }
    body.is-loading .loading-bar {
      opacity: 1;
      animation: hunt-progress 1.15s ease-in-out infinite alternate;
    }
    @keyframes hunt-progress {
      from { transform: scaleX(0.12); }
      to { transform: scaleX(0.72); }
    }
    .shell {
      max-width: 1180px;
      margin: 0 auto;
      padding: 28px 20px 40px;
      transition: opacity 120ms ease;
    }
    .nav {
      display: flex;
      justify-content: space-between;
      gap: 14px;
      align-items: center;
      margin-bottom: 24px;
      padding: 14px 16px;
      border: 1px solid rgba(221, 212, 199, 0.9);
      border-radius: 18px;
      background: rgba(255, 253, 248, 0.88);
      box-shadow: var(--shadow);
      backdrop-filter: blur(12px);
      position: sticky;
      top: 12px;
      z-index: 10;
    }
    .nav-group {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
    }
    .nav-link {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      padding: 9px 13px;
      color: var(--accent-ink);
      font-weight: 700;
      transition: background 140ms ease, color 140ms ease, transform 140ms ease;
    }
    .nav-link:hover {
      text-decoration: none;
      background: rgba(226, 239, 233, 0.75);
      transform: translateY(-1px);
    }
    .nav-link.active {
      background: var(--accent);
      color: white;
      box-shadow: 0 8px 16px rgba(36, 91, 78, 0.2);
    }
    .nav-link-secondary {
      color: var(--muted);
      font-weight: 600;
    }
    .hero {
      margin-bottom: 22px;
    }
    .hero h1 {
      margin: 0 0 8px;
      font-size: 2rem;
      line-height: 1.1;
    }
    .hero p {
      margin: 0;
      color: var(--muted);
      max-width: 760px;
    }
    .cards {
      display: grid;
      gap: 12px;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      margin-bottom: 24px;
    }
    .card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 16px;
      box-shadow: var(--shadow);
    }
    .card .label {
      font-size: 0.85rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--muted);
      margin-bottom: 8px;
    }
    .card .value {
      font-size: 1.6rem;
      font-weight: 700;
    }
    .toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-bottom: 18px;
    }
    .pill {
      border: 1px solid var(--line);
      background: var(--panel);
      border-radius: 999px;
      padding: 8px 12px;
      color: var(--ink);
      font-weight: 600;
      transition: background 140ms ease, border-color 140ms ease, transform 140ms ease;
    }
    .pill:hover {
      text-decoration: none;
      background: var(--panel-strong);
      transform: translateY(-1px);
    }
    .pill.active {
      background: var(--accent);
      border-color: var(--accent);
      color: white;
    }
    .table-wrap {
      overflow-x: auto;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 18px;
      box-shadow: var(--shadow);
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th, td {
      padding: 12px 14px;
      border-bottom: 1px solid var(--line);
      text-align: left;
      vertical-align: top;
      font-size: 0.95rem;
    }
    tr:last-child td {
      border-bottom: none;
    }
    th {
      font-size: 0.83rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--muted);
      background: #faf5ec;
    }
    tr[data-job-row]:hover td {
      background: rgba(250, 245, 236, 0.72);
    }
    .status {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border-radius: 999px;
      padding: 5px 10px;
      font-size: 0.8rem;
      font-weight: 700;
    }
    .status.done, .status.done_verified {
      background: var(--good-soft);
      color: var(--good);
    }
    .status.pending, .status.processing {
      background: var(--accent-soft);
      color: var(--accent);
    }
    .status.blocked, .status.blocked_verified {
      background: var(--warning-soft);
      color: var(--warning);
    }
    .status.failed {
      background: var(--danger-soft);
      color: var(--danger);
    }
    .mono {
      font-family: Consolas, "SFMono-Regular", monospace;
      font-size: 0.9rem;
      word-break: break-word;
    }
    .link-cell {
      min-width: 128px;
    }
    .link-cell a {
      display: inline-block;
      white-space: nowrap;
    }
    .stack {
      display: grid;
      gap: 16px;
    }
    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 18px;
      padding: 18px;
      box-shadow: var(--shadow);
    }
    .panel h2 {
      margin: 0 0 12px;
      font-size: 1.15rem;
    }
    .grid {
      display: grid;
      gap: 12px;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    }
    .field {
      background: #faf5ec;
      border-radius: 12px;
      padding: 12px;
    }
    .field .label {
      font-size: 0.8rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--muted);
      margin-bottom: 6px;
    }
    .field .value {
      word-break: break-word;
    }
    .actions {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      margin-top: 14px;
      align-items: center;
    }
    button {
      border: 0;
      background: var(--accent);
      color: white;
      border-radius: 999px;
      padding: 10px 14px;
      font-weight: 700;
      cursor: pointer;
      transition: transform 140ms ease, opacity 140ms ease, box-shadow 140ms ease;
      box-shadow: 0 8px 16px rgba(36, 91, 78, 0.18);
    }
    button:hover {
      transform: translateY(-1px);
    }
    button.secondary {
      background: #5d6a66;
    }
    button:disabled {
      opacity: 0.6;
      cursor: progress;
      transform: none;
      box-shadow: none;
    }
    pre {
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
      font-family: Consolas, "SFMono-Regular", monospace;
      font-size: 0.92rem;
      line-height: 1.45;
    }
    .toast {
      position: fixed;
      right: 18px;
      bottom: 18px;
      max-width: min(420px, calc(100vw - 36px));
      border-radius: 16px;
      padding: 14px 16px;
      background: rgba(31, 36, 33, 0.92);
      color: white;
      box-shadow: 0 18px 40px rgba(0, 0, 0, 0.24);
      opacity: 0;
      pointer-events: none;
      transform: translateY(12px);
      transition: opacity 160ms ease, transform 160ms ease;
      z-index: 30;
    }
    .toast.show {
      opacity: 1;
      transform: translateY(0);
    }
    .toast.error {
      background: rgba(169, 63, 49, 0.96);
    }
    tr.job-row-focus {
      outline: 2px solid var(--accent);
      outline-offset: -2px;
      background: var(--accent-soft);
    }
    .badge-priority {
      display: inline-block;
      font-size: 0.68rem;
      font-weight: 800;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      padding: 3px 8px;
      border-radius: 6px;
      background: var(--warning-soft);
      color: var(--warning);
      border: 1px solid rgba(132, 93, 0, 0.35);
      cursor: help;
      user-select: none;
      white-space: nowrap;
    }
    .jobs-selection-bar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 10px 14px;
      padding: 12px 16px;
      margin-bottom: 14px;
      border-radius: 14px;
      border: 1px solid var(--line);
      background: var(--panel-strong);
      box-shadow: var(--shadow);
      position: sticky;
      bottom: 12px;
      z-index: 8;
    }
    .jobs-selection-bar.is-hidden {
      display: none;
    }
    .jobs-selection-bar select {
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 8px 10px;
      background: #faf5ec;
      font: inherit;
    }
    .jobs-selection-bar .selection-count {
      font-weight: 700;
      color: var(--accent-ink);
    }
    #jobs-selection-status-wrap.is-hidden {
      display: none !important;
    }
    #jobs-selection-status-wrap:not(.is-hidden) {
      display: flex;
    }
    .jobs-advanced-panel {
      margin-bottom: 18px;
      border: 1px solid var(--line);
      border-radius: 16px;
      background: var(--panel);
      box-shadow: var(--shadow);
    }
    .jobs-advanced-panel summary {
      cursor: pointer;
      padding: 14px 16px;
      font-weight: 700;
      color: var(--accent-ink);
      list-style: none;
    }
    .jobs-advanced-panel summary::-webkit-details-marker { display: none; }
    .jobs-advanced-panel[open] summary {
      border-bottom: 1px solid var(--line);
    }
    .jobs-advanced-panel .jobs-advanced-body {
      padding: 16px;
    }
    .filter-form-grid {
      display: grid;
      gap: 12px;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      align-items: end;
    }
    .jobs-table-wrap table th:first-child,
    .jobs-table-wrap table td:first-child {
      width: 2.25rem;
      text-align: center;
      vertical-align: middle;
    }
    .jobs-table-wrap table th:nth-child(3),
    .jobs-table-wrap table td:nth-child(3) {
      text-align: center;
      white-space: nowrap;
    }
    kbd {
      font: 0.82em ui-monospace, Consolas, monospace;
      padding: 2px 6px;
      border-radius: 6px;
      border: 1px solid var(--line);
      background: #faf5ec;
    }
    @media (max-width: 760px) {
      .shell {
        padding: 18px 14px 32px;
      }
      .nav {
        position: static;
        padding: 12px;
      }
      .hero h1 {
        font-size: 1.7rem;
      }
    }
    """
    script = """
  <script>
    (() => {
      const APP_ROUTE_PATTERNS = [
        new RegExp('^/$'),
        new RegExp('^/jobs(?:/[0-9]+|/compare)?$'),
        new RegExp('^/health-view$'),
        new RegExp('^/ops$'),
      ];
      const PENDING_REFRESH_KEY = 'hunt-pending-refresh';
      const toast = () => document.getElementById('app-toast');
      let inFlightController = null;

      if ('scrollRestoration' in window.history) {
        window.history.scrollRestoration = 'manual';
      }

      function isAppRoute(url) {
        if (url.origin !== window.location.origin) return false;
        if (url.searchParams.get('download')) return false;
        return APP_ROUTE_PATTERNS.some((pattern) => pattern.test(url.pathname));
      }

      function normalizeUrl(url) {
        const parsed = new URL(url, window.location.origin);
        return `${parsed.pathname}${parsed.search}`;
      }

      function showToast(message, kind = 'ok') {
        const node = toast();
        if (!node) return;
        node.textContent = message;
        node.className = kind === 'error' ? 'toast show error' : 'toast show';
        window.clearTimeout(node._hideTimer);
        node._hideTimer = window.setTimeout(() => {
          node.className = kind === 'error' ? 'toast error' : 'toast';
        }, 2200);
      }

      function syncJobsSelectionBar() {
        const bar = document.getElementById('jobs-selection-bar');
        const countEl = document.getElementById('jobs-selection-count');
        const all = document.getElementById('jobs-select-all');
        if (!bar || !countEl) return;
        const checks = Array.from(document.querySelectorAll('.jobs-row-check'));
        const n = checks.filter((c) => c.checked).length;
        if (n === 0) {
          bar.classList.add('is-hidden');
          if (all) {
            all.checked = false;
            all.indeterminate = false;
          }
        } else {
          bar.classList.remove('is-hidden');
          countEl.textContent = `${n} selected`;
          if (all && checks.length) {
            all.indeterminate = n > 0 && n < checks.length;
            all.checked = n === checks.length;
          }
        }
      }

      document.addEventListener('change', (event) => {
        const t = event.target;
        if (!(t instanceof HTMLElement)) return;
        if (t.id === 'jobs-select-all') {
          document.querySelectorAll('.jobs-row-check').forEach((c) => { c.checked = t.checked; });
          syncJobsSelectionBar();
          return;
        }
        if (t.classList.contains('jobs-row-check')) {
          syncJobsSelectionBar();
          return;
        }
        if (t.id === 'jobs-selection-action') {
          const wrap = document.getElementById('jobs-selection-status-wrap');
          if (!wrap) return;
          if (t.value === 'set_status') {
            wrap.classList.remove('is-hidden');
          } else {
            wrap.classList.add('is-hidden');
          }
        }
      });

      function rememberScroll() {
        const state = window.history.state || {};
        window.history.replaceState({ ...state, url: window.location.href, scrollY: window.scrollY }, '', window.location.href);
      }

      function setPendingRefresh(url, message) {
        window.sessionStorage.setItem(PENDING_REFRESH_KEY, JSON.stringify({
          url: normalizeUrl(url),
          message,
        }));
      }

      function takePendingRefresh() {
        const raw = window.sessionStorage.getItem(PENDING_REFRESH_KEY);
        if (!raw) return null;
        try {
          const payload = JSON.parse(raw);
          if (payload && payload.url === normalizeUrl(window.location.href)) {
            window.sessionStorage.removeItem(PENDING_REFRESH_KEY);
            return payload;
          }
        } catch (_error) {
          window.sessionStorage.removeItem(PENDING_REFRESH_KEY);
        }
        return null;
      }

      async function swapTo(url, { push = false, replace = false, restoreScroll = false } = {}) {
        if (inFlightController) {
          inFlightController.abort();
        }
        const fromUrl = new URL(window.location.href);
        const toUrl = new URL(url, window.location.origin);
        const preserveJobsListScroll =
          !restoreScroll &&
          fromUrl.pathname === '/jobs' &&
          toUrl.pathname === '/jobs';
        const jobsListScrollY = preserveJobsListScroll ? window.scrollY : 0;
        inFlightController = new AbortController();
        document.body.classList.add('is-loading');
        try {
          const response = await fetch(url, {
            headers: { 'X-Hunt-App': '1', 'Accept': 'text/html' },
            signal: inFlightController.signal,
          });
          const text = await response.text();
          if (!response.ok) {
            window.location.href = url;
            return;
          }
          const parsed = new DOMParser().parseFromString(text, 'text/html');
          const nextShell = parsed.getElementById('app-shell');
          if (!nextShell) {
            window.location.href = url;
            return;
          }
          const currentShell = document.getElementById('app-shell');
          currentShell.replaceWith(nextShell);
          document.title = parsed.title;

          if (push) {
            window.history.pushState(
              { url, scrollY: preserveJobsListScroll ? jobsListScrollY : 0 },
              '',
              url
            );
          } else if (replace) {
            const previous = window.history.state || {};
            window.history.replaceState(
              {
                ...previous,
                url,
                scrollY: preserveJobsListScroll ? jobsListScrollY : (previous.scrollY ?? 0),
              },
              '',
              url
            );
          }

          const state = window.history.state || {};
          if (restoreScroll) {
            window.scrollTo(0, state.scrollY || 0);
          } else if (preserveJobsListScroll) {
            window.scrollTo(0, jobsListScrollY);
          } else {
            window.scrollTo(0, 0);
          }
          const pending = takePendingRefresh();
          if (pending && pending.message) {
            showToast(pending.message);
          }
        } catch (error) {
          if (error.name !== 'AbortError') {
            window.location.href = url;
          }
        } finally {
          document.body.classList.remove('is-loading');
        }
      }

      async function handleAsyncRequeue(form) {
        const submitButton = form.querySelector('button[type="submit"]');
        if (submitButton) submitButton.disabled = true;
        try {
          const tv = document.getElementById('hunt-review-ops-token-value');
          const headers = {
            'X-Hunt-Async': '1',
            'Accept': 'application/json',
          };
          if (tv && tv.value) headers['X-Review-Ops-Token'] = tv.value;
          const response = await fetch(form.action, {
            method: 'POST',
            headers,
          });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok) {
            throw new Error(payload.detail || payload.error || 'Requeue failed.');
          }
          const returnTo = payload.return_to;
          if (returnTo) {
            setPendingRefresh(returnTo, 'Job requeued for enrichment.');
            if (window.history.length > 1) {
              window.history.back();
              return;
            }
            await swapTo(returnTo, { replace: true, restoreScroll: true });
            return;
          }
          showToast('Job requeued for enrichment.');
          await swapTo(payload.redirect_url || window.location.href, { replace: true, restoreScroll: true });
        } catch (error) {
          showToast(error.message || 'Requeue failed.', 'error');
          if (submitButton) submitButton.disabled = false;
        }
      }

      document.addEventListener('click', (event) => {
        const target = event.target instanceof Element ? event.target : event.target && event.target.parentElement;
        if (!target) return;
        const anchor = target.closest('a[href]');
        if (!anchor) return;
        if (anchor.dataset.noAppNav === 'true') return;
        if (anchor.target && anchor.target !== '_self') return;
        if (anchor.hasAttribute('download')) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        const url = new URL(anchor.href, window.location.href);
        if (!isAppRoute(url)) return;
        event.preventDefault();
        rememberScroll();
        swapTo(url.toString(), { push: true });
      });

      document.addEventListener('submit', (event) => {
        const form = event.target;
        if (!(form instanceof HTMLFormElement)) return;
        if (form.dataset.asyncRequeue === 'true') {
          event.preventDefault();
          handleAsyncRequeue(form);
          return;
        }
        const method = (form.method || 'get').toLowerCase();
        if (method !== 'get') return;
        event.preventDefault();
        rememberScroll();
        const url = new URL(form.action || window.location.pathname, window.location.origin);
        const formData = new FormData(form);
        for (const [key, value] of formData.entries()) {
          if (value === '') {
            url.searchParams.delete(key);
          } else {
            url.searchParams.set(key, value.toString());
          }
        }
        swapTo(url.toString(), { push: true });
      });

      document.addEventListener('click', (event) => {
        const target = event.target instanceof Element ? event.target : null;
        const requeueBtn = target && target.closest('.ops-requeue-btn');
        if (requeueBtn) {
          event.preventDefault();
          const source = requeueBtn.getAttribute('data-source') || 'linkedin';
          const codesRaw = requeueBtn.getAttribute('data-codes') || '';
          const error_codes = codesRaw.split(',').map((s) => s.trim()).filter(Boolean);
          if (!error_codes.length) {
            showToast('No error codes on button.', 'error');
            return;
          }
          requeueBtn.disabled = true;
          const tv = document.getElementById('hunt-review-ops-token-value');
          const hdr = { 'Content-Type': 'application/json', Accept: 'application/json' };
          if (tv && tv.value) hdr['X-Review-Ops-Token'] = tv.value;
          fetch('/api/ops/requeue-errors', {
            method: 'POST',
            headers: hdr,
            body: JSON.stringify({ source, error_codes }),
          })
            .then(async (response) => {
              const payload = await response.json().catch(() => ({}));
              if (!response.ok) {
                const msg = typeof payload.detail === 'string'
                  ? payload.detail
                  : (payload.detail && JSON.stringify(payload.detail)) || 'Requeue failed.';
                throw new Error(msg);
              }
              showToast(`Requeued ${payload.updated} row(s).`, 'ok');
              await swapTo('/ops', { replace: true });
            })
            .catch((error) => {
              showToast(error.message || 'Requeue failed.', 'error');
            })
            .finally(() => {
              requeueBtn.disabled = false;
            });
          return;
        }
        const summaryBtn = target && target.closest('#ops-fetch-summary');
        if (summaryBtn) {
          event.preventDefault();
          fetch('/api/summary', { headers: { Accept: 'application/json' } })
            .then((r) => r.json())
            .then((data) => {
              const pre = document.getElementById('ops-summary-preview');
              if (pre) {
                pre.style.display = 'block';
                pre.textContent = JSON.stringify(data, null, 2);
              }
              showToast('Loaded /api/summary', 'ok');
            })
            .catch((e) => showToast(e.message || 'Fetch failed', 'error'));
        }
        const bulkDry = target && target.closest('#jobs-bulk-dry-run');
        const bulkRun = target && target.closest('#jobs-bulk-run');
        if (bulkDry || bulkRun) {
          event.preventDefault();
          const panel = document.getElementById('jobs-bulk-panel');
          const out = document.getElementById('jobs-bulk-result');
          if (!panel) return;
          const statuses = Array.from(panel.querySelectorAll('.jobs-bulk-status:checked')).map((el) => el.value);
          if (!statuses.length) {
            showToast('Select at least one target status.', 'error');
            return;
          }
          const src = panel.dataset.source;
          const payload = {
            source: src === 'all' ? null : src,
            status: panel.dataset.status,
            q: panel.dataset.q || '',
            tag: panel.dataset.tag || '',
            target_statuses: statuses,
            dry_run: Boolean(bulkDry),
          };
          const tv = document.getElementById('hunt-review-ops-token-value');
          const hdr = { 'Content-Type': 'application/json', Accept: 'application/json' };
          if (tv && tv.value) hdr['X-Review-Ops-Token'] = tv.value;
          const btn = bulkDry || bulkRun;
          btn.disabled = true;
          fetch('/api/ops/bulk-requeue', { method: 'POST', headers: hdr, body: JSON.stringify(payload) })
            .then(async (response) => {
              const data = await response.json().catch(() => ({}));
              if (!response.ok) {
                const msg = typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail || data);
                throw new Error(msg || 'Bulk requeue failed.');
              }
              if (out) {
                out.textContent = data.dry_run
                  ? `Would requeue ${data.count} row(s).`
                  : `Requeued ${data.updated} row(s).`;
              }
              showToast(data.dry_run ? `Dry-run: ${data.count} row(s)` : `Requeued ${data.updated} row(s)`, 'ok');
              if (!data.dry_run) await swapTo(window.location.href, { replace: true });
            })
            .catch((error) => showToast(error.message || 'Bulk requeue failed.', 'error'))
            .finally(() => {
              btn.disabled = false;
            });
        }
        const staleBtn = target && target.closest('#ops-stale-reset');
        if (staleBtn) {
          event.preventDefault();
          const out = document.getElementById('ops-stale-result');
          const tv = document.getElementById('hunt-review-ops-token-value');
          const hdr = { 'Content-Type': 'application/json', Accept: 'application/json' };
          if (tv && tv.value) hdr['X-Review-Ops-Token'] = tv.value;
          staleBtn.disabled = true;
          fetch('/api/ops/requeue-stale-processing', { method: 'POST', headers: hdr, body: '{}' })
            .then(async (response) => {
              const data = await response.json().catch(() => ({}));
              if (!response.ok) throw new Error(data.detail || 'Stale reset failed.');
              if (out) out.textContent = `Updated ${data.updated} row(s).`;
              showToast(`Stale processing requeue: ${data.updated}`, 'ok');
              await swapTo('/ops', { replace: true });
            })
            .catch((e) => showToast(e.message || 'Stale reset failed.', 'error'))
            .finally(() => {
              staleBtn.disabled = false;
            });
        }
        const priBtn = target && target.closest('[data-job-priority-set]');
        if (priBtn) {
          event.preventDefault();
          const id = priBtn.getAttribute('data-job-id');
          if (!id) return;
          const runNext = priBtn.getAttribute('data-job-priority-set') === '1';
          const tv = document.getElementById('hunt-review-ops-token-value');
          const hdr = { 'Content-Type': 'application/json', Accept: 'application/json' };
          if (tv && tv.value) hdr['X-Review-Ops-Token'] = tv.value;
          priBtn.disabled = true;
          fetch(`/api/jobs/${id}/priority`, {
            method: 'POST',
            headers: hdr,
            body: JSON.stringify({ run_next: runNext }),
          })
            .then(async (r) => {
              const data = await r.json().catch(() => ({}));
              if (!r.ok) throw new Error(data.detail || 'Priority update failed.');
              showToast(runNext ? 'Marked run next.' : 'Cleared priority flag.', 'ok');
              await swapTo(window.location.href, { replace: true, restoreScroll: true });
            })
            .catch((e) => showToast(e.message || 'Priority update failed.', 'error'))
            .finally(() => {
              priBtn.disabled = false;
            });
        }
        const selApply = target && target.closest('#jobs-selection-apply');
        if (selApply) {
          event.preventDefault();
          const actionEl = document.getElementById('jobs-selection-action');
          const statusEl = document.getElementById('jobs-selection-status');
          const action = actionEl && actionEl.value;
          const ids = Array.from(document.querySelectorAll('.jobs-row-check:checked'))
            .map((c) => parseInt(c.value, 10))
            .filter((x) => !Number.isNaN(x));
          if (!ids.length) {
            showToast('Select at least one row.', 'error');
            return;
          }
          if (!action) {
            showToast('Choose an action.', 'error');
            return;
          }
          const payload = { action, job_ids: ids };
          if (action === 'set_status') {
            payload.enrichment_status = statusEl && statusEl.value;
            if (!payload.enrichment_status) {
              showToast('Choose a new status.', 'error');
              return;
            }
          }
          if (action === 'delete') {
            const ok = window.confirm(
              `Delete ${ids.length} job row(s) from the database? This cannot be undone.`,
            );
            if (!ok) return;
            payload.confirm_delete = true;
          }
          const tv = document.getElementById('hunt-review-ops-token-value');
          const hdr = { 'Content-Type': 'application/json', Accept: 'application/json' };
          if (tv && tv.value) hdr['X-Review-Ops-Token'] = tv.value;
          selApply.disabled = true;
          fetch('/api/jobs/bulk-selection', { method: 'POST', headers: hdr, body: JSON.stringify(payload) })
            .then(async (r) => {
              const data = await r.json().catch(() => ({}));
              if (!r.ok) {
                const msg = typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail || data);
                throw new Error(msg || 'Bulk action failed.');
              }
              showToast(`Updated ${data.updated} row(s).`, 'ok');
              await swapTo(window.location.href, { replace: true });
            })
            .catch((e) => showToast(e.message || 'Bulk action failed.', 'error'))
            .finally(() => {
              selApply.disabled = false;
            });
          return;
        }
        const selClear = target && target.closest('#jobs-selection-clear');
        if (selClear) {
          event.preventDefault();
          document.querySelectorAll('.jobs-row-check').forEach((c) => { c.checked = false; });
          const all = document.getElementById('jobs-select-all');
          if (all) {
            all.checked = false;
            all.indeterminate = false;
          }
          const ae = document.getElementById('jobs-selection-action');
          if (ae) ae.value = '';
          const wrap = document.getElementById('jobs-selection-status-wrap');
          if (wrap) wrap.classList.add('is-hidden');
          syncJobsSelectionBar();
        }
      });

      window.addEventListener('popstate', () => {
        swapTo(window.location.href, { replace: true, restoreScroll: true });
      });

      window.addEventListener('pageshow', (event) => {
        if (!event.persisted) return;
        const url = new URL(window.location.href);
        if (!isAppRoute(url)) return;
        swapTo(url.toString(), { replace: true, restoreScroll: true });
      });

      if (!window.history.state || !window.history.state.url) {
        window.history.replaceState({ url: window.location.href, scrollY: window.scrollY }, '', window.location.href);
      }

      (function injectOpsTokenIntoPostForms() {
        const tv = document.getElementById('hunt-review-ops-token-value');
        if (!tv || !tv.value) return;
        document.addEventListener('submit', (e) => {
          const form = e.target;
          if (!(form instanceof HTMLFormElement)) return;
          if ((form.method || 'get').toLowerCase() !== 'post') return;
          let h = form.querySelector('input[name="ops_token"]');
          if (!h) {
            h = document.createElement('input');
            h.type = 'hidden';
            h.name = 'ops_token';
            form.appendChild(h);
          }
          h.value = tv.value;
        });
      })();

      (function jobsListKeyboardNav() {
        const path = window.location.pathname || '';
        if (path !== '/jobs') return;
        const table = document.querySelector('.jobs-table-wrap table tbody');
        if (!table) return;
        let idx = -1;
        const rows = () => Array.from(table.querySelectorAll('tr[data-job-id]'));
        function focusRow(i) {
          const r = rows();
          if (!r.length) return;
          idx = ((i % r.length) + r.length) % r.length;
          r.forEach((row, j) => row.classList.toggle('job-row-focus', j === idx));
          r[idx].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
        document.addEventListener('keydown', (e) => {
          if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT')) return;
          if (e.key === 'j') { e.preventDefault(); focusRow(idx < 0 ? 0 : idx + 1); }
          if (e.key === 'k') { e.preventDefault(); focusRow(idx < 0 ? 0 : idx - 1); }
          if (e.key === 'Enter' && idx >= 0) {
            const link = rows()[idx] && rows()[idx].querySelector('a[href^="/jobs/"]');
            if (link) { e.preventDefault(); link.click(); }
          }
        });
      })();

      (function persistJobsFilters() {
        const KEY = 'hunt-jobs-query-v1';
        const path = window.location.pathname || '';
        if (path === '/jobs' && window.location.search) {
          try {
            window.sessionStorage.setItem(KEY, window.location.search);
          } catch (_e) {}
        }
        if (path === '/jobs' && !window.location.search) {
          try {
            const saved = window.sessionStorage.getItem(KEY);
            if (saved && saved.startsWith('?')) {
              window.history.replaceState(window.history.state || {}, '', '/jobs' + saved);
              window.location.reload();
            }
          } catch (_e) {}
        }
      })();
    })();
  </script>
    """
    ops_token_el = ""
    if (REVIEW_OPS_TOKEN or "").strip():
        ops_token_el = f'<input type="hidden" id="hunt-review-ops-token-value" value="{html.escape((REVIEW_OPS_TOKEN or "").strip())}" aria-hidden="true" />'
    return f"""<!DOCTYPE html>
<html lang="en" style="background:#f6f1e7;">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{html.escape(title)}</title>
  <style>{styles}</style>
</head>
<body style="margin:0; min-height:100vh; background:#f6f1e7; color:#1f2421;">
    <div class="loading-bar" aria-hidden="true"></div>
    <div id="app-shell" class="shell" data-current-path="{html.escape(current_path)}">
      {render_nav(current_path)}
      {body}
    </div>
    <div id="app-toast" class="toast" aria-live="polite"></div>
    {ops_token_el}
    {script}
</body>
</html>
"""


def render_metrics(summary):
    linkedin_auth = summary.get("auth", {}).get("linkedin", {})
    lines = [
        "# HELP hunt_queue_total Total jobs known to the Hunt review queue.",
        "# TYPE hunt_queue_total gauge",
        f"hunt_queue_total {summary['total']}",
        "# HELP hunt_queue_ready Number of rows currently ready for enrichment.",
        "# TYPE hunt_queue_ready gauge",
        f"hunt_queue_ready {summary['ready_count']}",
        "# HELP hunt_queue_pending Number of rows currently pending enrichment.",
        "# TYPE hunt_queue_pending gauge",
        f"hunt_queue_pending {summary['pending_count']}",
        "# HELP hunt_queue_retry_ready Number of failed rows that are now eligible for retry.",
        "# TYPE hunt_queue_retry_ready gauge",
        f"hunt_queue_retry_ready {summary['retry_ready_count']}",
        "# HELP hunt_queue_processing Number of rows currently being processed.",
        "# TYPE hunt_queue_processing gauge",
        f"hunt_queue_processing {summary['processing_count']}",
        "# HELP hunt_queue_blocked Number of blocked enrichment rows.",
        "# TYPE hunt_queue_blocked gauge",
        f"hunt_queue_blocked {summary['blocked_count']}",
        "# HELP hunt_queue_stale_processing Number of stale processing rows.",
        "# TYPE hunt_queue_stale_processing gauge",
        f"hunt_queue_stale_processing {summary['stale_processing_count']}",
        "# HELP hunt_auth_available Whether LinkedIn auth is currently available for enrichment.",
        "# TYPE hunt_auth_available gauge",
        f'hunt_auth_available{{source="linkedin"}} {1 if linkedin_auth.get("available", True) else 0}',
    ]
    for source, count in sorted(summary.get("source_counts", {}).items()):
        lines.append(f'hunt_queue_source_count{{source="{source}"}} {count}')
    for status, count in sorted(summary.get("counts_by_status", {}).items()):
        lines.append(f'hunt_queue_status_count{{status="{status}"}} {count}')
    for error_code, count in sorted(summary.get("failure_counts", {}).items()):
        lines.append(f'hunt_queue_failure_count{{error_code="{error_code}"}} {count}')
    return "\n".join(lines) + "\n"


def render_artifact_links(row):
    artifact_fields = (
        ("last_artifact_dir", "Artifact dir", None),
        ("last_artifact_screenshot_path", "Screenshot", "screenshot"),
        ("last_artifact_html_path", "HTML snapshot", "html"),
        ("last_artifact_text_path", "Text snapshot", "text"),
    )
    rendered = []
    for field_name, label, artifact_kind in artifact_fields:
        value = row.get(field_name)
        if not value:
            continue
        if artifact_kind:
            rendered.append(
                f'<div class="field"><div class="label">{html.escape(label)}</div>'
                f'<div class="value mono"><a href="/api/jobs/{row["id"]}/artifacts/{artifact_kind}" target="_blank" rel="noreferrer">{format_text(value)}</a></div></div>'
            )
        else:
            rendered.append(
                f'<div class="field"><div class="label">{html.escape(label)}</div><div class="value mono">{format_text(value)}</div></div>'
            )
    if not rendered:
        return '<div class="field"><div class="label">Artifacts</div><div class="value">No failure artifacts saved.</div></div>'
    return "".join(rendered)


def render_summary_cards(summary):
    linkedin_auth = summary.get("auth", {}).get("linkedin", {})
    cards = [
        ("Total rows", summary["total"]),
        ("Pending enrich", summary["pending_count"]),
        (
            "Enriched",
            summary["counts_by_status"].get("done", 0)
            + summary["counts_by_status"].get("done_verified", 0),
        ),
        ("Failed", summary["counts_by_status"].get("failed", 0)),
        ("Blocked", summary["blocked_count"]),
        ("LinkedIn auth", "ready" if linkedin_auth.get("available", True) else "login needed"),
    ]
    return "".join(
        f"""
        <div class="card">
          <div class="label">{html.escape(label)}</div>
          <div class="value">{html.escape(str(value))}</div>
        </div>
        """
        for label, value in cards
    )


def _jobs_href(*, source="all", status="ready", limit=50):
    return f"/jobs?source={quote(source)}&status={quote(status)}&limit={limit}"


def render_queue_jump_strip(summary):
    """Compact links for overview : no duplicate of full health tables."""
    failed_n = int(summary.get("counts_by_status", {}).get("failed") or 0)
    done_n = int(summary.get("counts_by_status", {}).get("done") or 0) + int(
        summary.get("counts_by_status", {}).get("done_verified") or 0
    )
    pills = [
        ("All jobs", "all", "all"),
        ("Ready", "all", "ready"),
        ("Pending enrich", "all", "pending"),
        ("Processing", "all", "processing"),
        ("Failed", "all", "failed"),
        ("Blocked", "all", "blocked"),
        ("Done", "all", "done"),
        ("Done verified", "all", "done_verified"),
    ]
    parts = []
    for label, src, st in pills:
        parts.append(
            f'<a class="pill" href="{_jobs_href(source=src, status=st)}" data-app-nav="true">{html.escape(label)}</a>'
        )
    linkedin_auth = summary.get("auth", {}).get("linkedin", {})
    auth_ok = linkedin_auth.get("available", True)
    auth_hint = "LinkedIn auth OK" if auth_ok else "LinkedIn auth needs refresh"
    auth_class = "pill" if auth_ok else "pill active"
    return f"""
    <div class="panel">
      <h2 style="margin-top:0;font-size:1.05rem;">Jump into the queue</h2>
      <p class="muted" style="margin:0 0 10px 0;">
        At a glance : <strong>{summary["total"]}</strong> rows total,
        <strong>{summary["ready_count"]}</strong> ready,
        <strong>{summary["pending_count"]}</strong> pending,
        <strong>{failed_n}</strong> failed,
        <strong>{done_n}</strong> done.
        <a class="{auth_class}" style="margin-left:8px;" href="/health-view#review-auth-panel" data-app-nav="true">{html.escape(auth_hint)}</a>
      </p>
      <div class="actions" style="flex-wrap:wrap;gap:8px;">{"".join(parts)}</div>
      <p class="muted" style="margin:12px 0 0 0;font-size:0.9rem;">
        Full tables and events : <a href="/health-view" data-app-nav="true">Queue &amp; health</a>
        · Operator tools : <a href="/ops" data-app-nav="true">Ops</a>
      </p>
    </div>
    """


def render_monitoring_endpoints_panel():
    return """
    <div class="panel">
      <h2>Monitoring endpoints</h2>
      <p class="muted">Same queue snapshot in formats for scripts, Prometheus, and UIs.</p>
      <div class="actions" style="flex-wrap:wrap;gap:8px;">
        <a class="pill" href="/health" target="_blank" rel="noreferrer" data-no-app-nav="true">GET /health (JSON)</a>
        <a class="pill" href="/api/summary" target="_blank" rel="noreferrer" data-no-app-nav="true">GET /api/summary</a>
        <a class="pill" href="/metrics" target="_blank" rel="noreferrer" data-no-app-nav="true">GET /metrics</a>
      </div>
    </div>
    """


def render_auth_status(summary):
    linkedin_auth = summary.get("auth", {}).get("linkedin", {})
    events = summary.get("events", {}) or {}
    if not linkedin_auth:
        return ""

    available = linkedin_auth.get("available", True)
    status_class = "done" if available else "failed"
    headline = "LinkedIn auth ready" if available else "LinkedIn auth paused"
    description = (
        "Saved LinkedIn auth is currently available for unattended enrichment."
        if available
        else "LinkedIn enrichment is paused until the saved auth state is refreshed and saved again."
    )
    details = [
        ("State", linkedin_auth.get("status") or "unknown"),
        ("Available", str(bool(linkedin_auth.get("available", True))).lower()),
        ("Updated", linkedin_auth.get("updated_at") or "unknown"),
    ]
    if linkedin_auth.get("last_error"):
        details.append(("Last error", linkedin_auth.get("last_error")))

    def _format_event(payload):
        if not payload or not payload.get("value"):
            return None
        raw = payload.get("value")
        try:
            parsed = json.loads(raw)
            msg = parsed.get("message") or raw
            ts = parsed.get("ts") or payload.get("updated_at")
            return f"{msg} @ {ts}"
        except Exception:
            return f"{raw} @ {payload.get('updated_at')}"

    rate_limited = events.get("linkedin_last_rate_limited")
    rate_text = _format_event(rate_limited)
    if rate_text:
        details.append(
            (
                "Last rate limit",
                rate_text,
            )
        )
    automation_flagged = events.get("linkedin_last_automation_flagged")
    automation_text = _format_event(automation_flagged)
    if automation_text:
        details.append(
            (
                "Last automation detection",
                automation_text,
            )
        )
    last_priority = events.get("hunt_last_priority_job")
    priority_text = _format_event(last_priority)
    if priority_text:
        details.append(("Last priority job", priority_text))
    discord_err = events.get("discord_last_priority_notify_error")
    discord_text = _format_event(discord_err)
    if discord_text:
        details.append(
            (
                "Last Discord priority error",
                discord_text,
            )
        )
    rows = "".join(
        f"<tr><td>{format_text(label)}</td><td>{format_text(value)}</td></tr>"
        for label, value in details
    )
    hint = ""
    if not available:
        hint = '<p style="color: var(--muted);">Refresh auth with <code>DISPLAY=:98 ./hunter.sh auth-save --channel chrome</code>, then press Enter after the LinkedIn feed is visible.</p>'
    return f"""
    <div class="panel" id="review-auth-panel">
      <h2>{html.escape(headline)}</h2>
      <div style="margin-bottom: 12px;"><span class="status {status_class}">{html.escape(headline)}</span></div>
      <p>{html.escape(description)}</p>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Detail</th><th>Value</th></tr></thead>
          <tbody>{rows}</tbody>
        </table>
      </div>
      {hint}
    </div>
    """


def resolve_resume_path(value):
    if not value:
        return None
    path = Path(value).expanduser()
    try:
        resolved = path.resolve(strict=False)
    except OSError:
        resolved = path
    return resolved


def render_resume_links(row):
    link_specs = (
        ("selected_resume_pdf_path", "Selected PDF", "selected-pdf"),
        ("selected_resume_tex_path", "Selected TeX", "selected-tex"),
        ("latest_resume_pdf_path", "Latest PDF", "latest-pdf"),
        ("latest_resume_tex_path", "Latest TeX", "latest-tex"),
        ("latest_resume_keywords_path", "Keywords", "keywords"),
        ("latest_resume_job_description_path", "JD snapshot", "job-description"),
    )
    rendered = []
    for field_name, label, artifact_kind in link_specs:
        value = row.get(field_name)
        if not value:
            continue
        rendered.append(
            f'<div class="field"><div class="label">{html.escape(label)}</div>'
            f'<div class="value mono"><a href="/api/jobs/{row["id"]}/resume/{artifact_kind}" target="_blank" rel="noreferrer">{format_text(value)}</a></div></div>'
        )
    if not rendered:
        return '<div class="field"><div class="label">Resume artifacts</div><div class="value">No resume artifacts saved yet.</div></div>'
    return "".join(rendered)


def _render_keyword_pills(bucket_label: str, values: list[str]) -> str:
    if not values:
        return ""
    pills = "".join(
        f'<span class="pill" style="padding:6px 10px; font-size:0.85rem; font-weight:600;">{html.escape(v)}</span>'
        for v in values
        if v
    )
    return f"""
    <div style="margin-bottom: 12px;">
      <div class="label" style="margin-bottom:8px;">{html.escape(bucket_label)}</div>
      <div class="actions" style="flex-wrap:wrap; gap:8px;">{pills}</div>
    </div>
    """


def render_resume_keywords_panel(row, attempts):
    if not RESUME_TAILOR_AVAILABLE:
        return ""
    keywords = None
    if attempts:
        keywords = load_json_file((attempts[0] or {}).get("keywords_path"))
    if keywords is None:
        keywords = load_json_file(row.get("latest_resume_keywords_path"))
    if not keywords:
        return ""
    must = [str(x).strip() for x in (keywords.get("must_have_terms") or []) if str(x).strip()]
    nice = [str(x).strip() for x in (keywords.get("nice_to_have_terms") or []) if str(x).strip()]
    tools = [str(x).strip() for x in (keywords.get("tools_and_technologies") or []) if str(x).strip()]
    domain = [str(x).strip() for x in (keywords.get("domain_terms") or []) if str(x).strip()]
    if not (must or nice or tools or domain):
        return ""
    return f"""
    <div class="panel">
      <h2>Keywords extracted (C2)</h2>
      <p class="muted" style="margin-top:0;">Phrases extracted from the job description and used to score/shape the tailored resume.</p>
      {_render_keyword_pills("Must-have", must)}
      {_render_keyword_pills("Nice-to-have", nice)}
      {_render_keyword_pills("Tools & technologies", tools)}
      {_render_keyword_pills("Domain terms", domain)}
    </div>
    """


def _load_summary_for_attempt(attempt: dict) -> str | None:
    """Load the AI-generated summary from summary_rewrite.json in the attempt dir."""
    pdf_path = attempt.get("pdf_path") or attempt.get("tex_path")
    if not pdf_path:
        return None
    attempt_dir = Path(pdf_path).parent
    summary_path = attempt_dir / "summary_rewrite.json"
    data = load_json_file(summary_path)
    if not data:
        return None
    if not data.get("success"):
        return None
    return (data.get("summary") or "").strip() or None


def render_ai_summary_panel(attempts: list) -> str:
    """Prominent card showing the latest AI-generated summary paragraph."""
    if not RESUME_TAILOR_AVAILABLE or not attempts:
        return ""

    # Find the most recent attempt that has a summary_rewrite.json on disk.
    raw_data: dict | None = None
    keywords_used: list[str] = []
    for attempt in attempts:
        pdf_path = attempt.get("pdf_path") or attempt.get("tex_path")
        if not pdf_path:
            continue
        attempt_dir = Path(pdf_path).parent
        raw_data = load_json_file(attempt_dir / "summary_rewrite.json")
        if raw_data is not None:
            dist = load_json_file(attempt_dir / "keyword_distribution.json")
            if dist:
                keywords_used = dist.get("summary_keywords") or []
            break

    if raw_data is None:
        return ""

    summary_text = (raw_data.get("summary") or "").strip()
    success = raw_data.get("success", False)
    error = (raw_data.get("error") or "").strip()

    if success and summary_text:
        kw_pills = "".join(
            f'<span style="display:inline-block;background:#d8f5e0;color:#1a4a2e;border-radius:999px;'
            f'padding:2px 10px;font-size:0.78rem;margin:2px 3px 2px 0;">{html.escape(k)}</span>'
            for k in keywords_used
        )
        kw_block = f'<p style="margin:10px 0 0 0;">{kw_pills}</p>' if kw_pills else ""
        status_badge = '<span class="status done" style="font-size:0.75rem;padding:2px 6px;vertical-align:middle;">latest attempt</span>'
        body = f"""      <blockquote style="margin:0;padding:12px 16px;background:#fffdf8;border-left:3px solid #3cb878;border-radius:0 10px 10px 0;font-family:Georgia,serif;font-size:0.97rem;line-height:1.6;">
        {html.escape(summary_text)}
      </blockquote>
      {kw_block}"""
    else:
        reason = html.escape(error) if error else "Ollama backend not enabled, no mid-tier keywords, or candidate profile missing."
        status_badge = '<span class="status pending" style="font-size:0.75rem;padding:2px 6px;vertical-align:middle;">not generated</span>'
        body = f'<p class="muted" style="margin:0;font-style:italic;">Not generated — {reason}</p>'

    return f"""
    <div class="panel">
      <h2>AI-generated summary {status_badge}</h2>
      <p class="muted" style="margin-top:0;margin-bottom:12px;">Generated from mid-tier JD keywords. Not added to the resume — review only.</p>
      {body}
    </div>
    """


def render_resume_history_cards(attempts: list, job_id: int | None = None) -> str:
    """Attempt history as cards with PDF download and summary paragraph."""
    if not attempts:
        return ""
    cards = []
    for attempt in attempts:
        aid = attempt.get("id")
        jid = job_id or attempt.get("job_id")
        created = format_text(attempt.get("created_at") or "—")
        status = attempt.get("status") or "—"
        family = format_text(attempt.get("role_family") or "—")
        level = format_text(attempt.get("job_level") or "—")
        model = format_text(attempt.get("model_name") or "—")

        status_cls = "done" if "done" in status else ("failed" if "fail" in status else "pending")
        selected_badge = ""
        if attempt.get("is_selected_for_c3"):
            selected_badge = '<span class="status done" style="font-size:0.72rem;padding:1px 6px;">selected for apply</span> '
        elif attempt.get("is_latest_useful"):
            selected_badge = '<span class="status done_verified" style="font-size:0.72rem;padding:1px 6px;">useful</span> '

        download_links = []
        if aid and jid and attempt.get("pdf_path"):
            download_links.append(
                f'<a href="/api/attempts/{aid}/pdf" target="_blank" rel="noreferrer" '
                f'class="pill active" style="padding:5px 14px;font-size:0.85rem;">Download PDF</a>'
            )
        if aid and attempt.get("tex_path"):
            download_links.append(
                f'<a href="/api/attempts/{aid}/tex" target="_blank" rel="noreferrer" '
                f'class="pill" style="padding:5px 14px;font-size:0.85rem;">TeX</a>'
            )
        links_html = " ".join(download_links) if download_links else ""

        summary_html = ""
        summary_text = _load_summary_for_attempt(attempt)
        if summary_text:
            summary_html = (
                f'<blockquote style="margin:12px 0 0 0;padding:10px 14px;background:#fffdf8;'
                f'border-left:3px solid #3cb878;border-radius:0 8px 8px 0;'
                f'font-family:Georgia,serif;font-size:0.9rem;line-height:1.55;color:#2a2a2a;">'
                f'{html.escape(summary_text)}</blockquote>'
            )
        else:
            summary_html = '<p class="muted" style="margin:10px 0 0 0;font-size:0.85rem;">No AI summary for this attempt.</p>'

        flags = format_text(attempt.get("concern_flags") or "—")

        cards.append(f"""
        <div style="background:var(--panel-strong);border:1px solid var(--line);border-radius:14px;
                    padding:16px 18px;box-shadow:var(--shadow);margin-bottom:14px;">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px;">
            <div>
              {selected_badge}<span class="status {html.escape(status_cls)}" style="font-size:0.78rem;padding:2px 7px;">{html.escape(status)}</span>
              <span class="muted tiny" style="margin-left:8px;">ID {html.escape(str(aid or '?'))}</span>
              <span class="muted tiny" style="margin-left:8px;">{created}</span>
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;">{links_html}</div>
          </div>
          <div style="display:flex;gap:16px;flex-wrap:wrap;margin:10px 0 0 0;">
            <span class="muted tiny">Family: <strong>{family}</strong></span>
            <span class="muted tiny">Level: <strong>{level}</strong></span>
            <span class="muted tiny">Model: <strong>{model}</strong></span>
            <span class="muted tiny">Flags: <strong>{flags}</strong></span>
          </div>
          {summary_html}
        </div>
        """)

    return f"""
    <div class="panel">
      <h2>Resume history</h2>
      <p class="muted" style="margin-top:0;">Each card is one generation run. Click Download PDF to get that version. AI summaries are shown below each card — review only, not yet on the resume.</p>
      {"".join(cards)}
    </div>
    """


def render_resume_attempts(attempts, job_id=None):
    if not attempts:
        if not RESUME_TAILOR_AVAILABLE:
            return "<p>Resume tailoring is not deployed in this review container yet.</p>"
        return "<p>No resume attempts yet.</p>"
    rows = []
    for attempt in attempts:
        aid = attempt.get("id")
        jid = job_id or attempt.get("job_id")
        # Build artifact links for this specific attempt
        artifact_links = []
        if aid and jid:
            if attempt.get("pdf_path"):
                artifact_links.append(
                    f'<a href="/api/attempts/{aid}/pdf" target="_blank" rel="noreferrer" class="pill" style="padding:3px 8px;font-size:0.8rem;">PDF</a>'
                )
            if attempt.get("tex_path"):
                artifact_links.append(
                    f'<a href="/api/attempts/{aid}/tex" target="_blank" rel="noreferrer" class="pill" style="padding:3px 8px;font-size:0.8rem;">TeX</a>'
                )
            if attempt.get("keywords_path"):
                artifact_links.append(
                    f'<a href="/api/attempts/{aid}/keywords" target="_blank" rel="noreferrer" class="pill" style="padding:3px 8px;font-size:0.8rem;">Keywords</a>'
                )
            artifact_links.append(
                f'<a href="/api/attempts/{aid}/llm" target="_blank" rel="noreferrer" class="pill" style="padding:3px 8px;font-size:0.8rem;">LLM I/O</a>'
            )
        links_html = " ".join(artifact_links) if artifact_links else "—"

        selected_badge = ""
        if attempt.get("is_selected_for_c3"):
            selected_badge = ' <span class="status done" style="font-size:0.75rem;padding:2px 6px;">selected</span>'
        elif attempt.get("is_latest_useful"):
            selected_badge = ' <span class="status done_verified" style="font-size:0.75rem;padding:2px 6px;">useful</span>'

        jd_cell = _format_jd_usable_cell(attempt.get("jd_usable"))
        jd_note = format_text(attempt.get("jd_usable_reason")) if attempt.get("jd_usable_reason") else "—"

        rows.append(
            f"""
            <tr>
              <td>{format_text(aid)}{selected_badge}</td>
              <td>{format_text(attempt.get("status"))}</td>
              <td>{jd_cell}</td>
              <td style="max-width:220px;font-size:0.85rem;">{jd_note}</td>
              <td>{format_text(attempt.get("role_family"))}</td>
              <td>{format_text(attempt.get("job_level"))}</td>
              <td>{format_text(attempt.get("base_resume_name"))}</td>
              <td>{format_text(attempt.get("created_at"))}</td>
              <td style="white-space:nowrap;">{links_html}</td>
            </tr>
            """
        )
    return f"""
    <div class="table-wrap">
      <table>
        <thead><tr><th>ID</th><th>Status</th><th>JD OK</th><th>JD note</th><th>Family</th><th>Level</th><th>Base</th><th>Created</th><th>Files</th></tr></thead>
        <tbody>{"".join(rows)}</tbody>
      </table>
    </div>
    """


def render_status_toolbar(
    active_status,
    *,
    source,
    limit,
    q="",
    sort="date_scraped",
    direction="desc",
    tag="",
):
    pills = []
    for status in STATUS_OPTIONS:
        class_name = "pill active" if status == active_status else "pill"
        qs = build_jobs_query(
            source=source,
            status=status,
            limit=limit,
            page=1,
            q=q,
            sort=sort,
            direction=direction,
            tag=tag,
        )
        label = STATUS_FILTER_LABELS.get(status, status)
        pills.append(
            f'<a class="{class_name}" href="/jobs?{qs}" title="{html.escape(status)}">{html.escape(label)}</a>'
        )
    return "".join(pills)


def render_source_toolbar(
    active_source,
    *,
    status,
    limit,
    q="",
    sort="date_scraped",
    direction="desc",
    tag="",
):
    pills = []
    for source in SOURCE_OPTIONS:
        class_name = "pill active" if source == active_source else "pill"
        qs = build_jobs_query(
            source=source,
            status=status,
            limit=limit,
            page=1,
            q=q,
            sort=sort,
            direction=direction,
            tag=tag,
        )
        pills.append(
            f'<a class="{class_name}" href="/jobs?{qs}">{html.escape(source)}</a>'
        )
    return "".join(pills)


def render_search_bar(*, source, status, limit, q, sort, direction, tag=""):
    return f"""
    <form class="panel" method="get" action="/jobs" style="margin-bottom: 18px;">
      <p class="muted" style="margin:0 0 12px;">Filter the list below. Status chips are the same filters as the Status menu.</p>
      <div class="filter-form-grid">
        <div style="grid-column: span 2; min-width:min(100%, 280px);">
          <label class="label" for="q">Search</label>
          <input id="q" name="q" type="text" value="{
        html.escape(q)
    }" placeholder="company, title, description, or URL keyword" style="width:100%; box-sizing:border-box; border:1px solid var(--line); border-radius:12px; padding:10px 12px; background:#faf5ec;">
        </div>
        <div>
          <label class="label" for="tag">Tag</label>
          <input id="tag" name="tag" type="text" value="{
        html.escape(tag)
    }" placeholder="exact match on operator tag" style="width:100%; box-sizing:border-box; border:1px solid var(--line); border-radius:12px; padding:10px 12px; background:#faf5ec;">
        </div>
        <div>
          <label class="label" for="source">Source</label>
          <select id="source" name="source" style="width:100%; box-sizing:border-box; border:1px solid var(--line); border-radius:12px; padding:10px 12px; background:#faf5ec;">
            {
        "".join(
            f'<option value="{value}"{" selected" if source == value else ""}>{label}</option>'
            for value, label in (
                ("all", "All sources"),
                ("linkedin", "LinkedIn"),
                ("indeed", "Indeed"),
            )
        )
    }
          </select>
        </div>
        <div>
          <label class="label" for="status">Status</label>
          <select id="status" name="status" style="width:100%; box-sizing:border-box; border:1px solid var(--line); border-radius:12px; padding:10px 12px; background:#faf5ec;">
            {
        "".join(
            f'<option value="{value}"{" selected" if status == value else ""}>{label}</option>'
            for value, label in (
                ("all", "All statuses"),
                ("ready", "Ready"),
                ("pending", "Pending enrich"),
                ("processing", "Processing"),
                ("done", "Done"),
                ("done_verified", "Done verified"),
                ("failed", "Failed"),
                ("blocked", "Blocked"),
                ("blocked_verified", "Blocked verified"),
            )
        )
    }
          </select>
        </div>
        <div>
          <label class="label" for="sort">Sort</label>
          <select id="sort" name="sort" style="width:100%; box-sizing:border-box; border:1px solid var(--line); border-radius:12px; padding:10px 12px; background:#faf5ec;">
            {
        "".join(
            f'<option value="{value}"{" selected" if sort == value else ""}>{label}</option>'
            for value, label in (
                ("date_scraped", "Date scraped"),
                ("company", "Company"),
                ("title", "Title"),
                ("enrichment_status", "Enrichment"),
                ("apply_type", "Apply type"),
                ("enrichment_attempts", "Attempts"),
                ("next_enrichment_retry_at", "Next retry"),
                ("enriched_at", "Enriched at"),
                ("id", "ID"),
            )
        )
    }
          </select>
        </div>
        <div>
          <label class="label" for="direction">Direction</label>
          <select id="direction" name="direction" style="width:100%; box-sizing:border-box; border:1px solid var(--line); border-radius:12px; padding:10px 12px; background:#faf5ec;">
            <option value="desc"{" selected" if direction == "desc" else ""}>Desc</option>
            <option value="asc"{" selected" if direction == "asc" else ""}>Asc</option>
          </select>
        </div>
      </div>
      <input type="hidden" name="limit" value="{limit}">
      <div class="actions">
        <button type="submit">Apply filters</button>
        <a class="pill" href="/jobs?source=all&status=all&limit=50">Reset</a>
      </div>
    </form>
    """


def _sortable_link(
    label,
    column,
    *,
    source,
    status,
    limit,
    page,
    q,
    current_sort,
    current_direction,
    tag="",
):
    next_direction = "asc"
    if current_sort == column and current_direction == "asc":
        next_direction = "desc"
    arrow = ""
    if current_sort == column:
        arrow = " &uarr;" if current_direction == "asc" else " &darr;"
    qs = build_jobs_query(
        source=source,
        status=status,
        limit=limit,
        page=page,
        q=q,
        sort=column,
        direction=next_direction,
        tag=tag,
    )
    href = f"/jobs?{qs}"
    return f'<a href="{href}">{html.escape(label)}{arrow}</a>'


def render_jobs_bulk_panel(*, source, status, limit, page, q, sort, direction, tag=""):
    exp_csv = html.escape(
        build_jobs_query(
            source=source,
            status=status,
            limit=5000,
            page=1,
            q=q,
            sort=sort,
            direction=direction,
            tag=tag,
        )
    )
    return f"""
    <details class="jobs-advanced-panel">
      <summary>Advanced: requeue many rows by filters (not checkboxes)</summary>
      <div class="jobs-advanced-body">
        <p class="muted" style="margin-top:0;">Use this when you want every row that matches your <strong>current filters</strong> (source, status tab, search, tag), not only ticked rows. Choose which stored enrichment states to send back to <strong>Pending</strong>. Server caps batch size.</p>
        <div id="jobs-bulk-panel"
             data-source="{html.escape(source)}"
             data-status="{html.escape(status)}"
             data-q="{html.escape(q)}"
             data-tag="{html.escape(tag)}"
             data-sort="{html.escape(sort)}"
             data-direction="{html.escape(direction)}">
          <div style="display:flex; flex-wrap:wrap; gap:12px 18px; align-items:center; margin: 12px 0;">
            <label><input type="checkbox" class="jobs-bulk-status" value="failed" checked /> Failed</label>
            <label><input type="checkbox" class="jobs-bulk-status" value="processing" /> Processing</label>
            <label><input type="checkbox" class="jobs-bulk-status" value="pending" /> Pending enrichment</label>
            <label><input type="checkbox" class="jobs-bulk-status" value="blocked" /> Blocked</label>
            <label><input type="checkbox" class="jobs-bulk-status" value="blocked_verified" /> Blocked verified</label>
          </div>
          <div class="actions" style="flex-wrap:wrap;">
            <button type="button" class="pill secondary" id="jobs-bulk-dry-run">Count only (dry run)</button>
            <button type="button" class="pill active" id="jobs-bulk-run">Requeue matching rows</button>
            <span class="muted" id="jobs-bulk-result"></span>
          </div>
        </div>
        <p class="muted" style="margin-bottom:0;">
          <a class="pill" data-no-app-nav="true" href="/api/jobs/export?format=csv&amp;{exp_csv}">Download CSV</a>
          <a class="pill" data-no-app-nav="true" href="/api/jobs/export?format=json&amp;{exp_csv}">Download JSON</a>
          <span class="muted"> · Keyboard: <kbd>j</kbd> / <kbd>k</kbd> move, <kbd>Enter</kbd> opens row</span>
        </p>
      </div>
    </details>
    """


def render_jobs_selection_bar():
    opts = "".join(
        f'<option value="{html.escape(k)}">{html.escape(v)}</option>'
        for k, v in (
            ("pending", ENRICHMENT_STATUS_LABELS["pending"]),
            ("processing", ENRICHMENT_STATUS_LABELS["processing"]),
            ("failed", ENRICHMENT_STATUS_LABELS["failed"]),
            ("blocked", ENRICHMENT_STATUS_LABELS["blocked"]),
            ("blocked_verified", ENRICHMENT_STATUS_LABELS["blocked_verified"]),
            ("done", ENRICHMENT_STATUS_LABELS["done"]),
            ("done_verified", ENRICHMENT_STATUS_LABELS["done_verified"]),
        )
    )
    return f"""
    <div id="jobs-selection-bar" class="jobs-selection-bar is-hidden" role="region" aria-label="Bulk actions for selected jobs">
      <span id="jobs-selection-count" class="selection-count">0 selected</span>
      <label class="muted" style="display:flex; align-items:center; gap:8px;">
        Action
        <select id="jobs-selection-action" aria-label="Bulk action">
          <option value="">Choose…</option>
          <option value="requeue">Requeue for enrichment (LinkedIn / Indeed only)</option>
          <option value="set_status">Set enrichment status…</option>
          <option value="delete">Delete rows…</option>
        </select>
      </label>
      <label id="jobs-selection-status-wrap" class="muted is-hidden" style="align-items:center; gap:8px;">
        New status
        <select id="jobs-selection-status" aria-label="New enrichment status">{opts}</select>
      </label>
      <button type="button" class="pill active" id="jobs-selection-apply">Run action</button>
      <button type="button" class="pill secondary" id="jobs-selection-clear">Clear selection</button>
    </div>
    """


def render_jobs_table(rows, *, source, status, limit, page, q, sort, direction, return_to="", tag=""):
    if not rows:
        return '<div class="panel"><p>No jobs match this filter.</p></div>'

    body = []
    for row in rows:
        status_class = html.escape(row["enrichment_status"] or "unknown")
        job_link = add_return_to(f"/jobs/{row['id']}", return_to)
        linkedin_link = (
            f'<a class="mono" href="{html.escape(row["job_url"])}" target="_blank" rel="noreferrer">listing</a>'
            if row.get("job_url")
            else ""
        )
        apply_link = (
            f'<a class="mono" href="{html.escape(row["apply_url"])}" target="_blank" rel="noreferrer">apply</a>'
            if row.get("apply_url")
            else ""
        )
        pri = row.get("priority")
        pri_cell = (
            '<span class="badge-priority" title="This row is flagged “run next” for enrichment (set on the job page). Not a button.">Run next</span>'
            if pri
            else "—"
        )
        enrich_label = enrichment_status_display(row.get("enrichment_status"))
        notes_cell = format_text(truncate_text(row.get("operator_notes") or "", max_chars=40))
        tag_cell = format_text(row.get("operator_tag") or "")
        body.append(
            f"""
            <tr data-job-id="{row["id"]}">
              <td><input type="checkbox" class="jobs-row-check" value="{row["id"]}" aria-label="Select job {row["id"]}" /></td>
              <td><a href="{job_link}" data-app-nav="true">#{row["id"]}</a></td>
              <td>{pri_cell}</td>
              <td>{format_text(row["source"])}</td>
              <td>{format_text(row["company"])}</td>
              <td>{format_text(row["title"])}</td>
              <td class="link-cell">{linkedin_link}{" | " + apply_link if linkedin_link and apply_link else apply_link}</td>
              <td><span class="status {status_class}" title="Stored value: {html.escape(row.get('enrichment_status') or '')}">{format_text(enrich_label)}</span></td>
              <td>{format_text(row["apply_type"])}</td>
              <td>{format_text(row["enrichment_attempts"])}</td>
              <td class="mono">{format_text(row["next_enrichment_retry_at"])}</td>
              <td>{format_text(truncate_text(row["last_enrichment_error"]))}</td>
              <td class="muted">{notes_cell}</td>
              <td class="muted">{tag_cell}</td>
            </tr>
            """
        )

    return f"""
    <div class="table-wrap jobs-table-wrap">
      <table>
        <thead>
          <tr>
            <th scope="col"><input type="checkbox" id="jobs-select-all" aria-label="Select all rows on this page" /></th>
            <th scope="col">{_sortable_link("ID", "id", source=source, status=status, limit=limit, page=page, q=q, current_sort=sort, current_direction=direction, tag=tag)}</th>
            <th scope="col" title="Shows when this row is flagged to run before other enrichment work">Queue</th>
            <th scope="col">{_sortable_link("Source", "source", source=source, status=status, limit=limit, page=page, q=q, current_sort=sort, current_direction=direction, tag=tag)}</th>
            <th scope="col">{_sortable_link("Company", "company", source=source, status=status, limit=limit, page=page, q=q, current_sort=sort, current_direction=direction, tag=tag)}</th>
            <th scope="col">{_sortable_link("Title", "title", source=source, status=status, limit=limit, page=page, q=q, current_sort=sort, current_direction=direction, tag=tag)}</th>
            <th scope="col">Links</th>
            <th scope="col">{_sortable_link("Enrichment", "enrichment_status", source=source, status=status, limit=limit, page=page, q=q, current_sort=sort, current_direction=direction, tag=tag)}</th>
            <th scope="col">{_sortable_link("Apply type", "apply_type", source=source, status=status, limit=limit, page=page, q=q, current_sort=sort, current_direction=direction, tag=tag)}</th>
            <th scope="col">{_sortable_link("Attempts", "enrichment_attempts", source=source, status=status, limit=limit, page=page, q=q, current_sort=sort, current_direction=direction, tag=tag)}</th>
            <th scope="col">{_sortable_link("Next retry", "next_enrichment_retry_at", source=source, status=status, limit=limit, page=page, q=q, current_sort=sort, current_direction=direction, tag=tag)}</th>
            <th scope="col">{_sortable_link("Last error", "last_enrichment_error", source=source, status=status, limit=limit, page=page, q=q, current_sort=sort, current_direction=direction, tag=tag)}</th>
            <th scope="col">Note</th>
            <th scope="col">Tag</th>
          </tr>
        </thead>
        <tbody>
          {"".join(body)}
        </tbody>
      </table>
    </div>
    """


def render_pagination(*, total_rows, source, status, limit, page, q, sort, direction, tag=""):
    if total_rows <= limit:
        return ""

    total_pages = max(1, (total_rows + limit - 1) // limit)
    current_page = max(1, min(page, total_pages))

    links = []
    if current_page > 1:
        prev_page = current_page - 1
        qs = build_jobs_query(
            source=source,
            status=status,
            limit=limit,
            page=prev_page,
            q=q,
            sort=sort,
            direction=direction,
            tag=tag,
        )
        links.append(f'<a class="pill" href="/jobs?{qs}">Previous</a>')

    start_page = max(1, current_page - 2)
    end_page = min(total_pages, current_page + 2)
    for page_number in range(start_page, end_page + 1):
        class_name = "pill active" if page_number == current_page else "pill"
        qs = build_jobs_query(
            source=source,
            status=status,
            limit=limit,
            page=page_number,
            q=q,
            sort=sort,
            direction=direction,
            tag=tag,
        )
        links.append(f'<a class="{class_name}" href="/jobs?{qs}">{page_number}</a>')

    if current_page < total_pages:
        next_page = current_page + 1
        qs = build_jobs_query(
            source=source,
            status=status,
            limit=limit,
            page=next_page,
            q=q,
            sort=sort,
            direction=direction,
            tag=tag,
        )
        links.append(f'<a class="pill" href="/jobs?{qs}">Next</a>')

    return f"""
    <div class="toolbar" style="margin-top: 18px;">
      <span class="pill">Page {current_page} of {total_pages}</span>
      {"".join(links)}
    </div>
    """


def render_failure_breakdown(summary):
    if not summary["failure_counts"]:
        return "<p>No failed or blocked rows right now.</p>"
    items = "".join(
        f"<tr><td>{format_text(error_code)}</td><td>{count}</td></tr>"
        for error_code, count in summary["failure_counts"].items()
    )
    return f"""
    <div class="table-wrap">
      <table>
        <thead><tr><th>Error code</th><th>Count</th></tr></thead>
        <tbody>{items}</tbody>
      </table>
    </div>
    """


def _failure_count(summary, code):
    return int(summary.get("failure_counts", {}).get(code) or 0)


def render_ops_console(*, summary, last_updated: Optional[int] = None):
    auth_n = _failure_count(summary, "auth_expired")
    rate_n = _failure_count(summary, "rate_limited")
    banner = ""
    if last_updated is not None:
        banner = f"""
        <div class="panel" style="border-color: var(--good); background: var(--good-soft);">
          <p><strong>Done.</strong> Requeued <strong>{last_updated}</strong> failed row(s) back to <code>pending</code>.</p>
          <p class="muted">The next scheduled scrape or a manual enrichment run will pick them up.</p>
        </div>
        """
    return f"""
    {banner}
    <div class="panel">
      <h2>Transient failures : one-click requeue</h2>
      <p class="muted">Moves <strong>failed</strong> rows whose last error starts with <code>auth_expired:</code> or <code>rate_limited:</code> back to <strong>pending</strong> (clears retry timers and artifacts on those rows). Use after auth is fixed or a rate-limit window has passed.</p>
      <p>Current failed counts from summary : <strong>auth_expired</strong> {auth_n}, <strong>rate_limited</strong> {rate_n}.</p>
      <div class="actions" style="flex-wrap: wrap; gap: 10px;">
        <button type="button" class="pill active ops-requeue-btn" data-source="linkedin" data-codes="auth_expired,rate_limited">LinkedIn : both codes</button>
        <button type="button" class="pill ops-requeue-btn" data-source="linkedin" data-codes="auth_expired">LinkedIn : auth_expired only</button>
        <button type="button" class="pill ops-requeue-btn" data-source="linkedin" data-codes="rate_limited">LinkedIn : rate_limited only</button>
        <button type="button" class="pill ops-requeue-btn" data-source="indeed" data-codes="rate_limited">Indeed : rate_limited</button>
        <button type="button" class="pill ops-requeue-btn" data-source="all" data-codes="auth_expired,rate_limited">All sources : both codes</button>
      </div>
    </div>
    <div class="panel">
      <h2>Custom requeue (form, no JavaScript)</h2>
      <form method="post" action="/ops/requeue-errors" class="stack" style="gap: 12px;">
        <label>Source
          <select name="source">
            <option value="linkedin" selected>linkedin</option>
            <option value="indeed">indeed</option>
            <option value="all">all</option>
          </select>
        </label>
        <div>
          <div class="label">Error codes</div>
          <label><input type="checkbox" name="error_code" value="auth_expired" checked /> auth_expired</label>
          <label style="margin-left: 16px;"><input type="checkbox" name="error_code" value="rate_limited" checked /> rate_limited</label>
        </div>
        <button type="submit" class="pill active">Requeue matching rows</button>
      </form>
    </div>
    <div class="panel">
      <h2>Test and debug endpoints</h2>
      <p class="muted">Open in a new tab for raw machine output, or use the button to preview JSON in-page.</p>
      <div class="actions" style="flex-wrap: wrap; gap: 10px;">
        <a class="pill" href="/health" target="_blank" rel="noreferrer" data-no-app-nav="true">GET /health</a>
        <a class="pill" href="/api/summary" target="_blank" rel="noreferrer" data-no-app-nav="true">GET /api/summary</a>
        <a class="pill" href="/metrics" target="_blank" rel="noreferrer" data-no-app-nav="true">GET /metrics</a>
        <button type="button" class="pill" id="ops-fetch-summary">Fetch /api/summary (here)</button>
      </div>
      <pre id="ops-summary-preview" style="display:none; max-height: 320px; overflow: auto; margin-top: 12px; font-size: 0.85rem;"></pre>
    </div>
    <div class="panel">
      <h2>API : scripts and automation</h2>
      <p class="muted">POST JSON to <code>/api/ops/requeue-errors</code> with body <code>{{"source":"linkedin","error_codes":["auth_expired","rate_limited"]}}</code>.</p>
      <p class="muted">Bulk filters : <code>POST /api/ops/bulk-requeue</code> with <code>source</code>, <code>status</code> (review tab), <code>q</code>, <code>tag</code>, <code>target_statuses</code>, <code>dry_run</code>. Stale processing : <code>POST /api/ops/requeue-stale-processing</code>.</p>
      <p class="muted">When <code>REVIEW_OPS_TOKEN</code> is set, send header <code>X-Review-Ops-Token</code> or <code>Authorization: Bearer …</code> on those POSTs (forms pick it up automatically in this UI).</p>
      <p class="muted">CLI equivalent : <code>python3 scripts/hunterctl.py requeue-retryable</code> or <code>requeue-errors --error-code …</code> from the Hunt repo with <code>HUNT_DB_PATH</code> set.</p>
    </div>
    <div class="panel">
      <h2>Stale processing reset</h2>
      <p class="muted">Same maintenance rule as DB init : old <code>processing</code> claims go back to <code>pending</code>.</p>
      <div class="actions" style="flex-wrap:wrap;">
        <button type="button" class="pill active" id="ops-stale-reset">Requeue stale processing</button>
        <span class="muted" id="ops-stale-result"></span>
      </div>
    </div>
    """


def _parse_ops_requeue_payload(payload: dict):
    source = payload.get("source") or "linkedin"
    if source not in SOURCE_OPTIONS:
        raise HTTPException(status_code=400, detail=f"Unsupported source: {source}")
    raw_codes = payload.get("error_codes")
    if not isinstance(raw_codes, list) or not raw_codes:
        raise HTTPException(status_code=400, detail="error_codes must be a non-empty list.")
    codes = [c for c in raw_codes if isinstance(c, str) and c in OPS_ALLOWED_ERROR_CODES]
    if not codes:
        raise HTTPException(
            status_code=400,
            detail=f"error_codes must include at least one of: {', '.join(sorted(OPS_ALLOWED_ERROR_CODES))}",
        )
    return source, codes


def _parse_bulk_requeue_payload(payload: dict):
    raw_source = payload.get("source")
    if raw_source in (None, "", "all"):
        source = None
    elif raw_source in ("linkedin", "indeed"):
        source = raw_source
    else:
        raise HTTPException(status_code=400, detail=f"Unsupported source: {raw_source}")
    status = payload.get("status") or "all"
    if status not in STATUS_OPTIONS:
        raise HTTPException(status_code=400, detail=f"Unsupported status filter: {status}")
    q = payload.get("q")
    if q is not None and not isinstance(q, str):
        raise HTTPException(status_code=400, detail="q must be a string when provided.")
    tag = payload.get("tag")
    if tag is not None and not isinstance(tag, str):
        raise HTTPException(status_code=400, detail="tag must be a string when provided.")
    dry_run = bool(payload.get("dry_run"))
    raw_targets = payload.get("target_statuses")
    if not isinstance(raw_targets, list) or not raw_targets:
        raise HTTPException(status_code=400, detail="target_statuses must be a non-empty list.")
    targets = [t for t in raw_targets if isinstance(t, str) and t in BULK_REQUEUE_STATUS_CHOICES]
    if not targets:
        raise HTTPException(
            status_code=400,
            detail=f"target_statuses must contain at least one of: {', '.join(sorted(BULK_REQUEUE_STATUS_CHOICES))}",
        )
    return source, status, (q or ""), ((tag or "").strip() or None), tuple(targets), dry_run


def render_summary_table(summary):
    rows = [
        ("Total rows", summary["total"]),
        ("Pending enrich", summary["pending_count"]),
        ("Retry due", summary["retry_ready_count"]),
        ("Processing", summary["processing_count"]),
        ("Blocked", summary["blocked_count"]),
        ("Stale processing", summary["stale_processing_count"]),
        ("Oldest processing", summary["oldest_processing_started_at"]),
    ]
    status_rows = "".join(
        f"<tr><td>{format_text(status)}</td><td>{count}</td></tr>"
        for status, count in sorted(summary["counts_by_status"].items())
    )
    source_rows = "".join(
        f"<tr><td>{format_text(source)}</td><td>{count}</td></tr>"
        for source, count in sorted(summary["source_counts"].items())
    )
    main_rows = "".join(
        f"<tr><td>{format_text(label)}</td><td>{format_text(value)}</td></tr>"
        for label, value in rows
    )
    return f"""
    <div class="grid">
      <div class="panel">
        <h2>Queue summary</h2>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Metric</th><th>Value</th></tr></thead>
            <tbody>{main_rows}</tbody>
          </table>
        </div>
      </div>
      <div class="panel">
        <h2>Counts by status</h2>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Status</th><th>Count</th></tr></thead>
            <tbody>{status_rows}</tbody>
          </table>
        </div>
      </div>
      <div class="panel">
        <h2>Counts by source</h2>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Source</th><th>Count</th></tr></thead>
            <tbody>{source_rows}</tbody>
          </table>
        </div>
      </div>
    </div>
    """


def render_link_list(title, rows, *, return_to=""):
    if not rows:
        return f'<div class="panel"><h2>{html.escape(title)}</h2><p>No rows.</p></div>'
    items = "".join(
        f"""
        <tr>
          <td><a href="{add_return_to(f"/jobs/{row['id']}", return_to)}" data-app-nav="true">#{row["id"]}</a></td>
          <td>{format_text(row["company"])}</td>
          <td>{format_text(truncate_text(row["title"], max_chars=80))}</td>
          <td>{format_text(row["enrichment_status"])}</td>
        </tr>
        """
        for row in rows
    )
    return f"""
    <div class="panel">
      <h2>{html.escape(title)}</h2>
      <div class="table-wrap">
        <table>
          <thead><tr><th>ID</th><th>Company</th><th>Title</th><th>Status</th></tr></thead>
          <tbody>{items}</tbody>
        </table>
      </div>
    </div>
    """


# ---------------------------------------------------------------------------
# Auth routes
# ---------------------------------------------------------------------------

def _session_username(request: Request) -> str | None:
    """Extract and validate the session cookie from a request."""
    token = request.cookies.get(SESSION_COOKIE_NAME, "")
    return validate_session(token)


def require_auth(request: Request) -> str:
    """FastAPI dependency — returns username or raises 401."""
    username = _session_username(request)
    if not username:
        raise HTTPException(status_code=401, detail="Not authenticated.")
    return username


def _service_headers() -> dict[str, str]:
    if HUNT_SERVICE_TOKEN:
        return {"Authorization": f"Bearer {HUNT_SERVICE_TOKEN}"}
    return {}


def _has_valid_service_token(request: Request) -> bool:
    if not HUNT_SERVICE_TOKEN:
        return True
    auth = request.headers.get("authorization") or ""
    return auth.lower().startswith("bearer ") and auth[7:].strip() == HUNT_SERVICE_TOKEN


def require_session_or_service_token(request: Request) -> str:
    username = _session_username(request)
    if username:
        return username
    if _has_valid_service_token(request):
        return "service"
    raise HTTPException(status_code=401, detail="Not authenticated.")


def _bool_value(value) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    if isinstance(value, (int, float)):
        return bool(value)
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def _component_allowed(component: str) -> str:
    clean = (component or "").strip().lower()
    if clean not in {"c0", "c1", "c2", "c3", "c4"}:
        raise HTTPException(status_code=400, detail="component must be one of c0, c1, c2, c3, c4.")
    return clean


def _setting_row(row) -> dict:
    secret = _bool_value(row["secret"])
    raw_value = row["value"]
    return {
        "component": row["component"],
        "key": row["key"],
        "value": None if secret else raw_value,
        "value_type": row["value_type"],
        "secret": secret,
        "has_value": raw_value not in (None, ""),
        "updated_at": row["updated_at"],
        "updated_by": row["updated_by"],
    }


def _account_row(row) -> dict:
    return {
        "id": row["id"],
        "username": row["username"],
        "display_name": row["display_name"],
        "active": _bool_value(row["active"]),
        "auth_state": row["auth_state"],
        "last_auth_check": row["last_auth_check"],
        "last_auth_error": row["last_auth_error"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "has_password": row["password_encrypted"] not in (None, ""),
    }


def _check_component(name: str, url: str, *, path: str = "/status") -> dict:
    full_url = f"{url.rstrip('/')}{path}"
    try:
        with httpx.Client(timeout=4) as client:
            resp = client.get(full_url, headers=_service_headers())
        try:
            body = resp.json()
        except Exception:
            body = {"detail": resp.text[:240]}
        return {
            "component": name,
            "status": "ok" if 200 <= resp.status_code < 300 else "error",
            "status_code": resp.status_code,
            "url": full_url,
            "detail": body,
        }
    except httpx.HTTPError as exc:
        return {
            "component": name,
            "status": "unreachable",
            "status_code": None,
            "url": full_url,
            "detail": str(exc),
        }


def _check_db() -> dict:
    try:
        conn = get_connection()
        try:
            conn.execute("SELECT 1")
        finally:
            conn.close()
        return {"status": "ok"}
    except Exception as exc:
        return {"status": "error", "detail": str(exc)}


async def _read_login_payload(request: Request) -> dict[str, str]:
    """Read login payload without requiring python-multipart in local dev venvs."""
    content_type = (request.headers.get("content-type") or "").lower()
    raw = await request.body()
    if content_type.startswith("application/json"):
        try:
            parsed = json.loads(raw.decode("utf-8") or "{}")
        except json.JSONDecodeError:
            raise HTTPException(status_code=400, detail="Invalid login JSON.")
        return {
            "username": str(parsed.get("username") or ""),
            "password": str(parsed.get("password") or ""),
        }
    parsed = parse_qs(raw.decode("utf-8"), keep_blank_values=True)
    return {
        "username": parsed.get("username", [""])[0],
        "password": parsed.get("password", [""])[0],
    }


@app.post("/auth/login")
async def auth_login(request: Request, response: Response):
    """Accept form-encoded username+password, set session cookie on success."""
    body = await _read_login_payload(request)
    username = str(body.get("username") or "").strip()
    password = str(body.get("password") or "")
    if not check_credentials(username, password):
        raise HTTPException(status_code=401, detail="Invalid username or password.")
    token = create_session(username)
    result = JSONResponse({"status": "ok", "username": username})
    result.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=token,
        httponly=True,
        samesite="lax",
        max_age=60 * 60 * 24 * 7,
        secure=False,  # set True behind HTTPS in production
    )
    return result


@app.post("/auth/logout")
def auth_logout(request: Request, response: Response):
    """Delete the session cookie and invalidate the server-side token."""
    token = request.cookies.get(SESSION_COOKIE_NAME, "")
    if token:
        delete_session(token)
    result = JSONResponse({"status": "ok"})
    result.delete_cookie(SESSION_COOKIE_NAME)
    return result


@app.get("/auth/me")
def auth_me(request: Request):
    """Return current auth status — used by SPA on startup."""
    username = _session_username(request)
    return JSONResponse({"authenticated": bool(username), "username": username})


# ---------------------------------------------------------------------------
# New JSON API endpoints consumed by the React SPA
# ---------------------------------------------------------------------------

@app.get("/api/jobs/count")
def api_jobs_count(
    source: str = "all",
    status: str = "all",
    q: str = "",
    tag: str = "",
    _auth: str = Depends(require_auth),
):
    """Return total row count for current filter — used for pagination."""
    if source not in SOURCE_OPTIONS:
        raise HTTPException(status_code=400, detail=f"Unsupported source filter: {source}")
    if status not in STATUS_OPTIONS:
        raise HTTPException(status_code=400, detail=f"Unsupported status filter: {status}")
    source_filter = None if source == "all" else source
    tag_clean = (tag or "").strip() or None
    total = count_jobs_for_review(
        status=status, query=q, source=source_filter, operator_tag=tag_clean
    )
    return JSONResponse({"count": total})


@app.get("/api/logs")
def api_logs(_auth: str = Depends(require_auth)):
    """Return everything the Logs page needs in one call."""
    summary = get_review_queue_summary()
    activity = get_review_activity_summary(hours=24)
    runtime_state = list_runtime_state_recent(limit=60)
    audit = get_review_audit_entries(limit=25)
    return JSONResponse({
        "summary": summary,
        "activity": activity,
        "runtime_state": runtime_state,
        "audit": audit,
    })


@app.get("/api/jobs/{job_id}/attempts")
def api_job_attempts(job_id: int, _auth: str = Depends(require_auth)):
    """Return resume attempts for a job (from fletcher DB if available)."""
    attempts = list_resume_attempts(job_id, limit=8)
    return JSONResponse(attempts)


@app.get("/api/settings")
def api_settings(component: str | None = None, _auth: str = Depends(require_auth)):
    """List component settings. Secret values are redacted but presence is shown."""
    params: list = []
    where = ""
    if component:
        where = "WHERE component = ?"
        params.append(_component_allowed(component))
    conn = get_connection()
    try:
        rows = conn.execute(
            f"""
            SELECT component, key, value, value_type, secret, updated_at, updated_by
            FROM component_settings
            {where}
            ORDER BY component ASC, key ASC
            """,
            params,
        ).fetchall()
    finally:
        conn.close()
    return JSONResponse({"settings": [_setting_row(row) for row in rows]})


@app.post("/api/settings")
def api_settings_upsert(payload: dict = Body(...), _auth: str = Depends(require_auth)):
    """Create or update one component setting."""
    component = _component_allowed(str(payload.get("component") or ""))
    key = str(payload.get("key") or "").strip()
    if not key:
        raise HTTPException(status_code=400, detail="key is required.")
    value_type = str(payload.get("value_type") or "string").strip() or "string"
    secret = bool(payload.get("secret"))
    value = payload.get("value")
    updated_by = _auth
    conn = get_connection()
    try:
        conn.execute(
            """
            INSERT INTO component_settings (component, key, value, value_type, secret, updated_at, updated_by)
            VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)
            ON CONFLICT(component, key) DO UPDATE SET
                value = excluded.value,
                value_type = excluded.value_type,
                secret = excluded.secret,
                updated_at = CURRENT_TIMESTAMP,
                updated_by = excluded.updated_by
            """,
            (component, key, value, value_type, secret, updated_by),
        )
        conn.commit()
        row = conn.execute(
            """
            SELECT component, key, value, value_type, secret, updated_at, updated_by
            FROM component_settings
            WHERE component = ? AND key = ?
            """,
            (component, key),
        ).fetchone()
    finally:
        conn.close()
    try:
        append_review_audit_entry("setting_upsert", {"component": component, "key": key, "secret": secret})
    except Exception:
        pass
    return JSONResponse({"setting": _setting_row(row)})


@app.get("/api/linkedin/accounts")
def api_linkedin_accounts(_auth: str = Depends(require_auth)):
    conn = get_connection()
    try:
        rows = conn.execute(
            """
            SELECT id, username, password_encrypted, display_name, active, auth_state,
                   last_auth_check, last_auth_error, created_at, updated_at
            FROM linkedin_accounts
            ORDER BY active DESC, id ASC
            """
        ).fetchall()
    finally:
        conn.close()
    return JSONResponse({"accounts": [_account_row(row) for row in rows]})


@app.post("/api/linkedin/accounts")
def api_linkedin_accounts_upsert(payload: dict = Body(...), _auth: str = Depends(require_auth)):
    username = str(payload.get("username") or "").strip()
    if not username:
        raise HTTPException(status_code=400, detail="username is required.")
    display_name = str(payload.get("display_name") or "").strip() or None
    active = bool(payload.get("active", True))
    auth_state = str(payload.get("auth_state") or "unknown").strip() or "unknown"
    account_id = payload.get("id")
    conn = get_connection()
    try:
        if account_id:
            conn.execute(
                """
                UPDATE linkedin_accounts
                SET username = ?, display_name = ?, active = ?, auth_state = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (username, display_name, active, auth_state, int(account_id)),
            )
        else:
            conn.execute(
                """
                INSERT INTO linkedin_accounts (username, display_name, active, auth_state, updated_at)
                VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(username) DO UPDATE SET
                    display_name = excluded.display_name,
                    active = excluded.active,
                    auth_state = excluded.auth_state,
                    updated_at = CURRENT_TIMESTAMP
                """,
                (username, display_name, active, auth_state),
            )
        conn.commit()
        row = conn.execute(
            """
            SELECT id, username, password_encrypted, display_name, active, auth_state,
                   last_auth_check, last_auth_error, created_at, updated_at
            FROM linkedin_accounts
            WHERE username = ?
            """,
            (username,),
        ).fetchone()
    finally:
        conn.close()
    try:
        append_review_audit_entry("linkedin_account_upsert", {"username": username, "active": active})
    except Exception:
        pass
    return JSONResponse({"account": _account_row(row)})


@app.get("/api/system/status")
def api_system_status(_auth: str = Depends(require_auth)):
    """Return C0 operator health: DB plus component services as seen from C0."""
    c1 = _check_component("c1", HUNT_HUNTER_URL)
    c2 = _check_component("c2", HUNT_FLETCHER_URL)
    c4 = _check_component("c4", HUNT_COORDINATOR_URL)
    c3_bridge = _check_component("c3", HUNT_COORDINATOR_URL, path="/c3/pending-fills")
    pending_fills = None
    detail = c3_bridge.get("detail")
    if isinstance(detail, dict) and isinstance(detail.get("fills"), list):
        pending_fills = len(detail["fills"])
    c3 = {
        "component": "c3",
        "status": c3_bridge["status"],
        "status_code": c3_bridge["status_code"],
        "pending_fills": pending_fills,
        "detail": c3_bridge["detail"],
    }
    return JSONResponse(
        {
            "status": "ok",
            "db": _check_db(),
            "components": {
                "c1": c1,
                "c2": c2,
                "c3": c3,
                "c4": c4,
            },
        }
    )


@app.get("/api/c3/pending-fills")
async def api_c3_pending_fills(_auth: str = Depends(require_session_or_service_token)):
    from backend.gateway import _proxy_get

    return await _proxy_get(f"{HUNT_COORDINATOR_URL}/c3/pending-fills")


@app.post("/api/c3/fill-result")
async def api_c3_fill_result(request: Request, _auth: str = Depends(require_session_or_service_token)):
    from backend.gateway import _proxy_post

    body = await request.json()
    return await _proxy_post(f"{HUNT_COORDINATOR_URL}/c3/fill-result", body)


# ---------------------------------------------------------------------------
# Health (unauthenticated — for monitoring scripts)
# ---------------------------------------------------------------------------

@app.get("/health")
def health():
    summary = get_review_queue_summary()
    return {
        "status": "ok",
        "queue": summary,
    }


@app.get("/api/summary")
def api_summary(_auth: str = Depends(require_auth)):
    return JSONResponse(get_review_queue_summary())


@app.get("/metrics")
def metrics():
    return PlainTextResponse(
        render_metrics(get_review_queue_summary()), media_type="text/plain; version=0.0.4"
    )


def render_activity_stats_panel():
    stats = get_review_activity_summary(hours=24)
    return f"""
    <div class="panel">
      <h2>Activity (last {stats["hours"]}h, approximate)</h2>
      <p class="muted">Done counts use <code>enriched_at</code>. Failed-in-window uses <code>date_scraped</code> as a proxy when precise failure time is not stored.</p>
      <div class="table-wrap">
        <table>
          <tbody>
            <tr><td>Done or verified</td><td>{stats["done_or_verified"]}</td></tr>
            <tr><td>Failed rows (scraped in window)</td><td>{stats["failed_scraped_window"]}</td></tr>
            <tr><td>Rows scraped in window</td><td>{stats["rows_scraped_window"]}</td></tr>
          </tbody>
        </table>
      </div>
    </div>
    """


def render_runtime_state_timeline_panel():
    rows = list_runtime_state_recent(limit=60)
    if not rows:
        return '<div class="panel"><h2>Runtime state (recent)</h2><p>No rows.</p></div>'
    body = []
    for row in rows:
        val = row.get("value") or ""
        if len(val) > 200:
            val = val[:197] + "..."
        body.append(
            f"<tr><td class=\"mono\">{format_text(row.get('key'))}</td>"
            f"<td class=\"mono\">{format_text(row.get('updated_at'))}</td>"
            f"<td><pre>{format_text(val)}</pre></td></tr>"
        )
    return f"""
    <div class="panel">
      <h2>Runtime state (recent)</h2>
      <p class="muted">Latest keys from the <code>runtime_state</code> table (includes LinkedIn auth markers, rate-limit flags, and review audit tail).</p>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Key</th><th>Updated</th><th>Value (trimmed)</th></tr></thead>
          <tbody>{"".join(body)}</tbody>
        </table>
      </div>
    </div>
    """


def render_review_audit_panel():
    entries = get_review_audit_entries(limit=25)
    if not entries:
        return '<div class="panel"><h2>Review audit (recent)</h2><p>No audit entries yet. Destructive API actions append here when enabled.</p></div>'
    lines = []
    for entry in entries:
        detail = entry.get("detail")
        detail_s = json.dumps(detail, ensure_ascii=False) if detail is not None else ""
        lines.append(
            f"<tr><td class=\"mono\">{format_text(entry.get('at'))}</td>"
            f"<td>{format_text(entry.get('action'))}</td>"
            f"<td><pre>{format_text(detail_s)}</pre></td></tr>"
        )
    return f"""
    <div class="panel">
      <h2>Review audit (recent)</h2>
      <p class="muted">Last writes from the control plane (bulk requeue, stale reset, etc.).</p>
      <div class="table-wrap">
        <table>
          <thead><tr><th>At</th><th>Action</th><th>Detail</th></tr></thead>
          <tbody>{"".join(lines)}</tbody>
        </table>
      </div>
    </div>
    """


def render_systemd_help_panel():
    return """
    <div class="panel">
      <h2>systemd and journalctl (host)</h2>
      <p class="muted">Replace unit names with whatever you use on the server. These are typical patterns for inspecting Hunt-related services.</p>
      <pre style="white-space: pre-wrap;"># Follow logs for a service
sudo journalctl -u hunt-review.service -f

# Last 200 lines since boot
sudo journalctl -u hunt-c1-enrichment.service -n 200 --no-pager

# Errors since yesterday
sudo journalctl -u hunt-review.service --since yesterday -p err --no-pager

# Timer-triggered jobs (if using .timer units)
systemctl list-timers | grep -i hunt
</pre>
    </div>
    """


@app.get("/legacy/health-view", response_class=HTMLResponse)
def health_view():
    summary = get_review_queue_summary()
    body = f"""
    <section class="hero">
      <h1>Queue &amp; health</h1>
      <p>LinkedIn auth, runtime events, full counts by status and source, and enrichment failure codes. The <a href="/" data-app-nav="true">Overview</a> page only shows shortcuts and sample rows : use this page when you need the complete picture.</p>
    </section>
    <section class="stack">
      {render_auth_status(summary)}
      {render_summary_table(summary)}
      {render_activity_stats_panel()}
      <div class="panel">
        <h2>Failure breakdown</h2>
        {render_failure_breakdown(summary)}
      </div>
      {render_runtime_state_timeline_panel()}
      {render_review_audit_panel()}
      {render_systemd_help_panel()}
      {render_monitoring_endpoints_panel()}
    </section>
    """
    return HTMLResponse(render_layout("Queue & health", body, current_path="/health-view"))


@app.get("/legacy/summary")
def summary_redirect():
    """Legacy path : merged into Queue & health."""
    return RedirectResponse(url="/legacy/health-view", status_code=307)


@app.get("/legacy/ops", response_class=HTMLResponse)
def ops_console(updated: Optional[int] = Query(default=None, ge=0)):
    summary = get_review_queue_summary()
    body = f"""
    <section class="hero">
      <h1>Operator console</h1>
      <p>Bulk requeue for common transient enrichment failures, quick links to raw JSON and metrics, and the same POST API the CLI uses. Intended as the primary C1 control surface alongside job browse.</p>
    </section>
    <section class="stack">
      {render_ops_console(summary=summary, last_updated=updated)}
    </section>
    """
    return HTMLResponse(render_layout("Hunt ops", body, current_path="/ops"))


@app.post("/api/ops/requeue-errors", dependencies=[Depends(review_ops_dependency)])
def api_ops_requeue_errors(payload: dict = Body(...)):
    source, codes = _parse_ops_requeue_payload(payload)
    updated = requeue_enrichment_rows_by_error_codes(source=source, error_codes=codes)
    try:
        append_review_audit_entry(
            "ops_requeue_errors",
            {"updated": updated, "source": source, "error_codes": list(codes)},
        )
    except Exception:
        pass
    return JSONResponse(
        {"status": "ok", "updated": updated, "source": source, "error_codes": codes}
    )


@app.post("/api/ops/bulk-requeue", dependencies=[Depends(review_ops_dependency)])
def api_ops_bulk_requeue(payload: dict = Body(...)):
    source, status, q, tag, targets, dry_run = _parse_bulk_requeue_payload(payload)
    count = bulk_requeue_jobs_matching_review_filters(
        status=status,
        source=source,
        query=q,
        operator_tag=tag,
        target_statuses=targets,
        dry_run=dry_run,
    )
    if dry_run:
        return JSONResponse({"status": "ok", "dry_run": True, "count": count})
    try:
        append_review_audit_entry(
            "bulk_requeue",
            {
                "updated": count,
                "source": source,
                "status": status,
                "target_statuses": list(targets),
            },
        )
    except Exception:
        pass
    return JSONResponse({"status": "ok", "dry_run": False, "updated": count})


@app.post("/api/ops/requeue-stale-processing", dependencies=[Depends(review_ops_dependency)])
def api_ops_requeue_stale_processing():
    updated = manual_requeue_stale_processing_rows()
    try:
        append_review_audit_entry("requeue_stale_processing", {"updated": updated})
    except Exception:
        pass
    return JSONResponse({"status": "ok", "updated": updated})


@app.post("/legacy/ops/requeue-errors")
async def ops_requeue_errors_form(request: Request):
    form = await request.form()
    assert_review_ops_allowed(request, str(form.get("ops_token") or ""))
    source = str(form.get("source") or "linkedin")
    if source not in SOURCE_OPTIONS:
        raise HTTPException(status_code=400, detail=f"Unsupported source: {source}")
    raw_list = form.getlist("error_code")
    codes = [str(c) for c in raw_list if str(c) in OPS_ALLOWED_ERROR_CODES]
    if not codes:
        raise HTTPException(
            status_code=400,
            detail="Select at least one of auth_expired or rate_limited.",
        )
    updated = requeue_enrichment_rows_by_error_codes(source=source, error_codes=codes)
    try:
        append_review_audit_entry(
            "ops_requeue_errors_form",
            {"updated": updated, "source": source, "error_codes": codes},
        )
    except Exception:
        pass
    return RedirectResponse(url=f"/legacy/ops?updated={updated}", status_code=303)


@app.get("/api/jobs")
def api_jobs(
    source: str = "all",
    status: str = "all",
    limit: int = 50,
    page: int = 1,
    include_description: bool = False,
    q: str = "",
    tag: str = "",
    sort: str = "date_scraped",
    direction: str = "desc",
    _auth: str = Depends(require_auth),
):
    if source not in SOURCE_OPTIONS:
        raise HTTPException(status_code=400, detail=f"Unsupported source filter: {source}")
    if status not in STATUS_OPTIONS:
        raise HTTPException(status_code=400, detail=f"Unsupported status filter: {status}")
    safe_limit = max(1, min(limit, 250))
    safe_page = max(1, page)
    tag_clean = (tag or "").strip() or None
    rows = list_jobs_for_review(
        status=status,
        limit=safe_limit,
        offset=(safe_page - 1) * safe_limit,
        include_description=include_description,
        query=q,
        sort=sort,
        direction=direction,
        source=None if source == "all" else source,
        operator_tag=tag_clean,
    )
    return JSONResponse(rows)


@app.get("/api/jobs/export")
def api_jobs_export(
    export_format: str = Query("csv", alias="format"),
    source: str = "all",
    status: str = "all",
    limit: int = 5000,
    page: int = 1,
    q: str = "",
    tag: str = "",
    sort: str = "date_scraped",
    direction: str = "desc",
    _auth: str = Depends(require_auth),
):
    if export_format not in ("csv", "json"):
        raise HTTPException(status_code=400, detail="format must be csv or json.")
    if source not in SOURCE_OPTIONS:
        raise HTTPException(status_code=400, detail=f"Unsupported source filter: {source}")
    if status not in STATUS_OPTIONS:
        raise HTTPException(status_code=400, detail=f"Unsupported status filter: {status}")
    safe_limit = max(1, min(limit, 5000))
    safe_page = max(1, page)
    tag_clean = (tag or "").strip() or None
    rows = list_jobs_for_review(
        status=status,
        limit=safe_limit,
        offset=(safe_page - 1) * safe_limit,
        include_description=True,
        query=q,
        sort=sort,
        direction=direction,
        source=None if source == "all" else source,
        operator_tag=tag_clean,
    )
    if export_format == "json":
        return JSONResponse(rows)
    if not rows:
        return PlainTextResponse("", media_type="text/csv; charset=utf-8")
    columns = list(rows[0].keys())
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=columns, extrasaction="ignore")
    writer.writeheader()
    writer.writerows(rows)
    data = buf.getvalue()
    return PlainTextResponse(
        data,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="hunt-jobs-export.csv"'},
    )


@app.get("/api/jobs/{job_id}")
def api_job(job_id: int, _auth: str = Depends(require_auth)):
    row = get_job_by_id(job_id)
    if not row:
        raise HTTPException(status_code=404, detail="Job not found.")
    return JSONResponse(row)


@app.get("/api/jobs/{job_id}/artifacts/{artifact_kind}")
def api_job_artifact(job_id: int, artifact_kind: str, _auth: str = Depends(require_auth)):
    row = get_job_by_id(job_id)
    if not row:
        raise HTTPException(status_code=404, detail="Job not found.")

    field_map = {
        "screenshot": ("last_artifact_screenshot_path", "image/png"),
        "html": ("last_artifact_html_path", "text/html; charset=utf-8"),
        "text": ("last_artifact_text_path", "text/plain; charset=utf-8"),
    }
    artifact_info = field_map.get(artifact_kind)
    if artifact_info is None:
        raise HTTPException(status_code=400, detail="Unsupported artifact kind.")

    relative_path, media_type = artifact_info
    artifact_path = resolve_artifact_path(row.get(relative_path))
    if artifact_path is None or not artifact_path.exists():
        raise HTTPException(status_code=404, detail="Artifact not found.")
    return FileResponse(artifact_path, media_type=media_type)


@app.get("/api/jobs/{job_id}/resume/{artifact_kind}")
def api_job_resume_artifact(job_id: int, artifact_kind: str, _auth: str = Depends(require_auth)):
    row = get_job_by_id(job_id)
    if not row:
        raise HTTPException(status_code=404, detail="Job not found.")

    field_map = {
        "selected-pdf": ("selected_resume_pdf_path", "application/pdf"),
        "selected-tex": ("selected_resume_tex_path", "application/x-tex"),
        "latest-pdf": ("latest_resume_pdf_path", "application/pdf"),
        "latest-tex": ("latest_resume_tex_path", "application/x-tex"),
        "keywords": ("latest_resume_keywords_path", "application/json"),
        "job-description": ("latest_resume_job_description_path", "text/plain; charset=utf-8"),
    }
    artifact_info = field_map.get(artifact_kind)
    if artifact_info is None:
        raise HTTPException(status_code=400, detail="Unsupported resume artifact kind.")

    relative_path, media_type = artifact_info
    artifact_path = resolve_resume_path(row.get(relative_path))
    if artifact_path is None or not artifact_path.exists():
        raise HTTPException(status_code=404, detail="Resume artifact not found.")
    return FileResponse(artifact_path, media_type=media_type)


@app.get("/api/attempts/{attempt_id}/pdf")
def api_attempt_pdf(attempt_id: int, _auth: str = Depends(require_auth)):
    return _serve_attempt_artifact(attempt_id, "pdf_path", "application/pdf")


@app.get("/api/attempts/{attempt_id}/tex")
def api_attempt_tex(attempt_id: int, _auth: str = Depends(require_auth)):
    return _serve_attempt_artifact(attempt_id, "tex_path", "text/plain; charset=utf-8")


@app.get("/api/attempts/{attempt_id}/keywords")
def api_attempt_keywords(attempt_id: int, _auth: str = Depends(require_auth)):
    return _serve_attempt_artifact(attempt_id, "keywords_path", "application/json")


@app.get("/api/attempts/{attempt_id}/llm", response_class=HTMLResponse)
def api_attempt_llm(attempt_id: int, _auth: str = Depends(require_auth)):
    """Render an HTML page showing the Ollama prompt and response for this attempt."""
    attempt = _get_attempt_row(attempt_id)
    if not attempt:
        raise HTTPException(status_code=404, detail="Attempt not found.")

    attempt_dir = _attempt_dir_from_row(attempt)
    if not attempt_dir:
        raise HTTPException(status_code=404, detail="Attempt directory not found.")

    enrichment_path = attempt_dir / "llm_enrichment.json"
    prompt_path = attempt_dir / "ollama_prompt.txt"
    response_path = attempt_dir / "ollama_response.txt"

    enrichment = {}
    if enrichment_path.exists():
        try:
            enrichment = json.loads(enrichment_path.read_text(encoding="utf-8"))
        except Exception:
            pass

    prompt_text = ""
    if prompt_path.exists():
        try:
            prompt_text = prompt_path.read_text(encoding="utf-8")
        except Exception:
            pass

    response_text = ""
    if response_path.exists():
        try:
            response_text = response_path.read_text(encoding="utf-8")
        except Exception:
            pass

    job_id = attempt.get("job_id")
    back_link = f"/jobs/{job_id}" if job_id else "/jobs"

    meta_rows = ""
    for key in ("ollama_enriched", "error", "model", "duration_ms"):
        val = enrichment.get(key)
        if val is not None:
            meta_rows += f'<div class="field"><div class="label">{html.escape(key)}</div><div class="value mono">{html.escape(str(val))}</div></div>'

    prompt_block = f'<pre style="white-space:pre-wrap;word-break:break-word;max-height:600px;overflow:auto;background:#faf5ec;padding:16px;border-radius:12px;font-size:0.82rem;">{html.escape(prompt_text) if prompt_text else "<em>No prompt saved (enable HUNT_RESUME_LOG_LLM_IO=1)</em>"}</pre>'
    response_block = f'<pre style="white-space:pre-wrap;word-break:break-word;max-height:400px;overflow:auto;background:#faf5ec;padding:16px;border-radius:12px;font-size:0.82rem;">{html.escape(response_text) if response_text else "<em>No response saved</em>"}</pre>'

    body = f"""
    <section class="hero">
      <h1>LLM I/O — Attempt {attempt_id}</h1>
      <p>Job {job_id} &middot; {html.escape(str(attempt.get("created_at") or ""))}</p>
    </section>
    <section class="stack">
      <div class="panel">
        <h2>Enrichment metadata</h2>
        <div class="grid">{meta_rows if meta_rows else "<p>No enrichment metadata found.</p>"}</div>
        <div class="actions" style="margin-top:12px;">
          <a class="pill" href="{html.escape(back_link)}" data-app-nav="true">Back to job</a>
        </div>
      </div>
      <div class="panel">
        <h2>Prompt sent to Ollama</h2>
        {prompt_block}
      </div>
      <div class="panel">
        <h2>Raw response from Ollama</h2>
        {response_block}
      </div>
    </section>
    """
    return HTMLResponse(render_layout(f"LLM I/O — Attempt {attempt_id}", body, current_path=""))


def _get_attempt_row(attempt_id: int) -> dict | None:
    if not RESUME_TAILOR_AVAILABLE:
        return None
    try:
        from fletcher.db import get_connection as fletcher_get_connection  # type: ignore
        conn = fletcher_get_connection(None)
        try:
            row = conn.execute(
                "SELECT * FROM resume_attempts WHERE id = ? LIMIT 1", (attempt_id,)
            ).fetchone()
            return dict(row) if row else None
        finally:
            conn.close()
    except Exception:
        return None


def _attempt_dir_from_row(attempt: dict) -> Path | None:
    """Derive the attempt directory from stored artifact paths."""
    for field in ("tex_path", "pdf_path", "metadata_path", "keywords_path"):
        val = attempt.get(field)
        if val:
            p = Path(val)
            if p.parent.exists():
                return p.parent
    return None


def _serve_attempt_artifact(attempt_id: int, path_field: str, media_type: str):
    attempt = _get_attempt_row(attempt_id)
    if not attempt:
        raise HTTPException(status_code=404, detail="Attempt not found.")
    raw_path = attempt.get(path_field)
    if not raw_path:
        raise HTTPException(status_code=404, detail=f"No {path_field} for this attempt.")
    artifact_path = Path(raw_path)
    if not artifact_path.exists():
        raise HTTPException(status_code=404, detail="File not found on disk.")
    return FileResponse(artifact_path, media_type=media_type)


@app.post("/api/jobs/{job_id}/requeue", dependencies=[Depends(review_ops_dependency)])
def api_requeue_job(job_id: int):
    row = get_job_by_id(job_id)
    if not row or row.get("source") not in {"linkedin", "indeed"}:
        raise HTTPException(
            status_code=400, detail="Requeue is only supported for rows with an enrichment worker."
        )
    updated = requeue_review_job(job_id, source=row.get("source"))
    if updated != 1:
        raise HTTPException(status_code=404, detail="Job not found.")
    try:
        append_review_audit_entry("requeue_job", {"job_id": job_id})
    except Exception:
        pass
    return JSONResponse({"status": "ok", "job_id": job_id})


@app.post("/api/jobs/{job_id}/priority", dependencies=[Depends(review_ops_dependency)])
def api_job_priority(job_id: int, payload: dict = Body(...)):
    row = get_job_by_id(job_id)
    if not row:
        raise HTTPException(status_code=404, detail="Job not found.")
    run_next = bool(payload.get("run_next"))
    updated = set_job_priority(job_id, run_next=run_next)
    if updated != 1:
        raise HTTPException(status_code=404, detail="Job not found.")
    try:
        append_review_audit_entry("set_priority", {"job_id": job_id, "run_next": run_next})
    except Exception:
        pass
    return JSONResponse({"status": "ok", "job_id": job_id, "run_next": run_next})


@app.post("/api/jobs/{job_id}/operator-meta", dependencies=[Depends(review_ops_dependency)])
def api_job_operator_meta(job_id: int, payload: dict = Body(...)):
    row = get_job_by_id(job_id)
    if not row:
        raise HTTPException(status_code=404, detail="Job not found.")
    notes = payload.get("operator_notes")
    tag = payload.get("operator_tag")
    if notes is not None and not isinstance(notes, str):
        raise HTTPException(status_code=400, detail="operator_notes must be a string or null.")
    if tag is not None and not isinstance(tag, str):
        raise HTTPException(status_code=400, detail="operator_tag must be a string or null.")
    kw = {}
    if "operator_notes" in payload:
        kw["notes"] = notes
    if "operator_tag" in payload:
        kw["operator_tag"] = tag
    if not kw:
        raise HTTPException(status_code=400, detail="Send operator_notes and/or operator_tag.")
    updated = update_job_operator_meta(job_id, **kw)
    if updated != 1:
        raise HTTPException(status_code=404, detail="Job not found.")
    try:
        append_review_audit_entry("operator_meta", {"job_id": job_id, **kw})
    except Exception:
        pass
    return JSONResponse({"status": "ok", "job_id": job_id})


@app.post("/api/jobs/bulk-selection", dependencies=[Depends(review_ops_dependency)])
def api_jobs_bulk_selection(payload: dict = Body(...)):
    action = payload.get("action")
    if action not in ("requeue", "set_status", "delete"):
        raise HTTPException(
            status_code=400,
            detail="action must be one of: requeue, set_status, delete.",
        )
    raw_ids = payload.get("job_ids")
    if not isinstance(raw_ids, list) or not raw_ids:
        raise HTTPException(status_code=400, detail="job_ids must be a non-empty list.")
    try:
        if action == "requeue":
            updated = bulk_requeue_jobs_by_ids(raw_ids)
        elif action == "set_status":
            st = payload.get("enrichment_status")
            if not isinstance(st, str) or not st.strip():
                raise HTTPException(status_code=400, detail="enrichment_status is required.")
            updated = set_enrichment_status_for_job_ids(raw_ids, enrichment_status=st.strip())
        else:
            if payload.get("confirm_delete") is not True:
                raise HTTPException(
                    status_code=400,
                    detail="confirm_delete must be true to delete rows.",
                )
            updated = delete_jobs_by_ids(raw_ids)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except sqlite3.IntegrityError as exc:
        raise HTTPException(
            status_code=409,
            detail=f"Database rejected the change (likely a linked record): {exc}",
        ) from exc
    try:
        append_review_audit_entry(
            "bulk_selection",
            {"action": action, "updated": updated, "count_ids": len(raw_ids)},
        )
    except Exception:
        pass
    return JSONResponse({"status": "ok", "action": action, "updated": updated})


@app.get("/legacy", response_class=HTMLResponse)
def dashboard(request: Request):
    summary = get_review_queue_summary()
    ready_rows = list_jobs_for_review(status="ready", limit=8)
    blocked_rows = list_jobs_for_review(status="blocked", limit=8)
    failed_rows = list_jobs_for_review(status="failed", limit=8)
    return_to = request_path_with_query(request)

    body = f"""
    <section class="hero">
      <h1>Overview</h1>
      <p>Quick entry to filtered job lists and a small sample of rows that often need attention. For full counts, auth detail, and failure tables open <a href="/health-view" data-app-nav="true">Queue &amp; health</a> : for bulk requeue and API tests use <a href="/ops" data-app-nav="true">Ops</a>.</p>
    </section>
    <section class="stack">
      {render_queue_jump_strip(summary)}
      {render_link_list("Ready now", ready_rows, return_to=return_to)}
      {render_link_list("Blocked", blocked_rows, return_to=return_to)}
      {render_link_list("Failed", failed_rows, return_to=return_to)}
    </section>
    """
    return HTMLResponse(render_layout("Overview", body, current_path="/"))


@app.get("/legacy/jobs", response_class=HTMLResponse)
def jobs_page(
    request: Request,
    source: str = "all",
    status: str = "all",
    limit: int = 50,
    page: int = 1,
    q: str = "",
    tag: str = "",
    sort: str = "date_scraped",
    direction: str = "desc",
):
    if source not in SOURCE_OPTIONS:
        raise HTTPException(status_code=400, detail=f"Unsupported source filter: {source}")
    if status not in STATUS_OPTIONS:
        raise HTTPException(status_code=400, detail=f"Unsupported status filter: {status}")
    safe_limit = max(1, min(limit, 250))
    safe_page = max(1, page)
    source_filter = None if source == "all" else source
    tag_opt = (tag or "").strip() or None
    tag_display = (tag or "").strip()
    total_rows = count_jobs_for_review(
        status=status, query=q, source=source_filter, operator_tag=tag_opt
    )
    rows = list_jobs_for_review(
        status=status,
        limit=safe_limit,
        offset=(safe_page - 1) * safe_limit,
        query=q,
        sort=sort,
        direction=direction,
        source=source_filter,
        operator_tag=tag_opt,
    )
    summary = get_review_queue_summary(source=source_filter)
    return_to = request_path_with_query(request)

    body = f"""
    <section class="hero">
      <h1>Jobs</h1>
      <p>Filter with the form and chips, tick rows for bulk actions (requeue, set status, delete), or open a row for detail. The <strong>Queue</strong> column shows when a job is flagged to run before others : it is not a control.</p>
    </section>
    <section class="cards">{render_summary_cards(summary)}</section>
    {render_auth_status(summary) if source in ("all", "linkedin") else ""}
    {render_search_bar(source=source, status=status, limit=safe_limit, q=q, sort=sort, direction=direction, tag=tag_display)}
    <p class="muted" style="margin:0 0 8px;">Source</p>
    <div class="toolbar">{render_source_toolbar(source, status=status, limit=safe_limit, q=q, sort=sort, direction=direction, tag=tag_display)}</div>
    <p class="muted" style="margin:12px 0 8px;">Enrichment status</p>
    <div class="toolbar">{render_status_toolbar(status, source=source, limit=safe_limit, q=q, sort=sort, direction=direction, tag=tag_display)}</div>
    {render_jobs_bulk_panel(source=source, status=status, limit=safe_limit, page=safe_page, q=q, sort=sort, direction=direction, tag=tag_display)}
    {render_jobs_selection_bar()}
    {render_jobs_table(rows, source=source, status=status, limit=safe_limit, page=safe_page, q=q, sort=sort, direction=direction, return_to=return_to, tag=tag_display)}
    {render_pagination(total_rows=total_rows, source=source, status=status, limit=safe_limit, page=safe_page, q=q, sort=sort, direction=direction, tag=tag_display)}
    """
    return HTMLResponse(render_layout("Hunt jobs", body, current_path="/jobs"))


@app.get("/legacy/jobs/{job_id}", response_class=HTMLResponse)
def job_detail(request: Request, job_id: int, return_to: str = ""):
    row = get_job_by_id(job_id)
    if not row:
        raise HTTPException(status_code=404, detail="Job not found.")

    status_class = html.escape(row.get("enrichment_status") or "unknown")
    description = row.get("description") or "No description saved."
    resume_attempts = list_resume_attempts(job_id, limit=8)
    safe_return_to = normalize_return_to(return_to)
    if not safe_return_to:
        safe_return_to = normalize_return_to(request.headers.get("referer"))
    requeue_action = add_return_to(f"/jobs/{row['id']}/requeue", safe_return_to)
    back_link = safe_return_to or "/jobs"
    body = f"""
    <section class="hero">
      <h1>{format_text(row["title"])}</h1>
      <p>{format_text(row["company"])}</p>
      <div style="margin-top: 14px;">
        <span class="status {status_class}">{format_text(row["enrichment_status"])}</span>
      </div>
    </section>
    <section class="stack">
      <div class="panel">
        <h2>Job metadata</h2>
        <div class="grid">
          <div class="field"><div class="label">ID</div><div class="value">{row["id"]}</div></div>
          <div class="field"><div class="label">Source</div><div class="value">{format_text(row["source"])}</div></div>
          <div class="field"><div class="label">Apply type</div><div class="value">{format_text(row["apply_type"])}</div></div>
          <div class="field"><div class="label">Auto apply eligible</div><div class="value">{format_text(row["auto_apply_eligible"])}</div></div>
          <div class="field"><div class="label">Attempts</div><div class="value">{format_text(row["enrichment_attempts"])}</div></div>
          <div class="field"><div class="label">ATS type</div><div class="value">{format_text(row["ats_type"])}</div></div>
          <div class="field"><div class="label">Apply host</div><div class="value">{format_text(row["apply_host"])}</div></div>
          <div class="field"><div class="label">Enriched at</div><div class="value mono">{format_text(row.get("enriched_at"))}</div></div>
          <div class="field"><div class="label">Started at</div><div class="value mono">{format_text(row.get("last_enrichment_started_at"))}</div></div>
          <div class="field"><div class="label">Next retry</div><div class="value mono">{format_text(row.get("next_enrichment_retry_at"))}</div></div>
          <div class="field"><div class="label">Application status</div><div class="value">{format_text(row["status"])}</div></div>
        </div>
        <div class="actions">
          <a class="pill" href="{html.escape(back_link)}" data-app-nav="true">Back to list</a>
          <a class="pill active" href="{html.escape(row["job_url"])}" target="_blank" rel="noreferrer">Open listing</a>
          {f'<a class="pill" href="{html.escape(row["apply_url"])}" target="_blank" rel="noreferrer">Open apply URL</a>' if row.get("apply_url") else ""}
          {f'<form method="post" action="{html.escape(requeue_action)}" data-async-requeue="true"><button type="submit">Requeue enrichment</button></form>' if row.get("source") in {"linkedin", "indeed"} else '<span class="pill">This source is visible here, but does not have a worker yet</span>'}
        </div>
      </div>
      <div class="panel">
        <h2>Operator</h2>
        <p class="muted">Notes and tags live on the job row. Priority is the <code>jobs.priority</code> flag for workers that honor it.</p>
        <div class="field" style="margin-bottom: 10px;">
          <div class="label">Priority flag</div>
          <div class="value">{format_text(row.get("priority"))}</div>
        </div>
        <form method="post" action="/legacy/jobs/{row["id"]}/operator-meta" class="stack" style="gap:12px;">
          <input type="hidden" name="return_to" value="{html.escape(add_return_to(f"/jobs/{row['id']}", safe_return_to))}" />
          <label class="label" for="operator_notes">Notes</label>
          <textarea id="operator_notes" name="operator_notes" rows="4" style="width:100%; box-sizing:border-box; border:1px solid var(--line); border-radius:12px; padding:10px; background:#faf5ec;">{html.escape(row.get("operator_notes") or "")}</textarea>
          <label class="label" for="operator_tag">Tag</label>
          <input id="operator_tag" name="operator_tag" type="text" value="{html.escape(row.get("operator_tag") or "")}" style="width:100%; box-sizing:border-box; border:1px solid var(--line); border-radius:12px; padding:10px; background:#faf5ec;" />
          <button type="submit" class="pill active">Save notes and tag</button>
        </form>
        <div class="actions" style="margin-top: 14px;">
          <button type="button" class="pill active" data-job-priority-set="1" data-job-id="{row["id"]}">Flag for queue (shows in Jobs list)</button>
          <button type="button" class="pill secondary" data-job-priority-set="0" data-job-id="{row["id"]}">Remove queue flag</button>
          <a class="pill" href="/jobs/compare?a={row["id"]}" data-app-nav="true">Compare with another job</a>
        </div>
      </div>
      <div class="panel">
        <h2>Last enrichment error</h2>
        <pre>{format_text(row.get("last_enrichment_error"))}</pre>
      </div>
      <div class="panel">
        <h2>Resume generation</h2>
        <div class="grid">
          <div class="field"><div class="label">Resume status</div><div class="value">{format_text(row.get("resume_status"))}</div></div>
          <div class="field"><div class="label">Latest attempt</div><div class="value">{format_text(row.get("latest_resume_attempt_id"))}</div></div>
          <div class="field"><div class="label">Latest version</div><div class="value">{format_text(row.get("latest_resume_version_id"))}</div></div>
          <div class="field"><div class="label">Role family</div><div class="value">{format_text(row.get("latest_resume_family"))}</div></div>
          <div class="field"><div class="label">Job level</div><div class="value">{format_text(row.get("latest_resume_job_level"))}</div></div>
          <div class="field"><div class="label">Generated at</div><div class="value mono">{format_text(row.get("latest_resume_generated_at"))}</div></div>
          <div class="field"><div class="label">Fallback used</div><div class="value">{format_text(row.get("latest_resume_fallback_used"))}</div></div>
          <div class="field"><div class="label">Flags</div><div class="value">{format_text(row.get("latest_resume_flags"))}</div></div>
          <div class="field"><div class="label">JD usable (C2)</div><div class="value">{_format_jd_usable_cell(row.get("latest_resume_jd_usable"))}</div></div>
          <div class="field"><div class="label">JD usable reason</div><div class="value">{format_text(row.get("latest_resume_jd_usable_reason"))}</div></div>
          <div class="field"><div class="label">Selected version</div><div class="value">{format_text(row.get("selected_resume_version_id"))}</div></div>
          <div class="field"><div class="label">Ready for C3</div><div class="value">{format_text(row.get("selected_resume_ready_for_c3"))}</div></div>
          {render_resume_links(row)}
        </div>
      </div>
      {render_resume_keywords_panel(row, resume_attempts)}
      {render_ai_summary_panel(resume_attempts)}
      {render_resume_history_cards(resume_attempts, job_id=job_id)}
      <div class="panel">
        <h2>Resume attempts (raw table)</h2>
        <p class="muted" style="margin-top:0;">Each row is one generation run. Click PDF/TeX to view that version. LLM I/O shows the prompt sent to Ollama and the raw response.</p>
        {render_resume_attempts(resume_attempts, job_id=job_id)}
      </div>
      <div class="panel">
        <h2>Failure artifacts</h2>
        <div class="grid">
          {render_artifact_links(row)}
        </div>
      </div>
      <div class="panel">
        <h2>Description</h2>
        <pre>{format_text(description)}</pre>
      </div>
    </section>
    """
    return HTMLResponse(render_layout(f"Hunt job {job_id}", body, current_path=f"/jobs/{job_id}"))


@app.get("/legacy/jobs/compare", response_class=HTMLResponse)
def jobs_compare(
    a: Optional[int] = Query(None),
    b: Optional[int] = Query(None),
):
    if a is None or b is None:
        a_val = "" if a is None else str(int(a))
        body = f"""
    <section class="hero">
      <h1>Compare jobs</h1>
      <p>Enter two job IDs from the jobs table.</p>
    </section>
    <form class="panel" method="get" action="/jobs/compare" style="display:grid; gap:14px; max-width:420px;">
      <label>Job A <input name="a" type="number" min="1" required value="{html.escape(a_val)}" style="width:100%; box-sizing:border-box; padding:10px; border-radius:12px; border:1px solid var(--line);" /></label>
      <label>Job B <input name="b" type="number" min="1" required style="width:100%; box-sizing:border-box; padding:10px; border-radius:12px; border:1px solid var(--line);" /></label>
      <button type="submit" class="pill active">Compare</button>
    </form>
    """
        return HTMLResponse(render_layout("Compare jobs", body, current_path="/jobs/compare"))
    left = get_job_by_id(a)
    right = get_job_by_id(b)
    if not left or not right:
        raise HTTPException(status_code=404, detail="One or both jobs were not found.")
    fields = (
        ("id", "ID"),
        ("title", "Title"),
        ("company", "Company"),
        ("source", "Source"),
        ("enrichment_status", "Enrichment"),
        ("apply_type", "Apply type"),
        ("enrichment_attempts", "Attempts"),
        ("enriched_at", "Enriched at"),
        ("last_enrichment_error", "Last error"),
        ("operator_notes", "Operator notes"),
        ("operator_tag", "Operator tag"),
        ("priority", "Priority"),
        ("job_url", "Job URL"),
        ("apply_url", "Apply URL"),
    )
    rows_html = []
    for key, label in fields:
        lv = left.get(key)
        rv = right.get(key)
        rows_html.append(
            f"<tr><td>{html.escape(label)}</td><td><pre>{format_text(lv)}</pre></td>"
            f"<td><pre>{format_text(rv)}</pre></td></tr>"
        )
    body = f"""
    <section class="hero">
      <h1>Compare #{a} and #{b}</h1>
      <p><a href="/jobs/{a}" data-app-nav="true">Open A</a> · <a href="/jobs/{b}" data-app-nav="true">Open B</a> · <a href="/jobs/compare" data-app-nav="true">New compare</a></p>
    </section>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Field</th><th>Job {a}</th><th>Job {b}</th></tr></thead>
        <tbody>{"".join(rows_html)}</tbody>
      </table>
    </div>
    """
    return HTMLResponse(render_layout(f"Compare {a} vs {b}", body, current_path="/jobs/compare"))


@app.post("/legacy/jobs/{job_id}/operator-meta")
async def job_operator_meta_form(request: Request, job_id: int):
    form = await request.form()
    assert_review_ops_allowed(request, str(form.get("ops_token") or ""))
    row = get_job_by_id(job_id)
    if not row:
        raise HTTPException(status_code=404, detail="Job not found.")
    notes = str(form.get("operator_notes") or "")
    tag = str(form.get("operator_tag") or "")
    update_job_operator_meta(job_id, notes=notes, operator_tag=tag)
    try:
        append_review_audit_entry("operator_meta_form", {"job_id": job_id})
    except Exception:
        pass
    dest = normalize_return_to(str(form.get("return_to") or "")) or f"/jobs/{job_id}"
    return RedirectResponse(url=dest, status_code=303)


@app.post("/legacy/jobs/{job_id}/requeue")
async def requeue_job_post(job_id: int, request: Request):
    form = await request.form()
    assert_review_ops_allowed(request, str(form.get("ops_token") or ""))
    row = get_job_by_id(job_id)
    if not row or row.get("source") not in {"linkedin", "indeed"}:
        raise HTTPException(
            status_code=400, detail="Requeue is only supported for rows with an enrichment worker."
        )
    updated = requeue_review_job(job_id, source=row.get("source"))
    if updated != 1:
        raise HTTPException(status_code=404, detail="Job not found.")
    return_to = request.query_params.get("return_to") or ""
    safe_return_to = normalize_return_to(return_to)
    try:
        append_review_audit_entry("requeue_job_form", {"job_id": job_id})
    except Exception:
        pass
    if request.headers.get("X-Hunt-Async") == "1":
        return JSONResponse(
            {
                "status": "ok",
                "job_id": job_id,
                "redirect_url": add_return_to(f"/jobs/{job_id}", safe_return_to),
                "return_to": safe_return_to,
            }
        )
    return RedirectResponse(
        url=safe_return_to or add_return_to(f"/jobs/{job_id}", safe_return_to), status_code=303
    )


def main():
    init_db(maintenance=False)
    import uvicorn

    uvicorn.run(app, host=REVIEW_APP_HOST, port=REVIEW_APP_PORT)


# ---------------------------------------------------------------------------
# SPA catch-all — must be last so it does not shadow any API routes.
# Serves frontend/dist/index.html for every path not matched above.
# When the SPA is not built yet, returns a 503 with instructions.
# ---------------------------------------------------------------------------

@app.get("/{full_path:path}", include_in_schema=False)
def spa_shell(full_path: str):
    index = FRONTEND_DIST / "index.html"
    if index.exists():
        return HTMLResponse(index.read_text(encoding="utf-8"))
    return HTMLResponse(
        "<h1 style='font-family:sans-serif;padding:40px'>Hunt frontend not built</h1>"
        "<p style='font-family:sans-serif;padding:0 40px'>"
        "Run: <code>cd frontend && npm install && npm run build</code>"
        "</p>",
        status_code=503,
    )


if __name__ == "__main__":
    main()
