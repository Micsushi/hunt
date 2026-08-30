import {
  chromium,
  errors,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";

import {
  browserPageId,
  consumeBrowserMutationAdmission,
  consumeBrowserNavigationAdmission,
  generatedSessionId,
  providerError,
  sha256Digest,
  useResumeArtifactUpload,
  type BrowserCloseRequest,
  type BrowserEffectError,
  type BrowserNavigationObservation,
  type BrowserNavigationRequest,
  type BrowserObservation,
  type BrowserObservationRequest,
  type BrowserOperationReceipt,
  type BrowserMutation,
  type BrowserMutationRequest,
  type BrowserSession,
  type BrowserSessionError,
  type BrowserSessionResult,
  type BrowserStartRequest,
  type CancellationError,
  type GeneratedIdAllocator,
  type PortResult,
} from "../contracts/index.ts";
import {
  applyMutation,
  clickNext,
  inspectPage,
  type ResolvedBrowserTarget,
  type UploadedArtifactReadback,
} from "./adapter.ts";

type SessionResult<T> = Promise<
  PortResult<T, BrowserSessionError | CancellationError>
>;
type EffectResult<T> = Promise<
  PortResult<T, BrowserEffectError | CancellationError>
>;

export interface PlaywrightBrowserSessionOptions {
  readonly context?: BrowserContext;
  readonly attached?: {
    readonly page: Page;
    readonly sessionId: BrowserSessionResult["sessionId"];
    readonly pageId: BrowserSessionResult["pageId"];
  };
  readonly ids: GeneratedIdAllocator;
  readonly timeoutMs?: number;
}

export class PlaywrightBrowserSession implements BrowserSession {
  readonly #externalContext: BrowserContext | undefined;
  readonly #ids: GeneratedIdAllocator;
  readonly #timeoutMs: number;
  readonly #attached: boolean;
  #browser: Browser | undefined;
  #context: BrowserContext | undefined;
  #page: Page | undefined;
  #sessionId: BrowserSessionResult["sessionId"] | undefined;
  #pageId: BrowserSessionResult["pageId"] | undefined;
  #closedSessionId: BrowserSessionResult["sessionId"] | undefined;
  #starting = false;
  #invalidated = false;
  #targets = new Map<string, readonly ResolvedBrowserTarget[]>();
  readonly #seenTargets = new Set<string>();
  readonly #uploads = new Map<string, UploadedArtifactReadback>();
  readonly #mutationOperations = new Set<string>();
  readonly #navigationOperations = new Set<string>();

  constructor(options: PlaywrightBrowserSessionOptions) {
    if (options.attached !== undefined && options.context !== undefined) {
      throw new TypeError("attached page cannot be combined with a browser context");
    }
    this.#externalContext = options.context;
    this.#ids = options.ids;
    this.#timeoutMs = options.timeoutMs ?? 5_000;
    this.#attached = options.attached !== undefined;
    if (options.attached !== undefined) {
      this.#page = options.attached.page;
      this.#sessionId = options.attached.sessionId;
      this.#pageId = options.attached.pageId;
    }
  }

  async start(
    request: BrowserStartRequest,
    signal: AbortSignal,
  ): SessionResult<BrowserSessionResult> {
    if (signal.aborted) return cancelled();
    if (this.#attached) return failure("browser_page_owned");
    if (this.#invalidated) {
      await this.#releaseOwnedResources();
      this.#invalidated = false;
    }
    if (this.#page !== undefined || this.#starting) {
      return failure("browser_page_owned");
    }

    let target: URL;
    try {
      target = new URL(request.target);
    } catch {
      return failure("browser_target_invalid");
    }
    if (!new Set(["data:", "http:", "https:"]).has(target.protocol)) {
      return failure("browser_target_invalid");
    }

    this.#starting = true;
    try {
      if (this.#externalContext === undefined) {
        this.#browser = await chromium.launch();
        this.#context = await this.#browser.newContext();
      } else {
        this.#context = this.#externalContext;
      }
      this.#page = await this.#context.newPage();
      const navigation = await bounded(
        this.#page.goto(request.target, {
          timeout: 0,
          waitUntil: "domcontentloaded",
        }),
        signal,
        this.#timeoutMs,
      );
      if (navigation.kind === "cancelled") {
        await this.#releaseOwnedResources();
        return cancelled();
      }
      if (navigation.kind === "timeout") {
        await this.#releaseOwnedResources();
        return failure("browser_timeout");
      }
      if (navigation.kind === "error") throw navigation.error;

      const allocated = generatedSessionId(this.#ids);
      if (!allocated.ok) {
        await this.#releaseOwnedResources();
        return allocated;
      }
      this.#sessionId = allocated.value;
      this.#pageId = await currentPageId(this.#page);
      this.#closedSessionId = undefined;
      this.#targets.clear();
      this.#seenTargets.clear();
      this.#uploads.clear();
      this.#mutationOperations.clear();
      this.#navigationOperations.clear();
      return {
        ok: true,
        value: { sessionId: this.#sessionId, pageId: this.#pageId },
      };
    } catch (error) {
      await this.#releaseOwnedResources();
      return error instanceof errors.TimeoutError
        ? failure("browser_timeout")
        : failure("browser_target_invalid");
    } finally {
      this.#starting = false;
    }
  }

  async close(
    request: BrowserCloseRequest,
    signal: AbortSignal,
  ): SessionResult<void> {
    if (signal.aborted) return cancelled();
    if (request.sessionId === this.#closedSessionId) {
      return { ok: true, value: undefined };
    }
    if (request.sessionId !== this.#sessionId) {
      return failure("browser_session_missing");
    }
    this.#closedSessionId = request.sessionId;
    await this.#releaseOwnedResources();
    return { ok: true, value: undefined };
  }

  async observe(
    request: BrowserObservationRequest,
    signal: AbortSignal,
  ): SessionResult<BrowserObservation> {
    if (signal.aborted) return cancelled();
    const active = this.#activePage(request);
    if (!active.ok) return active;
    const result = await bounded(
      inspectPage(active.page, request.sessionId, request.pageId, this.#uploads),
      signal,
      this.#timeoutMs,
    );
    if (result.kind === "cancelled") return cancelled();
    if (result.kind === "timeout") return failure("browser_timeout");
    if (result.kind === "error") return failure("browser_target_invalid");
    this.#targets = new Map(result.value.targets);
    for (const token of this.#targets.keys()) this.#seenTargets.add(token);
    return { ok: true, value: result.value.observation };
  }

  async mutate(
    request: BrowserMutationRequest,
    signal: AbortSignal,
  ): EffectResult<BrowserOperationReceipt> {
    if (signal.aborted) return cancelled();
    const snapshot = request.snapshot;
    const consumed = consumeBrowserMutationAdmission(request);
    if (!consumed.ok) return consumed;
    const active = this.#activePage(snapshot.effect);
    if (!active.ok) return { ok: false, error: active.error as BrowserEffectError };
    const { operationId, mutation } = consumed.value.effect;
    if (this.#mutationOperations.has(operationId)) return failure("browser_operation_replayed");
    this.#mutationOperations.add(operationId);

    const observed = this.#targets.get(mutation.target);
    if (observed === undefined) {
      return failure(this.#seenTargets.has(mutation.target) ? "browser_target_stale" : "browser_target_invalid");
    }
    if (observed.length !== 1) return failure("browser_target_ambiguous");

    const fresh = await inspectPage(active.page, snapshot.effect.sessionId, snapshot.effect.pageId, this.#uploads)
      .catch(() => undefined);
    if (fresh === undefined) return failure("browser_target_stale");
    const matches = fresh.targets.get(mutation.target);
    const observedTarget = observed[0];
    const mayRebindExclusiveChoice = mutation.kind === "select" &&
      (observedTarget?.interaction === "exclusive-checkbox-group" ||
        observedTarget?.interaction === "multi-checkbox-group") &&
      compatible(observedTarget, mutation);
    if ((matches === undefined || matches.length === 0) && !mayRebindExclusiveChoice) {
      return failure("browser_target_stale");
    }
    if (matches !== undefined && matches.length > 1) return failure("browser_target_ambiguous");
    const target = matches?.[0] ?? observedTarget;
    if (target === undefined || !compatible(target, mutation)) return failure("browser_target_invalid");

    let effectStarted = false;
    const effect = async (upload?: Uint8Array, maximumAttempts = 2) => {
      effectStarted = true;
      for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
        let outcome: "applied" | "ambiguous" | "invalid";
        let internallyRebound = false;
        try {
          const rebound = await inspectPage(
            active.page, snapshot.effect.sessionId, snapshot.effect.pageId, this.#uploads,
          );
          const current = rebound.targets.get(mutation.target);
          const mayRebindInsideAdapter = (current === undefined || current.length === 0) &&
            compatible(target, mutation) && [
              "formatted-date", "exclusive-checkbox-group", "multi-checkbox-group",
              "field-popup", "owned-popup",
            ].includes(target.interaction ?? "");
          const currentTarget = current?.length === 1
            ? current[0]!
            : mayRebindInsideAdapter ? target : undefined;
          internallyRebound = currentTarget === target && mayRebindInsideAdapter;
          if (currentTarget === undefined || !compatible(currentTarget, mutation)) {
            outcome = current !== undefined && current.length > 1 ? "ambiguous" : "invalid";
          } else {
            outcome = await applyMutation(
              active.page, currentTarget, mutation, upload, Math.min(5_000, this.#timeoutMs),
            );
          }
        } catch (error) {
          const reconciled = await reconcileCommittedMutation(
            active.page,
            snapshot.effect.sessionId,
            snapshot.effect.pageId,
            mutation,
            this.#uploads,
          );
          if (reconciled === "committed") return "applied" as const;
          if (reconciled === "absent" && attempt + 1 < maximumAttempts) continue;
          throw error;
        }
        const adapterVerifiedInteraction = [
          "formatted-date", "composite-date", "exclusive-checkbox-group",
          "multi-checkbox-group", "field-popup", "owned-popup",
        ].includes(target.interaction ?? "");
        if (outcome === "applied" && (
          mutation.kind === "upload" || internallyRebound || adapterVerifiedInteraction
        )) {
          return outcome;
        }
        if (outcome === "ambiguous") return outcome;
        const reconciled = await reconcileCommittedMutation(
          active.page,
          snapshot.effect.sessionId,
          snapshot.effect.pageId,
          mutation,
          this.#uploads,
        );
        if (reconciled === "committed") return "applied" as const;
        if (reconciled === "absent" && attempt + 1 < maximumAttempts) continue;
        if (reconciled === "absent") {
          throw new TypeError(`browser ${outcome} after bounded committed-state recovery`);
        }
        throw new TypeError("browser effect uncertain after committed-state reconciliation");
      }
      return "invalid" as const;
    };
    const action = mutation.kind === "upload"
      ? useResumeArtifactUpload<"applied" | "ambiguous" | "invalid", never>(
          mutation.artifact,
          async (upload) => ({ ok: true as const, value: await effect(upload) }),
        )
      : effect().then((value) => ({ ok: true as const, value }));
    const result = await bounded(action, signal, this.#timeoutMs);
    if (result.kind === "cancelled") {
      if (effectStarted) {
        await this.#invalidateOwnedSession();
        return failure("browser_effect_uncertain");
      }
      return cancelled();
    }
    if (result.kind === "timeout") {
      if (effectStarted) {
        const reconciled = await reconcileCommittedMutation(
          active.page, snapshot.effect.sessionId, snapshot.effect.pageId, mutation, this.#uploads,
        );
        if (reconciled === "committed") {
          if (mutation.kind === "upload") rememberUpload(this.#uploads, mutation);
          return { ok: true, value: { operationId, pageId: snapshot.effect.pageId, attempted: true } };
        }
        if (reconciled === "absent" && result.kind === "timeout" && mutation.kind !== "upload") {
          const retry = await bounded(effect(undefined, 1), signal, this.#timeoutMs);
          if (retry.kind === "value" && retry.value === "applied") {
            return { ok: true, value: { operationId, pageId: snapshot.effect.pageId, attempted: true } };
          }
        }
        await this.#invalidateOwnedSession();
        return failure("browser_effect_uncertain");
      }
      return failure("browser_timeout");
    }
    if (result.kind === "error") {
      if (effectStarted) {
        if (await reconcileCommittedMutation(
          active.page, snapshot.effect.sessionId, snapshot.effect.pageId, mutation, this.#uploads,
        ) === "committed") {
          if (mutation.kind === "upload") rememberUpload(this.#uploads, mutation);
          return { ok: true, value: { operationId, pageId: snapshot.effect.pageId, attempted: true } };
        }
        await this.#invalidateOwnedSession();
        return failure("browser_effect_uncertain");
      }
      return failure("browser_target_invalid");
    }
    if (!result.value.ok) {
      if (
        result.value.error.code === "artifact_changed" ||
        result.value.error.code === "artifact_already_consumed" ||
        result.value.error.code === "artifact_handle_invalid"
      ) {
        return result.value as { readonly ok: false; readonly error: BrowserEffectError };
      }
      return failure("artifact_handle_invalid");
    }
    const applied = result.value.value;
    if (applied !== "applied") {
      return failure(applied === "ambiguous" ? "browser_target_ambiguous" : "browser_target_invalid");
    }
    if (mutation.kind === "upload") {
      rememberUpload(this.#uploads, mutation);
    }
    return { ok: true, value: { operationId, pageId: snapshot.effect.pageId, attempted: true } };
  }

  async navigate(
    request: BrowserNavigationRequest,
    signal: AbortSignal,
  ): EffectResult<BrowserNavigationObservation> {
    if (signal.aborted) return cancelled();
    const snapshot = request.snapshot;
    const consumed = consumeBrowserNavigationAdmission(request);
    if (!consumed.ok) return consumed;
    const active = this.#activePage(snapshot.effect);
    if (!active.ok) return { ok: false, error: active.error as BrowserEffectError };
    const { operationId } = consumed.value.effect;
    if (this.#navigationOperations.has(operationId)) return failure("browser_operation_replayed");
    this.#navigationOperations.add(operationId);

    let effectStarted = false;
    const action = (async () => {
      const matches = active.page.getByRole("button", { name: /^(?:next|continue|save(?:\s+and)?\s+continue)$/iu });
      const count = await matches.count();
      if (count !== 1) return count === 0 ? "invalid" as const : "ambiguous" as const;
      effectStarted = true;
      const applied = await clickNext(active.page, this.#timeoutMs);
      if (applied !== "applied") return applied;
      await active.page.waitForFunction(
        (fromPageId) =>
          document.documentElement.getAttribute("data-hunt-page-id") !== fromPageId,
        snapshot.effect.pageId,
        { timeout: 0 },
      );
      return Object.freeze({
        kind: "applied" as const,
        pageId: await currentPageId(active.page),
      });
    })();
    const result = await bounded(action, signal, this.#timeoutMs);
    if (result.kind === "cancelled" || result.kind === "timeout" || result.kind === "error") {
      if (effectStarted) {
        await this.#invalidateOwnedSession();
        return failure("browser_effect_uncertain");
      }
      if (result.kind === "cancelled") return cancelled();
      return failure(result.kind === "timeout" ? "browser_timeout" : "browser_target_invalid");
    }
    if (typeof result.value === "string") {
      return failure(result.value === "ambiguous" ? "browser_target_ambiguous" : "browser_target_invalid");
    }
    const fromPageId = snapshot.effect.pageId;
    this.#pageId = result.value.pageId;
    this.#targets.clear();
    return { ok: true, value: { operationId, fromPageId, pageId: this.#pageId } };
  }

  #activePage(request: { readonly sessionId: string; readonly pageId: string }):
    | { readonly ok: true; readonly page: Page }
    | { readonly ok: false; readonly error: BrowserSessionError } {
    if (this.#invalidated && request.sessionId === this.#sessionId) {
      return { ok: false, error: providerError("browser_session_invalidated") };
    }
    if (
      this.#page === undefined ||
      this.#page.isClosed() ||
      request.sessionId !== this.#sessionId ||
      request.pageId !== this.#pageId
    ) {
      return { ok: false, error: providerError("browser_session_missing") };
    }
    return { ok: true, page: this.#page };
  }

  async #releaseOwnedResources(): Promise<void> {
    const page = this.#page;
    const context = this.#context;
    const browser = this.#browser;
    this.#page = undefined;
    this.#context = undefined;
    this.#browser = undefined;
    this.#sessionId = undefined;
    this.#pageId = undefined;
    this.#targets.clear();
    this.#seenTargets.clear();
    this.#uploads.clear();
    this.#mutationOperations.clear();
    this.#navigationOperations.clear();
    if (!this.#attached) await page?.close().catch(() => undefined);
    if (this.#externalContext === undefined) {
      await context?.close().catch(() => undefined);
      await browser?.close().catch(() => undefined);
    }
  }

  async #invalidateOwnedSession(): Promise<void> {
    const sessionId = this.#sessionId;
    const pageId = this.#pageId;
    await this.#releaseOwnedResources();
    this.#sessionId = sessionId;
    this.#pageId = pageId;
    this.#invalidated = true;
  }
}

async function currentPageId(page: Page) {
  const declared = await page.locator("html").getAttribute("data-hunt-page-id");
  if (declared === null || declared.length === 0) {
    throw new RangeError("browser page coordinate is required");
  }
  return browserPageId(declared);
}

function cancelled(): { readonly ok: false; readonly error: CancellationError } {
  return { ok: false, error: providerError("operation_cancelled") };
}

function failure<C extends BrowserSessionError["code"]>(code: C) {
  return { ok: false, error: providerError(code) } as const;
}

function compatible(target: ResolvedBrowserTarget, mutation: BrowserMutation): boolean {
  if (mutation.kind === "set_text") return target.control.kind === "text";
  if (mutation.kind === "set_date") return target.control.kind === "date";
  if (mutation.kind === "set_checked") {
    return target.control.kind === "choice" && !(target.control.choice === "radio" && mutation.checked === false);
  }
  if (mutation.kind === "select") {
    return target.control.kind === "select" ||
      (target.control.kind === "choice" && target.control.choice === "radio");
  }
  return target.control.kind === "file";
}

export async function reconcileCommittedMutation(
  page: Page,
  sessionId: BrowserSessionResult["sessionId"],
  pageId: BrowserSessionResult["pageId"],
  mutation: BrowserMutation,
  uploads: ReadonlyMap<string, UploadedArtifactReadback>,
): Promise<"committed" | "absent" | "uncertain"> {
  const provisional = new Map(uploads);
  if (mutation.kind === "upload") rememberUpload(provisional, mutation);
  const observed = await inspectPage(page, sessionId, pageId, provisional).catch(() => undefined);
  const matches = observed?.targets.get(mutation.target);
  if (matches?.length !== 1) return "uncertain";
  const readback = matches[0]!.readback;
  const target = matches[0]!;
  if (mutation.kind === "set_text") {
    if (readback.kind === "text" && readback.value === mutation.text) return "committed";
    return readback.kind === "empty" ? "absent" : "uncertain";
  }
  if (mutation.kind === "set_date") {
    if (readback.kind === "text" && readback.value === mutation.isoDate) return "committed";
    return readback.kind === "empty" ? "absent" : "uncertain";
  }
  if (mutation.kind === "set_checked") {
    if (readback.kind !== "checked") return "uncertain";
    return readback.checked === mutation.checked ? "committed" : "absent";
  }
  if (mutation.kind === "select") {
    if (target.interaction === "multi-select" || target.interaction === "multi-checkbox-group") {
      return target.selectedOptions?.includes(mutation.option) === true ? "committed" : "absent";
    }
    if (readback.kind !== "selected") return "uncertain";
    return readback.option === mutation.option
      ? "committed"
      : "absent";
  }
  if (readback.kind !== "upload") return "uncertain";
  if (readback.resumeId === mutation.artifact.resumeId &&
      readback.sha256 === mutation.artifact.sha256) return "committed";
  return readback.resumeId === null && readback.sha256 === null ? "absent" : "uncertain";
}

function rememberUpload(
  uploads: Map<string, UploadedArtifactReadback>,
  mutation: Extract<BrowserMutation, { readonly kind: "upload" }>,
): void {
  uploads.set(mutation.target, {
    resumeId: mutation.artifact.resumeId,
    sha256: sha256Digest(mutation.artifact.sha256),
  });
}

type BoundedResult<T> =
  | { readonly kind: "value"; readonly value: T }
  | { readonly kind: "error"; readonly error: unknown }
  | { readonly kind: "cancelled" }
  | { readonly kind: "timeout" };

function bounded<T>(
  action: Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<BoundedResult<T>> {
  if (signal.aborted) {
    void action.catch(() => undefined);
    return Promise.resolve({ kind: "cancelled" });
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: BoundedResult<T>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = (): void => finish({ kind: "cancelled" });
    const timer = setTimeout(() => finish({ kind: "timeout" }), timeoutMs);
    signal.addEventListener("abort", onAbort, { once: true });
    action.then(
      (value) => finish({ kind: "value", value }),
      (error: unknown) => finish({ kind: "error", error }),
    );
  });
}
