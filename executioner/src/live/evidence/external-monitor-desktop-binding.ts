import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, normalize, resolve } from "node:path";

const desktopBindingFile = "isolated-desktop.json";

export interface ExternalMonitorDesktopBinding {
  readonly schemaVersion: 1;
  readonly bindingRevision: "s2-isolated-desktop-binding-v2";
  readonly runKey: string;
  readonly journeyId: string;
  readonly targetHandleId: string;
  readonly desktopName: string;
  readonly host: string;
  readonly tenant: string;
  readonly posting: string;
  readonly browserProfilePath: string;
  readonly observerAuthorityTokenSha256: string;
}

export async function waitForExternalMonitorDesktopBinding(
  runtimeRoot: string,
  token: string,
): Promise<ExternalMonitorDesktopBinding> {
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      const value = JSON.parse(stableObserverFile(
        resolve(runtimeRoot, desktopBindingFile),
        16 * 1024,
      ).toString("utf8"));
      return exactDesktopBinding(value, token);
    } catch {
      if (Date.now() >= deadline) denied();
      await delay(25);
    }
  }
}

export function stableObserverFile(path: string, maximum: number): Buffer {
  if (!isAbsolute(path) || normalize(path) !== path || !existsSync(path) ||
      lstatSync(path).isSymbolicLink() || !statSync(path).isFile() || statSync(path).size < 2 ||
      statSync(path).size > maximum ||
      comparable(realpathSync.native(path)) !== comparable(resolve(path))) denied();
  const before = statSync(path);
  const bytes = readFileSync(path);
  const after = statSync(path);
  if (before.size !== bytes.byteLength || before.ctimeMs !== after.ctimeMs ||
      before.mtimeMs !== after.mtimeMs) denied();
  return bytes;
}

export function observerDirectory(value: string): string {
  if (!isAbsolute(value) || normalize(value) !== value || lstatSync(value).isSymbolicLink() ||
      !statSync(value).isDirectory() ||
      comparable(realpathSync.native(value)) !== comparable(resolve(value))) denied();
  return realpathSync.native(value);
}

export function pendingExternalMonitorRequests(evidenceRoot: string): string[] {
  const requests: string[] = [];
  for (const directoryName of ["auth-monitor", "monitor"] as const) {
    const root = join(evidenceRoot, directoryName);
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root).sort()) {
      if (!name.endsWith(".request.json")) continue;
      const ack = join(root, name.replace(/\.request\.json$/u, ".ack.json"));
      if (!existsSync(ack)) requests.push(join(root, name));
    }
  }
  return requests;
}

function exactDesktopBinding(
  value: ExternalMonitorDesktopBinding,
  token: string,
): ExternalMonitorDesktopBinding {
  const keys = [
    "schemaVersion", "bindingRevision", "runKey", "journeyId", "targetHandleId",
    "desktopName", "host", "tenant", "posting", "browserProfilePath", "observerAuthorityTokenSha256",
  ];
  const actual = Object.keys(value);
  const tokenBytes = Buffer.from(token, "base64");
  try {
    if (actual.length !== keys.length || keys.some((key, index) => actual[index] !== key) ||
        value.schemaVersion !== 1 || value.bindingRevision !== "s2-isolated-desktop-binding-v2" ||
        !/^run_\d{8}_[a-z0-9]{16}$/u.test(value.runKey) ||
        !/^journey_[A-Za-z0-9_-]{16,64}$/u.test(value.journeyId) ||
        !/^target_ref_[A-Za-z0-9_-]{16,64}$/u.test(value.targetHandleId) ||
        !/^HuntC3_[0-9a-f]{32}$/u.test(value.desktopName) ||
        !/^[a-z0-9.-]{4,253}$/u.test(value.host) ||
        !/^[a-z0-9-]{2,64}$/u.test(value.tenant) || value.host.split(".")[0] !== value.tenant ||
        !/^[A-Za-z0-9-]{2,64}$/u.test(value.posting) || tokenBytes.byteLength !== 32 ||
        !isAbsolute(value.browserProfilePath) || normalize(value.browserProfilePath) !== value.browserProfilePath ||
        createHash("sha256").update(tokenBytes).digest("hex") !==
          value.observerAuthorityTokenSha256) denied();
    return Object.freeze({ ...value });
  } finally {
    tokenBytes.fill(0);
  }
}

function comparable(value: string): string {
  const normalized = normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function denied(): never {
  throw new Error("external monitor observer denied");
}
