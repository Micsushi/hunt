import assert from "node:assert/strict";
import { readFile, readdir, rm } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import {
  admitContractSnapshot,
  bindAdmissionRequest,
  generatedEvidenceId,
  generatedOperationId,
  guardRevision,
  type EvidenceAdmissionRequest,
  type EvidenceRecord,
  type JourneyId,
} from "../../../src/contracts/index.ts";
import {
  createEvidenceStore,
  EVIDENCE_MAX_MANIFEST_BYTES,
  EVIDENCE_MAX_RECORDS,
} from "../../../src/evidence/store.ts";
import { contractFixtures } from "../../../src/testing/contracts/index.ts";

const liveSignal = new AbortController().signal;
const journeyId = contractFixtures.journeyState.journeyId;

function evidenceRecord(seed = "1111111111111111"): EvidenceRecord {
  return {
    id: generatedEvidenceId(`evidence_${seed}`),
    kind: "semantic_snapshot",
    component: "F5",
    phase: "page_understanding",
    step: "classify",
    sha256: seed[0]?.repeat(64) ?? "0".repeat(64),
  };
}

function admittedRequest(
  record: EvidenceRecord,
  attemptSeed: string,
  selectedJourneyId: JourneyId = journeyId,
): EvidenceAdmissionRequest {
  const attemptId = generatedOperationId(`operation_${attemptSeed}`);
  const admitted = admitContractSnapshot(
    { journeyId: selectedJourneyId, operationId: attemptId, record },
    "evidence",
    {
      journeyId: selectedJourneyId,
      attemptId,
      guardRevision: guardRevision("policy-s1"),
    },
  );
  if (!admitted.ok) throw new Error("test evidence admission failed");
  return bindAdmissionRequest(admitted.value);
}

async function evidenceRoot(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "hunt-f11-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("cancelled evidence can be retried, deduplicated, and reloaded without replacing accepted facts", async (t) => {
  const root = await evidenceRoot(t);
  const record = evidenceRecord();
  const store = createEvidenceStore(root);

  const request = admittedRequest(record, "1111111111111111");
  assert.deepEqual(await store.write(request, AbortSignal.abort()), {
    ok: false,
    error: { code: "operation_cancelled", retryable: false },
  });
  assert.deepEqual(await store.read({ journeyId }, AbortSignal.abort()), {
    ok: false,
    error: { code: "operation_cancelled", retryable: false },
  });
  assert.deepEqual(await readdir(root), []);

  assert.deepEqual(
    await store.write(request, liveSignal),
    { ok: true, value: { recordId: record.id, written: true } },
  );
  assert.deepEqual(
    await store.write(admittedRequest(record, "2222222222222222"), liveSignal),
    { ok: true, value: { recordId: record.id, written: false } },
  );

  const reordered = {
    sha256: record.sha256,
    step: record.step,
    phase: record.phase,
    component: record.component,
    kind: record.kind,
    id: record.id,
  } satisfies EvidenceRecord;
  assert.deepEqual(
    await store.write(
      admittedRequest(reordered, "8888888888888888"),
      liveSignal,
    ),
    { ok: true, value: { recordId: record.id, written: false } },
  );
  assert.deepEqual(
    await store.write(
      admittedRequest(
        { ...record, component: "F11" },
        "9999999999999999",
      ),
      liveSignal,
    ),
    { ok: false, error: { code: "evidence_denied", retryable: false } },
  );

  const expected = { schemaVersion: 2, journeyId, records: [record] } as const;
  assert.deepEqual(await store.read({ journeyId }, liveSignal), {
    ok: true,
    value: expected,
  });
  assert.deepEqual(
    await createEvidenceStore(root).read({ journeyId }, liveSignal),
    { ok: true, value: expected },
  );

  const files = await readdir(root);
  assert.equal(files.length, 1);
  assert.match(files[0] ?? "", /^[a-f0-9]{64}\.json$/u);
  const persisted = await readFile(join(root, files[0] ?? ""), "utf8");
  assert.deepEqual(JSON.parse(persisted), expected);
  assert.ok(Buffer.byteLength(persisted) <= EVIDENCE_MAX_MANIFEST_BYTES);
});

test("stale, crossed, substitute, forged, reused, and concurrent capabilities fail exactly", async (t) => {
  const root = await evidenceRoot(t);
  const store = createEvidenceStore(root);
  const request = admittedRequest(
    evidenceRecord("3333333333333333"),
    "4444444444444444",
  );

  assert.deepEqual(
    await store.write(
      { ...request, guardRevision: guardRevision("policy-s2") },
      liveSignal,
    ),
    { ok: false, error: { code: "admission_stale", retryable: false } },
  );
  assert.deepEqual(
    await store.write(
      {
        ...request,
        attemptId: generatedOperationId("operation_5555555555555555"),
      },
      liveSignal,
    ),
    { ok: false, error: { code: "admission_mismatch", retryable: false } },
  );
  assert.deepEqual(
    await store.write(
      { ...request, snapshot: { ...request.snapshot } },
      liveSignal,
    ),
    { ok: false, error: { code: "admission_mismatch", retryable: false } },
  );
  assert.deepEqual(
    await store.write(
      {
        ...request,
        admission: {
          ...request.admission,
          permit: Object.freeze({}),
        },
      } as EvidenceAdmissionRequest,
      liveSignal,
    ),
    { ok: false, error: { code: "admission_invalid", retryable: false } },
  );

  const outcomes = await Promise.all([
    store.write(request, liveSignal),
    store.write(request, liveSignal),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.ok).length, 1);
  assert.deepEqual(
    outcomes.find((outcome) => !outcome.ok),
    { ok: false, error: { code: "admission_consumed", retryable: false } },
  );
  assert.deepEqual(await store.write(request, liveSignal), {
    ok: false,
    error: { code: "admission_consumed", retryable: false },
  });
  assert.equal((await readdir(root)).length, 1);
});

