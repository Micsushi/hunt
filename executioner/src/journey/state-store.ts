import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { types as utilTypes } from "node:util";

import {
  ContractParseError,
  parseDurableJourneyState,
  providerError,
  type CancellationError,
  type DurableJourneyState,
  type JourneyId,
  type JourneyStateError,
  type JourneyStateLoadRequest,
  type JourneyStateLoadResult,
  type JourneyStateStore,
  type JourneyStateTransitionCommand,
  type JourneyStateTransitionResult,
  type PortResult,
} from "../contracts/index.ts";
import { isAbortError } from "./cancellation.ts";

type StateResult<T> = PortResult<T, JourneyStateError | CancellationError>;

interface PersistedOperation {
  readonly signature: string;
  readonly result: JourneyStateTransitionResult;
}

interface PersistedJourney {
  readonly storageVersion: 1;
  readonly state: DurableJourneyState;
  readonly operations: Readonly<Record<string, PersistedOperation>>;
}

const legalNextStatuses = {
  ready: ["running"],
  running: ["running", "cancelling", "review_reached", "blocked", "failed"],
  cancelling: ["cancelling", "cancelled"],
  review_reached: [],
  blocked: [],
  cancelled: [],
  failed: [],
} as const;
const terminalStatuses = new Set(["review_reached", "blocked", "cancelled", "failed"]);
const mutationQueues = new Map<string, Promise<void>>();

function enqueueMutation<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = mutationQueues.get(key) ?? Promise.resolve();
  const result = previous.then(operation);
  const tail = result.then(() => undefined, () => undefined);
  mutationQueues.set(key, tail);
  void tail.then(() => {
    if (mutationQueues.get(key) === tail) mutationQueues.delete(key);
  });
  return result;
}

function exactDataRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    utilTypes.isProxy(value)
  ) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(descriptors);
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
  ) return undefined;
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) return undefined;
    result[key] = descriptor.value;
  }
  return result;
}

function ownDataRecord(value: unknown): Record<string, unknown> | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    utilTypes.isProxy(value)
  ) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") return undefined;
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) return undefined;
    result[key] = descriptor.value;
  }
  return result;
}

function validJourneyId(value: unknown): value is JourneyId {
  return typeof value === "string" &&
    /^journey_[A-Za-z0-9_-]{16,64}$/u.test(value);
}

function validOperationId(value: unknown): value is string {
  return typeof value === "string" &&
    /^operation_[A-Za-z0-9_-]{16,64}$/u.test(value);
}

function validPageId(value: unknown): boolean {
  return value === null ||
    (typeof value === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value));
}

function validLoadRequest(value: unknown): value is JourneyStateLoadRequest {
  const request = exactDataRecord(value, ["journeyId"]);
  return request !== undefined && validJourneyId(request.journeyId);
}

function validTransition(
  value: unknown,
): value is JourneyStateTransitionCommand {
  const command = exactDataRecord(value, [
    "journeyId",
    "operationId",
    "expectedRevision",
    "status",
    "pageId",
  ]);
  return command !== undefined &&
    validJourneyId(command.journeyId) &&
    validOperationId(command.operationId) &&
    Number.isSafeInteger(command.expectedRevision) &&
    (command.expectedRevision as number) >= 0 &&
    typeof command.status === "string" &&
    Object.hasOwn(legalNextStatuses, command.status) &&
    validPageId(command.pageId);
}

function commandSignature(command: JourneyStateTransitionCommand): string {
  return createHash("sha256").update(JSON.stringify([
    command.journeyId,
    command.operationId,
    command.expectedRevision,
    command.status,
    command.pageId,
  ])).digest("hex");
}

function invalidState(): TypeError {
  return new TypeError("journey_state_invalid");
}

function parseTransitionResult(value: unknown): JourneyStateTransitionResult {
  const result = exactDataRecord(value, ["state", "applied"]);
  if (result === undefined || typeof result.applied !== "boolean") {
    throw invalidState();
  }
  return Object.freeze({
    state: parseDurableJourneyState(result.state),
    applied: result.applied,
  });
}

function parsePersisted(value: unknown): PersistedJourney {
  const record = exactDataRecord(value, ["storageVersion", "state", "operations"]);
  const operations = ownDataRecord(record?.operations);
  if (record === undefined || record.storageVersion !== 1 || operations === undefined) {
    throw invalidState();
  }
  const state = parseDurableJourneyState(record.state);
  const parsedOperations: Record<string, PersistedOperation> = Object.create(null) as Record<string, PersistedOperation>;
  for (const [operationId, value] of Object.entries(operations)) {
    const operation = exactDataRecord(value, ["signature", "result"]);
    if (
      !validOperationId(operationId) ||
      operation === undefined ||
      typeof operation.signature !== "string" ||
      !/^[a-f0-9]{64}$/u.test(operation.signature)
    ) throw invalidState();
    const result = parseTransitionResult(operation.result);
    if (result.state.journeyId !== state.journeyId) throw invalidState();
    parsedOperations[operationId] = Object.freeze({
      signature: operation.signature,
      result,
    });
  }
  return Object.freeze({
    storageVersion: 1,
    state,
    operations: Object.freeze(parsedOperations),
  });
}

function stateReadError(error: unknown): JourneyStateError {
  if (
    error instanceof SyntaxError ||
    error instanceof ContractParseError ||
    (error instanceof TypeError && error.message === "journey_state_invalid")
  ) return providerError("journey_state_invalid");
  return providerError("journey_state_unavailable");
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT";
}

