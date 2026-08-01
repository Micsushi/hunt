import type {
  EventEnvelope,
  JourneyProgress,
} from "../../contracts/index.ts";

const terminalStatuses = new Set<JourneyProgress["status"]>([
  "review_reached",
  "blocked",
  "cancelled",
  "failed",
]);

export function terminalStatus(
  event: EventEnvelope,
): Extract<JourneyProgress["status"], "review_reached" | "blocked" | "cancelled" | "failed"> | undefined {
  if (event.kind !== "journey_terminal") return undefined;
  if (
    event.component === "F9" &&
    event.phase === "orchestration" &&
    event.step === "stop_review"
  ) return "review_reached";
  if (
    event.component === "F9" &&
    event.phase === "orchestration" &&
    event.step === "cancel"
  ) return "cancelled";
  if (
    (event.component === "F5" &&
      event.phase === "page_understanding" &&
      event.step === "classify") ||
    (event.component === "F6" &&
      event.phase === "answer_resolution" &&
      event.step === "resolve") ||
    (event.component === "F8" &&
      event.phase === "verification" &&
      event.step === "verify")
  ) return "blocked";
  if (event.phase === "terminal") return "failed";
  return undefined;
}

export function projectProgress(
  events: readonly EventEnvelope[],
  journeyId: string,
): JourneyProgress | undefined {
  let progress: JourneyProgress | undefined;

  for (const event of events) {
    if (event.journeyId !== journeyId) continue;
    progress ??= { journeyId: event.journeyId, status: "running", completedSteps: 0 };
    if (terminalStatuses.has(progress.status)) continue;

    if (event.kind === "step_completed") {
      progress = { ...progress, completedSteps: progress.completedSteps + 1 };
    } else if (event.kind === "step_failed") {
      progress = { ...progress, status: "failed" };
    } else {
      const status = terminalStatus(event);
      if (status !== undefined) progress = { ...progress, status };
    }
  }
  return progress;
}