test("denied and hostile evidence graphs never create retention", async (t) => {
  const root = await evidenceRoot(t);
  const store = createEvidenceStore(root);
  const forged = {
    purpose: "evidence",
    journeyId,
    attemptId: generatedOperationId("operation_6666666666666666"),
    guardRevision: guardRevision("policy-s1"),
    snapshot: {
      journeyId,
      operationId: generatedOperationId("operation_6666666666666666"),
      record: { ...evidenceRecord(), rawText: "person@example.invalid" },
    },
    admission: Object.freeze({}),
  } as unknown as EvidenceAdmissionRequest;
  assert.deepEqual(await store.write(forged, liveSignal), {
    ok: false,
    error: { code: "admission_invalid", retryable: false },
  });

  let getterReads = 0;
  const hostile = Object.defineProperty({}, "admission", {
    enumerable: true,
    get() {
      getterReads += 1;
      return {};
    },
  }) as EvidenceAdmissionRequest;
  assert.deepEqual(await store.write(hostile, liveSignal), {
    ok: false,
    error: { code: "evidence_denied", retryable: false },
  });
  assert.equal(getterReads, 0);

  let traps = 0;
  const proxy = new Proxy(
    {},
    {
      get() {
        traps += 1;
        return undefined;
      },
      getOwnPropertyDescriptor() {
        traps += 1;
        return undefined;
      },
      getPrototypeOf() {
        traps += 1;
        return Object.prototype;
      },
      ownKeys() {
        traps += 1;
        return [];
      },
    },
  ) as EvidenceAdmissionRequest;
  assert.deepEqual(await store.write(proxy, liveSignal), {
    ok: false,
    error: { code: "evidence_denied", retryable: false },
  });
  assert.equal(traps, 0);
  assert.deepEqual(await readdir(root), []);
});

test("concurrent stores serialize ownership without losing records", async (t) => {
  const root = await evidenceRoot(t);
  const firstStore = createEvidenceStore(root);
  const secondStore = createEvidenceStore(root);
  const first = evidenceRecord("5555555555555555");
  const second = evidenceRecord("6666666666666666");

  assert.deepEqual(
    await Promise.all([
      firstStore.write(
        admittedRequest(first, "9999999999999999"),
        liveSignal,
      ),
      secondStore.write(
        admittedRequest(second, "aaaaaaaaaaaaaaaa"),
        liveSignal,
      ),
    ]),
    [
      { ok: true, value: { recordId: first.id, written: true } },
      { ok: true, value: { recordId: second.id, written: true } },
    ],
  );
  assert.deepEqual(await firstStore.read({ journeyId }, liveSignal), {
    ok: true,
    value: { schemaVersion: 2, journeyId, records: [first, second] },
  });
});

test("evidence enforces independent record-count and byte limits", async (t) => {
  const first = evidenceRecord("7777777777777777");
  const second = evidenceRecord("8888888888888888");
  const countRoot = await evidenceRoot(t);
  const countStore = createEvidenceStore(countRoot, {
    maxRecords: 1,
    maxManifestBytes: EVIDENCE_MAX_MANIFEST_BYTES,
  });
  assert.equal(
    (
      await countStore.write(
        admittedRequest(first, "bbbbbbbbbbbbbbbb"),
        liveSignal,
      )
    ).ok,
    true,
  );
  assert.deepEqual(
    await countStore.write(
      admittedRequest(second, "cccccccccccccccc"),
      liveSignal,
    ),
    {
      ok: false,
      error: { code: "evidence_limit_exceeded", retryable: false },
    },
  );

  const sizeRoot = await evidenceRoot(t);
  const oneRecordBytes = Buffer.byteLength(
    JSON.stringify({ schemaVersion: 2, journeyId, records: [first] }),
  );
  const sizeStore = createEvidenceStore(sizeRoot, {
    maxRecords: EVIDENCE_MAX_RECORDS,
    maxManifestBytes: oneRecordBytes - 1,
  });
  assert.deepEqual(
    await sizeStore.write(
      admittedRequest(first, "dddddddddddddddd"),
      liveSignal,
    ),
    {
      ok: false,
      error: { code: "evidence_limit_exceeded", retryable: false },
    },
  );
  assert.deepEqual(await readdir(sizeRoot), []);
});
