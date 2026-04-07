import html
import json
import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import parse_qsl, quote, urlencode, urlsplit, urlunsplit

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import (
    FileResponse,
    HTMLResponse,
    JSONResponse,
    PlainTextResponse,
    RedirectResponse,
)

REPO_ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, REPO_ROOT)

from hunter.config import REVIEW_APP_HOST, REVIEW_APP_PORT  # noqa: E402
from hunter.db import (  # noqa: E402
    count_jobs_for_review,
    get_job_by_id,
    get_review_queue_summary,
    init_db,
    list_jobs_for_review,
)
from hunter.db import (  # noqa: E402
    requeue_job as requeue_review_job,
)
from hunter.failure_artifacts import resolve_artifact_path  # noqa: E402

try:  # noqa: E402
    from trapper.db import list_resume_attempts  # type: ignore

    RESUME_TAILOR_AVAILABLE = True
except ModuleNotFoundError:  # noqa: E402
    RESUME_TAILOR_AVAILABLE = False

    def list_resume_attempts(_job_id, limit=8):  # type: ignore
        return []


STATUS_OPTIONS = (
    "ready",
    "pending",
    "processing",
    "done",
    "done_verified",
    "failed",
    "blocked",
    "blocked_verified",
    "all",
)
SOURCE_OPTIONS = (
    "all",
    "linkedin",
    "indeed",
)

APP_ROUTE_PATHS = {
    "/",
    "/jobs",
    "/health-view",
    "/summary",
}


@asynccontextmanager
async def lifespan(app):
    init_db(maintenance=False)
    yield


app = FastAPI(title="Hunt Review (C1 Hunter)", version="0.1.0", lifespan=lifespan)


def format_text(value):
    if value is None:
        return "None"
    return html.escape(str(value))


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
          {_nav_link("Health", "/health-view", current_path=current_path, exact=True)}
          {_nav_link("Summary", "/summary", current_path=current_path, exact=True)}
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
        new RegExp('^/jobs(?:/[0-9]+)?$'),
        new RegExp('^/health-view$'),
        new RegExp('^/summary$'),
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
            window.history.pushState({ url, scrollY: 0 }, '', url);
          } else if (replace) {
            const previous = window.history.state || {};
            window.history.replaceState({ ...previous, url }, '', url);
          }

          const state = window.history.state || {};
          window.scrollTo(0, restoreScroll ? (state.scrollY || 0) : 0);
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
          const response = await fetch(form.action, {
            method: 'POST',
            headers: {
              'X-Hunt-Async': '1',
              'Accept': 'application/json',
            },
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
    })();
  </script>
    """
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
        hint = '<p style="color: var(--muted);">Refresh auth with <code>DISPLAY=:98 ./hunt.sh auth-save --channel chrome</code>, then press Enter after the LinkedIn feed is visible.</p>'
    return f"""
    <div class="panel">
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


def render_resume_attempts(attempts):
    if not attempts:
        if not RESUME_TAILOR_AVAILABLE:
            return "<p>Resume tailoring is not deployed in this review container yet.</p>"
        return "<p>No resume attempts yet.</p>"
    rows = []
    for attempt in attempts:
        rows.append(
            f"""
            <tr>
              <td>{format_text(attempt.get("id"))}</td>
              <td>{format_text(attempt.get("status"))}</td>
              <td>{format_text(attempt.get("role_family"))}</td>
              <td>{format_text(attempt.get("job_level"))}</td>
              <td>{format_text(attempt.get("latest_result_kind"))}</td>
              <td>{format_text(attempt.get("created_at"))}</td>
            </tr>
            """
        )
    return f"""
    <div class="table-wrap">
      <table>
        <thead><tr><th>ID</th><th>Status</th><th>Family</th><th>Level</th><th>Kind</th><th>Created</th></tr></thead>
        <tbody>{"".join(rows)}</tbody>
      </table>
    </div>
    """


def render_status_toolbar(
    active_status, *, source, limit, q="", sort="date_scraped", direction="desc"
):
    status_labels = {
        "ready": "ready",
        "pending": "pending_enrich",
        "processing": "processing",
        "done": "done",
        "done_verified": "done_verified",
        "failed": "failed",
        "blocked": "blocked",
        "blocked_verified": "blocked_verified",
        "all": "all",
    }
    pills = []
    for status in STATUS_OPTIONS:
        class_name = "pill active" if status == active_status else "pill"
        pills.append(
            f'<a class="{class_name}" href="/jobs?source={quote(source)}&status={quote(status)}&limit={limit}&q={quote(q)}&sort={quote(sort)}&direction={quote(direction)}">{html.escape(status_labels.get(status, status))}</a>'
        )
    return "".join(pills)


