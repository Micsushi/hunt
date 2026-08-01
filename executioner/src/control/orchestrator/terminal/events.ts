import type {
  ComponentId,
  EventKind,
  JourneyId,
  OperationId,
  PhaseId,
  StepId,
} from "../../../contracts/index.ts";
import type { JourneyOrchestratorDependencies } from "./types.ts";

export async function appendJourneyEvent(
  dependencies: JourneyOrchestratorDependencies,
  journeyId: JourneyId,
  coordinates: {
    readonly kind: EventKind;
    readonly component: ComponentId;
    readonly phase: PhaseId;
    readonly step: StepId;
    readonly sourceId: OperationId;
  },
  signal: AbortSignal,
  retryLimit = 0,
) {
  const request = {
    event: {
      schemaVersion: 2,
      eventId: dependencies.nextEventId(),
      journeyId,
      component: coordinates.component,
      phase: coordinates.phase,
      step: coordinates.step,
      kind: coordinates.kind,
      at: dependencies.clock(),
      source: { kind: "operation", id: coordinates.sourceId },
    },
  } as const;
  for (let attempt = 0; ; attempt += 1) {
    const result = await dependencies.events.append(request, signal);
    if (result.ok || !result.error.retryable || attempt >= retryLimit) {
      return result;
    }
  }
}
