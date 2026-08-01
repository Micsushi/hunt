import assert from "node:assert/strict";
import { test } from "node:test";

import {
  browserPageId,
  boundedText,
  fieldId,
  optionId,
  sha256Digest,
  type BrowserObservation,
  type BrowserReadback,
  type BrowserSession,
  type FieldIntent,
} from "../../../src/contracts/index.ts";
import {
  contractFixtures,
  createBrowserSessionFake,
  createResumeArtifactFixture,
} from "../../../src/testing/contracts/index.ts";
import { createFieldVerifier } from "../../../src/interaction/verification/field-verifier.ts";

function observation(
  intent: FieldIntent,
  readback: BrowserReadback,
  state: BrowserObservation["targets"][number]["state"] = {
    visibility: "visible",
    enabled: true,
    actionable: true,
  },
): BrowserObservation {
  return {
    ...contractFixtures.browserObservation,
    targets: [
      {
        ...contractFixtures.browserObservation.targets[0],
        token: intent.target,
        name: boundedText("Synthetic field"),
        state,
        readback,
      },
    ],
  };
}

const baseIntent = {
  fieldId: contractFixtures.field.fieldId,
  target: contractFixtures.field.target,
  provenance: "owner_provided",
} as const;

const cases: readonly {
  name: string;
  intent: FieldIntent;
  readback: BrowserReadback;
}[] = [
  {
    name: "text",
    intent: {
      ...baseIntent,
      kind: "text",
      behavior: "text",
      value: "Ada Lovelace",
    },
    readback: { kind: "text", value: boundedText("  Ada Lovelace  ") },
  },
  {
    name: "textarea",
    intent: {
      ...baseIntent,
      kind: "text",
      behavior: "textarea",
      value: "Build reliable\r\nsystems",
    },
    readback: {
      kind: "text",
      value: boundedText("Build reliable\nsystems"),
    },
  },
  ...(["radio", "select", "listbox"] as const).map((behavior) => ({
    name: behavior,
    intent: {
      ...baseIntent,
      kind: "choice" as const,
      behavior,
      optionId: optionId("option-us"),
      expectedOption: boundedText("United States"),
      provenance: "visible_option" as const,
    },
    readback: {
      kind: "selected" as const,
      option: boundedText(" United States "),
    },
  })),
  {
    name: "checkbox",
    intent: {
      ...baseIntent,
      kind: "toggle",
      behavior: "checkbox",
      checked: true,
    },
    readback: { kind: "checked", checked: true },
  },
  {
    name: "date",
    intent: {
      ...baseIntent,
      kind: "date",
      behavior: "date",
      isoDate: "2026-07-31",
    },
    readback: {
      kind: "text",
      value: boundedText(" 2026-07-31 "),
    },
  },
];

for (const scenario of cases) {
  test(`independently verifies normalized ${scenario.name} readback`, async () => {
    const browser = createBrowserSessionFake({
      observe: {
        ok: true,
        value: observation(scenario.intent, scenario.readback),
      },
    });
    const verifier = createFieldVerifier(browser.port);

    assert.deepEqual(
      await verifier.verify(
        {
          sessionId: contractFixtures.browserObservation.sessionId,
          pageId: contractFixtures.browserObservation.pageId,
          intent: scenario.intent,
          receipt: {
            ...contractFixtures.mutationReceipt,
            behavior: scenario.intent.behavior,
          },
        },
        new AbortController().signal,
      ),
      {
        ok: true,
        value: {
          kind: "verified",
          fieldId: contractFixtures.field.fieldId,
        },
      },
    );
  });
}

test("verifies an upload only when both artifact identity and SHA-256 match", async () => {
  const artifact = createResumeArtifactFixture();
  const intent = {
    ...baseIntent,
    kind: "resume_upload",
    behavior: "file_upload",
    artifact,
  } as const satisfies FieldIntent;
  const browser = createBrowserSessionFake({
    observe: {
      ok: true,
      value: observation(intent, {
        kind: "upload",
        resumeId: artifact.resumeId,
        sha256: sha256Digest(artifact.sha256),
      }),
    },
  });

  assert.deepEqual(
    await createFieldVerifier(browser.port).verify(
      {
        sessionId: contractFixtures.browserObservation.sessionId,
        pageId: contractFixtures.browserObservation.pageId,
        intent,
        receipt: {
          ...contractFixtures.mutationReceipt,
          behavior: "file_upload",
        },
      },
      new AbortController().signal,
    ),
    {
      ok: true,
      value: { kind: "verified", fieldId: intent.fieldId },
    },
  );
});

