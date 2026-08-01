import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  fixtureRunId,
  providerError,
  type FixtureFaultRequest,
  type FixtureResetRequest,
  type FixtureStartRequest,
} from "../../../../src/contracts/index.ts";
import {
  createFixtureRuntimeProviderFactory,
  FixtureServer,
  loadFixtureManifest,
} from "../../../../src/testing/fixture-server.ts";
import {
  assertProviderConformance,
  withContractProvider,
} from "../../../../src/testing/contracts/index.ts";

const fixtureRoot = fileURLToPath(
  new URL("../../../../fixtures/workday/s1/", import.meta.url),
);

test("the real F2 provider passes conformance with factory cleanup", async () => {
  const factory = createFixtureRuntimeProviderFactory(fixtureRoot);
  const leases: Array<{ readonly cleaned: boolean }> = [];
  let account: string | undefined;
  await withContractProvider(factory, async (provider, activeLease) => {
    leases.push(activeLease);
    await assertProviderConformance("FixtureRuntime", provider);
    const started = await provider.start(
      { fixtureRunId: fixtureRunId("fixture-run-synthetic") },
      new AbortController().signal,
    );
    if (!started.ok) assert.fail(started.error.code);
    account = `${started.value.origin}/account`;
    assert.equal((await fetch(account)).status, 503);
  });
  assert.equal(leases[0]?.cleaned, true);
  await assert.rejects(fetch(account!));

  await withContractProvider(factory, async (provider) => {
    assert.deepEqual(await provider.setFault({
      fixtureRunId: fixtureRunId("fixture-run-synthetic"),
      fault: null,
    }, new AbortController().signal), {
      ok: false,
      error: providerError("fixture_not_found"),
    });
  });
});

test("malformed provider requests fail closed without reading accessors", async (t) => {
  const server = new FixtureServer(fixtureRoot);
  t.after(() => server.close());
  const invalid = { ok: false, error: providerError("fixture_not_found") } as const;
  let getterReads = 0;
  const accessor = Object.defineProperty({}, "fixtureRunId", {
    enumerable: true,
    get() {
      getterReads += 1;
      return "fixture-run-synthetic";
    },
  });

  assert.deepEqual(await server.start(
    null as unknown as FixtureStartRequest,
    new AbortController().signal,
  ), invalid);
  assert.deepEqual(await server.start(
    accessor as FixtureStartRequest,
    new AbortController().signal,
  ), invalid);
  assert.deepEqual(await server.reset(
    { fixtureRunId: "" } as FixtureResetRequest,
    new AbortController().signal,
  ), invalid);
  assert.deepEqual(await server.setFault({
    fixtureRunId: fixtureRunId("fixture-run-synthetic"),
    fault: "unknown",
  } as unknown as FixtureFaultRequest, new AbortController().signal), invalid);
  assert.equal(getterReads, 0);
});

test("a cancelled listener rolls back without stopping a concurrent live start", async (t) => {
  const server = new FixtureServer(fixtureRoot);
  t.after(() => server.close());
  const controller = new AbortController();
  const cancelled = server.start(
    { fixtureRunId: fixtureRunId("fixture-run-concurrent") },
    controller.signal,
  );
  const live = server.start(
    { fixtureRunId: fixtureRunId("fixture-run-concurrent") },
    new AbortController().signal,
  );
  queueMicrotask(() => controller.abort());

  assert.deepEqual(await cancelled, {
    ok: false,
    error: providerError("operation_cancelled"),
  });
  const started = await live;
  assert.equal(started.ok, true);
  if (started.ok) {
    assert.equal((await fetch(`${started.value.origin}/account`)).status, 200);
  }
});

test("F2 fixture assets pass the component privacy report", () => {
  const manifest = loadFixtureManifest(fixtureRoot);
  const contents = manifest.pages
    .map(({ path }) => readFileSync(`${fixtureRoot}${path}`, "utf8"))
    .join("\n");
  for (const pattern of [
    /https?:\/\//iu,
    /\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/iu,
    /\b\d{3}[-.)\s]+\d{3}[-.\s]+\d{4}\b/u,
    /\b\d{3}-\d{2}-\d{4}\b/u,
    /\b(?:acme|contoso|example corporation|john doe|jane doe)\b/iu,
  ]) {
    assert.doesNotMatch(contents, pattern);
  }
  const review = readFileSync(`${fixtureRoot}/review`, "utf8");
  assert.match(review, />Submit application<\/button>/u);
  assert.match(review, /\bdisabled\b/u);
  assert.doesNotMatch(review, /<form\b|type="submit"|\b(?:href|action)=/iu);
});
