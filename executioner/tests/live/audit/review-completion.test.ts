import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deflateSync } from "node:zlib";

import { writeStage2AcceptanceManifest, writeStage2ReviewAcceptance } from "../../../src/acceptance/s2-local.ts";
import { writeStage2TerminalArtifact } from "../../../src/acceptance/s2-terminal-artifact.ts";
import { auditStage2Completion } from "../../../src/composition/private/s2-any-completion-audit.ts";
import {
  finalizeStage2RunStorage,
  prepareStage2RunStorage,
} from "../../../src/composition/private/s2-run-storage.ts";
import { fieldId, questionId, upstreamResumeId } from "../../../src/contracts/index.ts";
import { writeLiveEvidencePacket } from "../../../src/evidence/live/packet.ts";
import { writeAccountVerifiedEvidence } from "../../../src/live/evidence/account-verified-evidence.ts";
import { writeApplicationWalkEvidence } from "../../../src/live/evidence/application-walk-evidence.ts";
import { admitProfileFieldLearningEvidence } from
  "../../../src/live/evidence/profile-field-learning.ts";
import { createValueFreeRunTrace } from
  "../../../src/live/evidence/value-free-run-trace.ts";
import { retainedIntakeTextSha256 } from "../../../src/form/questions/catalog.ts";

const sourceRevision = "0123456789abcdef0123456789abcdef01234567";
const revisionId = "revision_abcdefghijklmnop";
const approvalId = "approval_abcdefghijklmnop";
const journeyId = "journey_abcdefghijklmnop";
const targetHandleId = "target_ref_abcdefghijklmnop";
const noProtection = { protect: async () => undefined };

