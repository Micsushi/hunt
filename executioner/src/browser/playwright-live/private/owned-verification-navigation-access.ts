import type {
  LivePortResult,
  PersistentBrowserErrorCode,
  VerificationNavigationResult,
} from "../../../contracts/live/index.ts";
import { bounded, cancelled, failure } from "./port-results.ts";
import type { ApprovedTargetBinding, PersistentPage } from "./types.ts";
import type {
  ByteScopedVerificationBrowserCapability,
  ByteScopedVerificationTarget,
  SemanticVerificationNavigationAdapter,
} from "./verification-navigation-types.ts";

type NavigationPortResult = LivePortResult<
  VerificationNavigationResult,
  PersistentBrowserErrorCode
>;

export class OwnedVerificationNavigationAccessScope {
  readonly #page: PersistentPage;
  readonly #adapter: SemanticVerificationNavigationAdapter;
  readonly #approvedTarget: ApprovedTargetBinding;
  readonly #ownerSignal: AbortSignal;
  readonly #timeoutMs: number;
  readonly #revalidateBeforeEffect: (
    signal: AbortSignal,
  ) => Promise<LivePortResult<void, PersistentBrowserErrorCode>>;
  readonly #observeAfterEffect: (
    signal: AbortSignal,
  ) => Promise<NavigationPortResult>;
  readonly #invalidate: () => Promise<void>;
  #terminalError: PersistentBrowserErrorCode | "operation_cancelled" | undefined;
  #active = true;
  #used = false;
  #effectStarted = false;
  #result: VerificationNavigationResult | undefined;
  readonly capability: ByteScopedVerificationBrowserCapability;

  constructor(
    page: PersistentPage,
    adapter: SemanticVerificationNavigationAdapter,
    approvedTarget: ApprovedTargetBinding,
    ownerSignal: AbortSignal,
    timeoutMs: number,
    revalidateBeforeEffect: (
      signal: AbortSignal,
    ) => Promise<LivePortResult<void, PersistentBrowserErrorCode>>,
    observeAfterEffect: (signal: AbortSignal) => Promise<NavigationPortResult>,
    invalidate: () => Promise<void>,
  ) {
    this.#page = page;
    this.#adapter = adapter;
    this.#approvedTarget = approvedTarget;
    this.#ownerSignal = ownerSignal;
    this.#timeoutMs = timeoutMs;
    this.#revalidateBeforeEffect = revalidateBeforeEffect;
    this.#observeAfterEffect = observeAfterEffect;
    this.#invalidate = invalidate;
    this.capability = new VerificationNavigationCapability(this);
  }

  async navigateVerificationTarget(
    values: ByteScopedVerificationTarget,
    signal: AbortSignal,
  ): Promise<NavigationPortResult> {
    if (!this.#active) return failure("browser_session_invalidated");
    if (this.#used) return failure("browser_operation_replayed");
    this.#used = true;
    const admitted = admitVerificationTarget(values, this.#approvedTarget);
    if (admitted === undefined) return this.#stop("browser_target_invalid");
    const combined = AbortSignal.any([this.#ownerSignal, signal]);
    if (combined.aborted) {
      admitted.fill(0);
      return this.#cancel();
    }
    const pinned = await this.#revalidateBeforeEffect(combined);
    if (!pinned.ok) {
      admitted.fill(0);
      return this.#beforeEffectFailure(pinned.error.code);
    }
    if (combined.aborted) {
      admitted.fill(0);
      return this.#cancel();
    }
    this.#effectStarted = true;
    const navigated = await bounded(
      Promise.resolve().then(() => this.#adapter.navigate(this.#page, admitted)),
      combined,
      this.#timeoutMs,
    );
    admitted.fill(0);
    if (navigated.kind !== "value") return this.#uncertain();
    const observed = await this.#observeAfterEffect(combined);
    if (!observed.ok) return this.#uncertain();
    this.#result = observed.value;
    return observed;
  }

  get terminalError(): PersistentBrowserErrorCode | "operation_cancelled" | undefined {
    return this.#terminalError;
  }

  get used(): boolean { return this.#used; }
  get result(): VerificationNavigationResult | undefined { return this.#result; }

  deactivate(): void { this.#active = false; }

  async failCallback(): Promise<void> {
    if (this.#effectStarted) await this.#uncertain();
    else this.#stop("browser_target_invalid");
  }

  #beforeEffectFailure(code: PersistentBrowserErrorCode | "operation_cancelled") {
    if (code === "operation_cancelled") return this.#cancel();
    if (code === "browser_timeout") return this.#stop("browser_timeout");
    return this.#stop(code);
  }

  async #uncertain(): Promise<NavigationPortResult> {
    this.#terminalError = "browser_effect_uncertain";
    this.#active = false;
    await this.#invalidate();
    return failure("browser_effect_uncertain");
  }

  #cancel(): NavigationPortResult {
    this.#terminalError = "operation_cancelled";
    this.#active = false;
    return cancelled();
  }

  #stop<const Code extends PersistentBrowserErrorCode>(code: Code): NavigationPortResult {
    this.#terminalError = code;
    this.#active = false;
    return failure(code);
  }
}

class VerificationNavigationCapability
  implements ByteScopedVerificationBrowserCapability
{
  readonly #scope: OwnedVerificationNavigationAccessScope;
  constructor(scope: OwnedVerificationNavigationAccessScope) { this.#scope = scope; }
  navigateVerificationTarget(
    values: ByteScopedVerificationTarget,
    signal: AbortSignal,
  ): Promise<NavigationPortResult> {
    return this.#scope.navigateVerificationTarget(values, signal);
  }
}

function admitVerificationTarget(
  values: ByteScopedVerificationTarget,
  approved: ApprovedTargetBinding,
): Uint8Array | undefined {
  if (
    !byteValue(values?.verificationTarget, 1, 4_096) ||
    !byteValue(values?.approvedHost, 1, 253) ||
    !byteValue(values?.approvedTenant, 1, 63)
  ) return undefined;
  const targetBytes = Uint8Array.from(values.verificationTarget);
  const hostBytes = Uint8Array.from(values.approvedHost);
  const tenantBytes = Uint8Array.from(values.approvedTenant);
  let target = "";
  let host = "";
  let tenant = "";
  let admitted = false;
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    target = decoder.decode(targetBytes);
    host = decoder.decode(hostBytes);
    tenant = decoder.decode(tenantBytes);
    const parsed = new URL(target);
    const canonical = parsed.toString();
    if (
      target !== canonical ||
      host !== approved.approved.host ||
      tenant !== approved.approved.tenant ||
      parsed.protocol !== "https:" ||
      parsed.hostname !== host ||
      parsed.port !== "" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.hash !== "" ||
      !workdayHost(host, tenant) ||
      /[\u0000-\u001f\u007f]/u.test(decodeURI(canonical)) ||
      !boundedVerificationRoute(parsed)
    ) return undefined;
    admitted = true;
    return targetBytes;
  } catch {
    return undefined;
  } finally {
    hostBytes.fill(0);
    tenantBytes.fill(0);
    if (!admitted) targetBytes.fill(0);
    host = "";
    tenant = "";
    target = "";
  }
}

function byteValue(
  value: Readonly<Uint8Array> | undefined,
  minimum: number,
  maximum: number,
): value is Readonly<Uint8Array> {
  return value instanceof Uint8Array && value.byteLength >= minimum &&
    value.byteLength <= maximum;
}

function workdayHost(host: string, tenant: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(tenant) &&
    new RegExp(`^${escapePattern(tenant)}\\.wd\\d{1,2}\\.myworkdayjobs\\.(?:com|invalid)$`, "u")
      .test(host);
}

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function boundedVerificationRoute(target: URL): boolean {
  if (target.pathname.length < 2 || target.pathname.length > 2_048) return false;
  const parameters = [...target.searchParams];
  if (parameters.length > 16) return false;
  const marker = /(?:verify|verification|activate|activation|confirm|confirmation)/iu;
  if (parameters.some(([name, value]) => name.length > 128 || value.length > 2_048)) {
    return false;
  }
  if (parameters.some(([name, value]) =>
    (marker.test(name) || /(?:token|code|key)/iu.test(name)) && value.length > 0
  )) return true;
  const segments = target.pathname.split("/").filter(Boolean);
  if (segments.length > 32) return false;
  const decoded = segments.map((segment) => decodeURIComponent(segment));
  const markerIndex = decoded.findIndex((segment) => marker.test(segment));
  return markerIndex >= 0 && markerIndex < decoded.length - 1 &&
    decoded[markerIndex + 1]!.length <= 2_048;
}
