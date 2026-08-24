import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  sign,
  timingSafeEqual,
  type KeyObject,
  verify,
} from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, normalize, resolve } from "node:path";

export const EXTERNAL_MONITOR_OBSERVER_LIVE_FILE =
  "external-monitor-observer-live.json" as const;

export interface Stage2ExternalMonitorObserverBinding {
  readonly schemaVersion: 1;
  readonly liveRevision: "s2-external-monitor-observer-live-v1";
  readonly journeyId: string;
  readonly targetHandleId: string;
  readonly observerPid: number;
  readonly observerStartedAt: string;
  readonly observerInstanceSha256: string;
  readonly publicKeySpki: string;
  readonly publicKeySha256: string;
}

export interface Stage2ExternalMonitorObserverSigner {
  readonly binding: Stage2ExternalMonitorObserverBinding;
  readonly privateKey: KeyObject;
}

export function createStage2ExternalMonitorObserverAuthority(request: {
  readonly runtimeRoot: string;
  readonly journeyId: string;
  readonly targetHandleId: string;
  readonly authorityToken: string;
}): Stage2ExternalMonitorObserverSigner & { readonly close: () => void } {
  const runtimeRoot = directory(request.runtimeRoot);
  if (!validJourney(request.journeyId) || !validTarget(request.targetHandleId)) denied();
  admitWrapperAuthority(runtimeRoot, request);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyBytes = publicKey.export({ type: "spki", format: "der" });
  const observerStartedAt = processStartedAt(process.pid);
  const binding = exactBinding({
    schemaVersion: 1,
    liveRevision: "s2-external-monitor-observer-live-v1",
    journeyId: request.journeyId,
    targetHandleId: request.targetHandleId,
    observerPid: process.pid,
    observerStartedAt,
    observerInstanceSha256: instanceDigest(process.pid, observerStartedAt),
    publicKeySpki: publicKeyBytes.toString("base64url"),
    publicKeySha256: digest(publicKeyBytes),
  });
  const path = join(runtimeRoot, EXTERNAL_MONITOR_OBSERVER_LIVE_FILE);
  writeFileSync(path, `${JSON.stringify(binding)}\n`, { flag: "wx", mode: 0o600 });
  return Object.freeze({
    binding,
    privateKey,
    close: () => rmSync(path, { force: true }),
  });
}

function admitWrapperAuthority(
  runtimeRoot: string,
  request: {
    readonly journeyId: string;
    readonly targetHandleId: string;
    readonly authorityToken: string;
  },
): void {
  const path = join(runtimeRoot, "isolated-desktop.json");
  if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !statSync(path).isFile() ||
      statSync(path).size < 2 || statSync(path).size > 16 * 1024 ||
      comparable(realpathSync.native(path)) !== comparable(resolve(path))) denied();
  const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const keys = [
    "schemaVersion", "bindingRevision", "runKey", "journeyId", "targetHandleId",
    "desktopName", "host", "tenant", "posting", "browserProfilePath",
    "observerAuthorityTokenSha256",
  ];
  const tokenBytes = Buffer.from(request.authorityToken, "base64");
  const expectedDigest = typeof value.observerAuthorityTokenSha256 === "string"
    ? Buffer.from(value.observerAuthorityTokenSha256, "hex")
    : Buffer.alloc(0);
  const actualDigest = createHash("sha256").update(tokenBytes).digest();
  try {
    if (Object.keys(value).length !== keys.length ||
        keys.some((key, index) => Object.keys(value)[index] !== key) ||
        value.schemaVersion !== 1 || value.bindingRevision !== "s2-isolated-desktop-binding-v2" ||
        value.journeyId !== request.journeyId || value.targetHandleId !== request.targetHandleId ||
        !/^run_\d{8}_[a-z0-9]{16}$/u.test(value.runKey as string) ||
        !/^HuntC3_[0-9a-f]{32}$/u.test(value.desktopName as string) ||
        tokenBytes.byteLength !== 32 || tokenBytes.toString("base64") !== request.authorityToken ||
        expectedDigest.byteLength !== actualDigest.byteLength ||
        !timingSafeEqual(expectedDigest, actualDigest)) denied();
  } finally {
    tokenBytes.fill(0);
    actualDigest.fill(0);
    expectedDigest.fill(0);
  }
}

