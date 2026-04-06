from __future__ import annotations

from contextlib import contextmanager
import json
import sqlite3
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from .config import resolve_db_path, resolve_runtime_root
from .context import build_apply_context_payload, build_c3_apply_payload, derive_concern_flags
from .db import EXECUTING_RUN_STATUSES, GLOBAL_HOLD_REASONS, TERMINAL_RUN_STATUSES, get_connection, init_orchestration_db
from .models import ApplyContext, OrchestrationEvent, OrchestrationRun, ReadyJobDecision, SubmitApproval, utc_now_iso


READY_ENRICHMENT_STATUSES = frozenset({"done", "done_verified"})
FAILURE_STATUSES = frozenset({"failed", "error"})


class OrchestrationError(RuntimeError):
    pass


def _truthy(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    if isinstance(value, (int, float)):
        return bool(value)
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def _text(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _normalize_status(value: Any, *, default: str = "new") -> str:
    text = _text(value).lower()
    return text or default


def _normalize_list(value: Any) -> list[str]:
    if not value:
        return []
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    if isinstance(value, tuple):
        return [str(item).strip() for item in value if str(item).strip()]
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return []
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            return [text]
        if isinstance(parsed, list):
            return [str(item).strip() for item in parsed if str(item).strip()]
        return [str(parsed).strip()] if str(parsed).strip() else []
    return [str(value).strip()] if str(value).strip() else []


def _dedupe(values: list[str]) -> list[str]:
    return list(dict.fromkeys(value for value in values if value))


class OrchestrationService:
    """DB-backed Component 4 orchestration flow."""

    def __init__(
        self,
        *,
        db_path: str | Path | None = None,
        runtime_root: str | Path | None = None,
    ) -> None:
        self.db_path = resolve_db_path(db_path)
        self.runtime_root = resolve_runtime_root(runtime_root)

    def ensure_initialized(self) -> None:
        init_orchestration_db(self.db_path)
        (self.runtime_root / "runs").mkdir(parents=True, exist_ok=True)
        (self.runtime_root / "approvals").mkdir(parents=True, exist_ok=True)

    @contextmanager
    def _connect(self):
        self.ensure_initialized()
        conn = get_connection(self.db_path)
        try:
            yield conn
        finally:
            conn.close()

    def _job_select_sql(self) -> str:
        return """
        SELECT
            id AS job_id,
            title,
            company,
            status,
            job_url,
            apply_url,
            description,
            source,
            date_scraped,
            priority,
            apply_type,
            auto_apply_eligible,
            enrichment_status,
            last_enrichment_error,
            apply_host,
            ats_type,
            latest_resume_job_description_path,
            latest_resume_flags,
            selected_resume_version_id,
            selected_resume_pdf_path,
            selected_resume_tex_path,
            selected_resume_selected_at,
            selected_resume_ready_for_c3
        FROM jobs
        """

    def _get_job_row(self, conn: sqlite3.Connection, job_id: int) -> sqlite3.Row | None:
        try:
            return conn.execute(self._job_select_sql() + " WHERE id = ?", (job_id,)).fetchone()
        except sqlite3.OperationalError as exc:
            if "no such table" in str(exc).lower():
                raise OrchestrationError(
                    "The Hunt jobs table is missing. Initialize Component 1 data before running C4."
                ) from exc
            raise

    def _list_job_rows(self, conn: sqlite3.Connection) -> list[sqlite3.Row]:
        try:
            return conn.execute(
                self._job_select_sql()
                + """
                ORDER BY
                    CASE lower(coalesce(source, ''))
                        WHEN 'linkedin' THEN 0
                        WHEN 'indeed' THEN 1
                        ELSE 999
                    END,
                    datetime(coalesce(date_scraped, CURRENT_TIMESTAMP)) DESC,
                    job_id DESC
                """
            ).fetchall()
        except sqlite3.OperationalError as exc:
            if "no such table" in str(exc).lower():
                raise OrchestrationError(
                    "The Hunt jobs table is missing. Initialize Component 1 data before running C4."
                ) from exc
            raise

    def _get_run_row(self, conn: sqlite3.Connection, run_id: str) -> sqlite3.Row | None:
        return conn.execute("SELECT * FROM orchestration_runs WHERE id = ?", (run_id,)).fetchone()

    def _get_open_run_for_job(self, conn: sqlite3.Connection, job_id: int) -> sqlite3.Row | None:
        placeholders = ", ".join("?" for _ in TERMINAL_RUN_STATUSES)
        return conn.execute(
            f"""
            SELECT *
            FROM orchestration_runs
            WHERE job_id = ?
              AND status NOT IN ({placeholders})
            ORDER BY datetime(started_at) DESC, id DESC
            LIMIT 1
            """,
            (job_id, *TERMINAL_RUN_STATUSES),
        ).fetchone()

    def _get_executing_run(self, conn: sqlite3.Connection) -> sqlite3.Row | None:
        placeholders = ", ".join("?" for _ in EXECUTING_RUN_STATUSES)
        return conn.execute(
            f"""
            SELECT *
            FROM orchestration_runs
            WHERE status IN ({placeholders})
            ORDER BY datetime(started_at) ASC, id ASC
            LIMIT 1
            """,
            tuple(EXECUTING_RUN_STATUSES),
        ).fetchone()

    def _get_global_hold_rows(self, conn: sqlite3.Connection) -> list[sqlite3.Row]:
        placeholders = ", ".join("?" for _ in GLOBAL_HOLD_REASONS)
        return conn.execute(
            f"""
            SELECT *
            FROM orchestration_runs
            WHERE status = 'manual_review'
              AND manual_review_reason IN ({placeholders})
            ORDER BY datetime(started_at) ASC, id ASC
            """,
            tuple(GLOBAL_HOLD_REASONS),
        ).fetchall()

    def _run_dir(self, run_id: str) -> Path:
        return self.runtime_root / "runs" / run_id

    def _write_json_artifact(self, path: Path, payload: Any) -> str:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        return str(path.resolve())

    def _claim_job_if_new(self, conn: sqlite3.Connection, job_id: int) -> None:
        conn.execute(
            """
            UPDATE jobs
            SET status = 'claimed'
            WHERE id = ?
              AND coalesce(nullif(trim(status), ''), 'new') = 'new'
            """,
            (job_id,),
        )

    def _update_job_status(self, conn: sqlite3.Connection, job_id: int, status: str) -> None:
        conn.execute("UPDATE jobs SET status = ? WHERE id = ?", (status, job_id))

    def _append_event(
        self,
        conn: sqlite3.Connection,
        *,
        run_id: str,
        event_type: str,
        step_name: str,
        payload: Any | None = None,
        payload_path: str | None = None,
    ) -> OrchestrationEvent:
        payload_json = json.dumps(payload, indent=2, sort_keys=True) if payload is not None else None
        cursor = conn.execute(
            """
            INSERT INTO orchestration_events (
                orchestration_run_id,
                event_type,
                step_name,
                payload_json,
                payload_path,
                created_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (run_id, event_type, step_name, payload_json, payload_path, utc_now_iso()),
        )
        row = conn.execute("SELECT * FROM orchestration_events WHERE id = ?", (cursor.lastrowid,)).fetchone()
        return OrchestrationEvent.from_row(row)

    def _decision_from_row(self, conn: sqlite3.Connection, row: sqlite3.Row) -> ReadyJobDecision:
        job_id = int(row["job_id"])
        open_run = self._get_open_run_for_job(conn, job_id)
        if open_run:
            run_status = _normalize_status(open_run["status"], default="")
            if run_status == "manual_review":
                return ReadyJobDecision(
                    job_id=job_id,
                    ready=False,
                    reason="manual_review_hold",
                    source=row["source"],
                    title=row["title"],
                    company=row["company"],
                    apply_url=row["apply_url"],
                    ats_type=row["ats_type"],
                    selected_resume_version_id=_text(row["selected_resume_version_id"]) or None,
                    selected_resume_pdf_path=_text(row["selected_resume_pdf_path"]) or None,
                    blocking_run_id=str(open_run["id"]),
                    manual_review_reason=_text(open_run["manual_review_reason"]) or None,
                    flags=_normalize_list(open_run["manual_review_flags_json"]),
                )
            return ReadyJobDecision(
                job_id=job_id,
                ready=False,
                reason="active_run",
                source=row["source"],
                title=row["title"],
                company=row["company"],
                apply_url=row["apply_url"],
                ats_type=row["ats_type"],
                selected_resume_version_id=_text(row["selected_resume_version_id"]) or None,
                selected_resume_pdf_path=_text(row["selected_resume_pdf_path"]) or None,
                blocking_run_id=str(open_run["id"]),
                flags=[run_status] if run_status else [],
            )

        app_status = _normalize_status(row["status"])
        if app_status == "claimed":
            return ReadyJobDecision(job_id=job_id, ready=False, reason="application_claimed", source=row["source"], title=row["title"], company=row["company"], apply_url=row["apply_url"], ats_type=row["ats_type"], selected_resume_version_id=_text(row["selected_resume_version_id"]) or None, selected_resume_pdf_path=_text(row["selected_resume_pdf_path"]) or None)
        if app_status == "applied":
            return ReadyJobDecision(job_id=job_id, ready=False, reason="already_applied", source=row["source"], title=row["title"], company=row["company"], apply_url=row["apply_url"], ats_type=row["ats_type"], selected_resume_version_id=_text(row["selected_resume_version_id"]) or None, selected_resume_pdf_path=_text(row["selected_resume_pdf_path"]) or None)
        if app_status in {"failed", "skipped"}:
            return ReadyJobDecision(job_id=job_id, ready=False, reason="application_terminal", source=row["source"], title=row["title"], company=row["company"], apply_url=row["apply_url"], ats_type=row["ats_type"], selected_resume_version_id=_text(row["selected_resume_version_id"]) or None, selected_resume_pdf_path=_text(row["selected_resume_pdf_path"]) or None, flags=[app_status])

        if int(row["priority"] or 0) != 0:
            return ReadyJobDecision(job_id=job_id, ready=False, reason="manual_only", source=row["source"], title=row["title"], company=row["company"], apply_url=row["apply_url"], ats_type=row["ats_type"], selected_resume_version_id=_text(row["selected_resume_version_id"]) or None, selected_resume_pdf_path=_text(row["selected_resume_pdf_path"]) or None)
        enrichment_status = _normalize_status(row["enrichment_status"], default="pending")
        if enrichment_status not in READY_ENRICHMENT_STATUSES:
            return ReadyJobDecision(job_id=job_id, ready=False, reason="waiting_on_enrichment", source=row["source"], title=row["title"], company=row["company"], apply_url=row["apply_url"], ats_type=row["ats_type"], selected_resume_version_id=_text(row["selected_resume_version_id"]) or None, selected_resume_pdf_path=_text(row["selected_resume_pdf_path"]) or None, flags=[enrichment_status])
        apply_type = _normalize_status(row["apply_type"], default="unknown")
        if apply_type == "easy_apply":
            return ReadyJobDecision(job_id=job_id, ready=False, reason="easy_apply_excluded", source=row["source"], title=row["title"], company=row["company"], apply_url=row["apply_url"], ats_type=row["ats_type"], selected_resume_version_id=_text(row["selected_resume_version_id"]) or None, selected_resume_pdf_path=_text(row["selected_resume_pdf_path"]) or None)
        if apply_type != "external_apply":
            return ReadyJobDecision(job_id=job_id, ready=False, reason="unsupported_apply_type", source=row["source"], title=row["title"], company=row["company"], apply_url=row["apply_url"], ats_type=row["ats_type"], selected_resume_version_id=_text(row["selected_resume_version_id"]) or None, selected_resume_pdf_path=_text(row["selected_resume_pdf_path"]) or None, flags=[apply_type])
        if not _truthy(row["auto_apply_eligible"]):
            return ReadyJobDecision(job_id=job_id, ready=False, reason="not_auto_apply_eligible", source=row["source"], title=row["title"], company=row["company"], apply_url=row["apply_url"], ats_type=row["ats_type"], selected_resume_version_id=_text(row["selected_resume_version_id"]) or None, selected_resume_pdf_path=_text(row["selected_resume_pdf_path"]) or None)
        if not _text(row["apply_url"]):
            return ReadyJobDecision(job_id=job_id, ready=False, reason="missing_apply_url", source=row["source"], title=row["title"], company=row["company"], apply_url=row["apply_url"], ats_type=row["ats_type"], selected_resume_version_id=_text(row["selected_resume_version_id"]) or None, selected_resume_pdf_path=_text(row["selected_resume_pdf_path"]) or None)
        if not _truthy(row["selected_resume_ready_for_c3"]) or not _text(row["selected_resume_version_id"]) or not _text(row["selected_resume_pdf_path"]):
            return ReadyJobDecision(job_id=job_id, ready=False, reason="waiting_on_resume", source=row["source"], title=row["title"], company=row["company"], apply_url=row["apply_url"], ats_type=row["ats_type"], selected_resume_version_id=_text(row["selected_resume_version_id"]) or None, selected_resume_pdf_path=_text(row["selected_resume_pdf_path"]) or None)
        return ReadyJobDecision(job_id=job_id, ready=True, reason="ready", source=row["source"], title=row["title"], company=row["company"], apply_url=_text(row["apply_url"]) or None, ats_type=_text(row["ats_type"]) or "unknown", selected_resume_version_id=_text(row["selected_resume_version_id"]) or None, selected_resume_pdf_path=_text(row["selected_resume_pdf_path"]) or None, flags=derive_concern_flags(row))

    def get_ready_decision(self, job_id: int) -> ReadyJobDecision:
        with self._connect() as conn:
            row = self._get_job_row(conn, job_id)
            if not row:
                return ReadyJobDecision(job_id=job_id, ready=False, reason="missing_job")
            return self._decision_from_row(conn, row)

    def list_ready_decisions(self, *, limit: int | None = 50, reason: str | None = None, only_ready: bool = False) -> list[ReadyJobDecision]:
        with self._connect() as conn:
            decisions: list[ReadyJobDecision] = []
            for row in self._list_job_rows(conn):
                decision = self._decision_from_row(conn, row)
                if only_ready and not decision.ready:
                    continue
                if reason and decision.reason != reason:
                    continue
                decisions.append(decision)
                if limit is not None and len(decisions) >= limit:
                    break
            return decisions

    def get_readiness_summary(self, *, sample_limit: int = 10) -> dict[str, Any]:
        with self._connect() as conn:
            decisions = [self._decision_from_row(conn, row) for row in self._list_job_rows(conn)]
            counts_by_reason: dict[str, int] = {}
            sample_ready_jobs: list[dict[str, Any]] = []
            for decision in decisions:
                counts_by_reason[decision.reason] = counts_by_reason.get(decision.reason, 0) + 1
                if decision.ready and len(sample_ready_jobs) < sample_limit:
                    sample_ready_jobs.append(decision.to_dict())
            active_run = self._get_executing_run(conn)
            global_hold_rows = self._get_global_hold_rows(conn)
            return {
                "total_jobs": len(decisions),
                "ready_count": counts_by_reason.get("ready", 0),
                "counts_by_reason": counts_by_reason,
                "sample_ready_jobs": sample_ready_jobs,
                "active_run_id": str(active_run["id"]) if active_run else None,
                "global_hold": {
                    "blocked": bool(global_hold_rows),
                    "run_ids": [str(row["id"]) for row in global_hold_rows],
                    "reasons": _dedupe([_text(row["manual_review_reason"]) for row in global_hold_rows]),
                },
            }

    def _create_run_payloads(self, *, row: sqlite3.Row, run_id: str, embed_resume_data: bool) -> tuple[dict[str, Any], str, str]:
        created_at = utc_now_iso()
        run_dir = self._run_dir(run_id)
        apply_context_path = str((run_dir / "apply_context.json").resolve())
        c3_apply_context_path = str((run_dir / "c3_apply_context.json").resolve())
        apply_context = build_apply_context_payload(
            row,
            run_id=run_id,
            created_at=created_at,
            apply_context_path=apply_context_path,
            c3_apply_context_path=c3_apply_context_path,
        )
        c3_payload = build_c3_apply_payload(row, primed_at=created_at, embed_resume_data=embed_resume_data)
        self._write_json_artifact(Path(apply_context_path), apply_context)
        self._write_json_artifact(Path(c3_apply_context_path), c3_payload)
        return apply_context, apply_context_path, c3_apply_context_path

    def build_apply_context(self, job_id: int, *, source_runtime: str = "manual", embed_resume_data: bool = False) -> ApplyContext:
        with self._connect() as conn:
            row = self._get_job_row(conn, job_id)
            if not row:
                raise OrchestrationError(f"Job {job_id} was not found.")
            ready = self._decision_from_row(conn, row)
            if not ready.ready:
                raise OrchestrationError(f"Job {job_id} is not ready for C4: {ready.reason}.")

            run_id = f"run-{job_id}-{uuid.uuid4().hex[:12]}"
            apply_context, apply_context_path, c3_apply_context_path = self._create_run_payloads(
                row=row,
                run_id=run_id,
                embed_resume_data=embed_resume_data,
            )
            now = utc_now_iso()
            conn.execute(
                """
                INSERT INTO orchestration_runs (
                    id, job_id, status, source_runtime, job_source, job_title, company,
                    selected_resume_version_id, selected_resume_pdf_path, selected_resume_tex_path,
                    apply_url, ats_type, apply_context_path, c3_apply_context_path,
                    manual_review_required, manual_review_reason, manual_review_flags_json,
                    submit_allowed, started_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    run_id,
                    job_id,
                    "apply_prepared",
                    source_runtime,
                    _text(row["source"]) or None,
                    _text(row["title"]) or None,
                    _text(row["company"]) or None,
                    _text(row["selected_resume_version_id"]) or None,
                    _text(row["selected_resume_pdf_path"]) or None,
                    _text(row["selected_resume_tex_path"]) or None,
                    _text(row["apply_url"]) or None,
                    _text(row["ats_type"]) or "unknown",
                    apply_context_path,
                    c3_apply_context_path,
                    0,
                    None,
                    json.dumps(apply_context["manual_review_flags"]),
                    0,
                    now,
                    now,
                ),
            )
            self._claim_job_if_new(conn, job_id)
            self._append_event(
                conn,
                run_id=run_id,
                event_type="run_started",
                step_name="apply_prep",
                payload={"ready_decision": ready.to_dict()},
                payload_path=apply_context_path,
            )
            conn.commit()

        return ApplyContext(**apply_context)

    def start_run(self, job_id: int, source_runtime: str = "manual") -> OrchestrationRun:
        context = self.build_apply_context(job_id, source_runtime=source_runtime)
        run = self.get_run(context.run_id)
        if run is None:
            raise OrchestrationError(f"Run {context.run_id} could not be loaded after creation.")
        return run

    def get_run(self, run_id: str) -> OrchestrationRun | None:
        with self._connect() as conn:
            row = self._get_run_row(conn, run_id)
            return OrchestrationRun.from_row(row) if row else None

    def list_runs(self, *, status: str | None = None, limit: int = 20) -> list[OrchestrationRun]:
        with self._connect() as conn:
            params: list[Any] = []
            sql = "SELECT * FROM orchestration_runs"
            if status:
                sql += " WHERE status = ?"
                params.append(status)
            sql += " ORDER BY datetime(started_at) DESC, id DESC LIMIT ?"
            params.append(limit)
            return [OrchestrationRun.from_row(row) for row in conn.execute(sql, tuple(params)).fetchall()]

    def list_events(self, run_id: str) -> list[OrchestrationEvent]:
        with self._connect() as conn:
            return [
                OrchestrationEvent.from_row(row)
                for row in conn.execute(
                    """
                    SELECT *
                    FROM orchestration_events
                    WHERE orchestration_run_id = ?
                    ORDER BY datetime(created_at) ASC, id ASC
                    """,
                    (run_id,),
                ).fetchall()
            ]

    def get_run_status(self, run_id: str) -> dict[str, Any]:
        run = self.get_run(run_id)
        if run is None:
            raise OrchestrationError(f"Run {run_id} was not found.")
        return {
            "run": run.to_dict(),
            "events": [event.to_dict() for event in self.list_events(run_id)],
        }

    def request_fill(self, run_id: str) -> dict[str, Any]:
        with self._connect() as conn:
            row = self._get_run_row(conn, run_id)
            if not row:
                raise OrchestrationError(f"Run {run_id} was not found.")
            run = OrchestrationRun.from_row(row)
            if run.status != "apply_prepared":
                raise OrchestrationError(f"Run {run_id} must be in apply_prepared before fill can be requested.")

            requested_at = utc_now_iso()
            fill_request_path = self._write_json_artifact(
                self._run_dir(run_id) / "fill_request.json",
                {
                    "run_id": run_id,
                    "job_id": run.job_id,
                    "apply_context_path": run.apply_context_path,
                    "c3_apply_context_path": run.c3_apply_context_path,
                    "requested_at": requested_at,
                },
            )
            conn.execute(
                "UPDATE orchestration_runs SET status = 'fill_requested', updated_at = ? WHERE id = ?",
                (requested_at, run_id),
            )
            self._append_event(
                conn,
                run_id=run_id,
                event_type="fill_requested",
                step_name="fill_request",
                payload={"job_id": run.job_id},
                payload_path=fill_request_path,
            )
            conn.commit()

        updated_run = self.get_run(run_id)
        if updated_run is None:
            raise OrchestrationError(f"Run {run_id} disappeared after requesting fill.")
        return {"run": updated_run.to_dict(), "fill_request_path": fill_request_path}

    def _load_result_json(self, result_json_path: str | Path) -> dict[str, Any]:
        path = Path(result_json_path).expanduser().resolve()
        if not path.exists():
            raise OrchestrationError(f"Result JSON was not found: {path}")
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise OrchestrationError(f"Result JSON could not be parsed: {path}") from exc
        if not isinstance(payload, dict):
            raise OrchestrationError("Result JSON must be an object.")
        return payload

    def _derive_review_flags(self, *, run: OrchestrationRun, fill_result: dict[str, Any]) -> list[str]:
        flags: list[str] = []
        text_chunks = " ".join(
            [
                _text(fill_result.get("status")),
                _text(fill_result.get("message")),
                _text(fill_result.get("reason")),
                _text(fill_result.get("pageStatus")),
                _text(fill_result.get("page_status")),
            ]
        ).lower()

        for field_name in ("manual_review_flags", "manualReviewFlags", "issues", "flags"):
            flags.extend(_normalize_list(fill_result.get(field_name)))

        if any(token in text_chunks for token in ("auth", "reauth")):
            flags.append("auth_required")
        if "login" in text_chunks or "sign in" in text_chunks:
            flags.append("login_required")
        if "captcha" in text_chunks:
            flags.append("captcha_challenge")
        if "otp" in text_chunks or "2fa" in text_chunks or "verification code" in text_chunks:
            flags.append("otp_required")
        if "verification" in text_chunks:
            flags.append("verification_required")
        if "security" in text_chunks or "challenge" in text_chunks:
            flags.append("security_challenge")
        if _normalize_list(fill_result.get("lowConfidenceAnswers")) or _normalize_list(fill_result.get("low_confidence_answers")):
            flags.append("low_confidence_answers")
        if _normalize_list(fill_result.get("missingRequiredFields")) or _normalize_list(fill_result.get("missing_required_fields")):
            flags.append("missing_required_fields")
        if _truthy(fill_result.get("unexpectedMultiPageFlow")) or _truthy(fill_result.get("unexpected_multi_page_flow")):
            flags.append("unexpected_multi_page_flow")

        resume_upload_ok = fill_result.get("resumeUploadOk")
        if resume_upload_ok is None:
            resume_upload_ok = fill_result.get("resume_upload_ok")
        if resume_upload_ok is False:
            flags.append("resume_upload_failure")

        if _truthy(fill_result.get("unsupportedStep")) or _truthy(fill_result.get("unsupported_step")):
            flags.append("unsupported_ats_step")

        final_url = _text(fill_result.get("finalUrl") or fill_result.get("final_url"))
        final_host = _text(fill_result.get("finalHost") or fill_result.get("final_host"))
        if not final_host and final_url:
            final_host = urlparse(final_url).hostname or ""
        expected_host = urlparse(run.apply_url or "").hostname or ""
        if final_host and expected_host and final_host.lower() != expected_host.lower():
            flags.append("hostname_drift")

        return _dedupe(flags)

    def _browser_summary(self, *, run: OrchestrationRun, fill_result: dict[str, Any], review_flags: list[str]) -> dict[str, Any]:
        return {
            "run_id": run.run_id,
            "job_id": run.job_id,
            "status": _normalize_status(fill_result.get("status"), default="unknown"),
            "apply_url": run.apply_url,
            "final_url": _text(fill_result.get("finalUrl") or fill_result.get("final_url")) or None,
            "final_host": _text(fill_result.get("finalHost") or fill_result.get("final_host")) or None,
            "message": _text(fill_result.get("message") or fill_result.get("reason")) or None,
            "generated_answers_used": _truthy(fill_result.get("generatedAnswersUsed") or fill_result.get("generated_answers_used")),
            "low_confidence_answers": _normalize_list(fill_result.get("lowConfidenceAnswers") or fill_result.get("low_confidence_answers")),
            "missing_required_fields": _normalize_list(fill_result.get("missingRequiredFields") or fill_result.get("missing_required_fields")),
            "steps": fill_result.get("steps") or [],
            "evidence": fill_result.get("evidence") or {},
            "manual_review_flags": review_flags,
        }

    def record_fill_result(self, run_id: str, result_json_path: str | Path) -> dict[str, Any]:
        raw_result = self._load_result_json(result_json_path)
        with self._connect() as conn:
            row = self._get_run_row(conn, run_id)
            if not row:
                raise OrchestrationError(f"Run {run_id} was not found.")
            run = OrchestrationRun.from_row(row)
            if run.status not in {"apply_prepared", "fill_requested"}:
                raise OrchestrationError(
                    f"Run {run_id} must be in apply_prepared or fill_requested before a fill result can be recorded."
                )

            run_dir = self._run_dir(run_id)
            fill_result_path = self._write_json_artifact(run_dir / "fill_result.json", raw_result)
            review_flags = self._derive_review_flags(run=run, fill_result=raw_result)
            browser_summary_path = self._write_json_artifact(
                run_dir / "browser_summary.json",
                self._browser_summary(run=run, fill_result=raw_result, review_flags=review_flags),
            )

            normalized_status = _normalize_status(raw_result.get("status"), default="unknown")
            if review_flags:
                new_status = "manual_review"
                completed_at = None
                manual_review_required = 1
                manual_review_reason = review_flags[0]
                job_status = "claimed"
            elif normalized_status in FAILURE_STATUSES:
                new_status = "failed"
                completed_at = utc_now_iso()
                manual_review_required = 0
                manual_review_reason = None
                job_status = "failed"
            else:
                new_status = "awaiting_submit_approval"
                completed_at = None
                manual_review_required = 0
                manual_review_reason = None
                job_status = "claimed"

            decision_payload = {
                "run_id": run_id,
                "job_id": run.job_id,
                "previous_status": run.status,
                "new_status": new_status,
                "manual_review_required": bool(manual_review_required),
                "manual_review_reason": manual_review_reason,
                "manual_review_flags": review_flags,
            }
            decision_path = self._write_json_artifact(run_dir / "decisions.json", decision_payload)
            now = utc_now_iso()
            conn.execute(
                """
                UPDATE orchestration_runs
                SET status = ?, fill_result_path = ?, browser_summary_path = ?, decision_path = ?,
                    manual_review_required = ?, manual_review_reason = ?, manual_review_flags_json = ?,
                    updated_at = ?, completed_at = ?
                WHERE id = ?
                """,
                (
                    new_status,
                    fill_result_path,
                    browser_summary_path,
                    decision_path,
                    manual_review_required,
                    manual_review_reason,
                    json.dumps(review_flags),
                    now,
                    completed_at,
                    run_id,
                ),
            )
            self._update_job_status(conn, run.job_id, job_status)
            self._append_event(
                conn,
                run_id=run_id,
                event_type="fill_recorded",
                step_name="fill_result",
                payload=decision_payload,
                payload_path=fill_result_path,
            )
            if new_status == "failed":
                final_status_path = self._write_json_artifact(
                    run_dir / "final_status.json",
                    {"run_id": run_id, "job_id": run.job_id, "status": "failed", "recorded_at": now},
                )
                conn.execute("UPDATE orchestration_runs SET final_status_path = ? WHERE id = ?", (final_status_path, run_id))
            conn.commit()

        updated_run = self.get_run(run_id)
        if updated_run is None:
            raise OrchestrationError(f"Run {run_id} disappeared after recording fill.")
        return {
            "run": updated_run.to_dict(),
            "manual_review_flags": review_flags,
            "browser_summary_path": browser_summary_path,
            "decision_path": decision_path,
        }

    def resolve_review(self, run_id: str, *, decision: str, approved_by: str, reason: str = "") -> dict[str, Any]:
        normalized_decision = _normalize_status(decision, default="")
        if normalized_decision not in {"continue", "fail"}:
            raise OrchestrationError("Review resolution decision must be 'continue' or 'fail'.")

        with self._connect() as conn:
            row = self._get_run_row(conn, run_id)
            if not row:
                raise OrchestrationError(f"Run {run_id} was not found.")
            run = OrchestrationRun.from_row(row)
            if run.status != "manual_review":
                raise OrchestrationError(f"Run {run_id} is not waiting on manual review.")

            now = utc_now_iso()
            review_resolution_path = self._write_json_artifact(
                self._run_dir(run_id) / "review_resolution.json",
                {
                    "run_id": run_id,
                    "job_id": run.job_id,
                    "decision": normalized_decision,
                    "approved_by": approved_by,
                    "reason": reason or None,
                    "resolved_at": now,
                },
            )
            if normalized_decision == "continue":
                new_status = "awaiting_submit_approval"
                completed_at = None
                job_status = "claimed"
            else:
                new_status = "failed"
                completed_at = now
                job_status = "failed"

            conn.execute(
                """
                UPDATE orchestration_runs
                SET status = ?, manual_review_required = 0, manual_review_reason = NULL,
                    updated_at = ?, completed_at = ?
                WHERE id = ?
                """,
                (new_status, now, completed_at, run_id),
            )
            self._update_job_status(conn, run.job_id, job_status)
            self._append_event(
                conn,
                run_id=run_id,
                event_type="manual_review_resolved",
                step_name="manual_review",
                payload={"decision": normalized_decision, "approved_by": approved_by, "reason": reason or None},
                payload_path=review_resolution_path,
            )
            if normalized_decision == "fail":
                final_status_path = self._write_json_artifact(
                    self._run_dir(run_id) / "final_status.json",
                    {"run_id": run_id, "job_id": run.job_id, "status": "failed", "recorded_at": now, "reason": reason or None},
                )
                conn.execute("UPDATE orchestration_runs SET final_status_path = ? WHERE id = ?", (final_status_path, run_id))
            conn.commit()

        updated_run = self.get_run(run_id)
        if updated_run is None:
            raise OrchestrationError(f"Run {run_id} disappeared after review resolution.")
        return {"run": updated_run.to_dict(), "review_resolution_path": review_resolution_path}

    def approve_submit(self, run_id: str, *, decision: str, approved_by: str, reason: str = "", approval_mode: str = "operator") -> dict[str, Any]:
        normalized_decision = _normalize_status(decision, default="")
        if normalized_decision not in {"approve", "deny"}:
            raise OrchestrationError("Submit approval decision must be 'approve' or 'deny'.")

        with self._connect() as conn:
            row = self._get_run_row(conn, run_id)
            if not row:
                raise OrchestrationError(f"Run {run_id} was not found.")
            run = OrchestrationRun.from_row(row)
            if run.status != "awaiting_submit_approval":
                raise OrchestrationError(f"Run {run_id} is not waiting on submit approval.")

            now = utc_now_iso()
            approval_id = f"approval-{uuid.uuid4().hex[:12]}"
            approval_path = self._write_json_artifact(
                self.runtime_root / "approvals" / str(run.job_id) / f"{now.replace(':', '-').replace('+00:00', 'Z')}_{approval_id}.json",
                {
                    "approval_id": approval_id,
                    "run_id": run_id,
                    "job_id": run.job_id,
                    "approval_mode": approval_mode,
                    "approved_by": approved_by,
                    "decision": normalized_decision,
                    "reason": reason or None,
                    "created_at": now,
                },
            )
            conn.execute(
                """
                INSERT INTO submit_approvals (
                    id, job_id, orchestration_run_id, approval_mode, approved_by, decision, reason, artifact_path, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (approval_id, run.job_id, run_id, approval_mode, approved_by, normalized_decision, reason or None, approval_path, now),
            )
            if normalized_decision == "approve":
                new_status = "submit_approved"
                submit_allowed = 1
                completed_at = None
                job_status = "claimed"
            else:
                new_status = "submit_denied"
                submit_allowed = 0
                completed_at = now
                job_status = "skipped"

            conn.execute(
                """
                UPDATE orchestration_runs
                SET status = ?, submit_allowed = ?, submit_approval_id = ?, updated_at = ?, completed_at = ?
                WHERE id = ?
                """,
                (new_status, submit_allowed, approval_id, now, completed_at, run_id),
            )
            self._update_job_status(conn, run.job_id, job_status)
            self._append_event(
                conn,
                run_id=run_id,
                event_type="submit_approval_recorded",
                step_name="submit_gate",
                payload={"approval_id": approval_id, "decision": normalized_decision, "approved_by": approved_by, "reason": reason or None},
                payload_path=approval_path,
            )
            if normalized_decision == "deny":
                final_status_path = self._write_json_artifact(
                    self._run_dir(run_id) / "final_status.json",
                    {"run_id": run_id, "job_id": run.job_id, "status": "submit_denied", "approval_id": approval_id, "recorded_at": now},
                )
                conn.execute("UPDATE orchestration_runs SET final_status_path = ? WHERE id = ?", (final_status_path, run_id))
            conn.commit()

        updated_run = self.get_run(run_id)
        approval = self.get_submit_approval(approval_id)
        if updated_run is None or approval is None:
            raise OrchestrationError(f"Approval state for run {run_id} could not be reloaded.")
        return {"run": updated_run.to_dict(), "approval": approval.to_dict()}

    def get_submit_approval(self, approval_id: str) -> SubmitApproval | None:
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM submit_approvals WHERE id = ?", (approval_id,)).fetchone()
            return SubmitApproval.from_row(row) if row else None

    def mark_submitted(self, run_id: str, *, summary_json_path: str | Path | None = None) -> dict[str, Any]:
        submitted_summary = {}
        if summary_json_path:
            submitted_summary = self._load_result_json(summary_json_path)

        with self._connect() as conn:
            row = self._get_run_row(conn, run_id)
            if not row:
                raise OrchestrationError(f"Run {run_id} was not found.")
            run = OrchestrationRun.from_row(row)
            if run.status != "submit_approved":
                raise OrchestrationError(f"Run {run_id} is not approved for submit.")

            now = utc_now_iso()
            final_status_path = self._write_json_artifact(
                self._run_dir(run_id) / "final_status.json",
                {"run_id": run_id, "job_id": run.job_id, "status": "submitted", "submitted_at": now, "summary": submitted_summary},
            )
            conn.execute(
                """
                UPDATE orchestration_runs
                SET status = 'submitted', final_status_path = ?, updated_at = ?, completed_at = ?
                WHERE id = ?
                """,
                (final_status_path, now, now, run_id),
            )
            self._update_job_status(conn, run.job_id, "applied")
            self._append_event(
                conn,
                run_id=run_id,
                event_type="submitted",
                step_name="final_submit",
                payload={"submitted_at": now},
                payload_path=final_status_path,
            )
            conn.commit()

        updated_run = self.get_run(run_id)
        if updated_run is None:
            raise OrchestrationError(f"Run {run_id} disappeared after submission.")
        return {"run": updated_run.to_dict(), "final_status_path": final_status_path}

    def pick_next_job(self) -> dict[str, Any]:
        with self._connect() as conn:
            active_run = self._get_executing_run(conn)
            if active_run:
                return {
                    "decision": "blocked",
                    "reason": "active_run_in_progress",
                    "active_run_id": str(active_run["id"]),
                    "job_id": int(active_run["job_id"]),
                }
            global_hold_rows = self._get_global_hold_rows(conn)
            if global_hold_rows:
                return {
                    "decision": "blocked",
                    "reason": "global_manual_review_hold",
                    "run_ids": [str(row["id"]) for row in global_hold_rows],
                    "reasons": _dedupe([_text(row["manual_review_reason"]) for row in global_hold_rows]),
                }
            for row in self._list_job_rows(conn):
                decision = self._decision_from_row(conn, row)
                if decision.ready:
                    return {
                        "decision": "picked",
                        "job_id": decision.job_id,
                        "source": decision.source,
                        "ats_type": decision.ats_type,
                        "reason": "ready",
                    }
            return {"decision": "idle", "reason": "no_ready_jobs"}

    def run_job(self, job_id: int, *, source_runtime: str = "manual", embed_resume_data: bool = False, prepare_only: bool = False) -> dict[str, Any]:
        context = self.build_apply_context(job_id, source_runtime=source_runtime, embed_resume_data=embed_resume_data)
        if prepare_only:
            run = self.get_run(context.run_id)
            if run is None:
                raise OrchestrationError(f"Run {context.run_id} could not be loaded after apply-prep.")
            return {"decision": "prepared", "run": run.to_dict(), "apply_context": context.to_dict()}
        fill_request = self.request_fill(context.run_id)
        return {
            "decision": "fill_requested",
            "run": fill_request["run"],
            "apply_context": context.to_dict(),
            "fill_request_path": fill_request["fill_request_path"],
        }

    def run_once(self, *, source_runtime: str = "scheduler", embed_resume_data: bool = False, prepare_only: bool = False) -> dict[str, Any]:
        pick = self.pick_next_job()
        if pick["decision"] != "picked":
            return pick
        result = self.run_job(
            int(pick["job_id"]),
            source_runtime=source_runtime,
            embed_resume_data=embed_resume_data,
            prepare_only=prepare_only,
        )
        return {"picked": pick, **result}
