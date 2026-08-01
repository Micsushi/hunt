import assert from "node:assert/strict";
import { test } from "node:test";

import {
  browserTargetToken,
} from "../../../src/contracts/index.ts";
import { requiredFieldFlowCases } from "../../../src/testing/contracts/field-flow-cases.ts";
import {
  discoverFields,
  UnsupportedTargetError,
} from "../../../src/form/discovery/discover-fields.ts";
import { createSemanticSnapshot } from "../../../src/form/semantic-snapshot.ts";
import { canonicalTarget as target } from "../../golden/s1/understanding/canonical-observation.ts";

test("all ten canonical coordinates classify from exact control structure", () => {
  const fields = discoverFields(requiredFieldFlowCases.map(target));
  assert.equal(fields.length, 10);
  for (const fieldCase of requiredFieldFlowCases) {
    const field = fields.find(({ fieldId }) => fieldId === fieldCase.fieldId);
    assert.deepEqual(field, {
      fieldId: fieldCase.fieldId,
      target: `target-${fieldCase.fieldId}`,
      label: fieldCase.fieldLabel,
      required: true,
      behavior: fieldCase.behavior,
      options: fieldCase.options.map(({ id, label }) => ({ id, label })),
      state: "populated",
    });
  }
});

test("textarea, date, grouped choices, and listbox remain structurally distinct", () => {
  const fields = discoverFields(requiredFieldFlowCases.map(target));
  assert.deepEqual(
    fields.map(({ fieldId, behavior }) => [fieldId, behavior]),
    [...requiredFieldFlowCases]
      .sort((left, right) => left.fieldId.localeCompare(right.fieldId))
      .map(({ fieldId, behavior }) => [fieldId, behavior]),
  );
});

test("values and untrusted labels are reduced to canonical semantic state", () => {
  const given = requiredFieldFlowCases[0];
  const fields = discoverFields([target(given)]);
  const serialized = JSON.stringify(fields);
  assert.equal(fields[0]?.label, "Given name");
  assert.equal(fields[0]?.state, "populated");
  assert.equal(serialized.includes("private value"), false);
  assert.equal(serialized.includes("untrusted"), false);
});

test("hidden fields are marked, disabled fields omitted, and mismatches unsupported", () => {
  const given = target(requiredFieldFlowCases[0]);
  const family = target(requiredFieldFlowCases[1]);
  const phone = target(requiredFieldFlowCases[2]);
  const fields = discoverFields([
    { ...given, state: { visibility: "hidden", enabled: true, actionable: false } },
    { ...family, state: { visibility: "visible", enabled: false, actionable: false } },
    { ...phone, control: { kind: "date", element: "input" } },
  ]);
  assert.deepEqual(fields.map(({ fieldId, behavior, state }) => ({ fieldId, behavior, state })), [
    { fieldId: "s1-field-given-name", behavior: "text", state: "hidden" },
    { fieldId: "s1-field-phone-number", behavior: "unsupported", state: "ambiguous" },
  ]);
});

test("unknown and duplicate target coordinates fail without deriving an ID", () => {
  const given = target(requiredFieldFlowCases[0]);
  assert.throws(
    () => discoverFields([{ ...given, token: browserTargetToken("target-private-applicant") }]),
    UnsupportedTargetError,
  );
  assert.throws(() => discoverFields([given, given]), /duplicate browser target/u);
});

test("semantic snapshots sort, freeze, and leave the source array untouched", () => {
  const fields = discoverFields(requiredFieldFlowCases.slice(0, 2).reverse().map(target));
  const source = [...fields].reverse();
  const before = [...source];
  const snapshot = createSemanticSnapshot({ kind: "workday", page: "profile" }, source);

  assert.deepEqual(source, before);
  assert.deepEqual(snapshot.fields.map(({ fieldId }) => fieldId), [
    "s1-field-family-name",
    "s1-field-given-name",
  ]);
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.fields));
  assert.ok(snapshot.fields.every(Object.isFrozen));
});
