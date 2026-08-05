import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  componentSourceOwners,
  dependencyViolations,
  sourceFiles,
  type SourceFile,
} from "./dependency-rule.ts";
import { componentBoundaries } from "../../src/contracts/ownership.ts";
import type { AccountLifecycleObservation } from "../../src/account/lifecycle/index.ts";
import type { ClassifiedAccountObservation } from "../../src/ats/workday/live/index.ts";

const acceptLifecycleObservation = (_value: AccountLifecycleObservation): void => undefined;
const proveF5ObservationAssignable = (value: ClassifiedAccountObservation): void =>
  acceptLifecycleObservation(value);
void proveF5ObservationAssignable;

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

test("the Windows secret owner may import contracts, Node, and its own subtree only", () => {
  assert.deepEqual(
    dependencyViolations([
      {
        path: "src/secrets/windows-dpapi/store.ts",
        source: [
          'import { readFile } from "node:fs/promises";',
          'import type { SecretStore } from "../../contracts/live/index.ts";',
          'import { readRecord } from "./record.ts";',
        ].join("\n"),
      },
      {
        path: "src/secrets/windows-dpapi/store.ts",
        source: 'import { fake } from "../../testing/live/fakes.ts";',
      },
    ]),
    ["src/secrets/windows-dpapi/store.ts imports test-only source src/testing/live/fakes.ts"],
  );
});

test("account entry owns policy only and composition owns peer capability wiring", () => {
  assert.deepEqual(
    dependencyViolations([
      {
        path: "src/account/entry/adapter.ts",
        source: [
          'import type { CredentialMutationAdapter } from "../../contracts/live/index.ts";',
          'import { local } from "./types.ts";',
        ].join("\n"),
      },
      {
        path: "src/account/entry/adapter.ts",
        source: 'import { browser } from "../../browser/playwright-live/session.ts";',
      },
      {
        path: "src/composition/s2-account-entry.ts",
        source: [
          'import { entry } from "../account/entry/index.ts";',
          'import { browser } from "../browser/playwright-live/session.ts";',
          'import { account } from "../ats/workday/live/index.ts";',
          'import { resolver } from "../secrets/windows-dpapi/private/resolver.ts";',
        ].join("\n"),
      },
    ]),
    [
      "src/account/entry/adapter.ts imports peer implementation src/browser/playwright-live/session.ts",
    ],
  );
});

test("the exact Stage 2 account lifecycle subtree shares F9 ownership", () => {
  assert.deepEqual(
    dependencyViolations([
      {
        path: "src/account/lifecycle/lifecycle.ts",
        source:
          'import { liveCoordinatorError } from "../../control/orchestrator/live/types.ts";',
      },
      {
        path: "src/composition/s2-account-verified-runner.ts",
        source: 'import { lifecycle } from "../account/lifecycle/index.ts";',
      },
    ]),
    [],
  );
});

test("the Stage 2 lifecycle owner does not widen unrelated account paths", () => {
  assert.deepEqual(
    dependencyViolations([
      { path: "src/account/other.ts", source: "export const other = true;" },
      {
        path: "src/account/lifecycles/other.ts",
        source: "export const other = true;",
      },
    ]),
    [
      "src/account/other.ts has no component owner",
      "src/account/lifecycles/other.ts has no component owner",
    ],
  );
});

test("the exact Stage 2 Review Stopper subtree has F8 ownership", () => {
  assert.deepEqual(
    dependencyViolations([{
      path: "src/interaction/review/index.ts",
      source: 'import type { PageCompletionResult } from "../../contracts/index.ts";',
    }]),
    [],
  );
  assert.deepEqual(
    dependencyViolations([{
      path: "src/interaction/reviews/other.ts",
      source: "export const other = true;",
    }]),
    ["src/interaction/reviews/other.ts has no component owner"],
  );
});

test("Gmail auth and safe provider implementations have separate owners", () => {
  assert.deepEqual(
    dependencyViolations([
      {
        path: "src/mailbox/providers/gmail/auth-executor.ts",
        source: [
          'import { request } from "node:http";',
          'import type { PrivilegedGmailAuthExecutor } from "../../../contracts/live/index.ts";',
          'import { parse } from "./http-parser.ts";',
          'import { RawArtifactVault } from "./private/raw-artifact-vault.ts";',
        ].join("\n"),
      },
      {
        path: "src/mailbox/providers/gmail/provider.ts",
        source: [
          'import type { MailboxProvider } from "../../../contracts/live/index.ts";',
          'import { SafeArtifactRegistry } from "./safe-artifact-registry.ts";',
        ].join("\n"),
      },
    ]),
    [],
  );

  assert.deepEqual(
    dependencyViolations([
      {
        path: "src/mailbox/providers/gmail/provider.ts",
        source: 'import { GmailAuthExecutor } from "./auth-executor.ts";',
      },
      {
        path: "src/mailbox/providers/gmail/auth-executor.ts",
        source: 'import { createBoundedMailboxPolicy } from "../../policy.ts";',
      },
    ]),
    [
      "src/mailbox/providers/gmail/provider.ts imports peer implementation src/mailbox/providers/gmail/auth-executor.ts",
      "src/mailbox/providers/gmail/auth-executor.ts imports peer implementation src/mailbox/policy.ts",
    ],
  );
});

