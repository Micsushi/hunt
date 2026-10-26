import assert from "node:assert/strict";
import test from "node:test";

import {
  admitContractSnapshot,
  bindAdmissionRequest,
  consumeAdmissionPermit,
  createGeneratedIdAllocator,
  generatedJourneyId,
  guardRevision,
  generatedOperationId,
  browserPageId,
  browserTargetToken,
  type BrowserMutationRequest,
  type AdmittedSnapshot,
} from "../../src/contracts/index.ts";

const generated = generatedJourneyId(
  createGeneratedIdAllocator({ next: () => "0123456789abcdef" }),
);
if (!generated.ok) throw new Error("test id allocation failed");
const binding = {
  journeyId: generated.value,
  attemptId: generatedOperationId("operation_1111111111111111"),
  guardRevision: guardRevision("guard-r1"),
} as const;

test("admission rejects proxies and accessors without executing traps", () => {
  let traps = 0;
  const proxy = new Proxy(
    {},
    {
      ownKeys() {
        traps += 1;
        return [];
      },
      getOwnPropertyDescriptor() {
        traps += 1;
        return undefined;
      },
      getPrototypeOf() {
        traps += 1;
        return Object.prototype;
      },
    },
  );
  const proxyResult = admitContractSnapshot(proxy, "privacy", binding);
  assert.deepEqual(proxyResult, {
    ok: false,
    error: { code: "admission_graph_invalid", retryable: false },
  });
  assert.equal(traps, 0);

  let getterReads = 0;
  const getter = Object.defineProperty({}, "policyRevision", {
    enumerable: true,
    get() {
      getterReads += 1;
      return "guard-r1";
    },
  });
  const getterResult = admitContractSnapshot(getter, "privacy", binding);
  assert.equal(getterResult.ok, false);
  assert.equal(getterReads, 0);
});

test("admission copies an exact graph and issues an exact-snapshot one-use permit", () => {
  const caller = {
    policyRevision: "guard-r1",
    semanticPayload: { fieldId: "s1-field-given-name", required: true },
  };
  const admitted = admitContractSnapshot(caller, "privacy", binding);
  assert.equal(admitted.ok, true);
  if (!admitted.ok) return;
  const request = bindAdmissionRequest(admitted.value);

  caller.semanticPayload.fieldId = "changed";
  assert.equal(Object.isFrozen(admitted.value.snapshot), true);
  assert.equal(
    Object.isFrozen(
      (admitted.value.snapshot as { semanticPayload: object }).semanticPayload,
    ),
    true,
  );
  assert.equal(
    (admitted.value.snapshot as { semanticPayload: { fieldId: string } })
      .semanticPayload.fieldId,
    "s1-field-given-name",
  );

  assert.deepEqual(
    consumeAdmissionPermit({
      ...request,
      snapshot: {
        ...(admitted.value.snapshot as unknown as { readonly [key: string]: never }),
      },
    }),
    {
      ok: false,
      error: { code: "admission_mismatch", retryable: false },
    },
  );

  assert.deepEqual(
    consumeAdmissionPermit(request),
    { ok: true, value: admitted.value.snapshot },
  );
  assert.deepEqual(
    consumeAdmissionPermit(request),
    {
      ok: false,
      error: { code: "admission_consumed", retryable: false },
    },
  );
});

test("admission rejects extra top-level keys, symbols, and inherited graphs", () => {
  const cases = [
    {
      policyRevision: "guard-r1",
      semanticPayload: {},
      extra: true,
    },
    Object.assign(
      { policyRevision: "guard-r1", semanticPayload: {} },
      { [Symbol("hidden")]: true },
    ),
    Object.assign(Object.create({ inherited: true }), {
      policyRevision: "guard-r1",
      semanticPayload: {},
    }),
  ];

  for (const value of cases) {
    const result = admitContractSnapshot(value, "privacy", binding);
    assert.equal(result.ok, false);
  }
});

test("purpose-specific admission closes nested shape and guard revision", () => {
  const invalid = [
    {
      purpose: "privacy" as const,
      value: { policyRevision: "wrong-revision", semanticPayload: {} },
    },
    {
      purpose: "privacy" as const,
      value: { policyRevision: "guard-r1", semanticPayload: "not-an-object" },
    },
    {
      purpose: "safety" as const,
      value: { policyRevision: "guard-r1", capability: "submit" },
    },
    {
      purpose: "evidence" as const,
      value: {
        journeyId: binding.journeyId,
        record: {
          id: "evidence_0123456789abcdef",
          kind: "verification",
          component: "F8",
          phase: "verification",
          step: "verify",
          sha256: "0".repeat(64),
          rawText: "forbidden",
        },
      },
    },
  ];

  for (const { purpose, value } of invalid) {
    assert.deepEqual(admitContractSnapshot(value, purpose, binding), {
      ok: false,
      error: { code: "admission_shape_invalid", retryable: false },
    });
  }
});

