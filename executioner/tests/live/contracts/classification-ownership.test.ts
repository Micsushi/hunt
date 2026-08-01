import assert from "node:assert/strict";
import { test } from "node:test";

import {
  liveClassificationOwnership,
  livePortNames,
} from "../../../src/contracts/index.ts";

test("classification ownership is separate from the nine frozen live ports", () => {
  assert.deepEqual(livePortNames, [
    "PersistentBrowserSession",
    "SecretStore",
    "CredentialMutationAdapter",
    "PrivilegedGmailAuthExecutor",
    "MailboxProvider",
    "VerificationArtifact",
    "PrivilegedVerificationNavigator",
    "LiveCheckpointStore",
    "LiveEvidenceSink",
  ]);
  assert.deepEqual(
    liveClassificationOwnership.map(({ contract, owner }) => [contract, owner]),
    [
      ["AtsFamilyClassifier", "F5"],
      ["WorkdayPageTypeClassifier", "F5"],
      ["UiBehaviorClassifier", "F5"],
      ["QuestionClassifier", "F6"],
      ["CanonicalAnswerTypeClassifier", "F6"],
      ["VisibleOptionMapper", "F6"],
      ["SanitizedUnknownCandidate", "F11"],
      ["ReviewedPromotionRecord", "between_runs"],
    ],
  );
  assert.deepEqual(
    liveClassificationOwnership.map(({ mutability }) => mutability),
    ["read_only", "read_only", "read_only", "read_only", "read_only", "read_only", "data_only", "data_only"],
  );
});
