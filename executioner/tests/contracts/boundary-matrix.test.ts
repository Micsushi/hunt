import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { componentBoundaries } from "../../src/contracts/ownership.ts";

const expectedFeatures = [
  "F2",
  "F3",
  "F4",
  "F5",
  "F6",
  "F7",
  "F8",
  "F9",
  "F10",
  "F11",
];

test("every Stage 1 component has complete boundary metadata", () => {
  assert.deepEqual(
    componentBoundaries.map(({ feature }) => feature),
    expectedFeatures,
  );

  for (const component of componentBoundaries) {
    assert.ok(component.component);
    assert.ok(component.sourceOwnership.length > 0);
    assert.ok(component.dataOwnership.length > 0);
    assert.ok(component.ports.length > 0);

    for (const port of component.ports) {
      assert.ok(port.name);
      assert.ok(port.consumers.length > 0);
      assert.ok(port.requests.length > 0);
      assert.ok(port.results.length > 0);
      assert.ok(port.errors.length > 0);
      assert.ok(port.sideEffect);
      assert.ok(port.retry);
      assert.ok(port.cancellation);
      assert.ok(port.idempotency);
    }
  }
});

test("source and cross-component data ownership are disjoint", () => {
  const sourceRoots = componentBoundaries.flatMap(
    ({ sourceOwnership }) => sourceOwnership,
  );
  assert.equal(new Set(sourceRoots).size, sourceRoots.length);

  const normalizedRoots = sourceRoots.map((root) => root.replace(/\/\*\*$/, ""));

  for (const [index, root] of normalizedRoots.entries()) {
    assert.ok(!root.startsWith("src/contracts"));
    assert.ok(
      normalizedRoots.every(
        (other, otherIndex) =>
          index === otherIndex ||
          (!root.startsWith(`${other}/`) && !other.startsWith(`${root}/`)),
      ),
      `overlapping source ownership: ${sourceRoots[index]}`,
    );
  }

  const dataNames = componentBoundaries.flatMap(
    ({ dataOwnership }) => dataOwnership,
  );
  assert.equal(new Set(dataNames).size, dataNames.length);

  const portNames = componentBoundaries.flatMap(({ ports }) =>
    ports.map(({ name }) => name),
  );
  assert.equal(new Set(portNames).size, portNames.length);
});

test("the human boundary document names the frozen matrix", () => {
  const document = readFileSync("docs/component-boundaries.md", "utf8");
  const requiredTerms = componentBoundaries.flatMap((component) => [
    component.feature,
    component.component,
    ...component.sourceOwnership,
    ...component.dataOwnership,
    ...component.ports.flatMap((port) => [
      port.name,
      ...port.consumers,
      ...port.requests,
      ...port.results,
      ...port.errors,
    ]),
  ]);

  for (const term of requiredTerms) {
    assert.ok(document.includes(term), `missing boundary documentation: ${term}`);
  }
});