def render_source_toolbar(
    active_source, *, status, limit, q="", sort="date_scraped", direction="desc"
):
    pills = []
    for source in SOURCE_OPTIONS:
        class_name = "pill active" if source == active_source else "pill"
        pills.append(
            f'<a class="{class_name}" href="/jobs?source={quote(source)}&status={quote(status)}&limit={limit}&q={quote(q)}&sort={quote(sort)}&direction={quote(direction)}">{html.escape(source)}</a>'
        )
    return "".join(pills)


def render_search_bar(*, source, status, limit, q, sort, direction):
    return f"""
    <form class="panel" method="get" action="/jobs" style="margin-bottom: 18px;">
      <div style="display:grid; gap:12px; grid-template-columns: minmax(220px, 2fr) repeat(4, minmax(120px, 1fr)); align-items:end;">
        <div>
          <label class="label" for="q">Search</label>
          <input id="q" name="q" type="text" value="{
        html.escape(q)
    }" placeholder="company, title, description, or URL keyword" style="width:100%; box-sizing:border-box; border:1px solid var(--line); border-radius:12px; padding:10px 12px; background:#faf5ec;">
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
                ("ready", "Ready"),
                ("pending", "Pending enrich"),
                ("processing", "Processing"),
                ("done", "Done"),
                ("done_verified", "Done verified"),
                ("failed", "Failed"),
                ("blocked", "Blocked"),
                ("blocked_verified", "Blocked verified"),
                ("all", "All statuses"),
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
        <a class="pill" href="/jobs?source=all&status=ready&limit=50">Reset</a>
      </div>
    </form>
    """


def _sortable_link(
    label, column, *, source, status, limit, page, q, current_sort, current_direction
):
    next_direction = "asc"
    if current_sort == column and current_direction == "asc":
        next_direction = "desc"
    arrow = ""
    if current_sort == column:
        arrow = " &uarr;" if current_direction == "asc" else " &darr;"
    href = f"/jobs?source={quote(source)}&status={quote(status)}&limit={limit}&page={page}&q={quote(q)}&sort={quote(column)}&direction={quote(next_direction)}"
    return f'<a href="{href}">{html.escape(label)}{arrow}</a>'


def render_jobs_table(rows, *, source, status, limit, page, q, sort, direction, return_to=""):
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
        body.append(
            f"""
            <tr>
              <td><a href="{job_link}" data-app-nav="true">#{row["id"]}</a></td>
              <td>{format_text(row["source"])}</td>
              <td>{format_text(row["company"])}</td>
              <td>{format_text(row["title"])}</td>
              <td class="link-cell">{linkedin_link}{" | " + apply_link if linkedin_link and apply_link else apply_link}</td>
              <td><span class="status {status_class}">{format_text(row["enrichment_status"])}</span></td>
              <td>{format_text(row["apply_type"])}</td>
              <td>{format_text(row["enrichment_attempts"])}</td>
              <td class="mono">{format_text(row["next_enrichment_retry_at"])}</td>
              <td>{format_text(truncate_text(row["last_enrichment_error"]))}</td>
            </tr>
            """
        )

    return f"""
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>{_sortable_link("ID", "id", source=source, status=status, limit=limit, page=page, q=q, current_sort=sort, current_direction=direction)}</th>
            <th>{_sortable_link("Source", "source", source=source, status=status, limit=limit, page=page, q=q, current_sort=sort, current_direction=direction)}</th>
            <th>{_sortable_link("Company", "company", source=source, status=status, limit=limit, page=page, q=q, current_sort=sort, current_direction=direction)}</th>
            <th>{_sortable_link("Title", "title", source=source, status=status, limit=limit, page=page, q=q, current_sort=sort, current_direction=direction)}</th>
            <th>Links</th>
            <th>{_sortable_link("Enrichment", "enrichment_status", source=source, status=status, limit=limit, page=page, q=q, current_sort=sort, current_direction=direction)}</th>
            <th>{_sortable_link("Apply Type", "apply_type", source=source, status=status, limit=limit, page=page, q=q, current_sort=sort, current_direction=direction)}</th>
            <th>{_sortable_link("Attempts", "enrichment_attempts", source=source, status=status, limit=limit, page=page, q=q, current_sort=sort, current_direction=direction)}</th>
            <th>{_sortable_link("Next Retry", "next_enrichment_retry_at", source=source, status=status, limit=limit, page=page, q=q, current_sort=sort, current_direction=direction)}</th>
            <th>{_sortable_link("Last Error", "last_enrichment_error", source=source, status=status, limit=limit, page=page, q=q, current_sort=sort, current_direction=direction)}</th>
          </tr>
        </thead>
        <tbody>
          {"".join(body)}
        </tbody>
      </table>
    </div>
    """


