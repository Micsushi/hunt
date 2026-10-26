import assert from "node:assert/strict";
import test from "node:test";

import {
  admitContractSnapshot,
  consumeEvidenceAdmission,
  generatedEvidenceId,
  generatedOperationId,
  guardRevision,
  providerError,
} from "../../../../src/contracts/index.ts";
import { contractFixtures } from "../../../../src/testing/contracts/index.ts";
import { recordStartEvidence } from "../../../../src/control/orchestrator/evidence/index.ts";

test("startup evidence is admitted once and contains only a digest", async () => {
  const records: unknown[] = [];
  const result = await recordStartEvidence(
    {
      privacy: {
        async admit(request) {
          return admitContractSnapshot(
            request.input,
            "evidence",
            request.binding,
          ) as never;
        },
      },
      evidence: {
        async write(request) {
          const consumed = consumeEvidenceAdmission(request);
          assert.equal(consumed.ok, true);
          if (!consumed.ok) return consumed;
          records.push(consumed.value.record);
          return {
            ok: true,
            value: { recordId: consumed.value.record.id, written: true },
          };
        },
        async read() {
          throw new Error("read is not used");
        },
      },
      nextOperationId: () => ({
        ok: true,
        value: generatedOperationId("operation_0123456789abcdef"),
      }),
      nextEvidenceId: () => generatedEvidenceId("evidence_0123456789abcdef"),
      guardRevision: guardRevision("policy-s1"),
    },
    contractFixtures.journeyState.journeyId,
    new AbortController().signal,
  );

  assert.deepEqual(result, { ok: true, value: undefined });
  assert.equal(records.length, 1);
  assert.match(
    (records[0] as { sha256: string }).sha256,
    /^[a-f0-9]{64}$/u,
  );
  assert.doesNotMatch(JSON.stringify(records[0]), /Synthetic|selector|submit/u);
});

test("evidence provider errors remain exact", async () => {
  const result = await recordStartEvidence(
    {
      privacy: {
        async admit(request) {
          return admitContractSnapshot(
            request.input,
            "evidence",
            request.binding,
          ) as never;
        },
      },
      evidence: {
        async write() {
          return { ok: false, error: providerError("evidence_unavailable") };
        },
        async read() {
          throw new Error("read is not used");
        },
      },
      nextOperationId: () => ({
        ok: true,
        value: generatedOperationId("operation_0123456789abcdef"),
      }),
      nextEvidenceId: () => generatedEvidenceId("evidence_0123456789abcdef"),
      guardRevision: guardRevision("policy-s1"),
    },
    contractFixtures.journeyState.journeyId,
    new AbortController().signal,
  );

  assert.deepEqual(result, {
    ok: false,
    error: providerError("evidence_unavailable"),
  });
});