export function readStage2ExternalMonitorObserverBinding(
  runtimeRootValue: string,
  expected: { readonly journeyId: string; readonly targetHandleId: string },
): Stage2ExternalMonitorObserverBinding {
  try {
    const root = directory(runtimeRootValue);
    const path = join(root, EXTERNAL_MONITOR_OBSERVER_LIVE_FILE);
    if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !statSync(path).isFile() ||
        statSync(path).size < 2 || statSync(path).size > 16 * 1024 ||
        comparable(realpathSync.native(path)) !== comparable(resolve(path))) denied();
    const binding = exactBinding(JSON.parse(readFileSync(path, "utf8")));
    if (binding.journeyId !== expected.journeyId ||
        binding.targetHandleId !== expected.targetHandleId ||
        processStartedAt(binding.observerPid) !== binding.observerStartedAt) denied();
    return binding;
  } catch {
    return denied();
  }
}

export function signStage2ExternalMonitorAcknowledgement(
  value: object,
  signer: Stage2ExternalMonitorObserverSigner,
): string {
  const publicKey = signer.privateKey.type === "private"
    ? createPublicKey(signer.privateKey).export({ type: "spki", format: "der" })
    : denied();
  if (digest(publicKey) !== signer.binding.publicKeySha256 ||
      publicKey.toString("base64url") !== signer.binding.publicKeySpki ||
      process.pid !== signer.binding.observerPid ||
      processStartedAt(process.pid) !== signer.binding.observerStartedAt) denied();
  return sign(null, payload(value), signer.privateKey).toString("base64url");
}

export function verifyStage2ExternalMonitorAcknowledgement(
  value: object,
  signature: unknown,
  binding: Stage2ExternalMonitorObserverBinding,
): boolean {
  try {
    if (typeof signature !== "string" || !/^[A-Za-z0-9_-]{80,128}$/u.test(signature)) {
      return false;
    }
    const publicKeyBytes = Buffer.from(binding.publicKeySpki, "base64url");
    if (publicKeyBytes.toString("base64url") !== binding.publicKeySpki ||
        digest(publicKeyBytes) !== binding.publicKeySha256) return false;
    const publicKey = createPublicKey({ key: publicKeyBytes, type: "spki", format: "der" });
    return verify(null, payload(value), publicKey, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}

function exactBinding(value: Stage2ExternalMonitorObserverBinding): Stage2ExternalMonitorObserverBinding {
  const expected = [
    "schemaVersion", "liveRevision", "journeyId", "targetHandleId", "observerPid",
    "observerStartedAt", "observerInstanceSha256", "publicKeySpki", "publicKeySha256",
  ];
  const keys = Object.keys(value);
  const publicKey = typeof value.publicKeySpki === "string"
    ? Buffer.from(value.publicKeySpki, "base64url")
    : Buffer.alloc(0);
  if (keys.length !== expected.length || expected.some((key, index) => keys[index] !== key) ||
      value.schemaVersion !== 1 || value.liveRevision !== "s2-external-monitor-observer-live-v1" ||
      !validJourney(value.journeyId) || !validTarget(value.targetHandleId) ||
      !Number.isSafeInteger(value.observerPid) || value.observerPid < 1 ||
      !timestamp(value.observerStartedAt) ||
      value.observerInstanceSha256 !== instanceDigest(value.observerPid, value.observerStartedAt) ||
      publicKey.byteLength < 32 || publicKey.byteLength > 128 ||
      publicKey.toString("base64url") !== value.publicKeySpki ||
      value.publicKeySha256 !== digest(publicKey)) denied();
  return Object.freeze({ ...value });
}

function processStartedAt(pid: number): string {
  if (!Number.isSafeInteger(pid) || pid < 1) denied();
  if (process.platform !== "win32") {
    if (pid !== process.pid) denied();
    return new Date(Date.now() - process.uptime() * 1_000).toISOString();
  }
  const script = `$p=Get-Process -Id ${pid} -ErrorAction Stop; $p.StartTime.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'")`;
  return timestamp(execFileSync("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script,
  ], { encoding: "utf8", windowsHide: true, timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] }).trim());
}

function instanceDigest(pid: number, startedAt: string): string {
  return digest(Buffer.from(`s2-monitor-observer-instance-v1\0${pid}\0${startedAt}`, "utf8"));
}

function payload(value: object): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

function directory(value: string): string {
  try {
    if (!isAbsolute(value) || normalize(value) !== value || lstatSync(value).isSymbolicLink() ||
        !statSync(value).isDirectory() ||
        comparable(realpathSync.native(value)) !== comparable(resolve(value))) denied();
    return realpathSync.native(value);
  } catch {
    return denied();
  }
}

function timestamp(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(Date.parse(value)).toISOString() !== value) denied();
  return value;
}

function validJourney(value: string): boolean {
  return /^journey_[A-Za-z0-9_-]{16,64}$/u.test(value);
}

function validTarget(value: string): boolean {
  return /^target_ref_[A-Za-z0-9_-]{16,64}$/u.test(value);
}

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function comparable(value: string): string {
  const normalized = normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function denied(): never {
  throw new Error("external monitor observer authority denied");
}
