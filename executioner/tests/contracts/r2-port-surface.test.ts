import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { portNames } from "../../src/contracts/index.ts";

test("R2 defers ModelController and fixture navigation remains browser-driven", () => {
  const portsSource = readFileSync(
    new URL("../../src/contracts/ports.ts", import.meta.url),
    "utf8",
  );
  const typesSource = readFileSync(
    new URL("../../src/contracts/types.ts", import.meta.url),
    "utf8",
  );
  const boundariesDocument = readFileSync(
    new URL("../../docs/component-boundaries.md", import.meta.url),
    "utf8",
  );

  assert.equal(portNames.includes("ModelController" as never), false);
  assert.doesNotMatch(portsSource, /interface ModelController/u);
  assert.doesNotMatch(portsSource, /transition\(request: FixtureTransitionRequest/u);
  assert.doesNotMatch(typesSource, /interface FixtureTransitionRequest/u);
  assert.doesNotMatch(typesSource, /ModelSuggestion/u);
  assert.doesNotMatch(boundariesDocument, /ModelController/u);
  assert.doesNotMatch(boundariesDocument, /ModelSuggestion/u);
  assert.doesNotMatch(boundariesDocument, /src\/control\/model/u);
  assert.doesNotMatch(boundariesDocument, /bounded model invocation/u);

  const fixtureSection = boundariesDocument.slice(
    boundariesDocument.indexOf("**FixtureRuntime**"),
    boundariesDocument.indexOf("### F3 Browser Session Adapter"),
  );
  assert.doesNotMatch(
    fixtureSection,
    /FixtureTransition|fixture transition|transitions|transition ID/u,
  );

  const mcpSection = boundariesDocument.slice(
    boundariesDocument.indexOf("**McpJourneyApi**"),
    boundariesDocument.indexOf("### F10 Observability"),
  );
  assert.match(
    mcpSection,
    /- Idempotency: `requestId` is the sole caller idempotency key\./u,
  );
  assert.doesNotMatch(mcpSection, /mutating requests use operation IDs/u);
});

test("the public contract has no short-form operation ID constructor", () => {
  const typesSource = readFileSync(
    new URL("../../src/contracts/types.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(typesSource, /export (?:const|function) operationId/u);
});
