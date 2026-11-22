import assert from "node:assert/strict";
import { test } from "node:test";

import {
  dependencyViolations,
  sourceFiles,
  type SourceFile,
} from "./dependency-rule.ts";
import { productBoundary } from "../../src/contracts/ownership.ts";
import type { AccountLifecycleObservation } from "../../src/account/lifecycle/index.ts";
import type { ClassifiedAccountObservation } from "../../src/ats/workday/live/index.ts";

const acceptLifecycleObservation = (_value: AccountLifecycleObservation): void => undefined;
const proveF5ObservationAssignable = (value: ClassifiedAccountObservation): void =>
  acceptLifecycleObservation(value);
void proveF5ObservationAssignable;

test("dependency rules reject synthetic and private imports and admit the shipped source", () => {
  const testOnlyImport = "../testing/evidence/retained-fixture-control-learning.ts";
  const files: SourceFile[] = [
    {
      path: "src/browser/adapter.ts",
      source: `import { capture } from "${testOnlyImport}";`,
    },
    {
      path: "src/live/runner/application-walk.ts",
      source: 'import { capture } from "../../testing/evidence/retained-fixture-control-learning.ts";',
    },
    {
      path: "src/composition/runtime.ts",
      source: `import { capture } from "${testOnlyImport}";`,
    },
  ];

  assert.deepEqual(dependencyViolations(files), [
    "src/browser/adapter.ts imports test-only source src/testing/evidence/retained-fixture-control-learning.ts",
    "src/live/runner/application-walk.ts imports test-only source src/testing/evidence/retained-fixture-control-learning.ts",
    "src/composition/runtime.ts imports test-only source src/testing/evidence/retained-fixture-control-learning.ts",
  ]);
  const assigned = Object.values(productBoundary.sourceOwners).flat();
  assert.equal(new Set(assigned).size, assigned.length);
  for (const path of [
    "src/browser/page-runtime/unassigned.js",
    "extension/page-runtime/unassigned.js",
    "extension/page-adapters/unassigned.js",
  ]) {
    assert.deepEqual(dependencyViolations([{ path, source: "" }]), [`${path} has no component owner`]);
  }
  const path = "extension/page-actions.js";
  assert.deepEqual(dependencyViolations([{
    path,
    source: [
      'import "./popup.d.ts";',
      'import { annotateQuestionContext } from "./question-context.js";',
      'import { submitReviewedApplication } from "../src/product/application-submission.ts";',
      'import { loadAccount } from "../src/product/account-storage.ts";',
    ].join("\n"),
  }]), [
    path + " imports non-extension module extension/popup.d.ts",
    path + " imports non-extension module src/product/application-submission.ts",
    path + " imports non-extension module src/product/account-storage.ts",
  ]);
  assert.deepEqual(dependencyViolations([...sourceFiles("src"), ...sourceFiles("extension")]), []);
});