test("rejects an upload with the right artifact identity but wrong SHA-256", async () => {
  const artifact = createResumeArtifactFixture();
  const intent = {
    ...baseIntent,
    kind: "resume_upload",
    behavior: "file_upload",
    artifact,
  } as const satisfies FieldIntent;
  const browser = createBrowserSessionFake({
    observe: {
      ok: true,
      value: observation(intent, {
        kind: "upload",
        resumeId: artifact.resumeId,
        sha256: sha256Digest("0".repeat(64)),
      }),
    },
  });

  const result = await createFieldVerifier(browser.port, { maxAttempts: 1 }).verify(
    {
      sessionId: contractFixtures.browserObservation.sessionId,
      pageId: contractFixtures.browserObservation.pageId,
      intent,
      receipt: { ...contractFixtures.mutationReceipt, behavior: "file_upload" },
    },
    new AbortController().signal,
  );

  assert.deepEqual(result, {
    ok: true,
    value: { kind: "rejected", fieldId: intent.fieldId, reason: "mismatch" },
  });
});

test("rejects a driver's false-success receipt after bounded readback", async () => {
  const browser = createBrowserSessionFake({
    observe: {
      ok: true,
      value: observation(contractFixtures.intent, {
        kind: "text",
        value: boundedText("Not Synthetic"),
      }),
    },
  });
  const verifier = createFieldVerifier(browser.port, { maxAttempts: 2 });

  assert.deepEqual(
    await verifier.verify(
      {
        sessionId: contractFixtures.browserObservation.sessionId,
        pageId: contractFixtures.browserObservation.pageId,
        intent: contractFixtures.intent,
        receipt: contractFixtures.mutationReceipt,
      },
      new AbortController().signal,
    ),
    {
      ok: true,
      value: {
        kind: "rejected",
        fieldId: contractFixtures.field.fieldId,
        reason: "mismatch",
      },
    },
  );
  assert.equal(
    browser.calls.filter(({ operation }) => operation === "observe").length,
    2,
  );
});

test("rejects materially changed textarea whitespace", async () => {
  const intent = {
    ...baseIntent,
    kind: "text",
    behavior: "textarea",
    value: "Build reliable  systems",
  } as const satisfies FieldIntent;
  const browser = createBrowserSessionFake({
    observe: {
      ok: true,
      value: observation(intent, {
        kind: "text",
        value: boundedText("Build reliable systems"),
      }),
    },
  });
  const verifier = createFieldVerifier(browser.port, { maxAttempts: 1 });

  const result = await verifier.verify(
    {
      sessionId: contractFixtures.browserObservation.sessionId,
      pageId: contractFixtures.browserObservation.pageId,
      intent,
      receipt: {
        ...contractFixtures.mutationReceipt,
        behavior: "textarea",
      },
    },
    new AbortController().signal,
  );

  assert.deepEqual(result, {
    ok: true,
    value: {
      kind: "rejected",
      fieldId: contractFixtures.field.fieldId,
      reason: "mismatch",
    },
  });
});

test("rejects compatibility characters changed by the browser", async () => {
  const intent = {
    ...baseIntent,
    kind: "text",
    behavior: "text",
    value: "①",
  } as const satisfies FieldIntent;
  const browser = createBrowserSessionFake({
    observe: {
      ok: true,
      value: observation(intent, {
        kind: "text",
        value: boundedText("1"),
      }),
    },
  });
  const verifier = createFieldVerifier(browser.port, { maxAttempts: 1 });

  const result = await verifier.verify(
    {
      sessionId: contractFixtures.browserObservation.sessionId,
      pageId: contractFixtures.browserObservation.pageId,
      intent,
      receipt: contractFixtures.mutationReceipt,
    },
    new AbortController().signal,
  );

  assert.deepEqual(result, {
    ok: true,
    value: {
      kind: "rejected",
      fieldId: contractFixtures.field.fieldId,
      reason: "mismatch",
    },
  });
});

