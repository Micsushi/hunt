import assert from "node:assert/strict";
import { test } from "node:test";

import {
  dependencyViolations,
  sourceFiles,
  type SourceFile,
} from "./dependency-rule.ts";

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
