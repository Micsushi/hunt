import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { writeApplicationWalkEvidence } from "../../../src/live/evidence/application-walk-evidence.ts";
import {
  fieldId,
  questionId,
  upstreamResumeId,
} from "../../../src/contracts/index.ts";

test("writes one exact checkpoint packet with all prior independent lane checks", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-application-walk-"));
  try {
    await writeApplicationWalkEvidence({
      root,
      acceptance: packet(),
      sensitiveValues: ["Ada", "private@example.invalid"],
    });
    assert.deepEqual(readdirSync(root), ["application-walk-acceptance.json"]);
    assert.deepEqual(
      JSON.parse(readFileSync(join(root, "application-walk-acceptance.json"), "utf8")),
      packet(),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects widened, incomplete, duplicate, Submit, and sensitive evidence", async () => {
  const cases = [
    { ...packet(), submitActivated: true },
    { ...packet(), completedPages: 2 },
    { ...packet(), pageChecks: packet().pageChecks.slice(0, 2) },
    {
      ...packet(),
      pageChecks: packet().pageChecks.map((item, index) =>
        index === 1 ? { ...item, duplicateRows: 1 } : item
      ),
    },
    {
      ...packet(),
      laneAcceptances: packet().laneAcceptances.map((lane) =>
        lane.checkpoint === "profile_verified"
          ? {
              ...lane,
              verifiedFields: lane.verifiedFields.map((field) => ({
                ...field,
                provenance: "invented",
              })),
            }
          : lane
      ),
    },
    { ...packet(), rawProfileValue: "Ada" },
  ];
  for (const acceptance of cases) {
    const root = mkdtempSync(join(tmpdir(), "hunt-s2-application-walk-denied-"));
    try {
      await assert.rejects(writeApplicationWalkEvidence({
        root,
        acceptance: acceptance as never,
        sensitiveValues: ["Ada"],
      }));
      assert.deepEqual(readdirSync(root), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

function packet() {
  return {
    schemaVersion: 1 as const,
    evidenceRevision: "s2-application-walk-acceptance-v1" as const,
    checkpoint: "pre_review" as const,
    status: "passed" as const,
    sourceRevision: "0123456789abcdef0123456789abcdef01234567",
    revisionId: "revision_abcdefghijklmnop",
    approvalId: "approval_abcdefghijklmnop",
    journeyId: "journey_abcdefghijklmnop",
    targetHandleId: "target_ref_abcdefghijklmnop",
    completedPages: 3,
    pageChecks: [
      {
        page: "profile" as const,
        checkpoint: "profile_verified" as const,
        independentlyVerified: true as const,
        requiredFields: 1,
        verifiedFields: 1,
        duplicateRows: 0,
      },
      {
        page: "resume" as const,
        checkpoint: "resume_verified" as const,
        independentlyVerified: true as const,
        requiredFields: 1,
        verifiedFields: 1,
        duplicateRows: 0,
      },
      {
        page: "questionnaire" as const,
        checkpoint: "questionnaire_verified" as const,
        independentlyVerified: true as const,
        requiredFields: 1,
        verifiedFields: 1,
        duplicateRows: 0,
      },
    ],
    laneAcceptances: [
      {
        schemaVersion: 1 as const,
        checkpoint: "profile_verified" as const,
        pageType: "profile" as const,
        verifiedFields: [{
          fieldId: "identity.given_name",
          questionType: "identity" as const,
          answerType: "text" as const,
          uiBehavior: "text" as const,
          uiVariant: "workday_text_v1",
          provenance: "owner_provided" as const,
        }],
        ownedDuplicateRows: 0 as const,
        independentlyVerified: true as const,
        submitActivated: false as const,
        privacyScan: "pass" as const,
      },
      {
        schemaVersion: 1 as const,
        checkpoint: "resume_verified" as const,
        artifactId: upstreamResumeId("resume_abcdefghijklmnop"),
        sizeBytes: 1024,
        fileType: "pdf" as const,
        browserState: {
          variant: "workday_resume_file_upload_v1" as const,
          inputCardinality: 1 as const,
          uploadedFileCount: 1 as const,
          uploadComplete: true as const,
          requiredErrorVisible: false as const,
          removeControlCardinality: 1 as const,
        },
        independentlyVerified: true as const,
        duplicateUploadAvoided: false,
        replacedExisting: false,
        submitActivated: false as const,
        privacyScan: "pass" as const,
      },
      {
        schemaVersion: 1 as const,
        checkpoint: "questionnaire_verified" as const,
        answers: [{
          fieldId: fieldId("authorization-answer"),
          questionId: questionId("s1-question-work-authorization"),
          provenance: "owner_provided" as const,
          protectedCategory: "authorization" as const,
          templateRevision: null,
          verification: "independent" as const,
        }],
        protectedPlaceholderCount: 0 as const,
        independentlyVerified: true as const,
        submitActivated: false as const,
        privacyScan: "pass" as const,
      },
    ],
    submitActivated: false as const,
    privacyScan: "pass" as const,
    cleanup: "pass" as const,
  };
}
