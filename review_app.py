import html
import os
import sys
from urllib.parse import quote

from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse


REPO_ROOT = os.path.dirname(os.path.abspath(__file__))
SCRAPER_DIR = os.path.join(REPO_ROOT, "scraper")
sys.path.insert(0, SCRAPER_DIR)

from config import REVIEW_APP_HOST, REVIEW_APP_PORT  # noqa: E402
from db import (  # noqa: E402
    get_job_by_id,
    get_linkedin_queue_summary,
    init_db,
    list_linkedin_jobs_for_review,
    requeue_linkedin_job,
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

app = FastAPI(title="Hunt Review", version="0.1.0")


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
      <a href="/health">Health</a>
      <a href="/api/summary">API summary</a>
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


def render_status_toolbar(active_status, *, limit):
    pills = []
    for status in STATUS_OPTIONS:
        class_name = "pill active" if status == active_status else "pill"
        pills.append(
            f'<a class="{class_name}" href="/jobs?status={quote(status)}&limit={limit}">{html.escape(status)}</a>'
        )
    return "".join(pills)


def render_jobs_table(rows):
    if not rows:
        return '<div class="panel"><p>No LinkedIn rows match this filter.</p></div>'

    body = []
    for row in rows:
        status_class = html.escape(row["enrichment_status"] or "unknown")
        job_link = f"/jobs/{row['id']}"
        body.append(
            f"""
            <tr>
              <td><a href="{job_link}">#{row['id']}</a></td>
              <td>{format_text(row['company'])}</td>
              <td>{format_text(row['title'])}</td>
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
            <th>ID</th>
            <th>Company</th>
            <th>Title</th>
            <th>Enrichment</th>
            <th>Apply type</th>
            <th>Attempts</th>
            <th>Next retry</th>
            <th>Last error</th>
          </tr>
        </thead>
        <tbody>
          {''.join(body)}
        </tbody>
      </table>
    </div>
    """


def render_failure_breakdown(summary):
    if not summary["failure_counts"]:
        return "<p>No failed or blocked LinkedIn rows right now.</p>"
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


@app.on_event("startup")
def on_startup():
    init_db()


@app.get("/health")
def health():
    summary = get_linkedin_queue_summary()
    return {
        "status": "ok",
        "queue": summary,
    }


@app.get("/api/summary")
def api_summary():
    return JSONResponse(get_linkedin_queue_summary())


@app.get("/api/jobs")
def api_jobs(status: str = "ready", limit: int = 50, include_description: bool = False):
    if status not in STATUS_OPTIONS:
        raise HTTPException(status_code=400, detail=f"Unsupported status filter: {status}")
    rows = list_linkedin_jobs_for_review(
        status=status,
        limit=max(1, min(limit, 250)),
        include_description=include_description,
    )
    return JSONResponse(rows)


@app.get("/api/jobs/{job_id}")
def api_job(job_id: int):
    row = get_job_by_id(job_id)
    if not row or row.get("source") != "linkedin":
        raise HTTPException(status_code=404, detail="LinkedIn job not found.")
    return JSONResponse(row)


@app.post("/api/jobs/{job_id}/requeue")
def api_requeue_job(job_id: int):
    updated = requeue_linkedin_job(job_id)
    if updated != 1:
        raise HTTPException(status_code=404, detail="LinkedIn job not found.")
    return JSONResponse({"status": "ok", "job_id": job_id})


@app.get("/", response_class=HTMLResponse)
def dashboard():
    summary = get_linkedin_queue_summary()
    ready_rows = list_linkedin_jobs_for_review(status="ready", limit=8)
    blocked_rows = list_linkedin_jobs_for_review(status="blocked", limit=8)
    failed_rows = list_linkedin_jobs_for_review(status="failed", limit=8)

    body = f"""
    <section class="hero">
      <h1>Hunt review lane</h1>
      <p>Component 1 control plane for the live LinkedIn queue on server2. This is the operator view for unattended enrichment, blocked rows, retries, and later agent handoff.</p>
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
def jobs_page(status: str = "ready", limit: int = 50):
    if status not in STATUS_OPTIONS:
        raise HTTPException(status_code=400, detail=f"Unsupported status filter: {status}")
    rows = list_linkedin_jobs_for_review(status=status, limit=max(1, min(limit, 250)))
    summary = get_linkedin_queue_summary()

    body = f"""
    <section class="hero">
      <h1>LinkedIn queue</h1>
      <p>Browse the live enrichment queue, filter by operational state, and drill into any one row for URLs, description quality, and manual actions.</p>
    </section>
    <section class="cards">{render_summary_cards(summary)}</section>
    <div class="toolbar">{render_status_toolbar(status, limit=limit)}</div>
    {render_jobs_table(rows)}
    """
    return HTMLResponse(render_layout("Hunt jobs", body))


@app.get("/jobs/{job_id}", response_class=HTMLResponse)
def job_detail(job_id: int):
    row = get_job_by_id(job_id)
    if not row or row.get("source") != "linkedin":
        raise HTTPException(status_code=404, detail="LinkedIn job not found.")

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
          <a class="pill active" href="{html.escape(row['job_url'])}" target="_blank" rel="noreferrer">Open LinkedIn listing</a>
          {f'<a class="pill" href="{html.escape(row["apply_url"])}" target="_blank" rel="noreferrer">Open apply URL</a>' if row.get("apply_url") else ""}
          <form method="post" action="/jobs/{row['id']}/requeue">
            <button type="submit">Requeue enrichment</button>
          </form>
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
    updated = requeue_linkedin_job(job_id)
    if updated != 1:
        raise HTTPException(status_code=404, detail="LinkedIn job not found.")
    return RedirectResponse(url=f"/jobs/{job_id}", status_code=303)


def main():
    init_db()
    import uvicorn

    uvicorn.run(app, host=REVIEW_APP_HOST, port=REVIEW_APP_PORT)


if __name__ == "__main__":
    main()
