import html
import os
import sys
from contextlib import asynccontextmanager
from urllib.parse import quote

from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse


REPO_ROOT = os.path.dirname(os.path.abspath(__file__))
SCRAPER_DIR = os.path.join(REPO_ROOT, "scraper")
sys.path.insert(0, SCRAPER_DIR)

from config import REVIEW_APP_HOST, REVIEW_APP_PORT  # noqa: E402
from db import (  # noqa: E402
    count_jobs_for_review,
    get_job_by_id,
    get_review_queue_summary,
    init_db,
    list_jobs_for_review,
    requeue_job as requeue_review_job,
)


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


@asynccontextmanager
async def lifespan(app):
    init_db(maintenance=False)
    yield


app = FastAPI(title="Hunt Review", version="0.1.0", lifespan=lifespan)


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


def render_layout(title, body):
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{html.escape(title)}</title>
  <style>
    :root {{
      --bg: #f3efe7;
      --panel: #fffdf8;
      --ink: #1f2421;
      --muted: #65706c;
      --line: #ddd4c7;
      --accent: #245b4e;
      --accent-soft: #e2efe9;
      --warning: #845d00;
      --warning-soft: #fff3d6;
      --danger: #a93f31;
      --danger-soft: #ffe6e1;
      --good: #256b38;
      --good-soft: #dff3e5;
      font-family: "Segoe UI", system-ui, sans-serif;
    }}
    body {{
      margin: 0;
      background: linear-gradient(180deg, #f6f1e7 0%, #efe8db 100%);
      color: var(--ink);
    }}
    a {{ color: var(--accent); text-decoration: none; }}
    a:hover {{ text-decoration: underline; }}
    .shell {{ max-width: 1180px; margin: 0 auto; padding: 28px 20px 40px; }}
    .nav {{
      display: flex;
      gap: 16px;
      align-items: center;
      margin-bottom: 24px;
      color: var(--muted);
    }}
    .nav a {{
      font-weight: 600;
    }}
    .hero {{
      margin-bottom: 22px;
    }}
    .hero h1 {{
      margin: 0 0 8px;
      font-size: 2rem;
      line-height: 1.1;
    }}
    .hero p {{
      margin: 0;
      color: var(--muted);
      max-width: 760px;
    }}
    .cards {{
      display: grid;
      gap: 12px;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      margin-bottom: 24px;
    }}
    .card {{
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 16px;
      box-shadow: 0 6px 22px rgba(31, 36, 33, 0.04);
    }}
    .card .label {{
      font-size: 0.85rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--muted);
      margin-bottom: 8px;
    }}
    .card .value {{
      font-size: 1.6rem;
      font-weight: 700;
    }}
    .toolbar {{
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-bottom: 18px;
    }}
    .pill {{
      border: 1px solid var(--line);
      background: var(--panel);
      border-radius: 999px;
      padding: 8px 12px;
      color: var(--ink);
      font-weight: 600;
    }}
    .pill.active {{
      background: var(--accent);
      border-color: var(--accent);
      color: white;
    }}
    .table-wrap {{
      overflow-x: auto;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 18px;
      box-shadow: 0 6px 22px rgba(31, 36, 33, 0.04);
    }}
    table {{
      width: 100%;
      border-collapse: collapse;
    }}
    th, td {{
      padding: 12px 14px;
      border-bottom: 1px solid var(--line);
      text-align: left;
      vertical-align: top;
      font-size: 0.95rem;
    }}
    tr:last-child td {{
      border-bottom: none;
    }}
    th {{
      font-size: 0.83rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--muted);
      background: #faf5ec;
    }}
    .status {{
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border-radius: 999px;
      padding: 5px 10px;
      font-size: 0.8rem;
      font-weight: 700;
    }}
    .status.done, .status.done_verified {{
      background: var(--good-soft);
      color: var(--good);
    }}
    .status.pending, .status.processing {{
      background: var(--accent-soft);
      color: var(--accent);
    }}
    .status.blocked, .status.blocked_verified {{
      background: var(--warning-soft);
      color: var(--warning);
    }}
    .status.failed {{
      background: var(--danger-soft);
      color: var(--danger);
    }}
    .mono {{
      font-family: Consolas, "SFMono-Regular", monospace;
      font-size: 0.9rem;
      word-break: break-word;
    }}
    .stack {{
      display: grid;
      gap: 16px;
    }}
    .panel {{
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 18px;
      padding: 18px;
      box-shadow: 0 6px 22px rgba(31, 36, 33, 0.04);
    }}
    .panel h2 {{
      margin: 0 0 12px;
      font-size: 1.15rem;
    }}
    .grid {{
      display: grid;
      gap: 12px;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    }}
    .field {{
      background: #faf5ec;
      border-radius: 12px;
      padding: 12px;
    }}
    .field .label {{
      font-size: 0.8rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--muted);
      margin-bottom: 6px;
    }}
    .field .value {{
      word-break: break-word;
    }}
    .actions {{
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      margin-top: 14px;
    }}
    button {{
      border: 0;
      background: var(--accent);
      color: white;
      border-radius: 999px;
      padding: 10px 14px;
      font-weight: 700;
      cursor: pointer;
    }}
    button.secondary {{
      background: #5d6a66;
    }}
    pre {{
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
      font-family: Consolas, "SFMono-Regular", monospace;
      font-size: 0.92rem;
      line-height: 1.45;
    }}
  </style>
