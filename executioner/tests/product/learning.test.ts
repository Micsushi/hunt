import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applicantProfile, productSources, productQuestionLearning } from "../../src/product/sources.ts";
import { boundedText, browserTargetToken, fieldId, questionId, disposeResumeArtifact } from "../../src/contracts/index.ts";
import { observedPendingProfileQuestions } from "../../src/browser/playwright-live/private/workday-application-runtime.ts";

import { admitPendingProfileQuestionsEvidence } from "../../src/live/evidence/question-answer-learning.ts";

const basic = { given_name: "Synthetic", family_name: "Applicant", email_address: "fixture@example.invalid" };

test("profile journal preserves repeated required-field ordinals and optional date metadata together", () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-failed-profile-learning-"));
  const sources = productSources(applicantProfile(basic), Buffer.from("%PDF-1.4\nfixture"));
  try {
    const learning = productQuestionLearning(root, sources);
    for (const [label, behavior, options] of [
      ["Have you ever worked here?", "radio_group", ["Yes", "No"]],
      ["Certification", "search_select", ["Certificate A", "Certificate B"]],
    ] as const) {
      const pending = observedPendingProfileQuestions({ pageType: "profile", rows: [], controls: [{
        controlId: "observed-1", fieldId: "unknown.required.1", label, required: true,
        uiBehavior: behavior, uiVariant: "workday_unknown_required_v1", readback: null, allowedOptions: options,
      }] }, "s2-profile");
      pending.forEach(question => learning.sink.recordPendingProfile?.(question));
    }
    const pending = observedPendingProfileQuestions({ pageType: "profile", rows: [], controls:
      (["month", "number", "year"] as const).map((behavior, index) => ({
        controlId: `date-${index}`, fieldId: `unknown.optional.${index}`, label: `Issue Date ${behavior}`,
        required: false, uiBehavior: behavior, uiVariant: "workday_empty_optional_date_segment_v1", readback: null,
      })),
    }, "s2-profile");
    assert.throws(() => admitPendingProfileQuestionsEvidence({ schemaVersion: 2, evidenceRevision: "s2-pending-profile-questions-v2",
      pendingProfileQuestions: [{ ...pending[0]!, observedUi: { behavior: "invalid", variant: "bad variant" } } as never],
    }), /denied/);
    pending.forEach(question => learning.sink.recordPendingProfile?.(question));
    learning.finish();
    const questions = JSON.parse(readFileSync(join(root, "pending-profile-questions.json"), "utf8")).pendingProfileQuestions;
    assert.deepEqual(questions.slice(0, 2).map((q: { exactQuestion: string }) => q.exactQuestion), ["Have you ever worked here?", "Certification"]);
    assert.ok(questions.every((q: { validation: string; actualOwnerValue: unknown }) => q.validation === "not_attempted" && q.actualOwnerValue === null));
    assert.deepEqual(questions.slice(2).map((q: { observedUi: unknown }) => q.observedUi),
      ["month", "number", "year"].map(behavior => ({ behavior, variant: "workday_empty_optional_date_segment_v1" })));
    assert.ok(questions.slice(2).every((q: { testDefault: unknown; actualOwnerValue: unknown; validation: string }) =>
      q.testDefault === null && q.actualOwnerValue === null && q.validation === "not_attempted"));
  } finally {
    disposeResumeArtifact(sources.resumeIntent.artifact);
    rmSync(root, { recursive: true, force: true });
  }
});

test("observation journal retains constraints and reports unavailable storage without monitor claims", () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-product-learning-unit-"));
  const sources = productSources(applicantProfile(basic), Buffer.from("%PDF-1.4\nfixture"));
  try {
    const observed = { pageId: "s2-questionnaire-test", questionId: questionId("question-comment"),
      field: { fieldId: fieldId("field-comment"), target: browserTargetToken("target-comment"),
        label: boundedText("Tell us more"), required: true, behavior: "textarea" as const,
        options: [], state: "empty" as const, constraints: { inputType: "text" as const, min: null, max: null,
          step: null, minLength: 2, maxLength: 500, pattern: null } }, semanticQuestionType: "unknown" as const };
    const learning = productQuestionLearning(join(root, "success"), sources);
    learning.sink.recordObserved(observed);
    learning.sink.write(); // Runtime's early seal must not lose later observations.
    learning.finish();
    const record = JSON.parse(readFileSync(join(root, "success", "question-answer-learning.json"), "utf8")).questions[0];
    assert.equal(record.uiType, "textarea");
    assert.equal(record.answerType, "text");
    const pending = JSON.parse(readFileSync(join(root, "success", "pending-profile-questions.json"), "utf8")).pendingProfileQuestions[0];
    assert.equal(pending.semanticQuestionType, "unknown");
    assert.equal(pending.constraints.maxLength, 500);
    assert.equal(pending.constraints.minLength, 2);
    assert.equal(record.monitorBinding, null);
    assert.equal(record.chosenAnswer, null);
    const blockedRoot = join(root, "file");
    writeFileSync(blockedRoot, "not a directory");
    const blocked = productQuestionLearning(blockedRoot, sources);
    blocked.sink.recordObserved(observed);
    assert.throws(() => blocked.finish(), /could not preserve discovered questions/);
  } finally {
    disposeResumeArtifact(sources.resumeIntent.artifact);
    rmSync(root, { recursive: true, force: true });
  }
});
