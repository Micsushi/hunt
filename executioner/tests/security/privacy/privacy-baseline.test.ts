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

test("bounded payload admission rejects credential and raw-content keys", () => {
  assert.deepEqual(
    findPayloadPrivacyViolations({
      component: "F9",
      nested: {
        accessToken: "synthetic",
        emailBody: "synthetic",
        rawPageText: "synthetic",
      },
    }),
    [
      "$.nested.accessToken:credential",
      "$.nested.emailBody:email_body",
      "$.nested.rawPageText:raw_text",
    ],
  );
  assert.deepEqual(
    findPayloadPrivacyViolations({
      component: "F9",
      phase: "orchestration",
      completedSteps: 2,
    }),
    [],
  );
});

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

test("file scanning is bounded to source, tests, and fixtures", () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-privacy-"));

  try {
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "fixtures"), { recursive: true });
    mkdirSync(join(root, "tests", "node_modules", "package"), {
      recursive: true,
    });
    mkdirSync(join(root, "src", "build"), { recursive: true });
    writeFileSync(join(root, "src", "safe.ts"), "export const value = 1;\n");
    writeFileSync(
      join(root, "fixtures", "leak.json"),
      `{"email":"person@${"example.com"}"}\n`,
    );
    writeFileSync(
      join(root, "tests", "node_modules", "package", "secret.txt"),
      `ghp_${"a".repeat(36)}\n`,
    );
    writeFileSync(
      join(root, "src", "build", "secret.pem"),
      ["-----BEGIN", "PRIVATE KEY-----"].join(" "),
    );

    assert.deepEqual(scanPrivacyFiles(root), [
      {
        file: "fixtures/leak.json",
        code: "real_email",
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the frozen F1 source, tests, and fixtures pass the shared scan", () => {
  assert.deepEqual(scanPrivacyFiles(resolve(".")), []);
});
