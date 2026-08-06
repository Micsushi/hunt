import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  scanForbiddenTokens,
  writeLiveEvidencePacket,
  type LiveEvidencePacketRequestV1,
  type UnknownCandidateEvidenceV1,
} from "../../../src/evidence/live/packet.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function evidenceRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "hunt-live-evidence-privacy-"));
  roots.push(root);
  const evidence = join(root, "evidence");
  mkdirSync(evidence);
  return evidence;
}

function candidate(): UnknownCandidateEvidenceV1 {
  return {
    schemaVersion: 1,
    layer: "question",
    acceptedSchemaId: "schema_0123456789abcdef",
    acceptedRevisionId: "classification_revision_0123456789abcdef",
    structuralTraitIds: ["structural_trait_0123456789abcdef"],
    controlCount: 4,
    requiredControlCount: 2,
    optionCount: 5,
    reviewLineage: [
      { layer: "ats_family", classificationId: "classification_atsfamily00000000" },
      { layer: "workday_page_type", classificationId: "classification_pagetype000000000" },
      { layer: "ui_behavior", classificationId: "classification_uibehavior0000000" },
    ],
  };
}

function request(root: string): LiveEvidencePacketRequestV1 {
  return {
    schemaVersion: 1,
    packetRevision: "s2-real-evidence-packet-v1",
    root,
    sourceRevision: "16c48bd1470addc9d9480d785ae84e412edd55ef",
    configurationRevisionId: "revision_0123456789abcdef",
    configurationApprovalId: "approval_0123456789abcdef",
    journeyId: "journey_0123456789abcdef",
    sealedAt: "2026-08-04T12:00:00.000Z",
    retentionDays: 30,
    milestones: [
      { kind: "account_verified", status: "verified" },
      { kind: "application_completed", status: "verified" },
      { kind: "review_reached", status: "verified" },
      { kind: "submit_guarded", status: "verified" },
    ],
    verificationSummaries: [
      { kind: "account", status: "verified", verifiedCount: 1 },
      { kind: "resume", status: "verified", verifiedCount: 1 },
      { kind: "required_fields", status: "verified", verifiedCount: 7 },
      { kind: "review", status: "verified", verifiedCount: 1 },
      { kind: "submit_guard", status: "verified", verifiedCount: 1 },
    ],
    errors: [],
    missingEvidence: [],
    browserTruth: {
      schemaVersion: 1,
      observer: "independent_browser",
      page: "review",
      reviewSignatureIds: ["review_signature_0123456789abcdef"],
      completionEvidenceIds: ["completion_evidence_0123456789abcdef"],
      submitStructurallyPresent: true,
      submitActivated: false,
    },
    diagnosticProjection: {
      reviewReached: true,
      requiredFieldsComplete: true,
      submitActivated: false,
    },
    unknownCandidate: candidate(),
    forbiddenTokens: [],
  };
}

test("rejects the caller's forbidden-token corpus before retaining files", () => {
  const root = evidenceRoot();
  const value = request(root);
  assert.throws(
    () => writeLiveEvidencePacket({
      ...value,
      forbiddenTokens: [value.journeyId, value.configurationApprovalId],
    }),
    /live evidence denied/u,
  );
  assert.deepEqual(readdirSync(root), []);
});

test("rejects JSON-escaped Windows paths, quotes, and control characters", () => {
  const token = "C:\\private\\owner\"value\nline";
  const serialized = Buffer.from(JSON.stringify({ value: token }), "utf8");
  assert.throws(
    () => scanForbiddenTokens([{ bytes: serialized }], [token]),
    /live evidence denied/u,
  );
});

test("rejects every forbidden unknown-candidate evidence field", () => {
  const forbidden = [
    "url",
    "selector",
    "targetToken",
    "targetHandleId",
    "applicantValue",
    "readbackValue",
    "credential",
    "rawDom",
    "variantId",
    "automaticallyApprovedVariantId",
  ];

  for (const key of forbidden) {
    const root = evidenceRoot();
    const value = request(root) as unknown as Record<string, unknown>;
    value.unknownCandidate = { ...candidate(), [key]: "private_value" };
    assert.throws(
      () => writeLiveEvidencePacket(value as unknown as LiveEvidencePacketRequestV1),
      /live evidence denied/u,
      key,
    );
    assert.deepEqual(readdirSync(root), [], key);
  }
});