test("rejects matching hidden state as stale", async () => {
  const browser = createBrowserSessionFake({
    observe: {
      ok: true,
      value: observation(
        contractFixtures.intent,
        { kind: "text", value: boundedText("Synthetic") },
        { visibility: "hidden", enabled: true, actionable: false },
      ),
    },
  });
  const verifier = createFieldVerifier(browser.port);

  assert.deepEqual(
    await verifier.verify(
      {
        sessionId: contractFixtures.browserObservation.sessionId,
        pageId: contractFixtures.browserObservation.pageId,
        intent: contractFixtures.intent,
        receipt: contractFixtures.mutationReceipt,
      },
      new AbortController().signal,
    ),
    {
      ok: true,
      value: {
        kind: "rejected",
        fieldId: contractFixtures.field.fieldId,
        reason: "stale",
      },
    },
  );
});

test("rejects readback from a stale page", async () => {
  const browser = createBrowserSessionFake({
    observe: {
      ok: true,
      value: {
        ...observation(contractFixtures.intent, {
          kind: "text",
          value: boundedText("Synthetic"),
        }),
        pageId: browserPageId("page-stale"),
      },
    },
  });
  const verifier = createFieldVerifier(browser.port);

  assert.deepEqual(
    await verifier.verify(
      {
        sessionId: contractFixtures.browserObservation.sessionId,
        pageId: contractFixtures.browserObservation.pageId,
        intent: contractFixtures.intent,
        receipt: contractFixtures.mutationReceipt,
      },
      new AbortController().signal,
    ),
    {
      ok: true,
      value: {
        kind: "rejected",
        fieldId: contractFixtures.field.fieldId,
        reason: "stale",
      },
    },
  );
});

test("returns unavailable when bounded polling never finds the target", async () => {
  const browser = createBrowserSessionFake({
    observe: {
      ok: true,
      value: {
        ...contractFixtures.browserObservation,
        targets: [],
      },
    },
  });
  const verifier = createFieldVerifier(browser.port, { maxAttempts: 2 });

  assert.deepEqual(
    await verifier.verify(
      {
        sessionId: contractFixtures.browserObservation.sessionId,
        pageId: contractFixtures.browserObservation.pageId,
        intent: contractFixtures.intent,
        receipt: contractFixtures.mutationReceipt,
      },
      new AbortController().signal,
    ),
    {
      ok: true,
      value: {
        kind: "unavailable",
        fieldId: contractFixtures.field.fieldId,
      },
    },
  );
  assert.equal(browser.calls.length, 2);
});

test("returns ambiguous for duplicate target readback", async () => {
  const target = observation(
    contractFixtures.intent,
    { kind: "text", value: boundedText("Synthetic") },
  ).targets[0];
  assert.ok(target);
  const browser = createBrowserSessionFake({
    observe: {
      ok: true,
      value: {
        ...contractFixtures.browserObservation,
        targets: [target, target],
      },
    },
  });
  const verifier = createFieldVerifier(browser.port);

  assert.deepEqual(
    await verifier.verify(
      {
        sessionId: contractFixtures.browserObservation.sessionId,
        pageId: contractFixtures.browserObservation.pageId,
        intent: contractFixtures.intent,
        receipt: contractFixtures.mutationReceipt,
      },
      new AbortController().signal,
    ),
    {
      ok: true,
      value: {
        kind: "ambiguous",
        fieldId: contractFixtures.field.fieldId,
      },
    },
  );
});

test("rejects inconsistent mutation intent and receipt without browser access", async () => {
  const browser = createBrowserSessionFake();
  const verifier = createFieldVerifier(browser.port);

  assert.deepEqual(
    await verifier.verify(
      {
        sessionId: contractFixtures.browserObservation.sessionId,
        pageId: contractFixtures.browserObservation.pageId,
        intent: contractFixtures.intent,
        receipt: {
          ...contractFixtures.mutationReceipt,
          fieldId: fieldId("different-field"),
        },
      },
      new AbortController().signal,
    ),
    {
      ok: false,
      error: {
        code: "verification_input_invalid",
        retryable: false,
      },
    },
  );
  assert.deepEqual(browser.calls, []);
});

test("stops before readback when cancelled", async () => {
  const browser = createBrowserSessionFake();
  const verifier = createFieldVerifier(browser.port);

  assert.deepEqual(
    await verifier.verify(
      {
        sessionId: contractFixtures.browserObservation.sessionId,
        pageId: contractFixtures.browserObservation.pageId,
        intent: contractFixtures.intent,
        receipt: contractFixtures.mutationReceipt,
      },
      AbortSignal.abort(),
    ),
    {
      ok: false,
      error: {
        code: "operation_cancelled",
        retryable: false,
      },
    },
  );
  assert.deepEqual(browser.calls, []);
});

