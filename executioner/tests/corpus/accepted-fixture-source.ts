import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createFrozenBundle } from "../../src/corpus/freeze/index.ts";

export async function frozenAcceptedBundle(): Promise<{
  bundlePath: string;
  ledgerPath: string;
}> {
  const executionerRoot = resolve(".");
  const repositoryRoot = resolve("..");
  const runtimeRoot = await mkdtemp(join(tmpdir(), "hunt-s3-f4-accept-"));
  const bundlePath = join(runtimeRoot, "bundle.json");
  await createFrozenBundle({
    repositoryRoot,
    executionerRoot,
    sourceRevision: "a".repeat(40),
    sourceTree: "b".repeat(40),
    clean: true,
    packageLockPath: resolve(executionerRoot, "package-lock.json"),
    manifestPath: resolve(executionerRoot, "corpus/workday-40/manifest.json"),
    variantMapPath: resolve(executionerRoot, "corpus/workday-40/variants.json"),
    fixtureManifestPath: resolve(executionerRoot, "fixtures/workday/corpus/manifest.json"),
    declarationsPath: resolve(executionerRoot, "corpus/workday-40/variant-declarations.json"),
    impactPath: resolve(executionerRoot, "corpus/workday-40/contract-impact.json"),
    baselinePath: resolve(executionerRoot, "corpus/workday-40/source-reconciliation.json"),
    sourceSnapshotPath: resolve(executionerRoot, "corpus/workday-40/source.snapshot"),
    configPath: resolve(executionerRoot, "corpus/workday-40/acceptance.json"),
    fixtureRoot: resolve(executionerRoot, "fixtures/workday/corpus"),
  }, bundlePath);
  return { bundlePath, ledgerPath: join(runtimeRoot, "ledger.json") };
}
