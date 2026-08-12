import type {
  AccountFieldName,
  OwnedAccountPageAccess,
  SemanticAccountPageAdapter,
  SemanticControlFact,
} from "./account-page-types.ts";
import type {
  LivePortResult,
  PersistentBrowserErrorCode,
} from "../../../contracts/live/index.ts";
import { bounded, cancelled, failure } from "./port-results.ts";
import type { PersistentPage } from "./types.ts";

export class OwnedAccountPageAccessScope implements OwnedAccountPageAccess {
  readonly #page: PersistentPage;
  readonly #adapter: SemanticAccountPageAdapter;
  readonly #signal: AbortSignal;
  readonly #timeoutMs: number;
  readonly #revalidate: () => Promise<LivePortResult<void, PersistentBrowserErrorCode>>;
  readonly #revalidateAfterActivation: () => Promise<LivePortResult<void, PersistentBrowserErrorCode>>;
  readonly #invalidate: () => Promise<void>;
  readonly #unverifiedFields = new Set<AccountFieldName>();
  #terminalError: PersistentBrowserErrorCode | "operation_cancelled" | undefined;
  #active = true;
  #effectStarted = false;

  constructor(
    page: PersistentPage,
    adapter: SemanticAccountPageAdapter,
    signal: AbortSignal,
    timeoutMs: number,
    revalidate: () => Promise<LivePortResult<void, PersistentBrowserErrorCode>>,
    invalidate: () => Promise<void>,
    revalidateAfterActivation = revalidate,
  ) {
    this.#page = page;
    this.#adapter = adapter;
    this.#signal = signal;
    this.#timeoutMs = timeoutMs;
    this.#revalidate = revalidate;
    this.#revalidateAfterActivation = revalidateAfterActivation;
    this.#invalidate = invalidate;
  }

  inspectField(
    field: Parameters<OwnedAccountPageAccess["inspectField"]>[0],
  ) {
    return this.#inspect(field);
  }

  inspectAction(
    action: Parameters<OwnedAccountPageAccess["inspectAction"]>[0],
  ) {
    return this.#inspect(action);
  }

  fill(field: AccountFieldName, bytes: Uint8Array) {
    return this.#fieldEffect(field, bytes, "fill");
  }

  matches(field: AccountFieldName, bytes: Uint8Array) {
    return this.#readBytes(field, bytes);
  }

  clear(field: AccountFieldName) {
    return this.#fieldEffect(field, undefined, "clear");
  }

  isEmpty(field: AccountFieldName) {
    return this.#readEmpty(field);
  }

