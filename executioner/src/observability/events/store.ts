import { isDeepStrictEqual } from "node:util";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  copyContractDataGraph,
  journeyId,
  parseEventEnvelope,
  providerError,
  type EventAppendRequest,
  type EventEnvelope,
  type EventSink,
  type JourneyProgress,
  type ProgressReadRequest,
  type ProgressReader,
} from "../../contracts/index.ts";
import { projectProgress, terminalStatus } from "../progress/project.ts";

const pathQueues = new Map<string, Promise<void>>();

export class JsonlEventStore implements EventSink, ProgressReader {
  readonly #path: string;

  constructor(path: string) {
    this.#path = resolve(path);
  }

  append(request: EventAppendRequest, signal: AbortSignal) {
    return this.#serialized(async () => {
      if (signal.aborted) return cancelled();

      const event = admittedEvent(request);
      if (event === undefined) return invalidEvent();

      try {
        const events = await this.#events(signal);
        if (signal.aborted) return cancelled();
        const existing = events.find(({ eventId }) => eventId === event.eventId);
        if (existing !== undefined) {
          if (!isDeepStrictEqual(existing, event)) return invalidEvent();
          return appendSuccess(false, projectProgress(events, event.journeyId)!);
        }

        await mkdir(dirname(this.#path), { recursive: true });
        if (signal.aborted) return cancelled();
        await appendFile(this.#path, `${JSON.stringify(event)}\n`, "utf8");
        return appendSuccess(
          true,
          projectProgress([...events, event], event.journeyId)!,
        );
      } catch (error) {
        return signal.aborted || isAbortError(error)
          ? cancelled()
          : { ok: false, error: providerError("event_store_unavailable") } as const;
      }
    });
  }

  read(request: ProgressReadRequest, signal: AbortSignal) {
    return this.#serialized(async () => {
      if (signal.aborted) return cancelled();
      const id = admittedJourneyId(request);
      if (id === undefined) return invalidEvent();
      try {
        const progress = projectProgress(await this.#events(signal), id);
        if (signal.aborted) return cancelled();
        return progress === undefined
          ? { ok: false, error: providerError("progress_not_found") } as const
          : { ok: true, value: progress } as const;
      } catch (error) {
        return signal.aborted || isAbortError(error)
          ? cancelled()
          : { ok: false, error: providerError("event_store_unavailable") } as const;
      }
    });
  }

  async #events(signal: AbortSignal): Promise<EventEnvelope[]> {
    let contents: string;
    try {
      contents = await readFile(this.#path, { encoding: "utf8", signal });
    } catch (error) {
      if (isMissingFile(error)) return [];
      throw error;
    }
    return contents
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => parseEventEnvelope(JSON.parse(line)));
  }

  #serialized<T>(operation: () => Promise<T>): Promise<T> {
    const pending = pathQueues.get(this.#path) ?? Promise.resolve();
    const result = pending.then(operation, operation);
    const settled = result.then(() => undefined, () => undefined);
    pathQueues.set(this.#path, settled);
    void settled.then(() => {
      if (pathQueues.get(this.#path) === settled) pathQueues.delete(this.#path);
    });
    return result;
  }
}

function admittedEvent(request: unknown): EventEnvelope | undefined {
  try {
    const copied = copyContractDataGraph(request);
    if (!copied.ok || !isRecord(copied.value)) return undefined;
    if (
      Object.keys(copied.value).length !== 1 ||
      !Object.hasOwn(copied.value, "event")
    ) return undefined;
    const event = parseEventEnvelope(copied.value.event);
    if (
      !isCanonicalTimestamp(event.at) ||
      (event.kind === "journey_terminal" && terminalStatus(event) === undefined)
    ) {
      return undefined;
    }
    return event;
  } catch {
    return undefined;
  }
}

function admittedJourneyId(request: unknown): JourneyProgress["journeyId"] | undefined {
  try {
    const copied = copyContractDataGraph(request);
    if (
      !copied.ok ||
      !isRecord(copied.value) ||
      Object.keys(copied.value).length !== 1 ||
      !Object.hasOwn(copied.value, "journeyId")
    ) return undefined;
    const value = copied.value.journeyId;
    return typeof value === "string" ? journeyId(value) : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCanonicalTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    return false;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function appendSuccess(appended: boolean, progress: JourneyProgress) {
  return { ok: true, value: { appended, progress } } as const;
}

function cancelled() {
  return { ok: false, error: providerError("operation_cancelled") } as const;
}

function invalidEvent() {
  return { ok: false, error: providerError("event_invalid") } as const;
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}
