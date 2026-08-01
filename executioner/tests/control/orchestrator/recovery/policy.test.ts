import assert from "node:assert/strict";
import test from "node:test";

import { providerError } from "../../../../src/contracts/index.ts";
import {
  retryDisposition,
  sessionRecoveryDisposition,
} from "../../../../src/control/orchestrator/recovery/policy.ts";

test("the retry table allows only declared retryable pre-effect failures", () => {
  assert.equal(
    retryDisposition(providerError("browser_timeout"), "none"),
    "retry",
  );
  assert.equal(
    retryDisposition(providerError("browser_timeout"), "uncertain"),
    "stop",
  );
  assert.equal(
    retryDisposition(providerError("browser_effect_uncertain"), "uncertain"),
    "stop",
  );
  assert.equal(
    retryDisposition(providerError("question_ambiguous"), "none"),
    "stop",
  );
});

test("only uncertain field operations require a fresh session before stopping", () => {
  for (const phase of ["field_interaction", "verification"] as const) {
    for (const code of [
      "browser_effect_uncertain",
      "browser_session_invalidated",
      "operation_cancelled",
    ] as const) {
      assert.equal(
        sessionRecoveryDisposition(providerError(code), phase, "uncertain"),
        "fresh_session_then_stop",
        `${phase}:${code}`,
      );
    }
  }

  assert.equal(
    sessionRecoveryDisposition(
      providerError("browser_effect_uncertain"),
      "navigation",
      "uncertain",
    ),
    "stop",
  );
  assert.equal(
    sessionRecoveryDisposition(
      providerError("operation_cancelled"),
      "field_interaction",
      "none",
    ),
    "stop",
  );
  assert.equal(
    sessionRecoveryDisposition(
      providerError("browser_target_invalid"),
      "field_interaction",
      "uncertain",
    ),
    "stop",
  );
});