def render_pagination(*, total_rows, source, status, limit, page, q, sort, direction):
    if total_rows <= limit:
        return ""

    total_pages = max(1, (total_rows + limit - 1) // limit)
    current_page = max(1, min(page, total_pages))

    links = []
    if current_page > 1:
        prev_page = current_page - 1
        links.append(
            f'<a class="pill" href="/jobs?source={quote(source)}&status={quote(status)}&limit={limit}&page={prev_page}&q={quote(q)}&sort={quote(sort)}&direction={quote(direction)}">Previous</a>'
        )

    start_page = max(1, current_page - 2)
    end_page = min(total_pages, current_page + 2)
    for page_number in range(start_page, end_page + 1):
        class_name = "pill active" if page_number == current_page else "pill"
        links.append(
            f'<a class="{class_name}" href="/jobs?source={quote(source)}&status={quote(status)}&limit={limit}&page={page_number}&q={quote(q)}&sort={quote(sort)}&direction={quote(direction)}">{page_number}</a>'
        )

    if current_page < total_pages:
        next_page = current_page + 1
        links.append(
            f'<a class="pill" href="/jobs?source={quote(source)}&status={quote(status)}&limit={limit}&page={next_page}&q={quote(q)}&sort={quote(sort)}&direction={quote(direction)}">Next</a>'
        )

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


@app.get("/health")
def health():
    summary = get_review_queue_summary()
    return {
        "status": "ok",
        "queue": summary,
    }


@app.get("/api/summary")
def api_summary():
    return JSONResponse(get_review_queue_summary())


@app.get("/metrics")
def metrics():
    return PlainTextResponse(
        render_metrics(get_review_queue_summary()), media_type="text/plain; version=0.0.4"
    )


@app.get("/health-view", response_class=HTMLResponse)
def health_view():
    summary = get_review_queue_summary()
    body = f"""
    <section class="hero">
      <h1>Health</h1>
      <p>Human-readable operational health for the live jobs review lane. Use the raw endpoints only for scripts, checks, or debugging.</p>
    </section>
    <section class="cards">{render_summary_cards(summary)}</section>
    <section class="stack">
      {render_auth_status(summary)}
      {render_summary_table(summary)}
      <div class="panel">
        <h2>Failure breakdown</h2>
        {render_failure_breakdown(summary)}
      </div>
    </section>
    """
    return HTMLResponse(render_layout("Hunt health", body, current_path="/health-view"))


@app.get("/summary", response_class=HTMLResponse)
def summary_view():
    summary = get_review_queue_summary()
    body = f"""
    <section class="hero">
      <h1>Summary</h1>
      <p>High-level queue counts and enrichment-state totals for the current jobs table across sources.</p>
    </section>
    <section class="cards">{render_summary_cards(summary)}</section>
    {render_auth_status(summary)}
    {render_summary_table(summary)}
    """
    return HTMLResponse(render_layout("Hunt summary", body, current_path="/summary"))


@app.get("/api/jobs")
def api_jobs(
    source: str = "all",
    status: str = "ready",
    limit: int = 50,
    page: int = 1,
    include_description: bool = False,
    q: str = "",
    sort: str = "date_scraped",
    direction: str = "desc",
):
    if source not in SOURCE_OPTIONS:
        raise HTTPException(status_code=400, detail=f"Unsupported source filter: {source}")
    if status not in STATUS_OPTIONS:
        raise HTTPException(status_code=400, detail=f"Unsupported status filter: {status}")
    safe_limit = max(1, min(limit, 250))
    safe_page = max(1, page)
    rows = list_jobs_for_review(
        status=status,
        limit=safe_limit,
        offset=(safe_page - 1) * safe_limit,
        include_description=include_description,
        query=q,
        sort=sort,
        direction=direction,
        source=None if source == "all" else source,
    )
    return JSONResponse(rows)


@app.get("/api/jobs/{job_id}")
def api_job(job_id: int):
    row = get_job_by_id(job_id)
    if not row:
        raise HTTPException(status_code=404, detail="Job not found.")
    return JSONResponse(row)


@app.get("/api/jobs/{job_id}/artifacts/{artifact_kind}")
def api_job_artifact(job_id: int, artifact_kind: str):
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
def api_job_resume_artifact(job_id: int, artifact_kind: str):
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


@app.post("/api/jobs/{job_id}/requeue")
def api_requeue_job(job_id: int):
    row = get_job_by_id(job_id)
    if not row or row.get("source") not in {"linkedin", "indeed"}:
        raise HTTPException(
            status_code=400, detail="Requeue is only supported for rows with an enrichment worker."
        )
    updated = requeue_review_job(job_id, source=row.get("source"))
    if updated != 1:
        raise HTTPException(status_code=404, detail="Job not found.")
    return JSONResponse({"status": "ok", "job_id": job_id})


@app.get("/", response_class=HTMLResponse)
def dashboard(request: Request):
    summary = get_review_queue_summary()
    ready_rows = list_jobs_for_review(status="ready", limit=8)
    blocked_rows = list_jobs_for_review(status="blocked", limit=8)
    failed_rows = list_jobs_for_review(status="failed", limit=8)
    return_to = request_path_with_query(request)

    body = f"""
    <section class="hero">
      <h1>Hunt review lane</h1>
      <p>C1 (Hunter) control plane for the live jobs table on server2. LinkedIn and Indeed now share the same enrichment queue model, while other sources can still be surfaced here for later adapters.</p>
    </section>
    <section class="cards">{render_summary_cards(summary)}</section>
    <section class="stack">
      {render_auth_status(summary)}
      <div class="panel">
        <h2>Failure breakdown</h2>
        {render_failure_breakdown(summary)}
      </div>
      {render_link_list("Ready now", ready_rows, return_to=return_to)}
      {render_link_list("Blocked", blocked_rows, return_to=return_to)}
      {render_link_list("Failed", failed_rows, return_to=return_to)}
    </section>
    """
    return HTMLResponse(render_layout("Hunt review", body, current_path="/"))


@app.get("/jobs", response_class=HTMLResponse)
def jobs_page(
    request: Request,
    source: str = "all",
    status: str = "ready",
    limit: int = 50,
    page: int = 1,
    q: str = "",
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
    total_rows = count_jobs_for_review(status=status, query=q, source=source_filter)
    rows = list_jobs_for_review(
        status=status,
        limit=safe_limit,
        offset=(safe_page - 1) * safe_limit,
        query=q,
        sort=sort,
        direction=direction,
        source=source_filter,
    )
    summary = get_review_queue_summary(source=source_filter)
    return_to = request_path_with_query(request)

    body = f"""
    <section class="hero">
      <h1>Jobs queue</h1>
      <p>Browse the live jobs table across sources, search by company, title, description, or URL keywords, sort by column headings, and open both the listing and apply link directly from the table.</p>
    </section>
    <section class="cards">{render_summary_cards(summary)}</section>
    {render_auth_status(summary) if source in ("all", "linkedin") else ""}
    {render_search_bar(source=source, status=status, limit=safe_limit, q=q, sort=sort, direction=direction)}
    <div class="toolbar">{render_source_toolbar(source, status=status, limit=safe_limit, q=q, sort=sort, direction=direction)}</div>
    <div class="toolbar">{render_status_toolbar(status, source=source, limit=safe_limit, q=q, sort=sort, direction=direction)}</div>
    {render_jobs_table(rows, source=source, status=status, limit=safe_limit, page=safe_page, q=q, sort=sort, direction=direction, return_to=return_to)}
    {render_pagination(total_rows=total_rows, source=source, status=status, limit=safe_limit, page=safe_page, q=q, sort=sort, direction=direction)}
    """
    return HTMLResponse(render_layout("Hunt jobs", body, current_path="/jobs"))


@app.get("/jobs/{job_id}", response_class=HTMLResponse)
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
          <div class="field"><div class="label">Selected version</div><div class="value">{format_text(row.get("selected_resume_version_id"))}</div></div>
          <div class="field"><div class="label">Ready for C3</div><div class="value">{format_text(row.get("selected_resume_ready_for_c3"))}</div></div>
          {render_resume_links(row)}
        </div>
      </div>
      <div class="panel">
        <h2>Recent resume attempts</h2>
        {render_resume_attempts(resume_attempts)}
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


@app.post("/jobs/{job_id}/requeue")
def requeue_job(job_id: int, request: Request, return_to: str = ""):
    row = get_job_by_id(job_id)
    if not row or row.get("source") not in {"linkedin", "indeed"}:
        raise HTTPException(
            status_code=400, detail="Requeue is only supported for rows with an enrichment worker."
        )
    updated = requeue_review_job(job_id, source=row.get("source"))
    if updated != 1:
        raise HTTPException(status_code=404, detail="Job not found.")
    safe_return_to = normalize_return_to(return_to)
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


if __name__ == "__main__":
    main()
