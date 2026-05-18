"""C4 Pipeline Scheduler — hardcoded loop over ready jobs, no LLM."""

from __future__ import annotations

import threading
from datetime import UTC, datetime
from typing import Any

from .service import OrchestrationService


class SchedulerLoop:
    """Iterates ready jobs, requests C3 fill for each, records the result.

    No LLM involved. All routing happens in OrchestrationService.
    """

    def __init__(
        self,
        service: OrchestrationService,
        *,
        interval_seconds: int = 60,
        source_runtime: str = "scheduler",
        browser_lane: str | None = None,
    ) -> None:
        self.service = service
        self.interval = interval_seconds
        self.source_runtime = source_runtime
        self.browser_lane = browser_lane
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._running = False
        self._last_tick: str | None = None
        self._tick_count = 0
        self._last_tick_result: dict[str, Any] | None = None

    def tick(self) -> dict[str, Any]:
        """Run one scheduler pass: pick the next ready job and request fill.

        Returns the result from run_once (decision + run details).
        """
        result = self.service.run_once(
            source_runtime=self.source_runtime,
            browser_lane=self.browser_lane,
        )
        self._last_tick = datetime.now(UTC).replace(microsecond=0).isoformat()
        self._tick_count += 1
        self._last_tick_result = result
        return result

    def start(self) -> None:
        """Start the scheduler loop in a background daemon thread."""
        if self._running:
            return
        self._stop.clear()
        self._running = True
        self._thread = threading.Thread(target=self._loop, daemon=True, name="c4-scheduler")
        self._thread.start()

    def stop(self) -> None:
        """Signal the scheduler loop to stop after the current sleep."""
        self._stop.set()
        self._running = False

    def status(self) -> dict[str, Any]:
        return {
            "running": self._running,
            "interval_seconds": self.interval,
            "last_tick": self._last_tick,
            "tick_count": self._tick_count,
            "last_tick_result": self._last_tick_result,
        }

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                self.tick()
            except Exception:
                pass
            self._stop.wait(self.interval)


# Module-level singleton, instantiated lazily by the API layer.
_scheduler: SchedulerLoop | None = None


def get_scheduler(service: OrchestrationService | None = None) -> SchedulerLoop:
    """Return the module-level scheduler, creating it if needed."""
    global _scheduler
    if _scheduler is None:
        if service is None:
            service = OrchestrationService()
        _scheduler = SchedulerLoop(service)
    return _scheduler
