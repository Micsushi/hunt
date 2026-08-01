import assert from "node:assert/strict";
import { test } from "node:test";

import {
  componentSourceOwners,
  dependencyViolations,
  sourceFiles,
  type SourceFile,
} from "./dependency-rule.ts";
import { componentBoundaries } from "../../src/contracts/ownership.ts";

test("component source ownership comes from the boundary matrix", () => {
  assert.deepEqual(
    componentSourceOwners,
    componentBoundaries.flatMap(({ feature, sourceOwnership }) =>
      sourceOwnership.map((pattern) => ({ pattern, owner: feature })),
    ),
  );
});

test("components may import contracts and their own implementation", () => {
  const files: SourceFile[] = [
    {
      path: "src/browser/adapter.ts",
      source: [
        'import type { BrowserPort } from "../contracts/browser.ts";',
        'import { openSession } from "./session.ts";',
      ].join("\n"),
    },
  ];

  assert.deepEqual(dependencyViolations(files), []);
});

test("components may not import peer implementations", () => {
  const files: SourceFile[] = [
    {
      path: "src/browser/adapter.ts",
      source: 'import { loadProfile } from "../profile/store.ts";',
    },
  ];

  assert.deepEqual(dependencyViolations(files), [
    "src/browser/adapter.ts imports peer implementation src/profile/store.ts",
  ]);
});

test("import types may not reference peer implementations", () => {
  const files: SourceFile[] = [
    {
      path: "src/browser/adapter.ts",
      source: 'type Profile = import("../profile/store.ts").Profile;',
    },
  ];

  assert.deepEqual(dependencyViolations(files), [
    "src/browser/adapter.ts imports peer implementation src/profile/store.ts",
  ]);
});

test("dynamic imports inspect a literal first argument with options", () => {
  const files: SourceFile[] = [
    {
      path: "src/browser/adapter.ts",
      source:
        'const profile = import("../profile/store.ts", { with: { type: "json" } });',
    },
  ];

  assert.deepEqual(dependencyViolations(files), [
    "src/browser/adapter.ts imports peer implementation src/profile/store.ts",
  ]);
});

test("nonliteral dynamic imports are rejected", () => {
  const files: SourceFile[] = [
    {
      path: "src/browser/adapter.ts",
      source: 'const path = "../profile/store.ts"; import(path);',
    },
  ];

  assert.deepEqual(dependencyViolations(files), [
    "src/browser/adapter.ts uses a nonliteral dynamic import",
  ]);
});

test("triple-slash path references obey component boundaries", () => {
  const files: SourceFile[] = [
    {
      path: "src/browser/adapter.ts",
      source: '/// <reference path="../profile/store.ts" />',
    },
  ];

  assert.deepEqual(dependencyViolations(files), [
    "src/browser/adapter.ts imports peer implementation src/profile/store.ts",
  ]);
});

test("production components may not import the contract test kit", () => {
  const files: SourceFile[] = [
    {
      path: "src/browser/adapter.ts",
      source:
        'import { fakeBrowser } from "../testing/contracts/browser.ts";',
    },
  ];

  assert.deepEqual(dependencyViolations(files), [
    "src/browser/adapter.ts imports test-only source src/testing/contracts/browser.ts",
  ]);
});

test("tests may import the contract test kit", () => {
  const files: SourceFile[] = [
    {
      path: "tests/browser/adapter.test.ts",
      source:
        'import { fakeBrowser } from "../../src/testing/contracts/browser.ts";',
    },
  ];

  assert.deepEqual(dependencyViolations(files), []);
});

test("the contract test kit may import itself", () => {
  const files: SourceFile[] = [
    {
      path: "src/testing/contracts/browser.ts",
      source: 'export { fakeBase } from "./base.ts";',
    },
  ];

  assert.deepEqual(dependencyViolations(files), []);
});

test("the live contract test kit is test-only and may import itself", () => {
  const files: SourceFile[] = [
    {
      path: "src/testing/live/fakes.ts",
      source: [
        'import type { SecretStore } from "../../contracts/live/index.ts";',
        'export { liveFixtures } from "./fixtures.ts";',
      ].join("\n"),
    },
    {
      path: "src/browser/adapter.ts",
      source: 'import { createSecretStoreFake } from "../testing/live/index.ts";',
    },
  ];

  assert.deepEqual(dependencyViolations(files), [
    "src/browser/adapter.ts imports test-only source src/testing/live/index.ts",
  ]);
});

