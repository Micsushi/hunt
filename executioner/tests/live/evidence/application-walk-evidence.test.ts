import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { writeApplicationWalkEvidence } from "../../../src/live/evidence/application-walk-evidence.ts";
import type { ProfileSyntheticFieldEvidence } from
  "../../../src/ats/workday/application/lane-composition.ts";
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

test("admits evidence in the exact observed route instead of a tenant-global order", async () => {
  const baseline = packet();
  const resumeFirst = {
    ...baseline,
    pageChecks: [baseline.pageChecks[1]!, baseline.pageChecks[0]!, baseline.pageChecks[2]!],
    laneAcceptances: [
      baseline.laneAcceptances[1]!,
      baseline.laneAcceptances[0]!,
      baseline.laneAcceptances[2]!,
    ],
  };
  const skippedResume = {
    ...baseline,
    completedPages: 2,
    pageChecks: [baseline.pageChecks[0]!, baseline.pageChecks[2]!],
    laneAcceptances: [baseline.laneAcceptances[0]!, baseline.laneAcceptances[2]!],
  };

  const directReview = {
    ...baseline,
    completedPages: 0,
    pageChecks: [],
    laneAcceptances: [],
  };
  for (const acceptance of [resumeFirst, skippedResume, directReview]) {
    const root = mkdtempSync(join(tmpdir(), "hunt-s2-application-route-"));
    try {
      await writeApplicationWalkEvidence({ root, acceptance, sensitiveValues: [] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("admits one cumulative lane proof for consecutive revealed questionnaire pages", async () => {
  const baseline = packet();
  const questionnaire = baseline.pageChecks[2]!;
  const acceptance = {
    ...baseline,
    completedPages: 5,
    pageChecks: [
      ...baseline.pageChecks,
      { ...questionnaire, requiredFields: 2, verifiedFields: 2 },
      { ...questionnaire, requiredFields: 3, verifiedFields: 3 },
    ],
  };
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-application-revealed-"));
  try {
    await writeApplicationWalkEvidence({ root, acceptance, sensitiveValues: [] });
    assert.equal(
      JSON.parse(readFileSync(join(root, "application-walk-acceptance.json"), "utf8"))
        .pageChecks.length,
      5,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("admits derived source-select and owner-backed prior-worker radio mechanics", async () => {
  const baseline = packet();
  const profile = baseline.laneAcceptances[0];
  if (profile?.checkpoint !== "profile_verified") throw new Error("profile fixture unavailable");
  const acceptance = {
    ...baseline,
    laneAcceptances: [{
      ...profile,
      verifiedFields: [
        ...profile.verifiedFields,
        {
          fieldId: "source.how_did_you_hear",
          questionType: "application_source" as const,
          answerType: "option" as const,
          uiBehavior: "search_select" as const,
          uiVariant: "workday_source_select_v1",
          provenance: "journey_derived" as const,
          lane: "live_owner_fact" as const,
          optionMappingProvenance: "visible_option" as const,
        },
        {
          fieldId: "employment.previously_worked_for_organization",
          questionType: "prior_employment" as const,
          answerType: "option" as const,
          uiBehavior: "radio_group" as const,
          uiVariant: "workday_previous_worker_radio_v1",
          provenance: "owner_provided" as const,
          lane: "live_owner_fact" as const,
          optionMappingProvenance: "visible_option" as const,
        },
      ],
    }, ...baseline.laneAcceptances.slice(1)],
  };
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-application-owner-ui-"));
  try {
    await writeApplicationWalkEvidence({ root, acceptance, sensitiveValues: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("admits a reviewed profile field identifier that contains a private option token", async () => {
  const baseline = packet();
  const profile = baseline.laneAcceptances[0];
  if (profile?.checkpoint !== "profile_verified") throw new Error("profile fixture unavailable");
  const acceptance = {
    ...baseline,
    laneAcceptances: [{
      ...profile,
      verifiedFields: [{
        ...profile.verifiedFields[0]!,
        fieldId: "social.linkedin",
        questionType: "social_network" as const,
        answerType: "url" as const,
      }],
    }, ...baseline.laneAcceptances.slice(1)],
  };
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-application-structural-"));
  try {
    await writeApplicationWalkEvidence({ root, acceptance, sensitiveValues: ["linkedin"] });
    const text = readFileSync(join(root, "application-walk-acceptance.json"), "utf8");
    assert.equal(text.includes('"linkedin"'), false);
    assert.equal(text.includes('"social.linkedin"'), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("still rejects a private option token embedded in an unreviewed field identifier", async () => {
  const baseline = packet();
  const profile = baseline.laneAcceptances[0];
  if (profile?.checkpoint !== "profile_verified") throw new Error("profile fixture unavailable");
  const acceptance = {
    ...baseline,
    laneAcceptances: [{
      ...profile,
      verifiedFields: [{
        ...profile.verifiedFields[0]!,
        fieldId: "identity.linkedin",
      }],
    }, ...baseline.laneAcceptances.slice(1)],
  };
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-application-private-id-"));
  try {
    await assert.rejects(
      writeApplicationWalkEvidence({ root, acceptance, sensitiveValues: ["linkedin"] }),
      /application-walk evidence denied/u,
    );
    assert.deepEqual(readdirSync(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("admits a short private token collision inside the reviewed profile learning digest", async () => {
  const baseline = packet();
  const profile = baseline.laneAcceptances[0];
  if (profile?.checkpoint !== "profile_verified") throw new Error("profile fixture unavailable");
  const { submitActivated, privacyScan, ...beforeGuard } = profile;
  const acceptance = {
    ...baseline,
    laneAcceptances: [{
      ...beforeGuard,
      profileFieldLearningSha256: `${"a".repeat(30)}143${"b".repeat(31)}`,
      submitActivated,
      privacyScan,
    }, ...baseline.laneAcceptances.slice(1)],
  };
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-application-reviewed-digest-"));
  try {
    await writeApplicationWalkEvidence({ root, acceptance, sensitiveValues: ["143"] });
    assert.equal(
      statSync(join(root, "application-walk-acceptance.json")).isFile(),
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("admits short private token collisions inside synthetic profile digests", async () => {
  const digestKeys = [
    "occurrenceId", "labelSha256", "optionsSha256", "constraintsSha256",
    "committedReadbackSha256",
  ] as const;
  const baseline = packet();
  const profile = baseline.laneAcceptances[0];
  if (profile?.checkpoint !== "profile_verified") throw new Error("profile fixture unavailable");
  const safeDigest = "a".repeat(64);
  const collidingDigest = `${"a".repeat(30)}143${"b".repeat(31)}`;
  for (const digestKey of digestKeys) {
    const syntheticField: ProfileSyntheticFieldEvidence = {
      occurrenceId: safeDigest,
      questionId: "question.profile.address.line1",
      fieldId: "address.line1",
      rowKey: null,
      labelSha256: safeDigest,
      required: true,
      semanticQuestionType: "unknown",
      answerType: "text",
      controlType: "text",
      uiVariant: "workday_text_v2",
      optionsSha256: safeDigest,
      constraintsSha256: safeDigest,
      committedReadbackSha256: safeDigest,
      provenance: "generated_default",
      [digestKey]: collidingDigest,
    };
    const root = mkdtempSync(join(tmpdir(), "hunt-s2-application-synthetic-digest-"));
    try {
      await writeApplicationWalkEvidence({
        root,
        acceptance: {
          ...baseline,
          answerFallbackPolicy: "deterministic_site_valid_editable",
          laneAcceptances: [{
            ...profile,
            answerFallbackPolicy: "deterministic_site_valid_editable",
            verifiedFields: [{
              fieldId: "address.line1",
              questionType: "address",
              answerType: "text",
              uiBehavior: "text",
              uiVariant: "workday_text_v2",
              provenance: "generated_default",
              lane: "synthetic_test_default",
            }],
            syntheticFields: [syntheticField],
            profileFieldLearningSha256: safeDigest,
          }, ...baseline.laneAcceptances.slice(1)],
        },
        sensitiveValues: ["143"],
      });
      assert.equal(statSync(join(root, "application-walk-acceptance.json")).isFile(), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("rejects synthetic defaults from live Workday v2 acceptance", async () => {
  const baseline = packet();
  const profile = baseline.laneAcceptances[0];
  if (profile?.checkpoint !== "profile_verified") throw new Error("profile fixture unavailable");
  const acceptance = {
    ...baseline,
    laneAcceptances: [{
      ...profile,
      verifiedFields: [
        { ...profile.verifiedFields[0]!, uiVariant: "workday_text_v2" },
        {
          fieldId: "address.region",
          questionType: "address" as const,
          answerType: "option" as const,
          uiBehavior: "search_select" as const,
          uiVariant: "workday_search_select_v2",
          provenance: "generated_default" as const,
          lane: "synthetic_test_default" as const,
          optionMappingProvenance: "visible_option" as const,
        },
        {
          fieldId: "phone.number",
          questionType: "phone" as const,
          answerType: "phone" as const,
          uiBehavior: "phone" as const,
          uiVariant: "workday_phone_v2",
          provenance: "generated_default" as const,
          lane: "synthetic_test_default" as const,
        },
      ],
    }, ...baseline.laneAcceptances.slice(1)],
  };
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-application-v2-ui-"));
  try {
    await assert.rejects(
      writeApplicationWalkEvidence({ root, acceptance: acceptance as never, sensitiveValues: [] }),
      /application-walk evidence denied/u,
    );
    assert.deepEqual(readdirSync(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("admits every supported synthetic unknown Profile control shape", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-profile-unknown-evidence-"));
  try {
    const baseline = packet();
    const shapes = [
      ["unknown.required.1", "text", "text"],
      ["unknown.required.2", "single_select", "select"],
      ["unknown.required.3", "multi_select", "multi_select"],
      ["unknown.required.4", "file", "file"],
    ] as const;
    const profile = baseline.laneAcceptances[0];
    if (profile?.checkpoint !== "profile_verified") throw new Error("profile fixture missing");
    const verifiedFields = shapes.map(([fieldIdValue, answerType, uiBehavior]) => ({
      fieldId: fieldIdValue,
      questionType: "unknown" as const,
      answerType,
      uiBehavior,
      uiVariant: "workday_unknown_required_v1",
      provenance: "generated_default" as const,
      lane: "synthetic_test_default" as const,
    }));
    const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
    const syntheticFields: readonly ProfileSyntheticFieldEvidence[] = shapes.map(
      ([fieldIdValue, answerType, uiBehavior]): ProfileSyntheticFieldEvidence => {
      const pendingAnswer: "text" | "single_select" | "multi_select" | "file" =
        answerType === "single_select" ? "single_select" : answerType;
      const controlType: "text" | "select" | "listbox" | "file_upload" =
        uiBehavior === "multi_select" ? "listbox" :
        uiBehavior === "file" ? "file_upload" : uiBehavior;
      return {
        occurrenceId: hash(`profile-page-1\0\0${fieldIdValue}`),
        questionId: `question.profile.${fieldIdValue}`,
        fieldId: fieldIdValue,
        rowKey: null,
        labelSha256: hash(`Unknown ${fieldIdValue}`),
        required: true,
        semanticQuestionType: "unknown" as const,
        answerType: pendingAnswer,
        controlType,
        uiVariant: "workday_unknown_required_v1",
        optionsSha256: hash(JSON.stringify(answerType.includes("select") ? ["One", "Two"] : [])),
        constraintsSha256: hash("null"),
        committedReadbackSha256: hash("Synthetic owner review"),
        provenance: "generated_default" as const,
      };
    });
    const laneAcceptances = [{
          schemaVersion: profile.schemaVersion,
          checkpoint: profile.checkpoint,
          pageId: profile.pageId,
          answerFallbackPolicy: "deterministic_site_valid_editable" as const,
          pageType: profile.pageType,
          verifiedFields,
          syntheticFields,
          ownedDuplicateRows: profile.ownedDuplicateRows,
          independentlyVerified: profile.independentlyVerified,
          profileFieldLearningSha256: "a".repeat(64),
          submitActivated: profile.submitActivated,
          privacyScan: profile.privacyScan,
        }, ...baseline.laneAcceptances.slice(1)];
    await writeApplicationWalkEvidence({
      root,
      acceptance: {
        ...baseline,
        answerFallbackPolicy: "deterministic_site_valid_editable",
        laneAcceptances,
      },
      sensitiveValues: [],
    });
    const admitted = JSON.parse(readFileSync(
      join(root, "application-walk-acceptance.json"), "utf8",
    ));
    assert.deepEqual(admitted.laneAcceptances[0].syntheticFields.map(
      ({ answerType, controlType }: { answerType: string; controlType: string }) =>
        [answerType, controlType]
    ), [["text", "text"], ["single_select", "select"], ["multi_select", "listbox"], ["file", "file_upload"]]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writes a bounded multi-page acceptance larger than the generic acceptance packet", async () => {
  const baseline = packet();
  const profile = baseline.laneAcceptances[0];
  if (profile?.checkpoint !== "profile_verified") throw new Error("profile fixture unavailable");
  const verifiedFields = Array.from({ length: 70 }, (_, index) => ({
    ...profile.verifiedFields[0]!,
    fieldId: `identity.field_${index.toString().padStart(3, "0")}_${"x".repeat(80)}`,
  }));
  const acceptance = {
    ...baseline,
    completedPages: 1,
    pageChecks: [{
      ...baseline.pageChecks[0]!,
      requiredFields: verifiedFields.length,
      verifiedFields: verifiedFields.length,
    }],
    laneAcceptances: [{ ...profile, verifiedFields }],
  };
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-application-large-route-"));
  try {
    await writeApplicationWalkEvidence({ root, acceptance, sensitiveValues: [] });
    assert.ok(statSync(join(root, "application-walk-acceptance.json")).size > 16 * 1024);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects widened, incomplete, duplicate, Submit, and sensitive evidence", async () => {
  const cases = [
    { ...packet(), answerFallbackPolicy: "deterministic_site_valid_editable" },
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
    {
      ...packet(),
      laneAcceptances: packet().laneAcceptances.map((lane) =>
        lane.checkpoint === "profile_verified"
          ? {
              ...lane,
              verifiedFields: lane.verifiedFields.map((field) => {
                const { lane: _lane, ...missingLane } = field;
                return missingLane;
              }),
            }
          : lane
      ),
    },
    {
      ...packet(),
      laneAcceptances: packet().laneAcceptances.map((lane) =>
        lane.checkpoint === "questionnaire_verified"
          ? {
              ...lane,
              answers: lane.answers.map((answer) => ({
                ...answer,
                lane: "synthetic_test_default",
              })),
            }
          : lane
      ),
    },
    {
      ...packet(),
      laneAcceptances: packet().laneAcceptances.map((lane) =>
        lane.checkpoint === "profile_verified"
          ? (() => {
              const { submitActivated, privacyScan, ...beforeGuard } = lane;
              return {
                ...beforeGuard,
                profileFieldLearningSha256: undefined,
                submitActivated,
                privacyScan,
              };
            })()
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
    schemaVersion: 2 as const,
    evidenceRevision: "s2-application-walk-acceptance-v2" as const,
    checkpoint: "pre_review" as const,
    status: "passed" as const,
    browserTransport: "live_browser" as const,
    answerFallbackPolicy: "owner_facts_only" as const,
    submissionPolicy: "forbidden" as const,
    liveProofEligibility: "eligible" as const,
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
        pageId: "profile-page-1" as never,
        answerFallbackPolicy: "owner_facts_only" as const,
        pageType: "profile" as const,
        verifiedFields: [{
          fieldId: "identity.given_name",
          questionType: "identity" as const,
          answerType: "text" as const,
          uiBehavior: "text" as const,
          uiVariant: "workday_text_v1",
          provenance: "owner_provided" as const,
          lane: "live_owner_fact" as const,
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
          pageId: "questionnaire-page-1" as never,
          fieldId: fieldId("authorization-answer"),
          questionId: questionId("s1-question-work-authorization"),
          provenance: "owner_provided" as const,
          lane: "live_owner_fact" as const,
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
