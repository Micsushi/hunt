import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createValueFreeRunTrace,
  readValueFreeRunTrace,
} from "../../../src/live/evidence/value-free-run-trace.ts";

test("durable run trace retains ordered structural state and drops applicant values", () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-value-free-trace-"));
  const streamed: string[] = [];
  try {
    const trace = createValueFreeRunTrace(root, (line) => streamed.push(line));
    trace("application_walk_progress", {
      checkpoint: "questionnaire",
      browserPage: "questionnaire",
      questionTypes: ["authorization", "employment"],
      answerTypes: ["single_select", "number"],
      completedPages: 2,
      code: "page_incomplete",
      classifier: "required_field_gate",
      primitive: "required_field_verification",
      unknownLayer: "required_field",
      submitActivated: false,
      email: "applicant_private_sentinel",
      answer: "private answer",
    });
    trace("external_monitor_acknowledged", {
      chain: "application",
      page: "questionnaire",
      moment: "after_readback",
      ordinal: 7,
      operationId: "operation_question_mutation_01",
      attempt: 1,
      submitPresent: false,
      submitActivated: false,
    });

    const path = join(root, "value-free-trace.ndjson");
    const text = readFileSync(path, "utf8");
    assert.equal(text.includes("applicant_private_sentinel"), false);
    assert.equal(text.includes("private answer"), false);
    assert.equal(streamed.join("").includes("applicant_private_sentinel"), false);
    const records = readValueFreeRunTrace(path);
    assert.deepEqual(records.map(({ sequence, event }) => [sequence, event]), [
      [1, "application_walk_progress"],
      [2, "external_monitor_acknowledged"],
    ]);
    assert.deepEqual(records[0]?.details.questionTypes, ["authorization", "employment"]);
    assert.equal(Object.isFrozen(records[0]?.details), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("trace observer and invalid details never alter runtime behavior", () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-value-free-trace-failure-"));
  try {
    const trace = createValueFreeRunTrace(root, () => { throw new Error("observer failed"); });
    assert.doesNotThrow(() => trace("account_state_observed", { value: "secret" }));
    assert.equal(readValueFreeRunTrace(join(root, "value-free-trace.ndjson")).length, 1);
    writeFileSync(join(root, "malformed.ndjson"), '{"schemaVersion":1}\n');
    assert.throws(
      () => readValueFreeRunTrace(join(root, "malformed.ndjson")),
      /value-free run trace denied/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
