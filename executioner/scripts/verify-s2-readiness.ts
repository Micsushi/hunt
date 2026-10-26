import {
  readStage2ReadinessCertificate,
  stage2ReadinessRuntimeIdentity,
} from "./private/synthetic-readiness.ts";

try {
  const args = parseArgs(process.argv.slice(2));
  const identity = stage2ReadinessRuntimeIdentity(args);
  const certificate = readStage2ReadinessCertificate(
    args.certificatePath,
    identity.runtimeKeySha256,
  );
  process.stdout.write(`${JSON.stringify({
    status: "ready",
    sourceRevision: certificate.sourceRevision,
    runtimeKeySha256: certificate.runtimeKeySha256,
    consecutiveRuns: certificate.consecutiveRuns.length,
    submitActivated: false,
  })}\n`);
} catch {
  process.stdout.write('{"status":"not_ready","submitActivated":false}\n');
  process.exitCode = 1;
}

function parseArgs(values: readonly string[]) {
  if (values.length !== 2) invalid();
  const parsed = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (key === undefined || value === undefined || parsed.has(key) ||
        key !== "--certificate") invalid();
    parsed.set(key, value);
  }
  const certificatePath = parsed.get("--certificate");
  const nodeExecutable = process.execPath;
  const npmCliPath = process.env.npm_execpath;
  if (certificatePath === undefined || npmCliPath === undefined) invalid();
  return Object.freeze({ certificatePath, nodeExecutable, npmCliPath });
}

function invalid(): never {
  throw new TypeError("readiness verification arguments invalid");
}
