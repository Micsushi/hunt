import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

import * as publicLive from "../../../src/contracts/live/index.ts";

test("the public live surface exposes data-only review records and no runtime learning edge", () => {
  const forbiddenExports = Object.keys(publicLive).filter((name) =>
    /(?:Learner|LearningPort|CatalogWriter|SelectorWriter|PromotionPort|ReloadPort|UpdatePort|FeedbackPort)/u.test(name));
  assert.deepEqual(forbiddenExports, []);

  const directory = new URL("../../../src/contracts/live/", import.meta.url);
  const source = readdirSync(directory)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => readFileSync(new URL(name, directory), "utf8"))
    .join("\n");
  assert.doesNotMatch(source, /interface\s+(?:Runtime)?(?:Learner|Learning|CatalogWriter|SelectorWriter|Promotion|Reload|Update|Feedback)(?:Port|Adapter)\b/u);
  assert.doesNotMatch(source, /\b(?:reload|selfModify|promoteDuringRun|updateCatalog|writeSelector|applyFeedback)\s*\(/u);
});

test("admitted Workday target identity remains identity, not an ATS detector result", () => {
  const source = readFileSync(new URL("../../../src/contracts/live/types.ts", import.meta.url), "utf8");
  const targetBody = source.match(/export interface TargetIdentityV1 \{(?<body>[\s\S]*?)\n\}/u)?.groups?.body ?? "";
  assert.match(targetBody, /readonly atsFamily: "workday"/u);
  assert.doesNotMatch(targetBody, /unknown|ambiguous|unsupported|classifier|detector/iu);
});
