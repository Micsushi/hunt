import assert from "node:assert/strict";
import { test } from "node:test";

import type { BrowserObservation } from "../../../../src/contracts/index.ts";
import { detectWorkdayPage } from "../../../../src/ats/workday/detector.ts";
import { contractFixtures } from "../../../../src/testing/contracts/fixtures.ts";

function observation(path: string, origin = "https://tenant.myworkdayjobs.com"): BrowserObservation {
  return { ...contractFixtures.browserObservation, origin, path, targets: [] };
}

test("exact Workday path signatures select one page handler", () => {
  for (const [path, page] of [
    ["/en-US/jobs/account", "account"],
    ["/en-US/jobs/apply/my-information", "profile"],
    ["/en-US/jobs/apply/application-questions", "questionnaire"],
    ["/en-US/jobs/apply/review", "review"],
  ] as const) {
    assert.deepEqual(detectWorkdayPage(observation(path)), {
      kind: "workday",
      page,
    });
  }
});

test("controlled fixture and loopback origins use the same signatures", () => {
  for (const origin of [
    "https://fixture.invalid",
    "http://fixture.invalid",
    "http://127.0.0.1:43121",
    "http://[::1]:43121",
  ]) {
    assert.deepEqual(detectWorkdayPage(observation("/profile", origin)), {
      kind: "workday",
      page: "profile",
    });
  }
});

test("unknown hosts, lookalikes, and unsupported paths remain unknown", () => {
  for (const [path, origin] of [
    ["/profile", "https://example.invalid"],
    ["/profile", "https://myworkdayjobs.com.evil.invalid"],
    ["/profile", "http://tenant.myworkdayjobs.com"],
    ["/candidate-home", "https://tenant.myworkdayjobs.com"],
    ["/acme-review", "https://tenant.myworkdayjobs.com"],
    ["/profile", "not-a-url"],
  ] as const) {
    assert.deepEqual(detectWorkdayPage(observation(path, origin)), {
      kind: "unknown",
    });
  }
});

test("conflicting or unbounded signatures are ambiguous or unknown", () => {
  assert.deepEqual(
    detectWorkdayPage(observation("/my-information/application-questions")),
    { kind: "ambiguous" },
  );
  assert.deepEqual(
    detectWorkdayPage(observation(`/${"a".repeat(2049)}/review`)),
    { kind: "unknown" },
  );
});
