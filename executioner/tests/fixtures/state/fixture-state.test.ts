import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  fixtureRunId,
  fixtureSemanticHash,
  providerError,
} from "../../../src/contracts/index.ts";
import { FixtureServer } from "../../../src/testing/fixture-server.ts";
import { FixtureState } from "../../../src/testing/fixture-state.ts";

const runId = fixtureRunId("fixture-run-state");
const otherRunId = fixtureRunId("fixture-run-other");
const origin = "http://127.0.0.1:3000";
const signal = new AbortController().signal;
const fixtureRoot = fileURLToPath(
  new URL("../../../fixtures/workday/s1/", import.meta.url),
);

test("one fixture state starts idempotently and rejects a competing run", () => {
  const state = new FixtureState();
  const started = state.start(runId, origin, signal);
  assert.deepEqual(state.start(runId, origin, signal), started);
  assert.deepEqual(state.start(otherRunId, origin, signal), {
    ok: false,
    error: providerError("fixture_already_started"),
  });
  assert.deepEqual(state.snapshot, {
    fixtureRunId: runId,
    pageId: "fixture-account",
    enabledFault: null,
  });
});

test("three resets reproduce the exact seed hash and clear the fault", () => {
  const state = new FixtureState();
  state.start(runId, origin, signal);
  state.setFault(runId, "component_failure", signal);
  const expected = {
    ok: true,
    value: {
      fixtureRunId: runId,
      semanticHash: fixtureSemanticHash("sha256.fixture-reset"),
    },
  } as const;

  assert.deepEqual(state.reset(runId, signal), expected);
  assert.deepEqual(state.reset(runId, signal), expected);
  assert.deepEqual(state.reset(runId, signal), expected);
  assert.equal(state.snapshot?.enabledFault, null);
  assert.deepEqual(state.reset(otherRunId, signal), {
    ok: false,
    error: providerError("fixture_not_found"),
  });
});

test("cancelled state operations leave the one record unchanged", () => {
  const state = new FixtureState();
  state.start(runId, origin, signal);
  const before = state.snapshot;

  assert.deepEqual(state.setFault(runId, "component_failure", AbortSignal.abort()), {
    ok: false,
    error: providerError("operation_cancelled"),
  });
  assert.deepEqual(state.reset(runId, AbortSignal.abort()), {
    ok: false,
    error: providerError("operation_cancelled"),
  });
  assert.deepEqual(state.snapshot, before);
});

test("the component fault is inert by default and browser-visible only when enabled", async (t) => {
  const server = new FixtureServer(fixtureRoot);
  t.after(() => server.close());
  const started = await server.start({ fixtureRunId: runId }, signal);
  assert.equal(started.ok, true);
  if (!started.ok) return;
  const account = `${started.value.origin}/account`;

  assert.equal((await fetch(account)).status, 200);
  assert.deepEqual(await server.setFault({
    fixtureRunId: runId,
    fault: "component_failure",
  }, signal), { ok: true, value: undefined });
  const faulted = await fetch(account);
  assert.equal(faulted.status, 503);
  assert.match(await faulted.text(), /data-fixture-fault="component_failure"/u);
  assert.deepEqual(await server.reset({ fixtureRunId: runId }, signal), {
    ok: true,
    value: {
      fixtureRunId: runId,
      semanticHash: fixtureSemanticHash("sha256.fixture-reset"),
    },
  });
  assert.equal((await fetch(account)).status, 200);
});
