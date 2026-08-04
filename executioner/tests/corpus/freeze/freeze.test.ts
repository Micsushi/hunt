import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  createFrozenBundle,
  verifyFrozenBundle,
  type FreezeSource,
} from "../../../src/corpus/freeze/index.ts";

const sha = (value: string) =>
  createHash("sha256").update(value).digest("hex");

async function source(): Promise<FreezeSource> {
  const root = await mkdtemp(join(tmpdir(), "hunt-corpus-freeze-"));
  await mkdir(join(root, "fixtures"));
  await writeFile(join(root, "package-lock.json"), "lock\n");
  await writeFile(
    join(root, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      slots: Array.from({ length: 40 }, (_, index) => ({
        slotId: `slot-${String(index + 1).padStart(2, "0")}`,
        availability: "available",
        variantFamily: index % 2 === 0 ? "account" : "questionnaire",
      })),
    }),
  );
  await writeFile(
    join(root, "variant-map.json"),
    JSON.stringify({ schemaVersion: 1, families: ["account", "questionnaire"] }),
  );
  await writeFile(
    join(root, "config.json"),
    JSON.stringify({
      schemaVersion: 1,
      mode: "deterministic_fixture",
      maxAttemptsPerSlot: 2,
      accountRefs: ["account-primary"],
    }),
  );
  await writeFile(join(root, "fixtures", "account.json"), '{"outcome":"review_reached"}\n');
  await writeFile(join(root, "fixtures", "fixture-matrix.json"), JSON.stringify({
    schemaVersion: 1,
    expected: "passed",
    families: ["account", "questionnaire"],
  }));
  return {
    repositoryRoot: root,
    executionerRoot: root,
    sourceRevision: "a".repeat(40),
    sourceTree: "b".repeat(40),
    clean: true,
    packageLockPath: join(root, "package-lock.json"),
    manifestPath: join(root, "manifest.json"),
    variantMapPath: join(root, "variant-map.json"),
    configPath: join(root, "config.json"),
    fixtureRoot: join(root, "fixtures"),
  };
}

test("freeze pins all inputs and detects drift", async () => {
  const input = await source();
  const bundlePath = join(input.repositoryRoot, ".runtime", "bundle.json");
  const bundle = await createFrozenBundle(input, bundlePath);

  assert.equal(bundle.schemaVersion, 1);
  assert.equal(bundle.sourceRevision, "a".repeat(40));
  assert.equal(bundle.sourceTree, "b".repeat(40));
  assert.equal(bundle.slotCount, 40);
  assert.equal(bundle.runId, `corpus-${sha(bundle.identity).slice(0, 20)}`);
  assert.deepEqual(await verifyFrozenBundle(bundlePath), bundle);

  await writeFile(input.manifestPath, '{"changed":true}\n');
  await assert.rejects(() => verifyFrozenBundle(bundlePath), /frozen input drift/);
});

test("freeze refuses dirty source and unsafe configuration", async () => {
  const dirty = await source();
  await assert.rejects(
    () => createFrozenBundle({ ...dirty, clean: false }, join(dirty.repositoryRoot, "bundle.json")),
    /dirty source tree/,
  );

  const unsafe = await source();
  await writeFile(
    unsafe.configPath,
    JSON.stringify({
      schemaVersion: 1,
      mode: "deterministic_fixture",
      maxAttemptsPerSlot: 0,
      accountRefs: ["person@candidate.invalid"],
    }),
  );
  await assert.rejects(
    () => createFrozenBundle(unsafe, join(unsafe.repositoryRoot, "bundle.json")),
    /acceptance configuration invalid/,
  );
});

test("freeze rejects schema extensions and incomplete fixture coverage", async () => {
  const extra = await source();
  await writeFile(
    extra.configPath,
    JSON.stringify({
      schemaVersion: 1,
      mode: "deterministic_fixture",
      maxAttemptsPerSlot: 2,
      accountRefs: ["account-primary"],
      note: "unreviewed",
    }),
  );
  await assert.rejects(
    () => createFrozenBundle(extra, join(extra.repositoryRoot, "bundle.json")),
    /acceptance configuration invalid/,
  );

  const uncovered = await source();
  await writeFile(
    join(uncovered.fixtureRoot, "fixture-matrix.json"),
    JSON.stringify({ schemaVersion: 1, expected: "passed", families: ["account"] }),
  );
  await assert.rejects(
    () => createFrozenBundle(uncovered, join(uncovered.repositoryRoot, "bundle.json")),
    /fixture matrix invalid/,
  );
});

test("freeze identity is output-location independent and the bundle path is locked", async () => {
  const input = await source();
  const firstPath = join(input.repositoryRoot, ".runtime", "one", "bundle.json");
  const secondPath = join(input.repositoryRoot, ".runtime", "deeper", "two", "bundle.json");
  const first = await createFrozenBundle(input, firstPath);
  const second = await createFrozenBundle(input, secondPath);

  assert.equal(first.identity, second.identity);
  assert.equal(first.runId, second.runId);
  await assert.rejects(() => createFrozenBundle(input, firstPath), /EEXIST/);
  await assert.rejects(
    () => verifyFrozenBundle(firstPath, { sourceRevision: "c".repeat(40), sourceTree: "b".repeat(40), clean: true }),
    /frozen source drift/,
  );
});

test("stored bundle contains hashes and references, never source contents", async () => {
  const input = await source();
  const bundlePath = join(input.repositoryRoot, "bundle.json");
  await createFrozenBundle(input, bundlePath);
  const serialized = await readFile(bundlePath, "utf8");

  assert.doesNotMatch(serialized, /review_reached/);
  assert.doesNotMatch(serialized, /lock\\n/);
  assert.match(serialized, /account-primary/);
});
