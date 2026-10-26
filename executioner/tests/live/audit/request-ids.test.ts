import assert from "node:assert/strict";
import test from "node:test";

import { journeyId } from "../../../src/contracts/index.ts";
import { stage2AuditMcpRequestIds } from "../../../src/composition/private/s2-audit-request-ids.ts";

test("Stage 2 audit request IDs derive only from the validated journey identity", () => {
  assert.deepEqual(
    stage2AuditMcpRequestIds(journeyId("journey_abcdefghijklmnop")),
    {
      status: "audit-abcdefghijklmnop-status",
      result: "audit-abcdefghijklmnop-result",
    },
  );
});

test("Stage 2 audit request IDs never accept a free-form company label", () => {
  assert.throws(
    () => stage2AuditMcpRequestIds("Northrop Grumman" as never),
    /journey identifier/u,
  );
});
