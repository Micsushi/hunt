import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  completeWorkdayProfilePage,
  profileInspectionDiagnostic,
  profileInspectionTraceDetails,
  type ProfileInspectionFailure,
  type ProfilePagePlan,
  type ProfilePageSnapshot,
  type WorkdayProfilePagePort,
} from "../../../src/ats/workday/application/profile/index.ts";
import {
  createValueFreeRunTrace,
  readValueFreeRunTrace,
} from "../../../src/live/evidence/value-free-run-trace.ts";

class ExhaustedInspectionPage implements WorkdayProfilePagePort {
  private readonly error: Error;
  private readonly failure: ProfileInspectionFailure;

  constructor(
    error: Error,
    failure: ProfileInspectionFailure,
  ) {
    this.error = error;
    this.failure = failure;
  }

  async inspect(): Promise<ProfilePageSnapshot> {
    throw this.error;
  }

  inspectionFailure(): ProfileInspectionFailure {
    return this.failure;
  }

  async commit(): Promise<void> {
    throw new Error("mutation not admitted");
  }

  async addOwnedRow(): Promise<string> {
    throw new Error("mutation not admitted");
  }

  async removeOwnedRow(): Promise<void> {
    throw new Error("mutation not admitted");
  }
}

test("durable run trace retains ordered structural state and drops applicant values", () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-value-free-trace-"));
  const streamed: string[] = [];
  try {
    const trace = createValueFreeRunTrace(root, (line) => streamed.push(line));
    trace("application_walk_progress", {
      checkpoint: "questionnaire",
      browserPage: "questionnaire",
      questionTypes: ["authorization", "employment"],
      answerTypes: ["single_select", "number"],
      completedPages: 2,
      code: "page_incomplete",
      classifier: "required_field_gate",
      primitive: "required_field_verification",
      unknownLayer: "required_field",
      submitActivated: false,
      email: "applicant_private_sentinel",
      answer: "private answer",
    });
    trace("external_monitor_acknowledged", {
      chain: "application",
      page: "questionnaire",
      moment: "after_readback",
      ordinal: 7,
      operationId: "operation_question_mutation_01",
      attempt: 1,
      submitPresent: false,
      submitActivated: false,
    });
    trace("application_observer_required_field_projection", {
      page: "profile",
      requiredFields: 2,
      verifiedFields: 1,
      unverifiedFieldIds: ["profile.phone.number"],
      unverifiedFieldReasons: ["profile.phone.number.phone.backing"],
      applicantValue: "private observer value",
    });
    trace("application_required_field_diagnostic", {
      fieldId: "phoneNumber--countryPhoneCode",
      uiBehavior: "search_select",
      selectedItemCount: 1,
      fieldOwnerSelectedItemCount: 1,
      derivedBackingRuleCount: 1,
      derivedBackingRuleMatched: true,
      derivedVisibleUpstreamCount: 1,
      derivedUpstreamBackingCommitted: false,
      applicantValue: "private derived value",
    });
    trace("profile_post_verification_phase", {
      phase: "stable_page",
      status: "failed",
      failureName: "TypeError",
      applicantValue: "private phase value",
    });
    trace("questionnaire_checkbox_diagnostics", {
      groupCount: 1,
      checkboxCount: 3,
      checkedCount: 0,
      adapterSelectCount: 5,
      adapterExclusiveSelectCount: 1,
      sharedOptionSelectCount: 2,
      exactObjectCallCount: 2,
      exactCommitCount: 0,
      nested: { answer: "private answer" },
    });
    trace("questionnaire_date_diagnostics", {
      dateInputCount: 1,
      allTextTelInputCount: 4,
      maskedInputCount: 1,
      visibleMaskedInputCount: 0,
      exactDateLabelCount: 1,
      exactMaskTextCount: 1,
      exactMaskTextSpanCount: 1,
      dateOwnerCandidateCount: 1,
      dateOwnerInputCount: 1,
      dateOwnerSvgCount: 1,
      boundDateInputCount: 1,
      boundDateExactLabelCount: 2,
      boundDateAssociatedLabelCount: 2,
      boundDateClosestFormFieldCount: 0,
      boundDateClosestDateSectionCount: 0,
      boundDatePlaceholderMaskCount: 0,
      boundDateValueMaskCount: 1,
      boundDateReactOnChangeCount: 1,
      dateSvgOwnerCandidateCount: 1,
      dateSvgOwnerDepth: 2,
      dateSvgOwnerExactLabelCount: 2,
      dateSvgOwnerLabelCount: 2,
      dateSvgOwnerSvgCount: 1,
      dateSvgOwnerInputCount: 1,
      dateSvgOwnerButtonCount: 0,
      dateSvgOwnerRoleButtonCount: 0,
      dateSvgOwnerAutomationCount: 1,
      dateSvgOwnerReactClickCount: 1,
      boundRightHitInput: false,
      boundRightHitWithinSvgOwner: true,
      boundRightHitSvgAncestor: true,
      boundRightReactClickAncestorCount: 1,
      ownedDateLabelOwnerDepth: 3,
      ownedDateLabelOwnerVisibleLabelCount: 2,
      ownedDateLabelOwnerExactLabelCount: 2,
      ownedDateLabelOwnerVisibleTextTelInputCount: 1,
      ownedDateLabelOwnerSvgCount: 1,
      ownedDateLabelOwnerButtonCount: 1,
      reboundDateExactLabelCount: 2,
      reboundDateLabelInputOwnerCount: 2,
      reboundDateLabelSvgOwnerCount: 2,
      reboundDateDistinctInputCount: 1,
      reboundDateDistinctSvgCount: 1,
      reboundDateJointOwnerCount: 1,
      formattedDateReboundCount: 1,
      fieldButtonCount: 0,
      fieldRoleButtonCount: 0,
      fieldSvgCount: 1,
      fieldAutomationCount: 2,
      rightHitInput: false,
      rightHitWithinField: true,
      rightHitButtonAncestor: false,
      rightHitRoleButtonAncestor: false,
      rightHitSvgAncestor: true,
      rightHitAutomationAncestor: true,
      rightHitReactClickAncestorCount: 1,
      applicantValue: "private date",
    });

    const path = join(root, "value-free-trace.ndjson");
    const text = readFileSync(path, "utf8");
    assert.equal(text.includes("applicant_private_sentinel"), false);
    assert.equal(text.includes("private answer"), false);
    assert.equal(streamed.join("").includes("applicant_private_sentinel"), false);
    const records = readValueFreeRunTrace(path);
    assert.deepEqual(records.map(({ sequence, event }) => [sequence, event]), [
      [1, "application_walk_progress"],
      [2, "external_monitor_acknowledged"],
      [3, "application_observer_required_field_projection"],
      [4, "application_required_field_diagnostic"],
      [5, "profile_post_verification_phase"],
      [6, "questionnaire_checkbox_diagnostics"],
      [7, "questionnaire_date_diagnostics"],
    ]);
    assert.deepEqual(records[0]?.details.questionTypes, ["authorization", "employment"]);
    assert.deepEqual(records[2]?.details, {
      page: "profile",
      requiredFields: 2,
      verifiedFields: 1,
      unverifiedFieldIds: ["profile.phone.number"],
      unverifiedFieldReasons: ["profile.phone.number.phone.backing"],
    });
    assert.deepEqual(records[3]?.details, {
      fieldId: "phoneNumber--countryPhoneCode",
      uiBehavior: "search_select",
      selectedItemCount: 1,
      fieldOwnerSelectedItemCount: 1,
      derivedBackingRuleCount: 1,
      derivedBackingRuleMatched: true,
      derivedVisibleUpstreamCount: 1,
      derivedUpstreamBackingCommitted: false,
    });
    assert.deepEqual(records[4]?.details, {
      phase: "stable_page",
      status: "failed",
      failureName: "TypeError",
    });
    assert.deepEqual(records[5]?.details, {
      groupCount: 1,
      checkboxCount: 3,
      checkedCount: 0,
      adapterSelectCount: 5,
      adapterExclusiveSelectCount: 1,
      sharedOptionSelectCount: 2,
      exactObjectCallCount: 2,
      exactCommitCount: 0,
    });
    assert.deepEqual(records[6]?.details, {
      dateInputCount: 1,
      allTextTelInputCount: 4,
      maskedInputCount: 1,
      visibleMaskedInputCount: 0,
      exactDateLabelCount: 1,
      exactMaskTextCount: 1,
      exactMaskTextSpanCount: 1,
      dateOwnerCandidateCount: 1,
      dateOwnerInputCount: 1,
      dateOwnerSvgCount: 1,
      boundDateInputCount: 1,
      boundDateExactLabelCount: 2,
      boundDateAssociatedLabelCount: 2,
      boundDateClosestFormFieldCount: 0,
      boundDateClosestDateSectionCount: 0,
      boundDatePlaceholderMaskCount: 0,
      boundDateValueMaskCount: 1,
      boundDateReactOnChangeCount: 1,
      dateSvgOwnerCandidateCount: 1,
      dateSvgOwnerDepth: 2,
      dateSvgOwnerExactLabelCount: 2,
      dateSvgOwnerLabelCount: 2,
      dateSvgOwnerSvgCount: 1,
      dateSvgOwnerInputCount: 1,
      dateSvgOwnerButtonCount: 0,
      dateSvgOwnerRoleButtonCount: 0,
      dateSvgOwnerAutomationCount: 1,
      dateSvgOwnerReactClickCount: 1,
      boundRightHitInput: false,
      boundRightHitWithinSvgOwner: true,
      boundRightHitSvgAncestor: true,
      boundRightReactClickAncestorCount: 1,
      ownedDateLabelOwnerDepth: 3,
      ownedDateLabelOwnerVisibleLabelCount: 2,
      ownedDateLabelOwnerExactLabelCount: 2,
      ownedDateLabelOwnerVisibleTextTelInputCount: 1,
      ownedDateLabelOwnerSvgCount: 1,
      ownedDateLabelOwnerButtonCount: 1,
      reboundDateExactLabelCount: 2,
      reboundDateLabelInputOwnerCount: 2,
      reboundDateLabelSvgOwnerCount: 2,
      reboundDateDistinctInputCount: 1,
      reboundDateDistinctSvgCount: 1,
      reboundDateJointOwnerCount: 1,
      formattedDateReboundCount: 1,
      fieldButtonCount: 0,
      fieldRoleButtonCount: 0,
      fieldSvgCount: 1,
      fieldAutomationCount: 2,
      rightHitInput: false,
      rightHitWithinField: true,
      rightHitButtonAncestor: false,
      rightHitRoleButtonAncestor: false,
      rightHitSvgAncestor: true,
      rightHitAutomationAncestor: true,
      rightHitReactClickAncestorCount: 1,
    });
    assert.equal(Object.isFrozen(records[0]?.details), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("questionnaire exception trace retains value-free reconciliation context", () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-value-free-reconciliation-trace-"));
  try {
    const trace = createValueFreeRunTrace(root);
    trace("questionnaire_reconciliation_exception", {
      learningPresent: true,
      errorType: "TypeError",
      fieldId: "field-workday-general-1",
      uiBehavior: "listbox",
      failureStage: "record_attempt",
      operationId: "operation_general_restore_01",
      priorCommittedState: "verified_intent_present",
      observedState: "selected",
      committedReadbackMatches: false,
      operation: "restore_choice",
      observedOptionCount: 4,
      remountGeneration: 2,
      conditionalDelta: 1,
      conditionalAdded: ["field-workday-general-2"],
      conditionalRemoved: ["field-workday-general-0"],
      underlyingError: "question_answer_learning_evidence_denied",
      chosenAnswer: "private answer",
    });

    const [record] = readValueFreeRunTrace(join(root, "value-free-trace.ndjson"));
    assert.deepEqual(record?.details, {
      learningPresent: true,
      errorType: "TypeError",
      fieldId: "field-workday-general-1",
      uiBehavior: "listbox",
      failureStage: "record_attempt",
      operationId: "operation_general_restore_01",
      priorCommittedState: "verified_intent_present",
      observedState: "selected",
      committedReadbackMatches: false,
      operation: "restore_choice",
      observedOptionCount: 4,
      remountGeneration: 2,
      conditionalDelta: 1,
      conditionalAdded: ["field-workday-general-2"],
      conditionalRemoved: ["field-workday-general-0"],
      underlyingError: "question_answer_learning_evidence_denied",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sealed run trace rejects retained callbacks without changing terminal bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-value-free-trace-"));
  try {
    const trace = createValueFreeRunTrace(root, () => undefined);
    trace("runtime_total_completed", { submitActivated: false });
    trace.seal();
    const path = join(root, "value-free-trace.ndjson");
    const before = readFileSync(path);
    trace("late_mutation", { submitActivated: true });
    assert.deepEqual(readFileSync(path), before);
    assert.equal(readValueFreeRunTrace(path).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("production acceptance enables only the sanitized retained trace gate", () => {
  const local = readFileSync(
    new URL("../../../src/acceptance/s2-local.ts", import.meta.url),
    "utf8",
  );
  const runtime = readFileSync(
    new URL("../../../src/acceptance/s2-playwright-runtime.ts", import.meta.url),
    "utf8",
  );
  const profile = readFileSync(
    new URL("../../../src/ats/workday/application/profile/playwright-page.ts", import.meta.url),
    "utf8",
  );
  assert.match(local, /name !== "HUNT_C3_VALUE_FREE_ACCOUNT_TRACE"/u);
  assert.match(local, /HUNT_C3_RETAINED_VALUE_FREE_TRACE: "1"/u);
  assert.match(runtime, /HUNT_C3_RETAINED_VALUE_FREE_TRACE === "1"/u);
  assert.doesNotMatch(profile, /HUNT_C3_RETAINED_VALUE_FREE_TRACE/u);
});

test("multi-select ownership trace retains only structural counts", () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-multi-select-ownership-trace-"));
  try {
    const trace = createValueFreeRunTrace(root, () => undefined);
    trace("profile_multi_select_readback_ownership", {
      selectedItemCount: 2,
      productionOwnerCount: 1,
      productionOwnedSelectedItemCount: 1,
      unownedSelectedItemCount: 1,
      canonicalItemCount: 1,
      fallbackItemCount: 0,
      chosenItemCount: 1,
      chosenUniqueCount: 1,
      usedProductionOwners: true,
      selectedLabels: ["private-skill-sentinel"],
      applicantValue: "private-profile-sentinel",
    });
    const path = join(root, "value-free-trace.ndjson");
    assert.deepEqual(readValueFreeRunTrace(path)[0]?.details, {
      selectedItemCount: 2,
      productionOwnerCount: 1,
      productionOwnedSelectedItemCount: 1,
      unownedSelectedItemCount: 1,
      canonicalItemCount: 1,
      fallbackItemCount: 0,
      chosenItemCount: 1,
      chosenUniqueCount: 1,
      usedProductionOwners: true,
    });
    assert.doesNotMatch(
      readFileSync(path, "utf8"),
      /private-skill-sentinel|private-profile-sentinel/iu,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("trace observer and invalid details never alter runtime behavior", () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-value-free-trace-failure-"));
  try {
    const trace = createValueFreeRunTrace(root, () => { throw new Error("observer failed"); });
    assert.doesNotThrow(() => trace("account_state_observed", { value: "secret" }));
    assert.equal(readValueFreeRunTrace(join(root, "value-free-trace.ndjson")).length, 1);
    writeFileSync(join(root, "malformed.ndjson"), '{"schemaVersion":1}\n');
    assert.throws(
      () => readValueFreeRunTrace(join(root, "malformed.ndjson")),
      /value-free run trace denied/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("profile inspection retry exhaustion survives runtime flattening and value-free persistence", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-profile-inspection-trace-"));
  const plan: ProfilePagePlan = {
    mode: "live",
    pageType: "profile",
    fields: [],
    repeatables: [],
  };
  const cases = [
    {
      classification: "liveness" as const,
      error: "Target page, context or browser has been closed raw-error-sentinel",
      bindingId: "profile.page",
      digest: "a".repeat(64),
    },
    {
      classification: "dom_owner_binding" as const,
      error: "Workday profile control binding is missing selector-sentinel",
      bindingId: "identity.given_name",
      digest: "b".repeat(64),
    },
    {
      classification: "unknown" as const,
      error: "opaque backend fault profile-value-sentinel",
      bindingId: "profile.unknown",
      digest: "c".repeat(64),
    },
  ];

  try {
    const trace = createValueFreeRunTrace(root, () => undefined);
    for (const item of cases) {
      const result = await completeWorkdayProfilePage(
        plan,
        new ExhaustedInspectionPage(new Error(item.error), {
          classification: item.classification,
          phase: "scalar",
          bindingIds: [item.bindingId],
          bindingPaths: ["profile.scalar"],
          bindingDigests: [item.digest],
          frameCount: 2,
          frameIdentityDigests: ["2".repeat(64), "3".repeat(64)],
          frameDomOwnerCandidateCounts: [1, 2],
          frameControlCandidateCounts: [2, 2],
          frameOwnerControlRelationshipDigests: ["4".repeat(64), "5".repeat(64)],
          frameOwnerControlTupleDigests: ["6".repeat(64), "7".repeat(64)],
          structuralIdentityDigest: "d".repeat(64),
          profileRootCandidateCount: 2,
          profileRootVisibleCount: 0,
          domOwnerCandidateCount: 3,
          controlCandidateCount: 4,
          controlIdDigests: ["e".repeat(64)],
          semanticIdDigests: ["f".repeat(64)],
          bindingDigest: "1".repeat(64),
          profilePortState: "inspecting",
        }),
        AbortSignal.any([]),
      );
      assert.equal(result.kind, "blocked");
      if (result.kind !== "blocked") continue;
      assert.equal(result.code, "profile_port_unavailable");
      assert.equal(result.profileInspectionDiagnostic?.classification, item.classification);
      assert.ok((result.profileInspectionDiagnostic?.retryCount ?? 0) > 0);
      assert.equal(result.profileInspectionDiagnostic?.deadlineMs, 5_000);
      assert.equal(
        result.profileInspectionDiagnostic?.deadlineOutcome,
        "deadline_exceeded_before_return",
      );

      trace("profile_reconciliation_blocked", {
        code: result.code,
        mutationAttempted: false,
        ...profileInspectionTraceDetails(result.profileInspectionDiagnostic!, {
          sessionState: "bound",
          cleanupState: "not_started",
          preservationEligible: false,
          preservationReason: "session_validation_required",
          continueAllowed: false,
        }),
        profileInspectionDiagnostic: result.profileInspectionDiagnostic,
        rawError: item.error,
        selector: '[data-automation-id="private-secret"]',
        profileValue: "profile-value-sentinel",
        credential: "credential-sentinel",
        mailbox: "mailbox_sentinel",
      });
    }

    const path = join(root, "value-free-trace.ndjson");
    const records = readValueFreeRunTrace(path);
    assert.equal(records.length, 3);
    const expectedKeys = [
      "code",
      "mutationAttempted",
      "profileInspectionClassification",
      "profileInspectionPhase",
      "profileInspectionRetryCount",
      "profileInspectionDeadlineMs",
      "profileInspectionElapsedMs",
      "profileInspectionAttemptCount",
      "profileInspectionDeadlineOutcome",
      "profileInspectionFrameCount",
      "profileInspectionFrameIdentityDigests",
      "profileInspectionFrameDomOwnerCandidateCounts",
      "profileInspectionFrameControlCandidateCounts",
      "profileInspectionFrameOwnerControlRelationshipDigests",
      "profileInspectionFrameOwnerControlTupleDigests",
      "profileInspectionStructuralIdentityDigest",
      "profileInspectionProfileRootCandidateCount",
      "profileInspectionProfileRootVisibleCount",
      "profileInspectionDomOwnerCandidateCount",
      "profileInspectionControlCandidateCount",
      "profileInspectionControlIdDigests",
      "profileInspectionSemanticIdDigests",
      "profileInspectionBindingDigest",
      "profileInspectionProfilePortState",
      "profileInspectionSessionState",
      "profileInspectionCleanupState",
      "profileInspectionPreservationEligible",
      "profileInspectionPreservationReason",
      "profileInspectionContinueAllowed",
      "profileInspectionBindingIds",
      "profileInspectionBindingPaths",
      "profileInspectionBindingDigests",
    ].sort();
    assert.deepEqual(Object.keys(records[0]!.details).sort(), expectedKeys);
    assert.deepEqual(records.map(({ details }) => details.profileInspectionClassification), [
      "liveness",
      "dom_owner_binding",
      "unknown",
    ]);
    for (const [index, record] of records.entries()) {
      assert.equal(record.details.mutationAttempted, false);
      assert.equal(record.details.profileInspectionAttemptCount, record.details.profileInspectionRetryCount);
      assert.equal(record.details.profileInspectionDeadlineOutcome, "deadline_exceeded_before_return");
      assert.equal(record.details.profileInspectionProfilePortState, "deadline_exceeded_before_return");
      assert.equal(record.details.profileInspectionSessionState, "bound");
      assert.equal(record.details.profileInspectionCleanupState, "not_started");
      assert.equal(record.details.profileInspectionPreservationEligible, false);
      assert.equal(record.details.profileInspectionPreservationReason, "session_validation_required");
      assert.equal(record.details.profileInspectionContinueAllowed, false);
      assert.equal(record.details.profileInspectionFrameCount, 2);
      assert.deepEqual(record.details.profileInspectionFrameIdentityDigests, [
        "2".repeat(64), "3".repeat(64),
      ]);
      assert.deepEqual(record.details.profileInspectionFrameDomOwnerCandidateCounts, [1, 2]);
      assert.deepEqual(record.details.profileInspectionFrameControlCandidateCounts, [2, 2]);
      assert.deepEqual(record.details.profileInspectionFrameOwnerControlRelationshipDigests, [
        "4".repeat(64), "5".repeat(64),
      ]);
      assert.deepEqual(record.details.profileInspectionFrameOwnerControlTupleDigests, [
        "6".repeat(64), "7".repeat(64),
      ]);
      assert.equal(record.details.profileInspectionProfileRootCandidateCount, 2);
      assert.equal(record.details.profileInspectionProfileRootVisibleCount, 0);
      assert.equal(record.details.profileInspectionDomOwnerCandidateCount, 3);
      assert.equal(record.details.profileInspectionControlCandidateCount, 4);
      assert.match(record.details.profileInspectionStructuralIdentityDigest as string, /^[0-9a-f]{64}$/u);
      assert.match(record.details.profileInspectionBindingDigest as string, /^[0-9a-f]{64}$/u);
      assert.match((record.details.profileInspectionControlIdDigests as readonly string[])[0]!, /^[0-9a-f]{64}$/u);
      assert.match((record.details.profileInspectionSemanticIdDigests as readonly string[])[0]!, /^[0-9a-f]{64}$/u);
      assert.deepEqual(record.details.profileInspectionBindingPaths, ["profile.scalar"]);
      assert.match(
        (record.details.profileInspectionBindingDigests as readonly string[])[0]!,
        /^[0-9a-f]{64}$/u,
      );
      assert.equal((record.details.profileInspectionBindingIds as readonly string[])[0], cases[index]!.bindingId);
    }
    const persisted = readFileSync(path, "utf8");
    assert.doesNotMatch(
      persisted,
      /raw-error-sentinel|selector-sentinel|profile-value-sentinel|credential-sentinel|mailbox_sentinel|private-secret|profileInspectionDiagnostic|submit/iu,
    );
    const delayed = profileInspectionDiagnostic(
      new Error("deadline-only sentinel"),
      undefined,
      162,
      1_000,
      162_000,
      "deadline_exceeded_before_return",
    );
    assert.equal(delayed.deadlineOutcome, "deadline_exceeded_before_return");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("persists eligible and rejected profile-session retention without private identity", () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-profile-retention-trace-"));
  try {
    const trace = createValueFreeRunTrace(root, () => undefined);
    trace("profile_session_preservation", {
      profileInspectionSessionState: "bound",
      profileInspectionCleanupState: "not_started",
      profileInspectionPreservationEligible: true,
      profileInspectionPreservationReason: "eligible",
      profileInspectionContinueAllowed: false,
      frameIdentity: "frame-url-title-label-value-sentinel",
      rawError: "private-error-sentinel",
    });
    trace("profile_session_preservation", {
      profileInspectionSessionState: "invalid",
      profileInspectionCleanupState: "started",
      profileInspectionPreservationEligible: false,
      profileInspectionPreservationReason: "lease_invalid",
      profileInspectionContinueAllowed: false,
    });
    const path = join(root, "value-free-trace.ndjson");
    const records = readValueFreeRunTrace(path);
    assert.deepEqual(records.map(({ details }) => [
      details.profileInspectionPreservationEligible,
      details.profileInspectionPreservationReason,
      details.profileInspectionContinueAllowed,
    ]), [[true, "eligible", false], [false, "lease_invalid", false]]);
    assert.doesNotMatch(readFileSync(path, "utf8"), /frame-url-title-label-value-sentinel|private-error-sentinel|submit/iu);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retains non-submittable learning conversion semantics without values", () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-profile-learning-conversion-trace-"));
  try {
    const trace = createValueFreeRunTrace(root, () => undefined);
    trace("profile_reconciliation_blocked", {
      learningConversion: "profile_ui_learning",
      executionMode: "synthetic_test_non_submittable",
      testOnly: true,
      mutationAllowed: false,
      defaultsGenerated: false,
      learningFieldIds: ["profile.address.country"],
      learningFieldReasons: ["profile.address.country.option_catalog"],
      rawValue: "private-profile-value",
    });
    const records = readValueFreeRunTrace(join(root, "value-free-trace.ndjson"));
    assert.deepEqual(records[0]?.details, {
      learningConversion: "profile_ui_learning",
      executionMode: "synthetic_test_non_submittable",
      testOnly: true,
      mutationAllowed: false,
      defaultsGenerated: false,
      learningFieldIds: ["profile.address.country"],
      learningFieldReasons: ["profile.address.country.option_catalog"],
    });
    assert.doesNotMatch(readFileSync(join(root, "value-free-trace.ndjson"), "utf8"),
      /private-profile-value/iu);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
