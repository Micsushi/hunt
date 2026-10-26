import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  writeLiveEvidencePacket,
  type LiveEvidencePacketRequestV1,
} from "../../../src/evidence/live/packet.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function evidenceRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "hunt-live-evidence-"));
  roots.push(root);
  const evidence = join(root, "evidence");
  mkdirSync(evidence);
  return evidence;
}

function request(
  root: string,
  overrides: Partial<LiveEvidencePacketRequestV1> = {},
): LiveEvidencePacketRequestV1 {
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
    unknownCandidate: null,
    forbiddenTokens: [],
    ...overrides,
  };
}

function unknownCandidate() {
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
  } as const;
}

test("writes a bounded packet whose manifest hashes every admitted artifact", () => {
  const root = evidenceRoot();
  const manifest = writeLiveEvidencePacket(request(root));
  const packetRoot = join(root, "real-evidence");
  const artifactFiles = readdirSync(packetRoot)
    .filter((name) => name !== "manifest.json")
    .sort();

  assert.deepEqual(artifactFiles, ["browser-truth.json", "summary.json"]);
  assert.deepEqual(manifest.artifacts.map(({ file }) => file), artifactFiles);
  assert.equal(manifest.artifactCount, artifactFiles.length);
  assert.equal(manifest.retention.deleteAfter, "2026-09-03T12:00:00.000Z");
  assert.equal(manifest.retention.disposition, "delete_after_retention");
  assert.equal(manifest.privacyScan, "pass");

  for (const artifact of manifest.artifacts) {
    const bytes = readFileSync(join(packetRoot, artifact.file));
    assert.equal(bytes.byteLength, artifact.bytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), artifact.sha256);
  }

  const summary = JSON.parse(readFileSync(join(packetRoot, "summary.json"), "utf8")) as {
    readonly diagnosticComparison: { readonly browserTruthSha256: string };
  };
  const browserTruth = readFileSync(join(packetRoot, "browser-truth.json"));
  assert.equal(
    summary.diagnosticComparison.browserTruthSha256,
    createHash("sha256").update(browserTruth).digest("hex"),
  );
});

test("denies a packet that silently omits missing browser evidence", () => {
  const root = evidenceRoot();
  assert.throws(
    () => writeLiveEvidencePacket(request(root, {
      milestones: request(root).milestones.map((item) =>
        item.kind === "review_reached" ? { ...item, status: "missing" as const } : item),
    })),
    /live evidence denied/u,
  );
  assert.deepEqual(readdirSync(root), []);
});

test("denies unknown-candidate evidence with noncanonical review lineage", () => {
  const root = evidenceRoot();
  assert.throws(
    () => writeLiveEvidencePacket(request(root, {
      unknownCandidate: {
        ...unknownCandidate(),
        reviewLineage: [...unknownCandidate().reviewLineage].reverse(),
      },
    })),
    /live evidence denied/u,
  );
  assert.deepEqual(readdirSync(root), []);
});

test("enforces the artifact byte limit independently of record counts", () => {
  const root = evidenceRoot();
  const error = {
    code: "acceptance_evidence_cleanup_failed",
    component: "F11",
    phase: "verification_navigation",
    step: "stop_review",
    retryable: false,
  } as const;

  assert.throws(
    () => writeLiveEvidencePacket(request(root, {
      errors: Array.from({ length: 16 }, () => error),
    })),
    /live evidence denied/u,
  );
  assert.deepEqual(readdirSync(root), []);
});

test("admits only factual errors bound to the frozen S2 policy", () => {
  const root = evidenceRoot();
  const manifest = writeLiveEvidencePacket(request(root, {
    errors: [{
      code: "mailbox_timeout",
      component: "S2_MAILBOX_PROVIDER",
      phase: "mailbox_verification",
      step: "observe",
      retryable: true,
    }],
  }));
  assert.equal(manifest.privacyScan, "pass");
});

