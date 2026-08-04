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

test("stored bundle contains hashes and references, never source contents", async () => {
  const input = await source();
  const bundlePath = join(input.repositoryRoot, "bundle.json");
  await createFrozenBundle(input, bundlePath);
  const serialized = await readFile(bundlePath, "utf8");

  assert.doesNotMatch(serialized, /review_reached/);
  assert.doesNotMatch(serialized, /lock\\n/);
  assert.match(serialized, /account-primary/);
});