test("the live preflight owner may import contracts, Node, and its own subtree", () => {
  const files: SourceFile[] = [
    {
      path: "src/live/preflight/admit.ts",
      source: [
        'import { realpathSync } from "node:fs";',
        'import type { TargetIdentityV1 } from "../../contracts/live/index.ts";',
        'export { binding } from "./private/binding.ts";',
      ].join("\n"),
    },
  ];

  assert.deepEqual(dependencyViolations(files), []);
});

test("the live preflight owner cannot import peers or test-only source", () => {
  const files: SourceFile[] = [
    {
      path: "src/live/preflight/admit.ts",
      source: [
        'import { browser } from "../../browser/adapter.ts";',
        'import { fake } from "../../testing/live/fakes.ts";',
      ].join("\n"),
    },
  ];

  assert.deepEqual(dependencyViolations(files), [
    "src/live/preflight/admit.ts imports peer implementation src/browser/adapter.ts",
    "src/live/preflight/admit.ts imports test-only source src/testing/live/fakes.ts",
  ]);
});

test("the architecture owner does not widen to other live source", () => {
  assert.deepEqual(
    dependencyViolations([
      { path: "src/live/other.ts", source: "export const other = true;" },
    ]),
    ["src/live/other.ts has no component owner"],
  );
});

test("composition may not import test-only source", () => {
  const files: SourceFile[] = [
    {
      path: "src/composition/runtime.ts",
      source: [
        'import { fakeBrowser } from "../testing/contracts/browser.ts";',
        'import { helper } from "../../tests/helper.ts";',
      ].join("\n"),
    },
  ];

  assert.deepEqual(dependencyViolations(files), [
    "src/composition/runtime.ts imports test-only source src/testing/contracts/browser.ts",
    "src/composition/runtime.ts imports test-only source tests/helper.ts",
  ]);
});

test("components may not import unowned source", () => {
  const files: SourceFile[] = [
    {
      path: "src/browser/adapter.ts",
      source: 'import { helper } from "../common/helper.ts";',
    },
  ];

  assert.deepEqual(dependencyViolations(files), [
    "src/browser/adapter.ts imports unowned source src/common/helper.ts",
  ]);
});

test("every source file must have an owner", () => {
  const files: SourceFile[] = [
    {
      path: "src/common/helper.ts",
      source: "export const helper = true;",
    },
  ];

  assert.deepEqual(dependencyViolations(files), [
    "src/common/helper.ts has no component owner",
  ]);
});

test("the composition root may assemble component implementations", () => {
  const files: SourceFile[] = [
    {
      path: "src/composition/runtime.ts",
      source: [
        'import { BrowserAdapter } from "../browser/adapter.ts";',
        'import { Orchestrator } from "../control/orchestrator/orchestrator.ts";',
      ].join("\n"),
    },
  ];

  assert.deepEqual(dependencyViolations(files), []);
});

test("C3 v2 imports are forbidden", () => {
  const files: SourceFile[] = [
    {
      path: "src/ats/workday/page.ts",
      source: [
        'import { fill } from "./fill-v2.js";',
        'import { legacy } from "../../background/index.js";',
      ].join("\n"),
    },
  ];

  assert.deepEqual(dependencyViolations(files), [
    "src/ats/workday/page.ts imports C3 v2 path src/ats/workday/fill-v2.js",
    "src/ats/workday/page.ts imports C3 v2 path src/background/index.js",
  ]);
});

test("comments and strings are not imports", () => {
  const files: SourceFile[] = [
    {
      path: "src/browser/adapter.ts",
      source: [
        '// import { loadProfile } from "../profile/store.ts";',
        'const example = `import { fill } from "../shared/v2/fill.js";`;',
      ].join("\n"),
    },
  ];

  assert.deepEqual(dependencyViolations(files), []);
});

test("executioner source follows the dependency rule", () => {
  assert.deepEqual(dependencyViolations(sourceFiles("src")), []);
});
