import assert from "node:assert/strict";
import { test } from "node:test";

import {
  inProcessContractPolicy,
  portNames,
  serializedContractVersions,
  serializedSchemas,
} from "../../src/contracts/index.ts";
import { componentBoundaries } from "../../src/contracts/ownership.ts";

test("plain in-process ports are pinned by the F1 source revision", () => {
  assert.deepEqual(inProcessContractPolicy, {
    pin: "git-revision",
    runtimeVersionField: false,
  });
  assert.deepEqual(
    portNames,
    componentBoundaries.flatMap(({ ports }) => ports.map(({ name }) => name)),
  );
});

test("only serialized Stage 1 boundaries export closed JSON Schemas", () => {
  assert.deepEqual(Object.keys(serializedSchemas), [
    "fixtureManifest",
    "durableJourneyState",
    "eventEnvelope",
    "errorEnvelope",
    "evidenceManifest",
    "mcpRequest",
    "mcpResponse",
    "terminalResult",
  ]);

  for (const [name, schema] of Object.entries(serializedSchemas)) {
    assert.equal(schema.type, "object");
    assert.equal(schema.additionalProperties, false);
    assert.equal(
      schema.properties.schemaVersion.const,
      serializedContractVersions[
        name as keyof typeof serializedContractVersions
      ],
    );
  }
});
