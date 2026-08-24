import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { assertCurrentProcessIsOnIsolatedDesktop } from "../../src/browser/playwright-live/private/windows-isolated-desktop-attestation.ts";
import { readStage2ExternalMonitorObserverBinding } from
  "../../src/live/evidence/external-monitor-authority.ts";
import {
  createStage2ExternalMonitorRuntime,
  currentProcessStartedAt,
} from "../../src/live/evidence/external-monitor-runtime.ts";

const [mode, outputPath, ...values] = process.argv.slice(2);
if (typeof outputPath !== "string") throw new TypeError("probe output missing");

if (mode === "argv") {
  await writeFile(outputPath, JSON.stringify(values), "utf8");
} else if (mode === "attest") {
  await assertCurrentProcessIsOnIsolatedDesktop();
  await writeFile(outputPath, "ok", "utf8");
} else if (mode === "identity") {
  await writeFile(outputPath, JSON.stringify({ pid: process.pid }), "utf8");
} else if (mode === "environment") {
  await writeFile(outputPath, process.env.HUNT_C3_VALUE_FREE_ACCOUNT_TRACE ?? "missing", "utf8");
} else if (mode === "monitor-binding") {
  const configPath = argument(values, "--config");
  const evidenceRoot = argument(values, "--evidence-root");
  const configBytes = await readFile(configPath);
  const config = JSON.parse(configBytes.toString("utf8")) as {
    readonly journeyId: string;
    readonly target: {
      readonly handleId: string;
      readonly host: string;
      readonly tenant: string;
      readonly posting: string;
    };
    readonly roots: { readonly runtime: { readonly path: string } };
  };
  const nonce = process.env.HUNT_C3_PROCESS_LIVE_NONCE;
  const issuedAt = process.env.HUNT_C3_PROCESS_ISSUED_AT;
  if (nonce === undefined || issuedAt === undefined) throw new TypeError("probe process binding missing");
  const desktopBinding = JSON.parse(await readFile(
    join(config.roots.runtime.path, "isolated-desktop.json"),
    "utf8",
  )) as { readonly browserProfilePath?: unknown };
  const monitor = createStage2ExternalMonitorRuntime({
    runtimeRoot: config.roots.runtime.path,
    evidenceRoot,
    journeyId: config.journeyId,
    targetHandleId: config.target.handleId,
    sourceRevision: "a".repeat(40),
    configSha256: createHash("sha256").update(configBytes).digest("hex"),
    host: config.target.host,
    tenant: config.target.tenant,
    posting: config.target.posting,
    processLiveNonceSha256: createHash("sha256").update(Buffer.from(nonce, "base64")).digest("hex"),
    processIssuedAt: issuedAt,
    processOwnerPid: process.pid,
    processOwnerStartedAt: currentProcessStartedAt(),
    observer: readStage2ExternalMonitorObserverBinding(config.roots.runtime.path, {
      journeyId: config.journeyId,
      targetHandleId: config.target.handleId,
    }),
  });
  monitor.close();
  await writeFile(outputPath, JSON.stringify({
    constructed: true,
    profileNestedUnderRuntime: typeof desktopBinding.browserProfilePath === "string" &&
      desktopBinding.browserProfilePath.startsWith(`${config.roots.runtime.path}\\browser-profiles\\`),
  }), "utf8");
} else if (mode === "linger") {
  const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    windowsHide: true,
  });
  await writeFile(outputPath, JSON.stringify({
    runnerPid: process.pid,
    descendantPid: descendant.pid,
  }), "utf8");
  await new Promise(() => undefined);
} else {
  throw new TypeError("probe mode invalid");
}

function argument(values: readonly string[], name: string): string {
  const index = values.indexOf(name);
  const value = values[index + 1];
  if (index < 0 || value === undefined) throw new TypeError("probe argument missing");
  return value;
}