test("retains an explicit missing-evidence summary when browser truth cannot prove Review", () => {
  const root = evidenceRoot();
  const manifest = writeLiveEvidencePacket(request(root, {
    milestones: request(root).milestones.map((item) =>
      item.kind === "review_reached" ? { ...item, status: "missing" as const } : item),
    verificationSummaries: request(root).verificationSummaries.map((item) =>
      item.kind === "review" ? { ...item, status: "missing" as const, verifiedCount: 0 } : item),
    missingEvidence: ["review_proof"],
    browserTruth: {
      ...request(root).browserTruth,
      page: "unknown",
      reviewSignatureIds: [],
      completionEvidenceIds: [],
    },
    diagnosticProjection: {
      reviewReached: false,
      requiredFieldsComplete: false,
      submitActivated: false,
    },
  }));
  assert.equal(manifest.privacyScan, "pass");
  const summary = readFileSync(join(root, "real-evidence", "summary.json"), "utf8");
  assert.match(summary, /"missingEvidence": \[\s*"review_proof"/u);
});

test("denies retention metadata that differs from the approved S2 policy", () => {
  const root = evidenceRoot();
  assert.throws(
    () => writeLiveEvidencePacket(request(root, { retentionDays: 1 as 30 })),
    /live evidence denied/u,
  );
  assert.deepEqual(readdirSync(root), []);
});

test("writes only the bounded structural unknown-candidate artifact", () => {
  const root = evidenceRoot();
  const manifest = writeLiveEvidencePacket(request(root, {
    unknownCandidate: unknownCandidate(),
  }));
  const candidate = JSON.parse(
    readFileSync(join(root, "real-evidence", "unknown-candidate.json"), "utf8"),
  ) as Record<string, unknown>;

  assert.deepEqual(Object.keys(candidate), [
    "schemaVersion",
    "layer",
    "acceptedSchemaId",
    "acceptedRevisionId",
    "structuralTraitIds",
    "controlCount",
    "requiredControlCount",
    "optionCount",
    "reviewLineage",
  ]);
  assert.equal(manifest.artifactCount, 3);
  assert.equal(Object.hasOwn(candidate, "observedVariantId"), false);
  assert.equal(Object.hasOwn(candidate, "candidateId"), false);
});

test("enforces record-count limits independently of byte limits", () => {
  const root = evidenceRoot();
  const error = {
    code: "mailbox_timeout",
    component: "S2_MAILBOX_PROVIDER",
    phase: "mailbox_verification",
    step: "observe",
    retryable: true,
  } as const;
  assert.throws(
    () => writeLiveEvidencePacket(request(root, {
      errors: Array.from({ length: 17 }, () => error),
    })),
    /live evidence denied/u,
  );
  assert.deepEqual(readdirSync(root), []);
});

test("denies undisclosed omission of whole milestone and verification categories", () => {
  const root = evidenceRoot();
  assert.throws(
    () => writeLiveEvidencePacket(request(root, {
      milestones: [],
      verificationSummaries: [],
      missingEvidence: [],
    })),
    /live evidence denied/u,
  );
  assert.deepEqual(readdirSync(root), []);
});

test("denies a false missing-evidence claim when corresponding proof is verified", () => {
  const root = evidenceRoot();
  assert.throws(
    () => writeLiveEvidencePacket(request(root, {
      missingEvidence: ["account_verification"],
    })),
    /live evidence denied/u,
  );
  assert.deepEqual(readdirSync(root), []);
});

test("reports diagnostic mismatch against sealed completion evidence", () => {
  const root = evidenceRoot();
  writeLiveEvidencePacket(request(root, {
    diagnosticProjection: {
      reviewReached: true,
      requiredFieldsComplete: false,
      submitActivated: false,
    },
  }));
  const summary = JSON.parse(
    readFileSync(join(root, "real-evidence", "summary.json"), "utf8"),
  ) as { readonly diagnosticComparison: { readonly matchesBrowserTruth: boolean } };
  assert.equal(summary.diagnosticComparison.matchesBrowserTruth, false);
});
