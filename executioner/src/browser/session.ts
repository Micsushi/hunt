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
      observedTarget?.interaction === "exclusive-checkbox-group" &&
      compatible(observedTarget, mutation);
    if ((matches === undefined || matches.length === 0) && !mayRebindExclusiveChoice) {
      return failure("browser_target_stale");
    }
    if (matches !== undefined && matches.length > 1) return failure("browser_target_ambiguous");
    const target = matches?.[0] ?? observedTarget;
    if (target === undefined || !compatible(target, mutation)) return failure("browser_target_invalid");

    let effectStarted = false;
    const effect = async (upload?: Uint8Array) => {
      effectStarted = true;
      return applyMutation(active.page, target, mutation, upload, Math.min(5_000, this.#timeoutMs));
    };
    const action = mutation.kind === "upload"
      ? useResumeArtifactUpload<"applied" | "ambiguous" | "invalid", never>(
          mutation.artifact,
          async (upload) => ({ ok: true as const, value: await effect(upload) }),
        )
      : effect().then((value) => ({ ok: true as const, value }));
    const result = await bounded(action, signal, this.#timeoutMs);
    if (result.kind === "cancelled" || result.kind === "timeout") {
      if (effectStarted) {
        if (
          result.kind === "timeout" && mutation.kind === "select" &&
          target.interaction === "field-popup" &&
          await reconcileCommittedFieldPopupSelection(
            active.page,
            snapshot.effect.sessionId,
            snapshot.effect.pageId,
            mutation.target,
            mutation.option,
            this.#uploads,
            signal,
            this.#timeoutMs,
          )
        ) {
          return { ok: true, value: { operationId, pageId: snapshot.effect.pageId, attempted: true } };
        }
        await this.#invalidateOwnedSession();
        return failure("browser_effect_uncertain");
      }
      return result.kind === "cancelled" ? cancelled() : failure("browser_timeout");
    }
    if (result.kind === "error") {
      if (effectStarted) {
        if (
          mutation.kind === "select" && target.interaction === "field-popup" &&
          await reconcileCommittedFieldPopupSelection(
            active.page,
            snapshot.effect.sessionId,
            snapshot.effect.pageId,
            mutation.target,
            mutation.option,
            this.#uploads,
            signal,
            this.#timeoutMs,
          )
        ) {
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
      this.#uploads.set(mutation.target, {
        resumeId: mutation.artifact.resumeId,
        sha256: sha256Digest(mutation.artifact.sha256),
      });
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

async function reconcileCommittedFieldPopupSelection(
  page: Page,
  sessionId: BrowserSessionResult["sessionId"],
  pageId: BrowserSessionResult["pageId"],
  targetToken: Extract<BrowserMutation, { readonly kind: "select" }>["target"],
  option: Extract<BrowserMutation, { readonly kind: "select" }>["option"],
  uploads: ReadonlyMap<string, UploadedArtifactReadback>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!signal.aborted) {
    const observed = await inspectPage(page, sessionId, pageId, uploads).catch(() => undefined);
    const matches = observed?.targets.get(targetToken);
    if (
      matches?.length === 1 && matches[0]?.readback.kind === "selected" &&
      matches[0].readback.option === option
    ) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await page.waitForTimeout(Math.min(50, remaining)).catch(() => undefined);
  }
  return false;
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
