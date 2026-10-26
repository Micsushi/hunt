import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import {
  createFrozenBundle,
  verifyFrozenBundle,
  type FreezeSource,
} from "../../../src/corpus/freeze/index.ts";
import { canonicalJson } from "../../../src/corpus/shared.ts";

const impactSha =
  "sha256.c0181706ab8be8034aecd306ca4d9b66dfbaded6163346605bc5981e8762af1f";

async function copiedSource(): Promise<FreezeSource> {
  const sourceRoot = resolve(".");
  const repositoryRoot = await mkdtemp(join(tmpdir(), "hunt-s3-f4-source-"));
  const executionerRoot = join(repositoryRoot, "executioner");
  const corpusRoot = join(executionerRoot, "corpus", "workday-40");
  const fixtureRoot = join(executionerRoot, "fixtures", "workday", "corpus");
  await mkdir(corpusRoot, { recursive: true });
  await cp(
    resolve(sourceRoot, "fixtures/workday/corpus"),
    fixtureRoot,
    { recursive: true },
  );
  for (const path of [
    "package.json",
    "package-lock.json",
    "corpus/workday-40/manifest.json",
    "corpus/workday-40/variants.json",
    "corpus/workday-40/variant-declarations.json",
    "corpus/workday-40/contract-impact.json",
    "corpus/workday-40/source-reconciliation.json",
    "corpus/workday-40/source.snapshot",
    "corpus/workday-40/acceptance.json",
    "src/account/entry/adapter.ts",
    "src/ats/workday/live/account-state.ts",
    "src/ats/workday/live/classifiers.ts",
    "src/interaction/drivers/registry.ts",
  ]) {
    const target = join(executionerRoot, path);
    await mkdir(resolve(target, ".."), { recursive: true });
    await cp(resolve(sourceRoot, path), target);
  }
  return {
    repositoryRoot,
    executionerRoot,
    sourceRevision: "a".repeat(40),
    sourceTree: "b".repeat(40),
    clean: true,
    packageLockPath: join(executionerRoot, "package-lock.json"),
    manifestPath: join(corpusRoot, "manifest.json"),
    variantMapPath: join(corpusRoot, "variants.json"),
    fixtureManifestPath: join(fixtureRoot, "manifest.json"),
    declarationsPath: join(corpusRoot, "variant-declarations.json"),
    impactPath: join(corpusRoot, "contract-impact.json"),
    baselinePath: join(corpusRoot, "source-reconciliation.json"),
    sourceSnapshotPath: join(corpusRoot, "source.snapshot"),
    configPath: join(corpusRoot, "acceptance.json"),
    fixtureRoot,
  };
}

test("freeze accepts only the impact-bound S3-F2 source with dormant F3", async () => {
  const executionerRoot = resolve(".");
  const repositoryRoot = resolve("..");
  const runtimeRoot = await mkdtemp(join(tmpdir(), "hunt-s3-f4-freeze-"));
  const bundle = await createFrozenBundle({
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
  } as never, join(runtimeRoot, "bundle.json"));

  assert.equal(bundle.impactSha, impactSha);
  assert.equal(bundle.prerequisiteTask, "S3-F2-T13");
  assert.equal(bundle.f3.taskCount, 12);
  assert.deepEqual(bundle.f3, {
    taskCount: 12,
    activatedCount: 0,
    variantEvidenceCount: 0,
    fixtureEvidenceCount: 0,
    slotEvidenceCount: 0,
  });
  assert.equal(bundle.mode, "deterministic_fixture");
  assert.equal(bundle.rootRelativeFromBundle.includes("\\"), false);
  assert.equal(bundle.inputs.some((input) => input.kind === "corpus_source"), true);
  assert.deepEqual(await verifyFrozenBundle(
    join(runtimeRoot, "bundle.json"),
  ), bundle);
  await assert.rejects(
    () => verifyFrozenBundle(join(runtimeRoot, "bundle.json"), {
      sourceRevision: "c".repeat(40),
      sourceTree: "b".repeat(40),
      clean: true,
    }),
    /frozen source drift/,
  );
});

test("freeze hashes text identically across CRLF and LF checkouts", async () => {
  const crlf = await copiedSource();
  const lf = await copiedSource();
  for (const path of [lf.sourceSnapshotPath, lf.packageLockPath]) {
    await writeFile(path, (await readFile(path, "utf8")).replaceAll("\r\n", "\n"));
  }
  const first = await createFrozenBundle(crlf, join(crlf.repositoryRoot, "bundle.json"));
  const second = await createFrozenBundle(lf, join(lf.repositoryRoot, "bundle.json"));
  const digestByKind = (bundle: typeof first, kind: "corpus_source" | "package_lock") =>
    bundle.inputs.find((input) => input.kind === kind)?.sha256;
  assert.equal(digestByKind(first, "corpus_source"), digestByKind(second, "corpus_source"));
  assert.equal(digestByKind(first, "package_lock"), digestByKind(second, "package_lock"));
});