test("repository ignore policy admits only the intended SecretStore source and tests", () => {
  const ignore = readFileSync("../.gitignore", "utf8");
  assert.match(ignore, /^!executioner\/src\/secrets\/$/mu);
  assert.match(ignore, /^!executioner\/src\/secrets\/\*\*$/mu);
  assert.match(ignore, /^!executioner\/tests\/secrets\/$/mu);
  assert.match(ignore, /^!executioner\/tests\/secrets\/\*\*$/mu);
});

test("the account credential resolver stays private and the public secret surface does not widen", () => {
  const publicSurface = readFileSync("src/secrets/index.ts", "utf8").trim();
  const privateResolver = readFileSync(
    "src/secrets/windows-dpapi/private/resolver.ts",
    "utf8",
  );
  assert.equal(
    publicSurface,
    'export { WindowsDpapiSecretStore } from "./windows-dpapi/store.ts";',
  );
  assert.match(
    privateResolver,
    /export interface AccountCredentialResolver \{/u,
  );
  assert.doesNotMatch(publicSurface, /Resolver|Custodian|CredentialBundle/u);
});

test("the architecture owner does not widen to other live source", () => {
  assert.deepEqual(
    dependencyViolations([
      { path: "src/live/other.ts", source: "export const other = true;" },
    ]),
    ["src/live/other.ts has no component owner"],
  );
});

test("additive live runner and evidence lanes do not widen frozen ownership", () => {
  assert.deepEqual(
    componentSourceOwners.filter(({ pattern }) => pattern.startsWith("src/live/")),
    [],
  );
  assert.deepEqual(dependencyViolations([
    {
      path: "src/live/runner/account-access.ts",
      source: 'import type { SecretStore } from "../../contracts/live/index.ts";',
    },
    {
      path: "src/live/evidence/account-access-evidence.ts",
      source: 'import { openSync } from "node:fs";',
    },
  ]), []);
  assert.deepEqual(dependencyViolations([
    {
      path: "src/live/runner/other.ts",
      source: 'import { walk } from "../../ats/workday/application/page-walk.ts";',
    },
    {
      path: "src/live/evidence/other.ts",
      source: 'import type { Walk } from "../../ats/workday/application/page-walk-contract.ts";',
    },
  ]), [
    "src/live/runner/other.ts imports peer implementation src/ats/workday/application/page-walk.ts",
    "src/live/evidence/other.ts imports peer implementation src/ats/workday/application/page-walk-contract.ts",
  ]);
});

test("S2-F3 application composition owns only its exact integration seams", () => {
  assert.deepEqual(dependencyViolations([
    {
      path: "src/ats/workday/application/lane-composition.ts",
      source: 'import { handler } from "./questions/index.ts";',
    },
    {
      path: "src/ats/workday/application/questions/index.ts",
      source: 'import { resolver } from "../../../../form/answers/resolver.ts";',
    },
    {
      path: "src/live/runner/application-walk.ts",
      source: 'import { walk } from "../../ats/workday/application/page-walk.ts";',
    },
    {
      path: "src/live/evidence/application-walk-evidence.ts",
      source: 'import type { Walk } from "../../ats/workday/application/page-walk-contract.ts";',
    },
  ]), []);
});

test("the raw-page owner admits only the exact closed Workday runtime assembler", () => {
  const source = 'import { handler } from "../../../ats/workday/application/page-walk.ts";';
  assert.deepEqual(dependencyViolations([{
    path: "src/browser/playwright-live/private/workday-application-runtime.ts",
    source,
  }]), []);
  assert.deepEqual(dependencyViolations([{
    path: "src/browser/playwright-live/private/other-application-runtime.ts",
    source,
  }]), [
    "src/browser/playwright-live/private/other-application-runtime.ts imports peer implementation src/ats/workday/application/page-walk.ts",
  ]);
  assert.deepEqual(dependencyViolations([{
    path: "src/browser/playwright-live/private/workday-application-runtime.ts",
    source: 'import { lifecycle } from "../../../account/lifecycle/index.ts";',
  }]), [
    "src/browser/playwright-live/private/workday-application-runtime.ts imports peer implementation src/account/lifecycle/index.ts",
  ]);
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
