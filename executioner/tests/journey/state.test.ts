import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import {
  browserPageId,
  generatedOperationId,
  journeyId,
  providerError,
  type JourneyStateLoadRequest,
  type JourneyStateTransitionCommand,
} from "../../src/contracts/index.ts";
import { FileJourneyStateStore } from "../../src/journey/state-store.ts";

const id = journeyId("journey_0123456789abcdef");
const pageAccount = browserPageId("page-account");
const pageProfile = browserPageId("page-profile");
const opStart = generatedOperationId("operation_0123456789abcdef");
const opAdvance = generatedOperationId("operation_123456789abcdef0");
const opCancel = generatedOperationId("operation_23456789abcdef01");
const opCancelled = generatedOperationId("operation_3456789abcdef012");
const opBlocked = generatedOperationId("operation_456789abcdef0123");

async function temporaryStore(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "hunt-f4-state-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  return { directory, store: new FileJourneyStateStore(directory) };
}

test("initialize persists schema v3 state and reopens idempotently", async (t) => {
  const { directory, store } = await temporaryStore(t);
  const initialized = await store.initialize(id, new AbortController().signal);

  assert.deepEqual(initialized, {
    ok: true,
    value: {
      schemaVersion: 3,
      journeyId: id,
      status: "ready",
      pageId: null,
      revision: 0,
    },
  });
  assert.deepEqual(
    await new FileJourneyStateStore(directory).initialize(id, new AbortController().signal),
    initialized,
  );
  assert.deepEqual(
    await new FileJourneyStateStore(directory).load({ journeyId: id }, new AbortController().signal),
    { ok: true, value: { state: initialized.ok ? initialized.value : null } },
  );
});

test("legal transitions use compare-and-swap and survive reopen", async (t) => {
  const { directory, store } = await temporaryStore(t);
  await store.initialize(id, new AbortController().signal);
  const started = await store.transition({
    journeyId: id,
    operationId: opStart,
    expectedRevision: 0,
    status: "running",
    pageId: pageAccount,
  }, new AbortController().signal);

  assert.deepEqual(started, {
    ok: true,
    value: {
      applied: true,
      state: {
        schemaVersion: 3,
        journeyId: id,
        status: "running",
        pageId: pageAccount,
        revision: 1,
      },
    },
  });
  assert.deepEqual(
    await new FileJourneyStateStore(directory).load({ journeyId: id }, new AbortController().signal),
    { ok: true, value: { state: started.ok ? started.value.state : null } },
  );
});

test("operation replay returns its original result after later transitions", async (t) => {
  const { directory, store } = await temporaryStore(t);
  await store.initialize(id, new AbortController().signal);
  const start = {
    journeyId: id,
    operationId: opStart,
    expectedRevision: 0,
    status: "running",
    pageId: pageAccount,
  } as const;
  const original = await store.transition(start, new AbortController().signal);
  await store.transition({
    ...start,
    operationId: opAdvance,
    expectedRevision: 1,
    pageId: pageProfile,
  }, new AbortController().signal);

  const replay = await new FileJourneyStateStore(directory).transition(
    start,
    new AbortController().signal,
  );
  assert.deepEqual(replay, original.ok
    ? { ok: true, value: { ...original.value, applied: false } }
    : original);
  assert.deepEqual(await store.transition({
    ...start,
    status: "failed",
  }, new AbortController().signal), {
    ok: false,
    error: providerError("journey_transition_illegal"),
  });
});

test("concurrent transitions serialize on expected revision", async (t) => {
  const { directory, store } = await temporaryStore(t);
  await store.initialize(id, new AbortController().signal);
  const stores = [store, new FileJourneyStateStore(directory)];
  const results = await Promise.all(stores.map((candidate, index) =>
    candidate.transition({
      journeyId: id,
      operationId: index === 0 ? opStart : opAdvance,
      expectedRevision: 0,
      status: "running",
      pageId: index === 0 ? pageAccount : pageProfile,
    }, new AbortController().signal)
  ));

  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.filter((result) =>
    !result.ok && result.error.code === "journey_revision_conflict").length, 1);
});

test("cancellation lifecycle reaches an immutable terminal state", async (t) => {
  const { store } = await temporaryStore(t);
  await store.initialize(id, new AbortController().signal);
  await store.transition({
    journeyId: id,
    operationId: opStart,
    expectedRevision: 0,
    status: "running",
    pageId: pageAccount,
  }, new AbortController().signal);
  await store.transition({
    journeyId: id,
    operationId: opCancel,
    expectedRevision: 1,
    status: "cancelling",
    pageId: pageAccount,
  }, new AbortController().signal);
  const terminal = await store.transition({
    journeyId: id,
    operationId: opCancelled,
    expectedRevision: 2,
    status: "cancelled",
    pageId: pageAccount,
  }, new AbortController().signal);
  assert.equal(terminal.ok && terminal.value.state.revision, 3);

  const noOp = await store.transition({
    journeyId: id,
    operationId: generatedOperationId("operation_456789abcdef0123"),
    expectedRevision: 3,
    status: "cancelled",
    pageId: pageAccount,
  }, new AbortController().signal);
  assert.deepEqual(noOp, terminal.ok
    ? { ok: true, value: { state: terminal.value.state, applied: false } }
    : terminal);
  assert.deepEqual(await store.transition({
    journeyId: id,
    operationId: generatedOperationId("operation_56789abcdef01234"),
    expectedRevision: 3,
    status: "failed",
    pageId: pageAccount,
  }, new AbortController().signal), {
    ok: false,
    error: providerError("journey_transition_illegal"),
  });
});