export class FileJourneyStateStore implements JourneyStateStore {
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = resolve(directory);
  }

  initialize(
    id: JourneyId,
    signal: AbortSignal,
  ): Promise<StateResult<DurableJourneyState>> {
    if (signal.aborted) {
      return Promise.resolve({ ok: false, error: providerError("operation_cancelled") });
    }
    if (!validJourneyId(id)) {
      return Promise.resolve({ ok: false, error: providerError("journey_state_invalid") });
    }
    return enqueueMutation(this.directory, async () => {
      if (signal.aborted) {
        return { ok: false, error: providerError("operation_cancelled") };
      }
      try {
        const existing = await this.read(id);
        if (existing !== null) return { ok: true, value: existing.state };
        const state = Object.freeze({
          schemaVersion: 3,
          journeyId: id,
          status: "ready",
          pageId: null,
          revision: 0,
        }) satisfies DurableJourneyState;
        await this.write({
          storageVersion: 1,
          state,
          operations: Object.freeze(Object.create(null) as Record<string, PersistedOperation>),
        }, signal);
        return { ok: true, value: state };
      } catch (error) {
        return isAbortError(error)
          ? { ok: false, error: providerError("operation_cancelled") }
          : { ok: false, error: stateReadError(error) };
      }
    });
  }

  async load(
    request: JourneyStateLoadRequest,
    signal: AbortSignal,
  ): Promise<StateResult<JourneyStateLoadResult>> {
    if (signal.aborted) {
      return { ok: false, error: providerError("operation_cancelled") };
    }
    if (!validLoadRequest(request)) {
      return { ok: false, error: providerError("journey_state_invalid") };
    }
    try {
      const record = await this.read(request.journeyId);
      return { ok: true, value: Object.freeze({ state: record?.state ?? null }) };
    } catch (error) {
      return { ok: false, error: stateReadError(error) };
    }
  }

  transition(
    command: JourneyStateTransitionCommand,
    signal: AbortSignal,
  ): Promise<StateResult<JourneyStateTransitionResult>> {
    if (signal.aborted) {
      return Promise.resolve({ ok: false, error: providerError("operation_cancelled") });
    }
    if (!validTransition(command)) {
      return Promise.resolve({ ok: false, error: providerError("journey_state_invalid") });
    }
    return enqueueMutation(this.directory, () => this.applyTransition(command, signal));
  }

  private async applyTransition(
    command: JourneyStateTransitionCommand,
    signal: AbortSignal,
  ): Promise<StateResult<JourneyStateTransitionResult>> {
    if (signal.aborted) {
      return { ok: false, error: providerError("operation_cancelled") };
    }
    let record: PersistedJourney | null;
    try {
      record = await this.read(command.journeyId);
    } catch (error) {
      return { ok: false, error: stateReadError(error) };
    }
    if (record === null) {
      return { ok: false, error: providerError("journey_state_unavailable") };
    }

    const signature = commandSignature(command);
    const previous = Object.hasOwn(record.operations, command.operationId)
      ? record.operations[command.operationId]
      : undefined;
    if (previous !== undefined) {
      return previous.signature === signature
        ? {
            ok: true,
            value: Object.freeze({ state: previous.result.state, applied: false }),
          }
        : { ok: false, error: providerError("journey_transition_illegal") };
    }
    if (command.expectedRevision !== record.state.revision) {
      return { ok: false, error: providerError("journey_revision_conflict") };
    }

    const terminal = terminalStatuses.has(record.state.status);
    const unchanged = command.status === record.state.status &&
      command.pageId === record.state.pageId;
    if (terminal && !unchanged) {
      return { ok: false, error: providerError("journey_transition_illegal") };
    }
    if (
      !terminal &&
      !(legalNextStatuses[record.state.status] as readonly string[]).includes(command.status)
    ) {
      return { ok: false, error: providerError("journey_transition_illegal") };
    }

    const state = terminal
      ? record.state
      : Object.freeze({
          schemaVersion: 3,
          journeyId: record.state.journeyId,
          status: command.status,
          pageId: command.pageId,
          revision: record.state.revision + 1,
        }) satisfies DurableJourneyState;
    const result = Object.freeze({ state, applied: !terminal });
    const operation = Object.freeze({ signature, result });
    const operations = Object.freeze({
      ...record.operations,
      [command.operationId]: operation,
    });
    try {
      await this.write({
        storageVersion: 1,
        state,
        operations,
      }, signal);
    } catch (error) {
      return isAbortError(error)
        ? { ok: false, error: providerError("operation_cancelled") }
        : { ok: false, error: providerError("journey_state_unavailable") };
    }
    return { ok: true, value: result };
  }

  private path(id: JourneyId): string {
    const filename = createHash("sha256").update(id).digest("hex");
    return join(this.directory, `${filename}.json`);
  }

  private async read(id: JourneyId): Promise<PersistedJourney | null> {
    try {
      const record = parsePersisted(JSON.parse(await readFile(this.path(id), "utf8")));
      if (record.state.journeyId !== id) throw invalidState();
      return record;
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw error;
    }
  }

  private async write(record: PersistedJourney, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new DOMException("operation_cancelled", "AbortError");
    await mkdir(this.directory, { recursive: true });
    const destination = this.path(record.state.journeyId);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(record), {
        encoding: "utf8",
        signal,
      });
      if (signal.aborted) throw new DOMException("operation_cancelled", "AbortError");
      await rename(temporary, destination);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}
