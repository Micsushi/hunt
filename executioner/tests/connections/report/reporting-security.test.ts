import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  bindAdmissionRequest,
  generatedEvidenceId,
  generatedOperationId,
  generatedReportId,
  guardRevision,
  type AdmittedSnapshot,
  type EvidenceAdmissionSnapshot,
  type EvidenceRecord,
  type FailureReport,
  type FailureReportRequest,
  type SafetyAdmissionRequest,
} from "../../../src/contracts/index.ts";
import { createEvidenceStore } from "../../../src/evidence/store.ts";
import { FactualFailureReporter } from "../../../src/observability/errors/reporter.ts";
import {
  createPrivacyGuard,
  createSafetyGuard,
} from "../../../src/safety/guards.ts";
import { contractFixtures } from "../../../src/testing/contracts/index.ts";

const signal = new AbortController().signal;
const journeyId = contractFixtures.journeyState.journeyId;
const policyRevision = guardRevision("policy-s1");

function providerFailure(): FailureReportRequest {
  return {
    reportId: generatedReportId("report_0000000000000001"),
    context: {
      journeyId,
      component: "F3",
      phase: "browser",
      step: "observe",
      code: "browser_timeout",
      retryable: true,
      source: {
        kind: "operation",
        id: generatedOperationId("operation_0000000000000004"),
      },
    },
  };
}

test("real F10 reporting preserves provider facts and bounds its notification seam", async () => {
  const notifications: FailureReport[] = [];
  const request = providerFailure();
  const delivered = await new FactualFailureReporter(async (report) => {
    notifications.push(report);
  }).report(request, signal);
  assert.deepEqual(delivered.ok ? delivered.value.report.context : delivered, request.context);
  assert.deepEqual(notifications, [request]);

  let attempts = 0;
  const unavailable = new FactualFailureReporter(async () => {
    attempts += 1;
    throw new Error("notification unavailable");
  });
  const expected = {
    ok: false,
    error: { code: "notification_unavailable", retryable: true },
  } as const;
  assert.deepEqual(await unavailable.report(request, signal), expected);
  assert.deepEqual(await unavailable.report(request, signal), expected);
  assert.deepEqual(await unavailable.report(request, signal), expected);
  assert.equal(attempts, 2);
});

test("F5, F6, and F8 factual results never enter real F10 failure notification", async () => {
  let notifications = 0;
  const reporter = new FactualFailureReporter(async () => {
    notifications += 1;
  });
  const cases = [
    { component: "F5", phase: "page_understanding", step: "classify", code: "unknown" },
    { component: "F6", phase: "answer_resolution", step: "resolve", code: "option_no_match" },
    { component: "F8", phase: "verification", step: "verify", code: "rejected" },
  ] as const;

  for (const [index, factual] of cases.entries()) {
    const result = await reporter.report({
      reportId: generatedReportId(
        `report_${(index + 2).toString().padStart(16, "0")}`,
      ),
      context: {
        journeyId,
        ...factual,
        retryable: false,
        source: {
          kind: "operation",
          id: generatedOperationId(
            `operation_${(index + 5).toString().padStart(16, "0")}`,
          ),
        },
      },
    } as unknown as FailureReportRequest, signal);
    assert.deepEqual(result, {
      ok: false,
      error: { code: "failure_context_invalid", retryable: false },
    });
  }
  assert.equal(notifications, 0);
});

test("real F11 guards deny without retention and evidence reloads digest-only", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hunt-t5-evidence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const privacy = createPrivacyGuard();
  const safety = createSafetyGuard();
  const evidence = createEvidenceStore(root);
  const privateValue = "person@example.invalid";
  const binding = {
    journeyId,
    attemptId: generatedOperationId("operation_0000000000000008"),
    guardRevision: policyRevision,
  } as const;

  const credentialDenied = await privacy.admit({
    binding,
    purpose: "privacy",
    input: {
      policyRevision,
      semanticPayload: { password: privateValue },
    },
  }, signal);
  const safetyBaseline = {
    binding,
    policyRevision,
    capability: "field_mutation",
    input: {
      policyRevision,
      capability: "field_mutation",
      effect: {
        kind: "browser_mutation",
        sessionId: contractFixtures.browserObservation.sessionId,
        pageId: contractFixtures.browserObservation.pageId,
        operationId: binding.attemptId,
        mutation: {
          kind: "set_text",
          target: contractFixtures.field.target,
          text: "safe-value",
        },
      },
    },
  } as const;
  const selectorDenied = await safety.admit({
    ...safetyBaseline,
    selector: privateValue,
  } as unknown as SafetyAdmissionRequest, signal);
  const submitDenied = await safety.admit({
    ...safetyBaseline,
    capability: "Submit",
  } as unknown as SafetyAdmissionRequest, signal);

  assert.deepEqual(credentialDenied, {
    ok: false,
    error: { code: "credential_forbidden", retryable: false },
  });
  assert.deepEqual(selectorDenied, {
    ok: false,
    error: { code: "selector_forbidden", retryable: false },
  });
  assert.deepEqual(submitDenied, {
    ok: false,
    error: { code: "submit_forbidden", retryable: false },
  });
  for (const denial of [credentialDenied, selectorDenied, submitDenied]) {
    assert.equal(JSON.stringify(denial).includes(privateValue), false);
  }
  assert.deepEqual(await readdir(root), []);

  const record: EvidenceRecord = {
    id: generatedEvidenceId("evidence_0000000000000001"),
    kind: "semantic_snapshot",
    component: "F9",
    phase: "orchestration",
    step: "start",
    sha256: createHash("sha256").update(privateValue).digest("hex"),
  };
  const operationId = generatedOperationId("operation_0000000000000009");
  const admitted = await privacy.admit({
    binding: { journeyId, attemptId: operationId, guardRevision: policyRevision },
    purpose: "evidence",
    input: { journeyId, operationId, record },
  }, signal);
  assert.equal(admitted.ok, true);
  if (!admitted.ok) assert.fail("real privacy guard rejected digest-only evidence");
  const request = bindAdmissionRequest(
    admitted.value as unknown as AdmittedSnapshot<
      "evidence",
      EvidenceAdmissionSnapshot
    >,
  );
  assert.deepEqual(await evidence.write(request, signal), {
    ok: true,
    value: { recordId: record.id, written: true },
  });
  assert.deepEqual(await evidence.write(request, signal), {
    ok: false,
    error: { code: "admission_consumed", retryable: false },
  });
  assert.deepEqual(await createEvidenceStore(root).read({ journeyId }, signal), {
    ok: true,
    value: { schemaVersion: 2, journeyId, records: [record] },
  });

  const [filename] = await readdir(root);
  assert.ok(filename);
  const durable = await readFile(join(root, filename), "utf8");
  assert.equal(durable.includes(record.sha256), true);
  assert.equal(durable.includes(privateValue), false);
  assert.doesNotMatch(durable, /password|selector|Submit/iu);
});