test("admission rejects undeclared capabilities, invalid dates, open coordinates, and null prototypes", () => {
  const nullTop = Object.assign(Object.create(null), {
    policyRevision: "guard-r1",
    semanticPayload: {},
  });
  const nullNested = {
    policyRevision: "guard-r1",
    semanticPayload: Object.assign(Object.create(null), { fieldId: "field-1" }),
  };
  const invalid = [
    { purpose: "privacy" as const, value: nullTop },
    { purpose: "privacy" as const, value: nullNested },
    {
      purpose: "safety" as const,
      value: { policyRevision: "guard-r1", capability: "observe", effect: {} },
    },
    {
      purpose: "safety" as const,
      value: {
        policyRevision: "guard-r1",
        capability: "field_mutation",
        effect: {
          kind: "browser_mutation",
          sessionId: "browser_session_0123456789abcdef",
          pageId: "page-1",
          operationId: binding.attemptId,
          mutation: { kind: "set_date", target: "target-1", isoDate: "2026-02-31" },
        },
      },
    },
    {
      purpose: "evidence" as const,
      value: {
        journeyId: binding.journeyId,
        operationId: binding.attemptId,
        record: {
          id: "evidence_0123456789abcdef",
          kind: "verification",
          component: "F8",
          phase: "invented_phase",
          step: "verify",
          sha256: "0".repeat(64),
        },
      },
    },
  ];
  for (const item of invalid) {
    assert.doesNotThrow(() => admitContractSnapshot(item.value, item.purpose, binding));
    assert.deepEqual(admitContractSnapshot(item.value, item.purpose, binding), {
      ok: false,
      error: { code: "admission_shape_invalid", retryable: false },
    });
  }
});

test("admission rejects nested hostile and non-JSON graphs within fixed bounds", () => {
  let traps = 0;
  const nestedProxy = new Proxy(
    {},
    {
      getPrototypeOf() {
        traps += 1;
        return Object.prototype;
      },
    },
  );
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const sparse = new Array(2);
  sparse[1] = true;
  const extraArray = [true] as boolean[] & { extra?: boolean };
  extraArray.extra = true;
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const nonEnumerable = Object.defineProperty({}, "hidden", {
    value: true,
  });
  let deep: Record<string, unknown> = {};
  for (let index = 0; index < 10; index += 1) deep = { next: deep };

  const hostile = [
    nestedProxy,
    revoked.proxy,
    sparse,
    extraArray,
    cycle,
    nonEnumerable,
    new Uint8Array([1]),
    { value: Number.POSITIVE_INFINITY },
    { value: "x".repeat(513) },
    deep,
  ];

  for (const semanticPayload of hostile) {
    const result = admitContractSnapshot(
      { policyRevision: "guard-r1", semanticPayload },
      "privacy",
      binding,
    );
    assert.deepEqual(result, {
      ok: false,
      error: { code: "admission_graph_invalid", retryable: false },
    });
  }
  assert.equal(traps, 0);
});

test("side-effect admission rejects cross-purpose, stale, substitute, reuse, and concurrent claims", async () => {
  const admitted = admitContractSnapshot(
    {
      policyRevision: "guard-r1",
      capability: "field_mutation",
      effect: {
        kind: "browser_mutation",
        sessionId: "browser_session_0123456789abcdef",
        pageId: browserPageId("page-1"),
        operationId: binding.attemptId,
        mutation: { kind: "set_text", target: "target-1", text: "x" },
      },
    },
    "safety",
    binding,
  );
  assert.equal(admitted.ok, true);
  if (!admitted.ok) return;
  const request = bindAdmissionRequest(admitted.value);

  assert.deepEqual(consumeAdmissionPermit({ ...request, purpose: "privacy" } as never), {
    ok: false,
    error: { code: "admission_mismatch", retryable: false },
  });
  assert.deepEqual(consumeAdmissionPermit({ ...request, attemptId: generatedOperationId("operation_2222222222222222") }), {
    ok: false,
    error: { code: "admission_mismatch", retryable: false },
  });
  assert.deepEqual(consumeAdmissionPermit({ ...request, guardRevision: guardRevision("guard-r2") }), {
    ok: false,
    error: { code: "admission_stale", retryable: false },
  });
  assert.equal(consumeAdmissionPermit({ ...request, snapshot: { ...request.snapshot } }).ok, false);
  assert.deepEqual(
    consumeAdmissionPermit({
      ...request,
      admission: { ...request.admission, permit: Object.freeze({}) } as never,
    }),
    { ok: false, error: { code: "admission_invalid", retryable: false } },
  );

  const otherOperation = generatedOperationId("operation_3333333333333333");
  const otherAdmission = admitContractSnapshot(
    {
      ...request.snapshot,
      effect: { ...request.snapshot.effect, operationId: otherOperation },
    },
    "safety",
    { ...binding, attemptId: otherOperation },
  );
  assert.equal(otherAdmission.ok, true);
  if (!otherAdmission.ok) return;
  const otherRequest = bindAdmissionRequest(otherAdmission.value);
  assert.deepEqual(consumeAdmissionPermit({ ...request, admission: otherRequest.admission } as never), {
    ok: false,
    error: { code: "admission_mismatch", retryable: false },
  });

  const [first, second] = await Promise.all([
    Promise.resolve().then(() => consumeAdmissionPermit(request)),
    Promise.resolve().then(() => consumeAdmissionPermit(request)),
  ]);
  assert.deepEqual([first.ok, second.ok].sort(), [false, true]);
  assert.deepEqual(consumeAdmissionPermit(request), {
    ok: false,
    error: { code: "admission_consumed", retryable: false },
  });
  assert.equal(consumeAdmissionPermit(otherRequest).ok, true);
});

if (false) {
  // @ts-expect-error protected browser effects require an admitted one-use claim
  const bypass: BrowserMutationRequest = {};
  void bypass;
}
