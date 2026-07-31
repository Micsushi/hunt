import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { frozenContractRevision } from "../../../src/testing/contracts/index.ts";

test("the frozen revision matches the checked-in contracts and policy record", () => {
  assert.match(frozenContractRevision, /^[0-9a-f]{40}$/u);
  assert.match(
    readFileSync("docs/contract-freeze.md", "utf8"),
    new RegExp(frozenContractRevision, "u"),
  );
  assert.doesNotThrow(() =>
    execFileSync(
      "git",
      [
        "diff",
        "--exit-code",
        frozenContractRevision,
        "--",
        ":(top)executioner/src/contracts",
      ],
      { stdio: "pipe" },
    ),
  );
});
