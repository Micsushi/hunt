from __future__ import annotations

from .models import ApplyContext, OrchestrationRun, ReadyJobDecision


class OrchestrationService:
    """Contract-shaped placeholder for Component 4 orchestration logic."""

    def get_ready_decision(self, job_id: int) -> ReadyJobDecision:
        return ReadyJobDecision(
            job_id=job_id,
            ready=False,
            reason="not_implemented",
            flags=["component4_skeleton"],
        )

    def build_apply_context(self, job_id: int) -> ApplyContext:
        return ApplyContext(
            job_id=job_id,
            manual_review_flags=["not_implemented"],
        )

    def start_run(self, job_id: int, source_runtime: str = "manual") -> OrchestrationRun:
        return OrchestrationRun(
            run_id=f"stub-{job_id}",
            job_id=job_id,
            status="not_implemented",
            source_runtime=source_runtime,
        )
