import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import {
  findPayloadPrivacyViolations,
  scanPrivacyFiles,
} from "../../../src/testing/contracts/index.ts";

test("frozen credential aliases report paths without rejected values", () => {
  const aliases = [
    "password",
    "workdayPassword",
    "apiKey",
    "accessToken",
    "sessionCookie",
    "authorizationHeader",
    "privateKey",
    "clientSecret",
    "bearerToken",
    "authToken",
    "oauthToken",
  ] as const;

  for (const alias of aliases) {
    const rejected = `rejected-${alias}`;
    const violations = findPayloadPrivacyViolations({
      nested: { [alias]: rejected },
    });
    assert.deepEqual(violations, [`$.nested.${alias}:credential`]);
    assert.equal(violations.join(" ").includes(rejected), false);
  }
});

test("the frozen F1 source, tests, and fixtures pass the shared scan", () => {
  assert.deepEqual(scanPrivacyFiles(resolve(".")), []);
});