test("freeze rejects impact, prerequisite, F3 evidence, and dormant path drift", async () => {
  const sourceDrift = await copiedSource();
  await writeFile(sourceDrift.sourceSnapshotPath, "changed source\n");
  await assert.rejects(
    () => createFrozenBundle(
      sourceDrift,
      join(sourceDrift.repositoryRoot, "source-drift-bundle.json"),
    ),
    /corpus source digest mismatch/,
  );

  const impactDrift = await copiedSource();
  const impact = JSON.parse(
    await readFile(impactDrift.impactPath, "utf8"),
  ) as {
    taskActivations: Array<{
      taskId: string;
      decision: string;
      variantIds: string[];
    }>;
  };
  const dormant = impact.taskActivations.find(
    (task) => task.taskId === "S3-F3-T1",
  )!;
  dormant.decision = "activated";
  dormant.variantIds = ["WD-OPTION-DORMANT-V1"];
  await writeFile(impactDrift.impactPath, JSON.stringify(impact));
  await assert.rejects(
    () => createFrozenBundle(
      impactDrift,
      join(impactDrift.repositoryRoot, "impact-bundle.json"),
    ),
    /contract impact invalid/,
  );

  const prerequisiteDrift = await copiedSource();
  await writeFile(prerequisiteDrift.configPath, JSON.stringify({
    schemaVersion: 1,
    mode: "deterministic_fixture",
    prerequisiteTask: "S3-F3-T12",
    impactSha,
    maxAttemptsPerFixture: 2,
  }));
  await assert.rejects(
    () => createFrozenBundle(
      prerequisiteDrift,
      join(prerequisiteDrift.repositoryRoot, "prerequisite-bundle.json"),
    ),
    /acceptance configuration invalid/,
  );

  const dormantPath = await copiedSource();
  const semanticCommand = join(
    dormantPath.executionerRoot,
    "scripts",
    "corpus-semantic.ts",
  );
  await mkdir(resolve(semanticCommand, ".."), { recursive: true });
  await writeFile(semanticCommand, "export {};\n");
  await assert.rejects(
    () => createFrozenBundle(
      dormantPath,
      join(dormantPath.repositoryRoot, "dormant-bundle.json"),
    ),
    /dormant S3-F3 artifact present/,
  );
});

test("verification rejects a self-resealed bundle with dormant F3 evidence", async () => {
  const source = await copiedSource();
  const bundlePath = join(source.repositoryRoot, "bundle.json");
  await createFrozenBundle(source, bundlePath);
  const impact = JSON.parse(await readFile(source.impactPath, "utf8")) as {
    taskActivations: Array<{ taskId: string; decision: string; variantIds: string[] }>;
  };
  const dormant = impact.taskActivations.find(
    (task) => task.taskId === "S3-F3-T1",
  )!;
  dormant.decision = "activated";
  dormant.variantIds = ["WD-OPTION-DORMANT-V1"];
  const impactBytes = JSON.stringify(impact);
  await writeFile(source.impactPath, impactBytes);

  const bundle = JSON.parse(await readFile(bundlePath, "utf8")) as Record<string, any>;
  const impactInput = bundle.inputs.find(
    (input: Record<string, unknown>) => input.kind === "contract_impact",
  );
  impactInput.sha256 = hash(impactBytes);
  const identityCore = {
    schemaVersion: bundle.schemaVersion,
    sourceRevision: bundle.sourceRevision,
    sourceTree: bundle.sourceTree,
    slotCount: bundle.slotCount,
    impactSha: bundle.impactSha,
    prerequisiteTask: bundle.prerequisiteTask,
    f3: bundle.f3,
    maxAttemptsPerFixture: bundle.maxAttemptsPerFixture,
    mode: bundle.mode,
    inputs: bundle.inputs,
  };
  bundle.identity = hash(canonicalJson(identityCore));
  bundle.runId = `corpus-${digest(bundle.identity).slice(0, 20)}`;
  const { seal: _seal, ...unsealed } = bundle;
  bundle.seal = hash(canonicalJson(unsealed));
  await writeFile(bundlePath, canonicalJson(bundle));

  await assert.rejects(
    () => verifyFrozenBundle(bundlePath),
    /contract impact invalid|dormant S3-F3 assertion failed/,
  );
});

function hash(value: string): string {
  return `sha256.${digest(value)}`;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
