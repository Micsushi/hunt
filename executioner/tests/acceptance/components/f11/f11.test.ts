import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  generatedOperationId,
  guardRevision,
  type EvidenceAdmissionRequest,
  type PrivacyAdmissionRequest,
  type SafetyAdmissionRequest,
} from "../../../../src/contracts/index.ts";
import { createEvidenceStore } from "../../../../src/evidence/store.ts";
import {
  createPrivacyGuard,
  createSafetyGuard,
} from "../../../../src/safety/guards.ts";
import {
  assertProviderConformance,
  contractFixtures,
  contractOperationCases,
} from "../../../../src/testing/contracts/index.ts";
import {
  dependencyViolations,
  sourceFiles,
} from "../../../architecture/dependency-rule.ts";

const liveSignal = new AbortController().signal;
const binding = {
  journeyId: contractFixtures.journeyState.journeyId,
  attemptId: generatedOperationId("operation_f11f11f11f11f11f"),
  guardRevision: guardRevision("policy-s1"),
} as const;

test("all three F11 providers conform to the frozen ports", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hunt-f11-conformance-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  await assertProviderConformance("PrivacyGuard", createPrivacyGuard());
  await assertProviderConformance("SafetyGuard", createSafetyGuard());
  await assertProviderConformance("EvidenceStore", createEvidenceStore(root));
});

test("one adversarial corpus fails closed without retaining rejected values", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hunt-f11-adversarial-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const privacy = createPrivacyGuard();
  const safety = createSafetyGuard();
  const evidence = createEvidenceStore(root);
  const marker = "person@example.invalid";
  const privacyRequest = (input: Record<string, unknown>) => ({
    binding,
    purpose: "privacy",
    input: {
      policyRevision: binding.guardRevision,
      semanticPayload: input,
    },
  }) as PrivacyAdmissionRequest;
  const safetyBaseline = contractOperationCases.SafetyGuard.admit.request;
  const cases = [
    {
      name: "credential",
      code: "credential_forbidden",
      run: () => privacy.admit(privacyRequest({ password: marker }), liveSignal),
    },
    {
      name: "token",
      code: "token_forbidden",
      run: () => privacy.admit(privacyRequest({ accessToken: marker }), liveSignal),
    },
    {
      name: "PII-shaped identifier",
      code: "raw_text_forbidden",
      run: () => privacy.admit(privacyRequest({ jobId: marker }), liveSignal),
    },
    {
      name: "selector",
      code: "selector_forbidden",
      run: () => safety.admit(
        { ...safetyBaseline, selector: marker } as unknown as SafetyAdmissionRequest,
        liveSignal,
      ),
    },
    {
      name: "policy override",
      code: "policy_override_forbidden",
      run: () => safety.admit(
        { ...safetyBaseline, policyOverride: marker } as unknown as SafetyAdmissionRequest,
        liveSignal,
      ),
    },
    {
      name: "Submit",
      code: "submit_forbidden",
      run: () => safety.admit(
        { ...safetyBaseline, capability: "submit" } as unknown as SafetyAdmissionRequest,
        liveSignal,
      ),
    },
    {
      name: "forged evidence",
      code: "admission_invalid",
      run: () => evidence.write(
        {
          purpose: "evidence",
          journeyId: binding.journeyId,
          attemptId: binding.attemptId,
          guardRevision: binding.guardRevision,
          snapshot: {
            journeyId: binding.journeyId,
            operationId: binding.attemptId,
            record: {
              ...contractFixtures.evidenceRecord,
              rawText: marker,
            },
          },
          admission: Object.freeze({}),
        } as unknown as EvidenceAdmissionRequest,
        liveSignal,
      ),
    },
  ] as const;

  for (const adversary of cases) {
    const result = await adversary.run();
    assert.equal(result.ok, false, adversary.name);
    if (!result.ok) assert.equal(result.error.code, adversary.code, adversary.name);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(marker, "u"));
  }
  assert.deepEqual(await readdir(root), []);
});

test("F11 imports only contracts and its own implementation", () => {
  const files = [
    ...sourceFiles("src/safety"),
    ...sourceFiles("src/evidence"),
  ];
  assert.deepEqual(dependencyViolations(files), []);
});

test("ModelController remains absent from the S1 F11 surface", () => {
  assert.equal(existsSync("src/control/model/controller.ts"), false);
});
