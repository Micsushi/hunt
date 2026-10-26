import { mkdirSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { dirname, join } from "node:path";

import { runStage2SyntheticReadiness } from
  "./private/synthetic-readiness.ts";

try {
  const args = await parseArgs(process.argv.slice(2));
  const result = await runStage2SyntheticReadiness(args);
  process.stdout.write(`${JSON.stringify({
    status: result.certificate.status,
    certificatePath: result.certificatePath,
    runtimeKeySha256: result.certificate.runtimeKeySha256,
    consecutiveRuns: result.certificate.consecutiveRuns.length,
    submitActivated: false,
  })}\n`);
  process.exitCode = result.certificate.status === "pass" ? 0 : 1;
} catch {
  process.stdout.write('{"status":"failed","failureClass":"setup","submitActivated":false}\n');
  process.exitCode = 2;
}

async function parseArgs(values: readonly string[]) {
  if (values.length % 2 !== 0 || values.length > 6) invalid();
  const parsed = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (key === undefined || value === undefined || parsed.has(key) ||
        !["--storage-root", "--page-port", "--monitor-port"].includes(key)) invalid();
    parsed.set(key, value);
  }
  const localAppData = process.env.LOCALAPPDATA;
  const npmCliPath = process.env.npm_execpath;
  if (localAppData === undefined || npmCliPath === undefined) invalid();
  const storageRoot = parsed.get("--storage-root") ?? join(localAppData, "Hunt", "c3-readiness");
  mkdirSync(dirname(storageRoot), { recursive: true, mode: 0o700 });
  const requestedPagePort = parsed.has("--page-port") ? Number(parsed.get("--page-port")) : undefined;
  const requestedMonitorPort = parsed.has("--monitor-port") ? Number(parsed.get("--monitor-port")) : undefined;
  if ((requestedPagePort !== undefined && !validPort(requestedPagePort)) ||
      (requestedMonitorPort !== undefined && !validPort(requestedMonitorPort))) invalid();
  const available = await reservePortPair();
  const pagePort = requestedPagePort ?? available[0];
  const monitorPort = requestedMonitorPort ?? available[1];
  if (pagePort === monitorPort) invalid();
  const nodeExecutable = process.execPath;
  return Object.freeze({ storageRoot, nodeExecutable, npmCliPath, pagePort, monitorPort });
}

async function reservePortPair(): Promise<readonly [number, number]> {
  const first = createServer();
  const second = createServer();
  try {
    const one = await listenRandom(first);
    const two = await listenRandom(second);
    return [one, two];
  } finally {
    await Promise.all([close(first), close(second)]);
  }
}

function listenRandom(server: Server): Promise<number> {
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const address = server.address();
      if (typeof address === "object" && address !== null) resolveListen(address.port);
      else reject(new Error("readiness port unavailable"));
    });
  });
}

function close(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolveClose, reject) => server.close((error) =>
    error === undefined ? resolveClose() : reject(error)));
}

function validPort(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1_024 && value <= 65_535;
}

function invalid(): never {
  throw new TypeError("synthetic readiness arguments invalid");
}