test("blocked is a durable immutable terminal state", async (t) => {
  const { directory, store } = await temporaryStore(t);
  await store.initialize(id, new AbortController().signal);
  await store.transition({
    journeyId: id,
    operationId: opStart,
    expectedRevision: 0,
    status: "running",
    pageId: pageAccount,
  }, new AbortController().signal);
  const blocked = await store.transition({
    journeyId: id,
    operationId: opBlocked,
    expectedRevision: 1,
    status: "blocked",
    pageId: pageAccount,
  }, new AbortController().signal);

  assert.deepEqual(blocked, {
    ok: true,
    value: {
      applied: true,
      state: {
        schemaVersion: 3,
        journeyId: id,
        status: "blocked",
        pageId: pageAccount,
        revision: 2,
      },
    },
  });
  assert.deepEqual(
    await new FileJourneyStateStore(directory).load({ journeyId: id }, new AbortController().signal),
    { ok: true, value: { state: blocked.ok ? blocked.value.state : null } },
  );
  assert.deepEqual(await store.transition({
    journeyId: id,
    operationId: generatedOperationId("operation_56789abcdef01234"),
    expectedRevision: 2,
    status: "failed",
    pageId: pageAccount,
  }, new AbortController().signal), {
    ok: false,
    error: providerError("journey_transition_illegal"),
  });
});

test("same-state nonterminal progress is an acknowledged new revision", async (t) => {
  const { store } = await temporaryStore(t);
  await store.initialize(id, new AbortController().signal);
  await store.transition({
    journeyId: id,
    operationId: opStart,
    expectedRevision: 0,
    status: "running",
    pageId: pageAccount,
  }, new AbortController().signal);
  const result = await store.transition({
    journeyId: id,
    operationId: opAdvance,
    expectedRevision: 1,
    status: "running",
    pageId: pageAccount,
  }, new AbortController().signal);
  assert.equal(result.ok && result.value.applied, true);
  assert.equal(result.ok && result.value.state.revision, 2);
});

test("aborted operations do not create or change durable state", async (t) => {
  const { store } = await temporaryStore(t);
  assert.deepEqual(await store.initialize(id, AbortSignal.abort()), {
    ok: false,
    error: providerError("operation_cancelled"),
  });
  assert.deepEqual(await store.load({ journeyId: id }, new AbortController().signal), {
    ok: true,
    value: { state: null },
  });
  const initial = await store.initialize(id, new AbortController().signal);
  assert.deepEqual(await store.transition({
    journeyId: id,
    operationId: opStart,
    expectedRevision: 0,
    status: "running",
    pageId: pageAccount,
  }, AbortSignal.abort()), {
    ok: false,
    error: providerError("operation_cancelled"),
  });
  assert.deepEqual(await store.load({ journeyId: id }, new AbortController().signal), {
    ok: true,
    value: { state: initial.ok ? initial.value : null },
  });
});

test("malformed, corrupt, missing, and unavailable state remain distinct", async (t) => {
  const { directory, store } = await temporaryStore(t);
  const invalid = { ok: false, error: providerError("journey_state_invalid") } as const;
  let getterReads = 0;
  const accessor = Object.defineProperty({}, "journeyId", {
    enumerable: true,
    get() {
      getterReads += 1;
      return id;
    },
  });
  assert.deepEqual(
    await store.load(null as unknown as JourneyStateLoadRequest, new AbortController().signal),
    invalid,
  );
  assert.deepEqual(
    await store.load(accessor as JourneyStateLoadRequest, new AbortController().signal),
    invalid,
  );
  assert.equal(getterReads, 0);
  assert.deepEqual(await store.transition({
    journeyId: id,
    operationId: opStart,
    expectedRevision: -1,
    status: "running",
    pageId: pageAccount,
  } as JourneyStateTransitionCommand, new AbortController().signal), invalid);
  assert.deepEqual(await store.load({ journeyId: id }, new AbortController().signal), {
    ok: true,
    value: { state: null },
  });

  await store.initialize(id, new AbortController().signal);
  const [filename] = await readdir(directory);
  assert.ok(filename);
  await writeFile(join(directory, filename), "{broken", "utf8");
  assert.deepEqual(await store.load({ journeyId: id }, new AbortController().signal), invalid);

  const unavailable = new FileJourneyStateStore(`${directory}\0blocked`);
  assert.deepEqual(await unavailable.load({ journeyId: id }, new AbortController().signal), {
    ok: false,
    error: providerError("journey_state_unavailable"),
  });
});

test("reload rejects tampered operation history and journey identity", async (t) => {
  const { directory, store } = await temporaryStore(t);
  await store.initialize(id, new AbortController().signal);
  const [filename] = await readdir(directory);
  assert.ok(filename);
  const path = join(directory, filename);
  const persisted = JSON.parse(await readFile(path, "utf8")) as {
    state: { journeyId: string };
  };
  persisted.state.journeyId = "journey_ffffffffffffffff";
  await writeFile(path, JSON.stringify(persisted), "utf8");

  assert.deepEqual(await store.load({ journeyId: id }, new AbortController().signal), {
    ok: false,
    error: providerError("journey_state_invalid"),
  });
});
