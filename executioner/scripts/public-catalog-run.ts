import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type PublicCatalogRun = Readonly<{
  runId: string;
  stagingDirectory: string;
  directory: string;
  failedDirectory: string;
  candidatePath: string;
  evidencePath: string;
  stagingManifestPath: string;
}>;

export function createPublicCatalogRun(
  outputRoot: string,
  runId = `run-${randomUUID()}`,
): PublicCatalogRun {
  if (!/^run-[a-z0-9-]{3,80}$/u.test(runId)) throw new TypeError("catalog run ID is invalid");
  const root = resolve(outputRoot);
  mkdirSync(root, { recursive: true });
  const directory = join(root, runId);
  const stagingDirectory = `${directory}.tmp`;
  const failedDirectory = `${directory}.failed`;
  if (existsSync(directory) || existsSync(stagingDirectory) || existsSync(failedDirectory)) {
    throw new Error("catalog run already exists");
  }
  mkdirSync(stagingDirectory);
  return {
    runId,
    stagingDirectory,
    directory,
    failedDirectory,
    candidatePath: join(stagingDirectory, "candidates.csv"),
    evidencePath: join(stagingDirectory, "verification.jsonl"),
    stagingManifestPath: join(stagingDirectory, "manifest.json"),
  };
}

export function finalizePublicCatalogRun(
  run: PublicCatalogRun,
  result: Readonly<{
    sourceSha256: string;
    rows: number;
    verified: boolean;
  }>,
): Readonly<{
  directory: string;
  candidatePath: string;
  evidencePath: string | null;
  manifestPath: string;
}> {
  if (!/^[a-f0-9]{64}$/u.test(result.sourceSha256)) throw new TypeError("source digest is invalid");
  if (!Number.isSafeInteger(result.rows) || result.rows < 1) throw new TypeError("catalog row count is invalid");
  if (!existsSync(run.candidatePath) || (result.verified && !existsSync(run.evidencePath))) {
    throw new Error("catalog run artifacts are incomplete");
  }
  const candidateSha256 = sha256(run.candidatePath);
  const evidenceSha256 = result.verified ? sha256(run.evidencePath) : null;
  writeFileSync(run.stagingManifestPath, `${JSON.stringify({
    schemaVersion: 1,
    runId: run.runId,
    rows: result.rows,
    verified: result.verified,
    sourceSha256: result.sourceSha256,
    candidateSha256,
    evidenceSha256,
  }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  renameSync(run.stagingDirectory, run.directory);
  return {
    directory: run.directory,
    candidatePath: join(run.directory, "candidates.csv"),
    evidencePath: result.verified ? join(run.directory, "verification.jsonl") : null,
    manifestPath: join(run.directory, "manifest.json"),
  };
}

export function failPublicCatalogRun(run: PublicCatalogRun): string {
  if (!existsSync(run.stagingDirectory)) return run.failedDirectory;
  if (existsSync(run.failedDirectory)) throw new Error("failed catalog run already exists");
  renameSync(run.stagingDirectory, run.failedDirectory);
  return run.failedDirectory;
}

export function preservePublicCatalogFailure(run: PublicCatalogRun, originalError: unknown): never {
  tryFailPublicCatalogRun(run);
  throw originalError;
}

export function tryFailPublicCatalogRun(run: PublicCatalogRun): string | null {
  try {
    return failPublicCatalogRun(run);
  } catch {
    return null;
  }
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