</head>
<body>
    <div class="shell">
      <div class="nav">
        <a href="/">Overview</a>
        <a href="/jobs">Jobs</a>
        <a href="/health-view">Health</a>
        <a href="/summary">Summary</a>
        <a href="/health">Raw health</a>
        <a href="/api/summary">Raw API</a>
      </div>
      {body}
    </div>
</body>
</html>
"""


def render_summary_cards(summary):
    cards = [
        ("Total rows", summary["total"]),
        ("Ready now", summary["ready_count"]),
        ("Pending", summary["pending_count"]),
        ("Enriched", summary["counts_by_status"].get("done", 0) + summary["counts_by_status"].get("done_verified", 0)),
        ("Failed enrich", summary["counts_by_status"].get("failed", 0)),
        ("Blocked", summary["blocked_count"]),
        ("Stale processing", summary["stale_processing_count"]),
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


def render_status_toolbar(active_status, *, source, limit, q="", sort="date_scraped", direction="desc"):
    pills = []
    for status in STATUS_OPTIONS:
        class_name = "pill active" if status == active_status else "pill"
        pills.append(
            f'<a class="{class_name}" href="/jobs?source={quote(source)}&status={quote(status)}&limit={limit}&q={quote(q)}&sort={quote(sort)}&direction={quote(direction)}">{html.escape(status)}</a>'
        )
    return "".join(pills)


def render_source_toolbar(active_source, *, status, limit, q="", sort="date_scraped", direction="desc"):
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
          <input id="q" name="q" type="text" value="{html.escape(q)}" placeholder="company, title, description, or URL keyword" style="width:100%; box-sizing:border-box; border:1px solid var(--line); border-radius:12px; padding:10px 12px; background:#faf5ec;">
        </div>
        <div>
          <label class="label" for="source">Source</label>
          <select id="source" name="source" style="width:100%; box-sizing:border-box; border:1px solid var(--line); border-radius:12px; padding:10px 12px; background:#faf5ec;">
            {''.join(
                f'<option value="{value}"{" selected" if source == value else ""}>{label}</option>'
                for value, label in (
                    ("all", "All sources"),
                    ("linkedin", "LinkedIn"),
                    ("indeed", "Indeed"),
                )
            )}
          </select>
        </div>
        <div>
          <label class="label" for="status">Status</label>
          <select id="status" name="status" style="width:100%; box-sizing:border-box; border:1px solid var(--line); border-radius:12px; padding:10px 12px; background:#faf5ec;">
            {''.join(
                f'<option value="{value}"{" selected" if status == value else ""}>{label}</option>'
                for value, label in (
                    ("ready", "Ready"),
                    ("pending", "Pending"),
                    ("processing", "Processing"),
                    ("done", "Done"),
                    ("done_verified", "Done verified"),
                    ("failed", "Failed"),
                    ("blocked", "Blocked"),
                    ("blocked_verified", "Blocked verified"),
                    ("all", "All statuses"),
                )
            )}
          </select>
        </div>
        <div>
          <label class="label" for="sort">Sort</label>
          <select id="sort" name="sort" style="width:100%; box-sizing:border-box; border:1px solid var(--line); border-radius:12px; padding:10px 12px; background:#faf5ec;">
            {''.join(
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
            )}
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


def _sortable_link(label, column, *, source, status, limit, page, q, current_sort, current_direction):
    next_direction = "asc"
    if current_sort == column and current_direction == "asc":
        next_direction = "desc"
    arrow = ""
    if current_sort == column:
        arrow = " &uarr;" if current_direction == "asc" else " &darr;"
    href = f"/jobs?source={quote(source)}&status={quote(status)}&limit={limit}&page={page}&q={quote(q)}&sort={quote(column)}&direction={quote(next_direction)}"
    return f'<a href="{href}">{html.escape(label)}{arrow}</a>'


def render_jobs_table(rows, *, source, status, limit, page, q, sort, direction):
    if not rows:
        return '<div class="panel"><p>No jobs match this filter.</p></div>'

    body = []
    for row in rows:
        status_class = html.escape(row["enrichment_status"] or "unknown")
        job_link = f"/jobs/{row['id']}"
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
              <td><a href="{job_link}">#{row['id']}</a></td>
              <td>{format_text(row['source'])}</td>
              <td>{format_text(row['company'])}</td>
              <td>{format_text(row['title'])}</td>
              <td>{linkedin_link}{' | ' + apply_link if linkedin_link and apply_link else apply_link}</td>
              <td><span class="status {status_class}">{format_text(row['enrichment_status'])}</span></td>
              <td>{format_text(row['apply_type'])}</td>
              <td>{format_text(row['enrichment_attempts'])}</td>
              <td class="mono">{format_text(row['next_enrichment_retry_at'])}</td>
              <td>{format_text(truncate_text(row['last_enrichment_error']))}</td>
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
          {''.join(body)}
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
      {''.join(links)}
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
        ("Ready now", summary["ready_count"]),
        ("Pending", summary["pending_count"]),
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


def render_link_list(title, rows):
    if not rows:
        return f'<div class="panel"><h2>{html.escape(title)}</h2><p>No rows.</p></div>'
    items = "".join(
        f"""
        <tr>
          <td><a href="/jobs/{row['id']}">#{row['id']}</a></td>
          <td>{format_text(row['company'])}</td>
          <td>{format_text(truncate_text(row['title'], max_chars=80))}</td>
          <td>{format_text(row['enrichment_status'])}</td>
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
      {render_summary_table(summary)}
      <div class="panel">
        <h2>Failure breakdown</h2>
        {render_failure_breakdown(summary)}
      </div>
    </section>
    """
    return HTMLResponse(render_layout("Hunt health", body))


@app.get("/summary", response_class=HTMLResponse)
def summary_view():
    summary = get_review_queue_summary()
    body = f"""
    <section class="hero">
      <h1>Summary</h1>
      <p>High-level queue counts and enrichment-state totals for the current jobs table across sources.</p>
    </section>
    <section class="cards">{render_summary_cards(summary)}</section>
    {render_summary_table(summary)}
    """
    return HTMLResponse(render_layout("Hunt summary", body))


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


@app.post("/api/jobs/{job_id}/requeue")
def api_requeue_job(job_id: int):
    row = get_job_by_id(job_id)
    if not row or row.get("source") not in {"linkedin", "indeed"}:
        raise HTTPException(status_code=400, detail="Requeue is only supported for rows with an enrichment worker.")
    updated = requeue_review_job(job_id, source=row.get("source"))
    if updated != 1:
        raise HTTPException(status_code=404, detail="Job not found.")
    return JSONResponse({"status": "ok", "job_id": job_id})


@app.get("/", response_class=HTMLResponse)
def dashboard():
    summary = get_review_queue_summary()
    ready_rows = list_jobs_for_review(status="ready", limit=8)
    blocked_rows = list_jobs_for_review(status="blocked", limit=8)
    failed_rows = list_jobs_for_review(status="failed", limit=8)

    body = f"""
    <section class="hero">
      <h1>Hunt review lane</h1>
      <p>Component 1 control plane for the live jobs table on server2. LinkedIn and Indeed now share the same enrichment queue model, while other sources can still be surfaced here for later adapters.</p>
    </section>
    <section class="cards">{render_summary_cards(summary)}</section>
    <section class="stack">
      <div class="panel">
        <h2>Failure breakdown</h2>
        {render_failure_breakdown(summary)}
      </div>
      {render_link_list("Ready now", ready_rows)}
      {render_link_list("Blocked", blocked_rows)}
      {render_link_list("Failed", failed_rows)}
    </section>
    """
    return HTMLResponse(render_layout("Hunt review", body))


@app.get("/jobs", response_class=HTMLResponse)
def jobs_page(source: str = "all", status: str = "ready", limit: int = 50, page: int = 1, q: str = "", sort: str = "date_scraped", direction: str = "desc"):
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

    body = f"""
    <section class="hero">
      <h1>Jobs queue</h1>
      <p>Browse the live jobs table across sources, search by company, title, description, or URL keywords, sort by column headings, and open both the listing and apply link directly from the table.</p>
    </section>
    <section class="cards">{render_summary_cards(summary)}</section>
    {render_search_bar(source=source, status=status, limit=safe_limit, q=q, sort=sort, direction=direction)}
    <div class="toolbar">{render_source_toolbar(source, status=status, limit=safe_limit, q=q, sort=sort, direction=direction)}</div>
    <div class="toolbar">{render_status_toolbar(status, source=source, limit=safe_limit, q=q, sort=sort, direction=direction)}</div>
    {render_jobs_table(rows, source=source, status=status, limit=safe_limit, page=safe_page, q=q, sort=sort, direction=direction)}
    {render_pagination(total_rows=total_rows, source=source, status=status, limit=safe_limit, page=safe_page, q=q, sort=sort, direction=direction)}
    """
    return HTMLResponse(render_layout("Hunt jobs", body))


@app.get("/jobs/{job_id}", response_class=HTMLResponse)
def job_detail(job_id: int):
    row = get_job_by_id(job_id)
    if not row:
        raise HTTPException(status_code=404, detail="Job not found.")

    status_class = html.escape(row.get("enrichment_status") or "unknown")
    description = row.get("description") or "No description saved."
    body = f"""
    <section class="hero">
      <h1>{format_text(row['title'])}</h1>
      <p>{format_text(row['company'])}</p>
      <div style="margin-top: 14px;">
        <span class="status {status_class}">{format_text(row['enrichment_status'])}</span>
      </div>
    </section>
    <section class="stack">
      <div class="panel">
        <h2>Job metadata</h2>
        <div class="grid">
          <div class="field"><div class="label">ID</div><div class="value">{row['id']}</div></div>
          <div class="field"><div class="label">Source</div><div class="value">{format_text(row['source'])}</div></div>
          <div class="field"><div class="label">Apply type</div><div class="value">{format_text(row['apply_type'])}</div></div>
          <div class="field"><div class="label">Auto apply eligible</div><div class="value">{format_text(row['auto_apply_eligible'])}</div></div>
          <div class="field"><div class="label">Attempts</div><div class="value">{format_text(row['enrichment_attempts'])}</div></div>
          <div class="field"><div class="label">ATS type</div><div class="value">{format_text(row['ats_type'])}</div></div>
          <div class="field"><div class="label">Apply host</div><div class="value">{format_text(row['apply_host'])}</div></div>
          <div class="field"><div class="label">Enriched at</div><div class="value mono">{format_text(row.get('enriched_at'))}</div></div>
          <div class="field"><div class="label">Started at</div><div class="value mono">{format_text(row.get('last_enrichment_started_at'))}</div></div>
          <div class="field"><div class="label">Next retry</div><div class="value mono">{format_text(row.get('next_enrichment_retry_at'))}</div></div>
          <div class="field"><div class="label">Application status</div><div class="value">{format_text(row['status'])}</div></div>
        </div>
        <div class="actions">
          <a class="pill active" href="{html.escape(row['job_url'])}" target="_blank" rel="noreferrer">Open listing</a>
          {f'<a class="pill" href="{html.escape(row["apply_url"])}" target="_blank" rel="noreferrer">Open apply URL</a>' if row.get("apply_url") else ""}
          {f'<form method="post" action="/jobs/{row["id"]}/requeue"><button type="submit">Requeue enrichment</button></form>' if row.get("source") in {"linkedin", "indeed"} else '<span class="pill">This source is visible here, but does not have a worker yet</span>'}
        </div>
      </div>
      <div class="panel">
        <h2>Last enrichment error</h2>
        <pre>{format_text(row.get('last_enrichment_error'))}</pre>
      </div>
      <div class="panel">
        <h2>Description</h2>
        <pre>{format_text(description)}</pre>
      </div>
    </section>
    """
    return HTMLResponse(render_layout(f"Hunt job {job_id}", body))


@app.post("/jobs/{job_id}/requeue")
def requeue_job(job_id: int):
    row = get_job_by_id(job_id)
    if not row or row.get("source") not in {"linkedin", "indeed"}:
        raise HTTPException(status_code=400, detail="Requeue is only supported for rows with an enrichment worker.")
    updated = requeue_review_job(job_id, source=row.get("source"))
    if updated != 1:
        raise HTTPException(status_code=404, detail="Job not found.")
    return RedirectResponse(url=f"/jobs/{job_id}", status_code=303)


def main():
    init_db(maintenance=False)
    import uvicorn

    uvicorn.run(app, host=REVIEW_APP_HOST, port=REVIEW_APP_PORT)


if __name__ == "__main__":
    main()