  async activate(
    action: Parameters<OwnedAccountPageAccess["activate"]>[0],
  ) {
    const admitted = await this.#inspect(action);
    if (!admitted.ok) return admitted;
    if (admitted.value.cardinality !== 1) {
      return failure(
        admitted.value.cardinality > 1
          ? "browser_target_ambiguous"
          : "browser_target_invalid",
      );
    }
    if (!admitted.value.actionable) return failure("browser_target_invalid");
    if (this.#signal.aborted) return this.#cancel();
    this.#effectStarted = true;
    const applied = await bounded(
      this.#adapter.activate(this.#page, action),
      this.#signal,
      this.#timeoutMs,
    );
    if (applied.kind !== "value") return this.#uncertain();
    const ownership = await this.#revalidateAfterActivation();
    if (!ownership.ok) return this.#uncertain();
    return { ok: true, value: undefined } as const;
  }

  get terminalError(): PersistentBrowserErrorCode | "operation_cancelled" | undefined {
    return this.#terminalError;
  }

  get hasUnverifiedEffect(): boolean {
    return this.#unverifiedFields.size > 0;
  }

  get effectStarted(): boolean { return this.#effectStarted; }

  deactivate(): void {
    this.#active = false;
  }

  async #inspect(control: Parameters<SemanticAccountPageAdapter["inspect"]>[1]) {
    if (!this.#active) return failure("browser_session_invalidated");
    if (this.#signal.aborted) return this.#cancel();
    const inspected = await bounded(
      this.#adapter.inspect(this.#page, control),
      this.#signal,
      this.#timeoutMs,
    );
    if (inspected.kind === "cancelled") return this.#cancel();
    if (inspected.kind === "timeout") return failure("browser_timeout");
    if (inspected.kind === "error" || !validFact(inspected.value)) {
      return failure("browser_target_invalid");
    }
    return { ok: true, value: inspected.value } as const;
  }

  async #fieldEffect(
    field: AccountFieldName,
    bytes: Uint8Array | undefined,
    kind: "fill" | "clear",
  ) {
    const admitted = await this.#inspect(field);
    if (!admitted.ok) return admitted;
    if (admitted.value.cardinality !== 1) {
      return failure(
        admitted.value.cardinality > 1
          ? "browser_target_ambiguous"
          : "browser_target_invalid",
      );
    }
    if (!admitted.value.actionable) return failure("browser_target_invalid");
    if (this.#signal.aborted) return this.#cancel();
    this.#effectStarted = true;
    const transient = bytes?.slice();
    const action = kind === "fill"
      ? this.#adapter.fill(this.#page, field, transient!)
      : this.#adapter.clear(this.#page, field);
    const applied = await bounded(action, this.#signal, this.#timeoutMs);
    transient?.fill(0);
    if (applied.kind !== "value") return this.#uncertain();
    this.#unverifiedFields.add(field);
    const ownership = await this.#revalidate();
    if (!ownership.ok) return this.#uncertain();
    return { ok: true, value: undefined } as const;
  }

  async #readBytes(field: AccountFieldName, bytes: Uint8Array) {
    if (!this.#active) return failure("browser_session_invalidated");
    if (this.#signal.aborted) return this.#cancel();
    const transient = bytes.slice();
    const read = await bounded(
      this.#adapter.matches(this.#page, field, transient),
      this.#signal,
      this.#timeoutMs,
    );
    transient.fill(0);
    if (read.kind === "cancelled" || read.kind === "timeout") {
      return this.#unverifiedFields.has(field)
        ? this.#uncertain()
        : read.kind === "cancelled"
          ? this.#cancel()
          : failure("browser_timeout");
    }
    if (read.kind === "error") {
      return this.#unverifiedFields.has(field)
        ? this.#uncertain()
        : failure("browser_target_invalid");
    }
    const ownership = await this.#revalidate();
    if (!ownership.ok) {
      return this.#unverifiedFields.has(field)
        ? this.#uncertain()
        : this.#invalidated();
    }
    if (read.value) this.#unverifiedFields.delete(field);
    return { ok: true, value: read.value } as const;
  }

  async #readEmpty(field: AccountFieldName) {
    if (!this.#active) return failure("browser_session_invalidated");
    if (this.#signal.aborted) return this.#cancel();
    const read = await bounded(
      this.#adapter.isEmpty(this.#page, field),
      this.#signal,
      this.#timeoutMs,
    );
    if (read.kind === "cancelled" || read.kind === "timeout") {
      return this.#unverifiedFields.has(field)
        ? this.#uncertain()
        : read.kind === "cancelled"
          ? this.#cancel()
          : failure("browser_timeout");
    }
    if (read.kind === "error") {
      return this.#unverifiedFields.has(field)
        ? this.#uncertain()
        : failure("browser_target_invalid");
    }
    const ownership = await this.#revalidate();
    if (!ownership.ok) {
      return this.#unverifiedFields.has(field)
        ? this.#uncertain()
        : this.#invalidated();
    }
    if (read.value) this.#unverifiedFields.delete(field);
    return { ok: true, value: read.value } as const;
  }

  async #uncertain() {
    this.#terminalError = "browser_effect_uncertain";
    this.#active = false;
    return failure("browser_effect_uncertain");
  }

  async #invalidated() {
    this.#terminalError = "browser_session_invalidated";
    this.#active = false;
    return failure("browser_session_invalidated");
  }

  #cancel() {
    this.#terminalError = "operation_cancelled";
    this.#active = false;
    return cancelled();
  }
}

function validFact(value: SemanticControlFact): boolean {
  return Number.isSafeInteger(value.cardinality) &&
    value.cardinality >= 0 &&
    value.cardinality <= 16 &&
    typeof value.actionable === "boolean";
}