test("Review completion reconciles the exact gate, walk, browser truth, process cleanup, privacy, and Submit guard", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "hunt-s2-review-audit-"));
  try {
    const layout = await prepareStage2RunStorage({
      storageRoot,
      runKey: "run_20260810_reviewauditxxxxx",
    }, noProtection);
    const configSha256 = writeOwnerConfig(layout);
    await writeReviewEvidence(layout.evidenceRoot, configSha256);

    const audit = await auditStage2Completion(layout.evidenceRoot);
    assert.deepEqual(audit, {
      schemaVersion: 1,
      evidenceRevision: "s2-review-completion-v1",
      status: "pass",
      sourceRevision,
      journeyId,
      runStatus: "passed",
      acceptance: "present",
      applicationWalk: "present",
      acceptanceGate: "present",
      realEvidence: "validated",
      accountVerification: "present",
      processBinding: "production_bound",
      processAuditSha256: digest(readFileSync(join(layout.evidenceRoot, "process-audit.json"))),
      terminalArtifactSha256: digest(readFileSync(
        join(layout.evidenceRoot, "terminal-artifact.json"),
      )),
      profileFieldLearningSha256: digest(readFileSync(
        join(layout.evidenceRoot, "profile-field-learning.json"),
      )),
      questionAnswerLearningSha256: digest(readFileSync(
        join(layout.evidenceRoot, "question-answer-learning.json"),
      )),
      authMonitor: "external_chain_acknowledged",
      monitor: "external_chain_acknowledged",
      monitorClassification: "review_verified",
      processCleanup: "pass",
      privacyScan: "pass",
      submitPresent: true,
      submitActivated: false,
    });
    assert.deepEqual(
      JSON.parse(readFileSync(join(layout.evidenceRoot, "completion-audit.json"), "utf8")),
      audit,
    );
    assert.equal(existsSync(join(layout.evidenceRoot, "review-process-binding.json")), false);
    await finalizeStage2RunStorage({
      storageRoot,
      ownerConfigPath: layout.ownerConfigPath,
      evidenceRoot: layout.evidenceRoot,
    });
    assert.equal(existsSync(layout.transientRoot), false);
    const storageManifest = JSON.parse(
      readFileSync(join(layout.evidenceRoot, "storage-manifest.json"), "utf8"),
    ) as { readonly retainedFiles: readonly { readonly file: string }[] };
    assert.deepEqual(
      storageManifest.retainedFiles.map(({ file }) => file).filter((file) =>
        file.startsWith("real-evidence/")
      ),
      [
        "real-evidence/browser-truth.json",
        "real-evidence/manifest.json",
        "real-evidence/summary.json",
      ],
    );
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("Review completion rejects a required control retained as explicit unset", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "hunt-s2-review-required-unset-"));
  try {
    const layout = await prepareStage2RunStorage({
      storageRoot,
      runKey: "run_20260810_requiredunsetxxx",
    }, noProtection);
    const configSha256 = writeOwnerConfig(layout);
    await writeReviewEvidence(layout.evidenceRoot, configSha256);
    const path = join(layout.evidenceRoot, "profile-field-learning.json");
    const learning = JSON.parse(readFileSync(path, "utf8"));
    learning.liveAcceptanceEligible = false;
    learning.fields[1] = {
      ...learning.fields[1],
      fieldIdentity: "profile.unknown.required.1",
      uiVariant: "workday_unknown_required_v1",
      questionCategory: "unknown",
      answerCategory: "unknown",
      required: true,
      optionMapping: "unresolved",
      terminalDisposition: "required_unset",
    };
    writeFileSync(path, `${JSON.stringify(learning)}\n`);
    await assert.rejects(auditStage2Completion(layout.evidenceRoot), /completion audit denied/u);
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("Review completion admits one exact value-free application trace and rejects drift", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "hunt-s2-review-trace-audit-"));
  try {
    const layout = await prepareStage2RunStorage({
      storageRoot,
      runKey: "run_20260810_reviewtracexxxxx",
    }, noProtection);
    const configSha256 = writeOwnerConfig(layout);
    await writeReviewEvidence(layout.evidenceRoot, configSha256, journeyId, false, false, false);
    const trace = createValueFreeRunTrace(layout.evidenceRoot, () => undefined);
    trace("application_walk_started", {
      journeyId,
      stopAfter: "pre_review",
      submitActivated: false,
    });
    trace("application_walk_terminal", {
      journeyId,
      status: "passed",
      checkpoint: "pre_review",
      completedPages: 3,
      submitActivated: false,
    });
    assert.equal(
      (await auditStage2Completion(layout.evidenceRoot) as { readonly status: string }).status,
      "pass",
    );

    const path = join(layout.evidenceRoot, "value-free-trace.ndjson");
    const text = readFileSync(path, "utf8").replace('"status":"passed"', '"status":"failed"');
    writeFileSync(path, text);
    await assert.rejects(auditStage2Completion(layout.evidenceRoot), /completion audit denied/u);
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("Review completion requires the value-free trace", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "hunt-s2-review-trace-required-"));
  try {
    const layout = await prepareStage2RunStorage({
      storageRoot,
      runKey: "run_20260810_tracerequiredxxx",
    }, noProtection);
    const configSha256 = writeOwnerConfig(layout);
    await writeReviewEvidence(layout.evidenceRoot, configSha256);
    rmSync(join(layout.evidenceRoot, "value-free-trace.ndjson"));
    await assert.rejects(auditStage2Completion(layout.evidenceRoot), /completion audit denied/u);
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("Review completion and storage reject a missing terminal artifact", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "hunt-s2-review-terminal-required-"));
  try {
    const layout = await prepareStage2RunStorage({
      storageRoot,
      runKey: "run_20260810_terminalrequired",
    }, noProtection);
    const configSha256 = writeOwnerConfig(layout);
    await writeReviewEvidence(layout.evidenceRoot, configSha256);
    rmSync(join(layout.evidenceRoot, "terminal-artifact.json"));
    await assert.rejects(
      auditStage2Completion(layout.evidenceRoot),
      /completion audit denied/u,
    );
    await assert.rejects(() => finalizeStage2RunStorage({
      storageRoot,
      ownerConfigPath: layout.ownerConfigPath,
      evidenceRoot: layout.evidenceRoot,
    }), /storage finalization denied/u);
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("Review completion admits cumulative learning across repeated questionnaire pages", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "hunt-s2-review-questionnaire-repeat-"));
  try {
    const layout = await prepareStage2RunStorage({
      storageRoot,
      runKey: "run_20260810_questionrepeatxx",
    }, noProtection);
    const configSha256 = writeOwnerConfig(layout);
    await writeReviewEvidence(
      layout.evidenceRoot,
      configSha256,
      journeyId,
      false,
      false,
      true,
      true,
    );
    const audit = await auditStage2Completion(layout.evidenceRoot) as { readonly status: string };
    assert.equal(audit.status, "pass");
    const learning = JSON.parse(readFileSync(
      join(layout.evidenceRoot, "question-answer-learning.json"),
      "utf8",
    )) as { readonly questions: readonly unknown[] };
    assert.equal(learning.questions.length, 2);
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("Review completion reconciles Profile controls embedded on Resume with failed learning attempts", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "hunt-s2-review-combined-profile-"));
  try {
    const layout = await prepareStage2RunStorage({
      storageRoot,
      runKey: "run_20260810_combinedprofilex",
    }, noProtection);
    const configSha256 = writeOwnerConfig(layout);
    await writeReviewEvidence(
      layout.evidenceRoot,
      configSha256,
      journeyId,
      false,
      false,
      true,
      false,
      1,
      false,
      true,
    );

    const audit = await auditStage2Completion(layout.evidenceRoot) as {
      readonly status: string;
      readonly profileFieldLearningSha256: string | null;
    };
    assert.equal(audit.status, "pass");
    assert.equal(
      audit.profileFieldLearningSha256,
      digest(readFileSync(join(layout.evidenceRoot, "profile-field-learning-02.json"))),
    );
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("Review completion admits bound non-submittable synthetic questionnaire learning", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "hunt-s2-review-synthetic-questions-"));
  try {
    const layout = await prepareStage2RunStorage({
      storageRoot,
      runKey: "run_20260810_syntheticquestxx",
    }, noProtection);
    const configSha256 = writeOwnerConfig(layout);
    await writeReviewEvidence(
      layout.evidenceRoot,
      configSha256,
      journeyId,
      false,
      false,
      true,
      false,
      1,
      true,
    );
    const audit = await auditStage2Completion(layout.evidenceRoot) as {
      readonly status: string;
      readonly questionAnswerLearningSha256: string | null;
    };
    assert.equal(audit.status, "pass");
    assert.match(audit.questionAnswerLearningSha256 ?? "", /^[0-9a-f]{64}$/u);
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("Review finalization rejects schema-valid profile learning replaced after audit sealing", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "hunt-s2-review-learning-tamper-"));
  try {
    const layout = await prepareStage2RunStorage({
      storageRoot,
      runKey: "run_20260810_reviewlearnbindx",
    }, noProtection);
    const configSha256 = writeOwnerConfig(layout);
    await writeReviewEvidence(layout.evidenceRoot, configSha256);
    await auditStage2Completion(layout.evidenceRoot);
    const path = join(layout.evidenceRoot, "profile-field-learning.json");
    const learning = JSON.parse(readFileSync(path, "utf8"));
    const replacement = {
      ...learning,
      fields: [...learning.fields].reverse(),
    };
    assert.doesNotThrow(() => admitProfileFieldLearningEvidence(replacement));
    writeFileSync(path, `${JSON.stringify(replacement, null, 2)}\n`);

    await assert.rejects(
      finalizeStage2RunStorage({
        storageRoot,
        ownerConfigPath: layout.ownerConfigPath,
        evidenceRoot: layout.evidenceRoot,
      }),
      /storage finalization denied/u,
    );
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("Review completion admits an exact tenant-skipped Resume route", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "hunt-s2-review-audit-skip-resume-"));
  try {
    const layout = await prepareStage2RunStorage({
      storageRoot,
      runKey: "run_20260810_reviewskipxxxxxx",
    }, noProtection);
    const configSha256 = writeOwnerConfig(layout);
    await writeReviewEvidence(layout.evidenceRoot, configSha256, journeyId, true);
    const audit = await auditStage2Completion(layout.evidenceRoot) as { readonly status: string };
    assert.equal(audit.status, "pass");
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("Review completion admits an independently observed direct Review route", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "hunt-s2-review-audit-direct-"));
  try {
    const layout = await prepareStage2RunStorage({
      storageRoot,
      runKey: "run_20260810_reviewdirectxxxx",
    }, noProtection);
    const configSha256 = writeOwnerConfig(layout);
    await writeReviewEvidence(layout.evidenceRoot, configSha256, journeyId, false, true);
    const audit = await auditStage2Completion(layout.evidenceRoot) as { readonly status: string };
    assert.equal(audit.status, "pass");
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("Review completion rejects a crossed real-evidence journey binding", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "hunt-s2-review-audit-"));
  try {
    const layout = await prepareStage2RunStorage({
      storageRoot,
      runKey: "run_20260810_reviewcrossedxxx",
    }, noProtection);
    const configSha256 = writeOwnerConfig(layout);
    await writeReviewEvidence(layout.evidenceRoot, configSha256, "journey_qrstuvwxyzabcdef");

    await assert.rejects(
      auditStage2Completion(layout.evidenceRoot),
      /completion audit denied/u,
    );
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("Review finalization rejects an unmanifested real-evidence file without deleting transient state", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "hunt-s2-review-audit-"));
  try {
    const layout = await prepareStage2RunStorage({
      storageRoot,
      runKey: "run_20260810_reviewextrafilex",
    }, noProtection);
    const configSha256 = writeOwnerConfig(layout);
    await writeReviewEvidence(layout.evidenceRoot, configSha256);
    await auditStage2Completion(layout.evidenceRoot);
    writeFileSync(join(layout.evidenceRoot, "real-evidence", "private.json"), "{}\n");

    await assert.rejects(finalizeStage2RunStorage({
      storageRoot,
      ownerConfigPath: layout.ownerConfigPath,
      evidenceRoot: layout.evidenceRoot,
    }), /storage finalization denied/u);
    assert.equal(existsSync(layout.transientRoot), true);
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("Review completion requires exact bound account-verified evidence", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "hunt-s2-review-audit-"));
  try {
    const layout = await prepareStage2RunStorage({
      storageRoot,
      runKey: "run_20260810_reviewnoaccountx",
    }, noProtection);
    const configSha256 = writeOwnerConfig(layout);
    await writeReviewEvidence(layout.evidenceRoot, configSha256);
    rmSync(join(layout.evidenceRoot, "acceptance.json"));
    await assert.rejects(auditStage2Completion(layout.evidenceRoot), /completion audit denied/u);
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("Review completion rejects account-verified evidence crossed from another journey", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "hunt-s2-review-audit-"));
  try {
    const layout = await prepareStage2RunStorage({
      storageRoot,
      runKey: "run_20260810_reviewacctcrossx",
    }, noProtection);
    const configSha256 = writeOwnerConfig(layout);
    await writeReviewEvidence(layout.evidenceRoot, configSha256);
    const path = join(layout.evidenceRoot, "acceptance.json");
    const acceptance = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({
      ...acceptance,
      journeyId: "journey_qrstuvwxyzabcdef",
    }));
    await assert.rejects(auditStage2Completion(layout.evidenceRoot), /completion audit denied/u);
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("Review completion requires the exact external ordinal monitor chain", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "hunt-s2-review-audit-"));
  try {
    const layout = await prepareStage2RunStorage({
      storageRoot,
      runKey: "run_20260810_reviewnomonitorx",
    }, noProtection);
    const configSha256 = writeOwnerConfig(layout);
    await writeReviewEvidence(layout.evidenceRoot, configSha256);
    rmSync(join(layout.evidenceRoot, "monitor"), { recursive: true });
    await assert.rejects(auditStage2Completion(layout.evidenceRoot), /completion audit denied/u);
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("Review completion requires the exact authenticated external monitor chain", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "hunt-s2-review-audit-"));
  try {
    const layout = await prepareStage2RunStorage({
      storageRoot,
      runKey: "run_20260810_reviewnoauthmonx",
    }, noProtection);
    const configSha256 = writeOwnerConfig(layout);
    await writeReviewEvidence(layout.evidenceRoot, configSha256);
    rmSync(join(layout.evidenceRoot, "auth-monitor"), { recursive: true });
    writeProcessAudit(layout.evidenceRoot, "2026-08-10T12:01:00.000Z", configSha256);
    await assert.rejects(auditStage2Completion(layout.evidenceRoot), /completion audit denied/u);
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("Review finalization rejects an unvalidated auth-monitor file", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "hunt-s2-review-audit-"));
  try {
    const layout = await prepareStage2RunStorage({
      storageRoot,
      runKey: "run_20260810_reviewauthextrax",
    }, noProtection);
    const configSha256 = writeOwnerConfig(layout);
    await writeReviewEvidence(layout.evidenceRoot, configSha256);
    await auditStage2Completion(layout.evidenceRoot);
    writeFileSync(join(layout.evidenceRoot, "auth-monitor", "private.json"), "{}\n");
    await assert.rejects(finalizeStage2RunStorage({
      storageRoot,
      ownerConfigPath: layout.ownerConfigPath,
      evidenceRoot: layout.evidenceRoot,
    }), /storage finalization denied/u);
    assert.equal(existsSync(layout.transientRoot), true);
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("Review completion rejects an external monitor ACK crossed from another journey", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "hunt-s2-review-audit-"));
  try {
    const layout = await prepareStage2RunStorage({
      storageRoot,
      runKey: "run_20260810_reviewmoncrossxx",
    }, noProtection);
    const configSha256 = writeOwnerConfig(layout);
    await writeReviewEvidence(layout.evidenceRoot, configSha256);
    const path = join(
      layout.evidenceRoot,
      "monitor",
      "0014-review-review_readback.ack.json",
    );
    const ack = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({
      ...ack,
      journeyId: "journey_qrstuvwxyzabcdef",
    }));
    await assert.rejects(auditStage2Completion(layout.evidenceRoot), /completion audit denied/u);
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("Review completion rejects a reviewed structure bound to the wrong page", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "hunt-s2-review-audit-"));
  try {
    const layout = await prepareStage2RunStorage({
      storageRoot,
      runKey: "run_20260810_reviewmonwrongpg",
    }, noProtection);
    const configSha256 = writeOwnerConfig(layout);
    await writeReviewEvidence(layout.evidenceRoot, configSha256);
    const path = join(
      layout.evidenceRoot,
      "monitor",
      "0014-review-review_readback.ack.json",
    );
    const ack = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({
      ...ack,
      structuralDescriptionIds: ["monitor_structure_profile_v1"],
    }));
    await assert.rejects(auditStage2Completion(layout.evidenceRoot), /completion audit denied/u);
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("Review completion rejects a monitor ACK that claims Submit activation", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "hunt-s2-review-audit-"));
  try {
    const layout = await prepareStage2RunStorage({
      storageRoot,
      runKey: "run_20260810_reviewmonsubmitx",
    }, noProtection);
    const configSha256 = writeOwnerConfig(layout);
    await writeReviewEvidence(layout.evidenceRoot, configSha256);
    const path = join(
      layout.evidenceRoot,
      "monitor",
      "0014-review-review_readback.ack.json",
    );
    const ack = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({
      ...ack,
      submitActivated: true,
    }));
    await assert.rejects(auditStage2Completion(layout.evidenceRoot), /completion audit denied/u);
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("Review completion rejects an unbound recovered mutation attempt", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "hunt-s2-review-audit-"));
  try {
    const layout = await prepareStage2RunStorage({
      storageRoot,
      runKey: "run_20260810_reviewretryxxxxx",
    }, noProtection);
    const configSha256 = writeOwnerConfig(layout);
    await writeReviewEvidence(
      layout.evidenceRoot,
      configSha256,
      journeyId,
      false,
      false,
      true,
      false,
      2,
    );
    rmSync(join(layout.evidenceRoot, "monitor"), { recursive: true });
    const moments = [...applicationMoments()];
    moments.splice(2, 0,
      ["profile", "recovery_observed", "operation_profile_recovery_01", 1],
      ["profile", "before_mutation", "operation_profile_mutation_02", 2],
      ["profile", "after_readback", "operation_profile_mutation_02", 2],
    );
    writeExternalMonitorChain(
      layout.evidenceRoot,
      "monitor",
      moments,
      "review_verified",
      false,
      configSha256,
    );
    writeProcessAudit(layout.evidenceRoot, "2026-08-10T12:01:00.000Z", configSha256);
    await assert.rejects(
      auditStage2Completion(layout.evidenceRoot),
      /completion audit denied/u,
    );
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("Review completion rejects incomplete Profile bindings, verification, and inventory", async (t) => {
  const cases = [
    ["bindingmissingxx", (learning: any) => {
      learning.fields[0] = {
        ...learning.fields[0],
        prefillDisposition: "already_correct",
        driverAttempt: "none",
        monitorBinding: null,
        terminalDisposition: "verified_without_mutation",
        mechanics: {
          popupBound: "not_applicable",
          optionFocused: "not_applicable",
          optionActivated: "not_applicable",
          popupClosed: "not_applicable",
          backingValueCommitted: "not_observed",
          validationCleared: "not_observed",
          persistentReadback: "not_attempted",
        },
      };
    }],
    ["bindingmismatchx", (learning: any) => {
      learning.fields[0].monitorBinding.attempt = 2;
    }],
    ["observationmissx", (learning: any) => {
      learning.fields[1].observationBinding = null;
    }],
    ["observationbadxx", (learning: any) => {
      learning.fields[1].observationBinding.attempt = 3;
    }],
    ["bindingduplicate", (learning: any) => {
      learning.fields[1] = {
        ...learning.fields[1],
        answerState: "answered",
        lane: "live_owner_fact",
        prefillDisposition: "conflict",
        driverAttempt: "text",
        monitorBinding: { ...learning.fields[0].monitorBinding },
        terminalDisposition: "verified",
        mechanics: { ...learning.fields[0].mechanics },
      };
    }],
    ["optionalomittedx", (learning: any) => {
      learning.visibleControlCount = 1;
      learning.fields = learning.fields.slice(0, 1);
    }],
    ["answeredunlisted", (learning: any) => {
      learning.fields[1] = {
        ...learning.fields[1],
        answerState: "answered",
        lane: "live_owner_fact",
        prefillDisposition: "already_correct",
        terminalDisposition: "verified_without_mutation",
      };
    }],
    ["requiredmismatch", (learning: any) => {
      learning.fields[1] = {
        ...learning.fields[1],
        required: true,
        answerState: "answered",
        lane: "live_owner_fact",
        prefillDisposition: "already_correct",
        terminalDisposition: "verified_without_mutation",
      };
    }],
  ] as const;
  for (const [suffix, mutate] of cases) {
    await t.test(suffix, async () => {
      const storageRoot = mkdtempSync(join(tmpdir(), "hunt-s2-review-profile-binding-"));
      try {
        const layout = await prepareStage2RunStorage({
          storageRoot,
          runKey: `run_20260810_${suffix}`,
        }, noProtection);
        const configSha256 = writeOwnerConfig(layout);
        await writeReviewEvidence(layout.evidenceRoot, configSha256);
        const path = join(layout.evidenceRoot, "profile-field-learning.json");
        const learning = JSON.parse(readFileSync(path, "utf8"));
        mutate(learning);
        writeFileSync(path, `${JSON.stringify(learning)}\n`);
        await assert.rejects(
          auditStage2Completion(layout.evidenceRoot),
          /completion audit denied/u,
        );
      } finally {
        rmSync(storageRoot, { recursive: true, force: true });
      }
    });
  }
});

test("Review completion rejects an unpaired monitored mutation operation", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "hunt-s2-review-audit-"));
  try {
    const layout = await prepareStage2RunStorage({
      storageRoot,
      runKey: "run_20260810_reviewunpairedxx",
    }, noProtection);
    const configSha256 = writeOwnerConfig(layout);
    await writeReviewEvidence(layout.evidenceRoot, configSha256);
    rmSync(join(layout.evidenceRoot, "monitor"), { recursive: true });
    const moments = applicationMoments().filter((_, index) => index !== 5);
    writeExternalMonitorChain(
      layout.evidenceRoot,
      "monitor",
      moments,
      "review_verified",
      false,
      configSha256,
    );
    writeProcessAudit(layout.evidenceRoot, "2026-08-10T12:01:00.000Z", configSha256);
    await assert.rejects(auditStage2Completion(layout.evidenceRoot), /completion audit denied/u);
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("Review completion rejects an illegal same-page navigation transition", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "hunt-s2-review-audit-"));
  try {
    const layout = await prepareStage2RunStorage({
      storageRoot,
      runKey: "run_20260810_reviewbadnavxxxx",
    }, noProtection);
    const configSha256 = writeOwnerConfig(layout);
    await writeReviewEvidence(layout.evidenceRoot, configSha256);
    rmSync(join(layout.evidenceRoot, "monitor"), { recursive: true });
    const moments = applicationMoments();
    moments[4] = ["profile", "transition", "operation_profile_navigation_01", 1];
    writeExternalMonitorChain(
      layout.evidenceRoot, "monitor", moments, "review_verified", false, configSha256,
    );
    writeProcessAudit(layout.evidenceRoot, "2026-08-10T12:01:00.000Z", configSha256);
    await assert.rejects(auditStage2Completion(layout.evidenceRoot), /completion audit denied/u);
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("Review completion rejects a monitor chain without the process-derived live token", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "hunt-s2-review-audit-"));
  try {
    const layout = await prepareStage2RunStorage({
      storageRoot,
      runKey: "run_20260810_reviewbadtokxxxx",
    }, noProtection);
    const configSha256 = writeOwnerConfig(layout);
    await writeReviewEvidence(layout.evidenceRoot, configSha256);
    rmSync(join(layout.evidenceRoot, "monitor"), { recursive: true });
    writeExternalMonitorChain(
      layout.evidenceRoot,
      "monitor",
      applicationMoments(),
      "review_verified",
      false,
      configSha256,
      "f".repeat(64),
    );
    writeProcessAudit(layout.evidenceRoot, "2026-08-10T12:01:00.000Z", configSha256);
    await assert.rejects(auditStage2Completion(layout.evidenceRoot), /completion audit denied/u);
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("Review completion rejects signature-only PNGs even when their request hashes agree", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "hunt-s2-review-audit-"));
  try {
    const layout = await prepareStage2RunStorage({
      storageRoot,
      runKey: "run_20260810_reviewfakepngxxx",
    }, noProtection);
    const configSha256 = writeOwnerConfig(layout);
    await writeReviewEvidence(layout.evidenceRoot, configSha256);
    rmSync(join(layout.evidenceRoot, "monitor"), { recursive: true });
    writeMonitorChain(layout.evidenceRoot, true, configSha256);
    writeProcessAudit(layout.evidenceRoot, "2026-08-10T12:01:00.000Z", configSha256);
    await assert.rejects(auditStage2Completion(layout.evidenceRoot), /completion audit denied/u);
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("Review completion rejects an unbound legacy process audit before audit sealing", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "hunt-s2-review-audit-"));
  try {
    const layout = await prepareStage2RunStorage({
      storageRoot,
      runKey: "run_20260810_reviewoldprocess",
    }, noProtection);
    const configSha256 = writeOwnerConfig(layout);
    await writeReviewEvidence(layout.evidenceRoot, configSha256);
    writeFileSync(join(layout.evidenceRoot, "process-audit.json"), JSON.stringify({
      schemaVersion: 1,
      evidenceRevision: "s2-windows-process-audit-v1",
      status: "pass",
      jobCloseApplied: true,
      membersObservedBeforeClose: 1,
      membersAliveAfterClose: 0,
      checkedAt: "2026-08-10T12:01:00.000Z",
    }));
    await assert.rejects(auditStage2Completion(layout.evidenceRoot), /completion audit denied/u);
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("Review completion rejects a production process audit crossed before audit sealing", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "hunt-s2-review-audit-"));
  try {
    const layout = await prepareStage2RunStorage({
      storageRoot,
      runKey: "run_20260810_reviewproccrossx",
    }, noProtection);
    const configSha256 = writeOwnerConfig(layout);
    await writeReviewEvidence(layout.evidenceRoot, configSha256);
    const path = join(layout.evidenceRoot, "process-audit.json");
    const processAudit = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({
      ...processAudit,
      journeyId: "journey_qrstuvwxyzabcdef",
    }));
    await assert.rejects(auditStage2Completion(layout.evidenceRoot), /completion audit denied/u);
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("Review completion rejects an ACK observed after production process close", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "hunt-s2-review-audit-"));
  try {
    const layout = await prepareStage2RunStorage({
      storageRoot,
      runKey: "run_20260810_reviewlateackxxx",
    }, noProtection);
    const configSha256 = writeOwnerConfig(layout);
    await writeReviewEvidence(layout.evidenceRoot, configSha256);
    const ackPath = join(
      layout.evidenceRoot,
      "monitor",
      "0014-review-review_readback.ack.json",
    );
    const ack = JSON.parse(readFileSync(ackPath, "utf8"));
    writeFileSync(ackPath, JSON.stringify({ ...ack, observedAt: "2026-08-10T12:02:00.000Z" }));
    writeProcessAudit(layout.evidenceRoot, "2026-08-10T12:01:00.000Z", configSha256);
    await assert.rejects(auditStage2Completion(layout.evidenceRoot), /completion audit denied/u);
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("Review finalization rejects a production-bound process audit changed after completion", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "hunt-s2-review-audit-"));
  try {
    const layout = await prepareStage2RunStorage({
      storageRoot,
      runKey: "run_20260810_reviewprocessxxx",
    }, noProtection);
    const configSha256 = writeOwnerConfig(layout);
    await writeReviewEvidence(layout.evidenceRoot, configSha256);
    await auditStage2Completion(layout.evidenceRoot);
    writeProcessAudit(layout.evidenceRoot, "2026-08-10T12:02:00.000Z", configSha256);
    await assert.rejects(finalizeStage2RunStorage({
      storageRoot,
      ownerConfigPath: layout.ownerConfigPath,
      evidenceRoot: layout.evidenceRoot,
    }), /storage finalization denied/u);
    assert.equal(existsSync(layout.transientRoot), true);
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

type Layout = Awaited<ReturnType<typeof prepareStage2RunStorage>>;

function writeOwnerConfig(layout: Layout): string {
  const owner = {
    schemaVersion: 1,
    contractRevision: "s2-owner-inputs-v1",
    revisionId,
    journeyId,
    target: {
      handleId: targetHandleId,
      url: "https://bankofamerica.wd1.myworkdayjobs.com/en-US/Careers/job/Business-Manager_26016513",
      host: "bankofamerica.wd1.myworkdayjobs.com",
      tenant: "bankofamerica",
      posting: "26016513",
    },
    approval: { approvalId },
    roots: {
      runtime: { path: layout.runtimeRoot },
      secrets: { path: layout.secretsRoot },
      evidence: { path: layout.evidenceRoot },
    },
    policy: { cleanupLeaseHours: 24, retentionDays: 30 },
  };
  const bytes = Buffer.from(JSON.stringify(owner), "utf8");
  writeFileSync(layout.ownerConfigPath, bytes);
  return createHash("sha256").update(bytes).digest("hex");
}

async function writeReviewEvidence(
  root: string,
  configSha256: string,
  packetJourneyId = journeyId,
  skipResume = false,
  directReview = false,
  writeTrace = true,
  repeatedQuestionnaire = false,
  profileMutationAttempt = 1,
  syntheticQuestionnaire = false,
  combinedResumeProfile = false,
): Promise<void> {
  let learningBytes = Buffer.from(`${JSON.stringify({
    schemaVersion: 5,
    evidenceRevision: "s2-profile-field-learning-v5",
    page: "profile",
    executionMode: "live",
    testOnly: false,
    liveAcceptanceEligible: true,
    visibleControlCount: 2,
    fields: [{
      fieldIdentity: "profile.identity.given_name",
      uiType: "text",
      uiVariant: "workday_text_v2",
      questionCategory: "identity",
      answerCategory: "text",
      required: true,
      answerState: "answered",
      lane: "live_owner_fact",
      binderStrategy: "catalog_selector_exact",
      sanitizedLabelSha256: retainedIntakeTextSha256("First Name"),
      metadataReconciliation: "matched",
      backingState: "set",
      validationState: "clear",
      optionCatalogState: "not_applicable",
      observationBinding: {
        operationId: "operation_profile_observation_01",
        attempt: 1,
        stateObservedAck: true,
      },
      visibleOptionIds: [],
      selectedOptionId: null,
      optionMapping: "not_applicable",
      prefillDisposition: "conflict",
      driverAttempt: "text",
      monitorBinding: {
        operationId: `operation_profile_mutation_0${profileMutationAttempt}`,
        attempt: profileMutationAttempt,
        beforeMutationAck: true,
        afterReadbackAck: true,
      },
      terminalDisposition: "verified",
      mechanics: {
        popupBound: "not_applicable",
        optionFocused: "not_applicable",
        optionActivated: "not_applicable",
        popupClosed: "not_applicable",
        backingValueCommitted: "observed",
        validationCleared: "observed",
        persistentReadback: "verified_after_rescan",
      },
    }, {
      fieldIdentity: "profile.social.linkedin",
      uiType: "text",
      uiVariant: "workday_text_v2",
      questionCategory: "social_network",
      answerCategory: "url",
      required: false,
      answerState: "unset",
      lane: null,
      binderStrategy: "catalog_selector_exact",
      sanitizedLabelSha256: retainedIntakeTextSha256("LinkedIn"),
      metadataReconciliation: "matched",
      backingState: "unset",
      validationState: "clear",
      optionCatalogState: "not_applicable",
      observationBinding: {
        operationId: "operation_profile_observation_01",
        attempt: 1,
        stateObservedAck: true,
      },
      visibleOptionIds: [],
      selectedOptionId: null,
      optionMapping: "not_applicable",
      prefillDisposition: "needs_owner_input",
      driverAttempt: "none",
      monitorBinding: null,
      terminalDisposition: "optional_unset",
      mechanics: {
        popupBound: "not_applicable",
        optionFocused: "not_applicable",
        optionActivated: "not_applicable",
        popupClosed: "not_applicable",
        backingValueCommitted: "not_observed",
        validationCleared: "not_observed",
        persistentReadback: "not_attempted",
      },
    }],
  }, null, 2)}\n`, "utf8");
  if (combinedResumeProfile) {
    const learning = JSON.parse(learningBytes.toString("utf8"));
    learning.executionMode = "synthetic_test_non_submittable";
    learning.testOnly = true;
    learning.liveAcceptanceEligible = false;
    learning.fields[0].lane = "synthetic_test_default";
    learningBytes = Buffer.from(`${JSON.stringify(learning, null, 2)}\n`, "utf8");
  }
  if (!directReview) {
    writeFileSync(join(root, "profile-field-learning.json"), learningBytes);
  }
  const profileFieldLearningSha256 = digest(learningBytes);
  let combinedProfileFieldLearningSha256: string | undefined;
  if (combinedResumeProfile) {
    const template = JSON.parse(learningBytes.toString("utf8"));
    const linkedIn = {
      ...template.fields[0],
      fieldIdentity: "profile.social.linkedin",
      questionCategory: "social_network",
      answerCategory: "url",
      required: false,
      lane: "live_owner_fact",
      sanitizedLabelSha256: "84308bea454057aa509a12fbd5212988973d7cd513bc555a24a06dd2cc72e39e",
      observationBinding: {
        operationId: "operation_resume_profile_observation_01",
        attempt: 1,
        stateObservedAck: true,
      },
      monitorBinding: {
        operationId: "operation_resume_profile_mutation_01",
        attempt: 2,
        beforeMutationAck: true,
        afterReadbackAck: true,
      },
    };
    const failed = {
      fieldIdentity: "profile.skills.values",
      uiType: "multi_select",
      uiVariant: "workday_multi_select_v1",
      questionCategory: "skill",
      answerCategory: "multi_select",
      required: false,
      answerState: "answered",
      lane: "live_owner_fact",
      binderStrategy: "catalog_selector_exact",
      sanitizedLabelSha256: "c8ef807f501a67099c3f7d98ee9b554fa8140756d2de1902a776bcf8503ad53a",
      metadataReconciliation: "matched",
      backingState: "unset",
      validationState: "clear",
      optionCatalogState: "unknown",
      observationBinding: {
        operationId: "operation_resume_profile_observation_02",
        attempt: 2,
        stateObservedAck: true,
      },
      visibleOptionIds: [],
      selectedOptionId: null,
      optionMapping: "owner_visible_option",
      prefillDisposition: "blank",
      driverAttempt: "multi_select",
      monitorBinding: {
        operationId: "operation_resume_profile_mutation_02",
        attempt: 3,
        beforeMutationAck: true,
        afterReadbackAck: true,
      },
      terminalDisposition: "driver_failed",
      mechanics: {
        popupBound: "not_observed",
        optionFocused: "not_observed",
        optionActivated: "not_observed",
        popupClosed: "not_observed",
        backingValueCommitted: "not_observed",
        validationCleared: "not_observed",
        persistentReadback: "driver_failed",
      },
    };
    const optional = {
      ...template.fields[1],
      fieldIdentity: "profile.social.twitter",
      questionCategory: "social_network",
      answerCategory: "text",
      sanitizedLabelSha256: "7352f353c460e74c7ae226952d04f8aa307b12329c5512ec8cb6f1a0f8f9b2cb",
      observationBinding: {
        operationId: "operation_resume_profile_observation_03",
        attempt: 3,
        stateObservedAck: true,
      },
    };
    const combinedBytes = Buffer.from(`${JSON.stringify({
      ...template,
      visibleControlCount: 3,
      fields: [linkedIn, failed, optional],
    }, null, 2)}\n`, "utf8");
    writeFileSync(join(root, "profile-field-learning-02.json"), combinedBytes);
    combinedProfileFieldLearningSha256 = digest(combinedBytes);
  }
  if (!directReview) {
    writeFileSync(join(root, "question-answer-learning.json"), `${JSON.stringify({
      schemaVersion: 4,
      evidenceRevision: "s2-question-answer-learning-v4",
      page: "questionnaire",
      executionMode: syntheticQuestionnaire ? "synthetic_test_non_submittable" : "live",
      testOnly: syntheticQuestionnaire,
      liveAcceptanceEligible: !syntheticQuestionnaire,
      questions: [{
        questionId: "s1-question-work-authorization",
        fieldId: "authorization-answer",
        label: "Are you authorized to work in this location?",
        required: true,
        uiType: "radio",
        answerType: "single_select",
        possibleAnswers: ["Yes", "No"],
        answerState: "answered",
        lane: syntheticQuestionnaire ? "synthetic_test_default" : "live_owner_fact",
        chosenAnswer: syntheticQuestionnaire ? "synthetic_choice_applied" : "owner_answer_applied",
        strategy: syntheticQuestionnaire ? "first_visible_option" : "owner_answer",
        provenance: syntheticQuestionnaire ? "reviewed_catalog" : "owner_provided",
        replaceWithOwnerAnswer: syntheticQuestionnaire,
        interactionState: "attempted",
        monitorBinding: {
          operationId: "operation_question_mutation_01",
          attempt: 1,
          beforeMutationAck: true,
          afterReadbackAck: true,
        },
        verificationResult: "verified",
        failureCode: null,
        retryable: false,
        terminalDisposition: "verified",
        attemptHistory: [{
          operationId: "operation_question_mutation_01",
          attempt: 1,
          beforeMutationAck: true,
          afterReadbackAck: true,
          outcome: "verified",
          failureCode: null,
          retryable: false,
        }],
      }, ...(repeatedQuestionnaire ? [{
        questionId: "observed-question-0123456789abcdef01234567",
        fieldId: "privacy-answer",
        label: "Voluntary disclosure preference",
        required: true,
        uiType: "select",
        answerType: "single_select",
        possibleAnswers: ["Prefer not to answer"],
        answerState: "answered",
        lane: "live_owner_fact",
        chosenAnswer: "owner_answer_applied",
        strategy: "owner_answer",
        provenance: "owner_provided",
        replaceWithOwnerAnswer: false,
        interactionState: "attempted",
        monitorBinding: {
          operationId: "operation_question_mutation_02",
          attempt: 2,
          beforeMutationAck: true,
          afterReadbackAck: true,
        },
        verificationResult: "verified",
        failureCode: null,
        retryable: false,
        terminalDisposition: "verified",
        attemptHistory: [{
          operationId: "operation_question_mutation_02",
          attempt: 2,
          beforeMutationAck: true,
          afterReadbackAck: true,
          outcome: "verified",
          failureCode: null,
          retryable: false,
        }],
      }] : [])],
    }, null, 2)}\n`);
  }
  await writeAccountVerifiedEvidence({
    root,
    acceptance: {
      schemaVersion: 1,
      evidenceRevision: "s2-account-verified-acceptance-v2",
      checkpoint: "account_verified",
      status: "passed",
      sourceRevision,
      revisionId,
      approvalId,
      journeyId,
      targetHandleId,
      accountState: "application_ready",
      independentlyObservedVerifiedState: true,
      verificationProof: "credential_sign_in",
      provider: "workday-auth",
      consumedCandidateCount: 0,
      messageBodyRetained: false,
      submitActivated: false,
      privacyScan: "pass",
      cleanup: "pass",
    },
    sensitiveValues: [],
  });
  await writeApplicationWalkEvidence({
    root,
    acceptance: applicationWalk(
      profileFieldLearningSha256,
      skipResume,
      directReview,
      repeatedQuestionnaire,
      syntheticQuestionnaire,
      combinedProfileFieldLearningSha256,
    ),
    sensitiveValues: [],
  });
  writeStage2ReviewAcceptance(root, reviewAcceptance(configSha256), []);
  writeStage2AcceptanceManifest(root, {
    schemaVersion: 1,
    acceptanceRevision: "s2-real-acceptance-gate-v1",
    status: "review_verified",
    sourceRevision,
    configSha256,
    contractRevision: "s2-owner-inputs-v1",
    revisionId,
    approvalId,
    journeyId,
    targetHandleId,
    checkpoint: "review",
    quality: "pass",
    reviewProof: "independently_verified",
    submitPresent: true,
    submitActivated: false,
    privacyScan: "pass",
    cleanup: "pending_exact_finalization",
  });
  writeLiveEvidencePacket({
    schemaVersion: 1,
    packetRevision: "s2-real-evidence-packet-v1",
    root,
    sourceRevision,
    configurationRevisionId: revisionId,
    configurationApprovalId: approvalId,
    journeyId: packetJourneyId,
    sealedAt: "2026-08-10T12:00:00.000Z",
    retentionDays: 30,
    milestones: [
      { kind: "account_verified", status: "verified" },
      { kind: "application_completed", status: "verified" },
      { kind: "review_reached", status: "verified" },
      { kind: "submit_guarded", status: "verified" },
    ],
    verificationSummaries: [
      { kind: "account", status: "verified", verifiedCount: 1 },
      skipResume || directReview
        ? { kind: "resume", status: "missing", verifiedCount: 0 }
        : { kind: "resume", status: "verified", verifiedCount: 1 },
      {
        kind: "required_fields",
        status: "verified",
        verifiedCount: directReview ? 0 : repeatedQuestionnaire
          ? 4
          : skipResume ? 2 : 3,
      },
      { kind: "review", status: "verified", verifiedCount: 1 },
      { kind: "submit_guard", status: "verified", verifiedCount: 1 },
    ],
    errors: [],
    missingEvidence: skipResume || directReview ? ["resume_verification"] : [],
    browserTruth: {
      schemaVersion: 1,
      observer: "independent_browser",
      page: "review",
      reviewSignatureIds: ["review_signature_workday_review_root_v1"],
      completionEvidenceIds: ["completion_evidence_required_fields_v1"],
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
  });
  writeAuthMonitorChain(root, false, configSha256);
  writeMonitorChain(
    root,
    false,
    configSha256,
    skipResume,
    directReview,
    repeatedQuestionnaire,
    combinedResumeProfile,
  );
  writeProcessAudit(root, "2026-08-10T12:01:00.000Z", configSha256);
  writeStage2TerminalArtifact(root, {
    schemaVersion: 1,
    evidenceRevision: "s2-terminal-artifact-v1",
    resultCode: "review_reached",
    terminal: {
      schemaVersion: 4,
      journeyId: journeyId as never,
      status: "review_reached",
      completedPages: directReview ? 0 : repeatedQuestionnaire || combinedResumeProfile
        ? 4
        : skipResume ? 2 : 3,
    },
  });
  if (writeTrace) {
    const trace = createValueFreeRunTrace(root, () => undefined);
    trace("application_walk_started", {
      journeyId,
      stopAfter: "pre_review",
      submitActivated: false,
    });
    trace("application_walk_terminal", {
      journeyId,
      status: "passed",
      checkpoint: "pre_review",
      completedPages: directReview ? 1 : repeatedQuestionnaire || combinedResumeProfile
        ? 4
        : skipResume ? 2 : 3,
      submitActivated: false,
    });
  }
}

function writeProcessAudit(root: string, checkedAt: string, configSha256: string): void {
  const runKey = root.split(/[\\/]/u).at(-2)!;
  writeFileSync(join(root, "process-audit.json"), JSON.stringify({
    schemaVersion: 1,
    evidenceRevision: "s2-windows-process-audit-v2",
    status: "pass",
    runKey,
    journeyId,
    targetHandleId,
    configSha256,
    processLiveNonceSha256: digest(Buffer.from("live-nonce-for-review-fixture")),
    processIssuedAt: "2026-08-10T11:59:59.000Z",
    processOwnerPid: 4242,
    processOwnerStartedAt: "2026-08-10T11:59:59.100Z",
    processExitObservedAt: "2026-08-10T12:00:59.000Z",
    jobCloseApplied: true,
    membersObservedBeforeClose: 1,
    membersAliveAfterClose: 0,
    monitorFileCount: monitorLedger(root).length,
    monitorChainSha256: monitorChainDigest(root),
    checkedAt,
  }));
}

function writeMonitorChain(
  root: string,
  signatureOnly: boolean,
  configSha256: string,
  skipResume = false,
  directReview = false,
  repeatedQuestionnaire = false,
  combinedResumeProfile = false,
): void {
  writeExternalMonitorChain(
    root,
    "monitor",
    applicationMoments(skipResume, directReview, repeatedQuestionnaire, combinedResumeProfile),
    "review_verified",
    signatureOnly,
    configSha256,
  );
}

function applicationMoments(
  skipResume = false,
  directReview = false,
  repeatedQuestionnaire = false,
  combinedResumeProfile = false,
): Array<readonly [string, string, string, number]> {
  if (directReview) return [
    ["review", "review_readback", "operation_review_readback_01", 1],
  ];
  if (skipResume) return [
    ["profile", "state_observed", "operation_profile_observation_01", 1],
    ["profile", "before_mutation", "operation_profile_mutation_01", 1],
    ["profile", "after_readback", "operation_profile_mutation_01", 1],
    ["profile", "before_navigation", "operation_profile_navigation_01", 1],
    ["questionnaire", "transition", "operation_profile_navigation_01", 1],
    ["questionnaire", "before_mutation", "operation_question_mutation_01", 1],
    ["questionnaire", "after_readback", "operation_question_mutation_01", 1],
    ["questionnaire", "before_navigation", "operation_question_navigation_01", 1],
    ["review", "transition", "operation_question_navigation_01", 1],
    ["review", "review_readback", "operation_review_readback_01", 1],
  ];
  const moments: Array<readonly [string, string, string, number]> = [
    ["profile", "state_observed", "operation_profile_observation_01", 1],
    ["profile", "before_mutation", "operation_profile_mutation_01", 1],
    ["profile", "after_readback", "operation_profile_mutation_01", 1],
    ["profile", "before_navigation", "operation_profile_navigation_01", 1],
    ["resume", "transition", "operation_profile_navigation_01", 1],
    ["resume", "before_mutation", "operation_resume_mutation_01", 1],
    ["resume", "after_readback", "operation_resume_mutation_01", 1],
    ...(combinedResumeProfile ? [
      ["resume", "state_observed", "operation_resume_profile_observation_01", 1],
      ["resume", "state_observed", "operation_resume_profile_observation_02", 2],
      ["resume", "state_observed", "operation_resume_profile_observation_03", 3],
      ["resume", "before_mutation", "operation_resume_profile_mutation_01", 2],
      ["resume", "after_readback", "operation_resume_profile_mutation_01", 2],
      ["resume", "before_mutation", "operation_resume_profile_mutation_02", 3],
      ["resume", "after_readback", "operation_resume_profile_mutation_02", 3],
    ] as const : []),
    ["resume", "before_navigation", "operation_resume_navigation_01", 1],
    ["questionnaire", "transition", "operation_resume_navigation_01", 1],
    ["questionnaire", "before_mutation", "operation_question_mutation_01", 1],
    ["questionnaire", "after_readback", "operation_question_mutation_01", 1],
    ["questionnaire", "before_navigation", "operation_question_navigation_01", 1],
  ];
  if (repeatedQuestionnaire) {
    moments.push(
      ["questionnaire", "transition", "operation_question_navigation_01", 1],
      ["questionnaire", "before_mutation", "operation_question_mutation_02", 2],
      ["questionnaire", "after_readback", "operation_question_mutation_02", 2],
      ["questionnaire", "before_navigation", "operation_question_navigation_02", 2],
      ["review", "transition", "operation_question_navigation_02", 2],
    );
  } else {
    moments.push(["review", "transition", "operation_question_navigation_01", 1]);
  }
  moments.push(["review", "review_readback", "operation_review_readback_01", 1]);
  return moments;
}

function writeAuthMonitorChain(root: string, signatureOnly: boolean, configSha256: string): void {
  writeExternalMonitorChain(root, "auth-monitor", [
    ["account_entry", "before_mutation", "operation_account_mutation_01", 1],
    ["account_entry", "after_readback", "operation_account_mutation_01", 1],
    ["account_entry", "before_navigation", "operation_account_navigation_01", 1],
    ["application_ready", "transition", "operation_account_navigation_01", 1],
    ["application_ready", "state_observed", "operation_application_ready_01", 1],
  ], "account_verified", signatureOnly, configSha256);
}

function writeExternalMonitorChain(
  root: string,
  directory: "auth-monitor" | "monitor",
  moments: readonly (readonly [string, string, string, number])[],
  finalClassification: "account_verified" | "review_verified",
  signatureOnly: boolean,
  configSha256: string,
  monitorLiveToken = monitorLiveTokenSha256(),
): void {
  const monitorRoot = join(root, directory);
  const combinedResumeProfile = moments.some(([, , operationId]) =>
    operationId.startsWith("operation_resume_profile_")
  );
  mkdirSync(monitorRoot);
  let previousAckSha256: string | null = null;
  for (const [index, [page, moment, operationId, attempt]] of moments.entries()) {
    const prefix = `${String(index + 1).padStart(4, "0")}-${page}-${moment}`;
    const screenshotFile = `${prefix}.png`;
    const taxonomyFile = `${prefix}.taxonomy.json`;
    const requestFile = `${prefix}.request.json`;
    const ackFile = `${prefix}.ack.json`;
    const screenshot = signatureOnly
      ? Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      : pngBytes(index);
    writeFileSync(join(monitorRoot, screenshotFile), screenshot);
    const taxonomy = jsonBytes({
      schemaVersion: 1,
      evidenceRevision: "s2-monitor-taxonomy-v1",
      journeyId,
      targetHandleId,
      ordinal: index + 1,
      page,
      moment,
      fieldCount: page === "review"
        ? 3
        : page === "profile" ? 2 : page === "resume" && combinedResumeProfile ? 4 : 1,
      requiredFieldCount: 1,
      controlTypes: ["text"],
      questionTypes: page === "application_ready" || page === "profile"
        ? ["identity", "address", "phone", "application_source", "prior_employment"]
        : ["identity"],
      answerTypes: page === "application_ready" || page === "profile"
        ? ["text", "phone", "option", "boolean"]
        : ["text"],
      validationState: "clear",
      submitPresent: page === "review",
      submitActivated: false,
      privacyScan: "pass",
    });
    writeFileSync(join(monitorRoot, taxonomyFile), taxonomy);
    const request = jsonBytes({
      schemaVersion: 1,
      requestRevision: "s2-external-monitor-request-v1",
      journeyId,
      targetHandleId,
      operationId,
      attempt,
      ordinal: index + 1,
      page,
      moment,
      screenshotFile,
      screenshotSha256: digest(screenshot),
      taxonomyFile,
      taxonomySha256: digest(taxonomy),
      previousAckSha256,
      processLiveNonceSha256: digest(Buffer.from("live-nonce-for-review-fixture")),
      processIssuedAt: "2026-08-10T11:59:59.000Z",
      processInstanceSha256: processInstanceSha256(),
      monitorLiveTokenSha256: monitorLiveToken,
      issuedAt: `2026-08-10T12:00:${String(index).padStart(2, "0")}.000Z`,
      sourceRevision,
      configSha256,
      capturedIdentityDigests: identityDigests(),
    });
    writeFileSync(join(monitorRoot, requestFile), request);
    const ack = jsonBytes({
      schemaVersion: 2,
      evidenceRevision: "s2-external-monitor-ack-v2",
      status: "acknowledged",
      observer: "independent_visual_monitor",
      journeyId,
      targetHandleId,
      operationId,
      attempt,
      ordinal: index + 1,
      page,
      moment,
      requestFile,
      requestSha256: digest(request),
      classification: index === moments.length - 1 ? finalClassification : "safe_to_continue",
      observedScreenshotSha256: digest(screenshot),
      identityReconciliation: "matched",
      identityDimensions: ["host", "posting", "title"],
      observedIdentityDigests: identityDigests(),
      structuralDescriptionIds: [`monitor_structure_${page}_v1`],
      privacyScan: "pass",
      submitPresent: page === "review",
      submitActivated: false,
      observedAt: `2026-08-10T12:00:${String(index).padStart(2, "0")}.000Z`,
    });
    writeFileSync(join(monitorRoot, ackFile), ack);
    previousAckSha256 = digest(ack);
  }
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function identityDigests() {
  return {
    hostSha256: digest(Buffer.from("bankofamerica.wd1.myworkdayjobs.com")),
    tenantSha256: digest(Buffer.from("bankofamerica")),
    postingSha256: digest(Buffer.from("26016513")),
    titleSha256: digest(Buffer.from("Business Manager")),
  };
}

function monitorLiveTokenSha256(): string {
  return digest(Buffer.from(
    `s2-monitor-live-v1\0${digest(Buffer.from("live-nonce-for-review-fixture"))}\0${journeyId}\0${targetHandleId}`,
    "utf8",
  ));
}

function processInstanceSha256(): string {
  return digest(Buffer.from(["s2-process-instance-v1", "4242", "2026-08-10T11:59:59.100Z"].join("\0")));
}

function monitorChainDigest(root: string): string {
  const names = monitorLedger(root);
  const lines = names.map((name) => `${name}:${digest(readFileSync(join(root, name)))}\n`).join("");
  return digest(Buffer.from(lines, "utf8"));
}

function monitorLedger(root: string): string[] {
  return ["auth-monitor", "monitor"].flatMap((directory) => {
    const path = join(root, directory);
    return existsSync(path) ? readdirSync(path).map((name) => `${directory}/${name}`) : [];
  }).sort();
}

function pngBytes(seed: number): Buffer {
  const width = 320;
  const height = 200;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  raw[raw.length - 1] = seed;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return chunk;
}

function crc32(value: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function reviewAcceptance(configSha256: string) {
  return {
    schemaVersion: 1 as const,
    evidenceRevision: "s2-review-acceptance-v1" as const,
    sourceRevision,
    configSha256,
    contractRevision: "s2-owner-inputs-v1",
    revisionId,
    approvalId,
    journeyId,
    targetHandleId,
    checkpoint: "review" as const,
    status: "passed" as const,
    reviewProof: "independently_verified" as const,
    submitPresent: true as const,
    submitActivated: false as const,
    privacyScan: "pass" as const,
  };
}

function applicationWalk(
  profileFieldLearningSha256: string,
  skipResume = false,
  directReview = false,
  repeatedQuestionnaire = false,
  syntheticQuestionnaire = false,
  combinedProfileFieldLearningSha256?: string,
) {
  const pageChecks = [
    pageCheck("profile", "profile_verified"),
    pageCheck("resume", "resume_verified"),
    pageCheck("questionnaire", "questionnaire_verified"),
  ];
  const questionnaire = questionnaireAcceptance();
  const laneAcceptances = [
    profileAcceptance(profileFieldLearningSha256, combinedProfileFieldLearningSha256 !== undefined),
    resumeAcceptance(),
    syntheticQuestionnaire ? { ...questionnaire, answers: [] } : questionnaire,
  ];
  if (combinedProfileFieldLearningSha256 !== undefined) {
    pageChecks.splice(2, 0, pageCheck("profile", "profile_verified", 0));
    laneAcceptances.splice(2, 0, profileAcceptance(
      combinedProfileFieldLearningSha256,
      false,
      "social.linkedin",
    ));
  }
  if (repeatedQuestionnaire) {
    pageChecks.push(pageCheck("questionnaire", "questionnaire_verified"));
    const revealed = questionnaireAcceptance(
      "privacy-answer",
      "observed-question-0123456789abcdef01234567",
      "owner_provided",
      "consent",
    );
    const cumulativeQuestionnaire = laneAcceptances[2]!;
    if (cumulativeQuestionnaire.checkpoint !== "questionnaire_verified") {
      throw new Error("questionnaire fixture unavailable");
    }
    laneAcceptances[2] = {
      ...cumulativeQuestionnaire,
      answers: [...cumulativeQuestionnaire.answers, ...revealed.answers],
    };
  }
  return {
    schemaVersion: 1 as const,
    evidenceRevision: "s2-application-walk-acceptance-v1" as const,
    checkpoint: "pre_review" as const,
    status: "passed" as const,
    sourceRevision,
    revisionId,
    approvalId,
    journeyId,
    targetHandleId,
    completedPages: directReview ? 0 : repeatedQuestionnaire ||
        combinedProfileFieldLearningSha256 !== undefined
      ? 4
      : skipResume ? 2 : 3,
    pageChecks: directReview
      ? []
      : skipResume ? [pageChecks[0]!, pageChecks[2]!] : pageChecks,
    laneAcceptances: directReview
      ? []
      : skipResume
      ? [laneAcceptances[0]!, laneAcceptances[2]!]
      : laneAcceptances,
    submitActivated: false as const,
    privacyScan: "pass" as const,
    cleanup: "pass" as const,
  };
}

function profileAcceptance(
  profileFieldLearningSha256: string,
  synthetic = false,
  field = "identity.given_name",
) {
  return {
    schemaVersion: 1 as const,
    checkpoint: "profile_verified" as const,
    pageType: "profile" as const,
    verifiedFields: [{
      fieldId: field,
      questionType: field === "social.linkedin" ? "social_network" as const : "identity" as const,
      answerType: field === "social.linkedin" ? "url" as const : "text" as const,
      uiBehavior: "text" as const,
      uiVariant: "workday_text_v2",
      provenance: synthetic ? "generated_default" as const : "owner_provided" as const,
      lane: synthetic ? "synthetic_test_default" as const : "live_owner_fact" as const,
    }],
    ownedDuplicateRows: 0 as const,
    independentlyVerified: true as const,
    profileFieldLearningSha256,
    submitActivated: false as const,
    privacyScan: "pass" as const,
  };
}

function resumeAcceptance() {
  return {
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
  };
}

function questionnaireAcceptance(
  answerFieldId = "authorization-answer",
  answerQuestionId = "s1-question-work-authorization",
  provenance: "owner_provided" | "reviewed_catalog" = "owner_provided",
  protectedCategory: "authorization" | "consent" = "authorization",
) {
  return {
    schemaVersion: 1 as const,
    checkpoint: "questionnaire_verified" as const,
    answers: [{
      fieldId: fieldId(answerFieldId),
      questionId: questionId(answerQuestionId),
      provenance,
      lane: "live_owner_fact" as const,
      protectedCategory,
      templateRevision: null,
      verification: "independent" as const,
    }],
    protectedPlaceholderCount: 0 as const,
    independentlyVerified: true as const,
    submitActivated: false as const,
    privacyScan: "pass" as const,
  };
}

function pageCheck(
  page: "resume" | "profile" | "questionnaire",
  checkpoint: "resume_verified" | "profile_verified" | "questionnaire_verified",
  requiredFields = 1,
) {
  return {
    page,
    checkpoint,
    independentlyVerified: true as const,
    requiredFields,
    verifiedFields: requiredFields,
    duplicateRows: 0,
  };
}