test("does not verify when cancellation occurs during readback", async () => {
  const controller = new AbortController();
  const browser = createBrowserSessionFake();
  const port = {
    ...browser.port,
    async observe() {
      controller.abort();
      return {
        ok: true,
        value: observation(contractFixtures.intent, {
          kind: "text",
          value: boundedText("Synthetic"),
        }),
      };
    },
  } satisfies BrowserSession;
  const verifier = createFieldVerifier(port);

  assert.deepEqual(
    await verifier.verify(
      {
        sessionId: contractFixtures.browserObservation.sessionId,
        pageId: contractFixtures.browserObservation.pageId,
        intent: contractFixtures.intent,
        receipt: contractFixtures.mutationReceipt,
      },
      controller.signal,
    ),
    {
      ok: false,
      error: {
        code: "operation_cancelled",
        retryable: false,
      },
    },
  );
});

test("maps exhausted browser timeouts to verification_timeout", async () => {
  const browser = createBrowserSessionFake({
    observe: {
      ok: false,
      error: {
        code: "browser_timeout",
        retryable: true,
      },
    },
  });
  const verifier = createFieldVerifier(browser.port, { maxAttempts: 2 });

  assert.deepEqual(
    await verifier.verify(
      {
        sessionId: contractFixtures.browserObservation.sessionId,
        pageId: contractFixtures.browserObservation.pageId,
        intent: contractFixtures.intent,
        receipt: contractFixtures.mutationReceipt,
      },
      new AbortController().signal,
    ),
    {
      ok: false,
      error: {
        code: "verification_timeout",
        retryable: true,
      },
    },
  );
  assert.equal(browser.calls.length, 2);
});

test("preserves exhausted unavailable after a successful readback despite an earlier timeout", async () => {
  const unavailableObservation = {
    ...contractFixtures.browserObservation,
    targets: [],
  } as const;
  const browser = createBrowserSessionFake({
    observe: (_request, _signal, callIndex) => callIndex === 0
      ? {
          ok: false,
          error: { code: "browser_timeout", retryable: true },
        }
      : { ok: true, value: unavailableObservation },
  });

  const result = await createFieldVerifier(browser.port, { maxAttempts: 2 }).verify(
    {
      sessionId: contractFixtures.browserObservation.sessionId,
      pageId: contractFixtures.browserObservation.pageId,
      intent: contractFixtures.intent,
      receipt: contractFixtures.mutationReceipt,
    },
    new AbortController().signal,
  );

  assert.deepEqual(result, {
    ok: true,
    value: { kind: "unavailable", fieldId: contractFixtures.field.fieldId },
  });
});

for (const code of [
  "browser_target_stale",
  "browser_target_ambiguous",
  "browser_session_missing",
  "browser_effect_uncertain",
] as const) {
  test(`preserves unexpected BrowserSession error ${code} exactly`, async () => {
    const dependencyResult = {
      ok: false,
      error: { code, retryable: false },
    } as const;
    const browser = createBrowserSessionFake({ observe: dependencyResult });

    const result = await createFieldVerifier(browser.port).verify(
      {
        sessionId: contractFixtures.browserObservation.sessionId,
        pageId: contractFixtures.browserObservation.pageId,
        intent: contractFixtures.intent,
        receipt: contractFixtures.mutationReceipt,
      },
      new AbortController().signal,
    );

    assert.equal(result, dependencyResult);
    assert.equal(browser.calls.length, 1);
  });
}

test("never remutates while verifying", async () => {
  const browser = createBrowserSessionFake({
    observe: {
      ok: true,
      value: observation(contractFixtures.intent, {
        kind: "text",
        value: boundedText("Synthetic"),
      }),
    },
  });

  await createFieldVerifier(browser.port).verify(
    {
      sessionId: contractFixtures.browserObservation.sessionId,
      pageId: contractFixtures.browserObservation.pageId,
      intent: contractFixtures.intent,
      receipt: contractFixtures.mutationReceipt,
    },
    new AbortController().signal,
  );

  assert.deepEqual(browser.calls.map(({ operation }) => operation), ["observe"]);
});
