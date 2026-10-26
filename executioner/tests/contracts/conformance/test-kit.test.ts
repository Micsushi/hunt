import assert from "node:assert/strict";
import { test } from "node:test";

import {
  browserPageId,
  consumeBrowserMutationAdmission,
  consumeBrowserNavigationAdmission,
  consumeEvidenceAdmission,
  createGeneratedIdAllocator,
  fixturePageId,
  fixtureSemanticHash,
  generatedJourneyId,
  generatedSessionId,
  portNames,
  type PortResult,
  type BrowserSession,
  type EventSink,
  type EvidenceStore,
  type FailureReporter,
  type FixtureRuntime,
  type JourneyControl,
  type JourneyIntake,
  type JourneyStateStore,
  type McpJourneyApi,
  type ProgressReader,
} from "../../../src/contracts/index.ts";
import {
  assertProviderConformance,
  contractFakeFactories,
  contractFixtures,
  contractOperationCases,
  contractPortOperations,
} from "../../../src/testing/contracts/index.ts";

function generatedValue<T>(result: PortResult<T, unknown>): T {
  if (!result.ok) throw new Error("test id allocation failed");
  return result.value;
}

test("the shared kit has one narrow fake for every frozen port", () => {
  assert.deepEqual(Object.keys(contractFakeFactories), portNames);
  assert.deepEqual(Object.keys(contractPortOperations), portNames);

  for (const name of portNames) {
    const harness = contractFakeFactories[name]();
    assert.deepEqual(
      Object.keys(harness.port).sort(),
      [...contractPortOperations[name]].sort(),
      `${name} fake must expose only its declared operations`,
    );
    assert.deepEqual(harness.calls, []);
  }
});

test("every shared fake passes the same provider conformance helper", async () => {
  for (const name of portNames) {
    const harness = contractFakeFactories[name]();
    await assertProviderConformance(name, harness.port);
    assert.deepEqual(
      harness.calls.map(({ operation }) => operation),
      contractPortOperations[name].flatMap((operation) => [
        operation,
        operation,
      ]),
    );
  }
});

test("a provider that violates the result envelope fails conformance", async () => {
  const valid = contractFakeFactories.FixtureRuntime().port;
  const invalid = {
    ...valid,
    start: async () => ({ ok: true }),
  } as unknown as FixtureRuntime;

  await assert.rejects(
    () => assertProviderConformance("FixtureRuntime", invalid),
    /FixtureRuntime\.start.*value/u,
  );

  const extraErrorDetail = {
    ...valid,
    start: async () => ({
      ok: false,
      error: {
        code: "fixture_timeout",
        retryable: true,
        detail: "not part of the frozen error",
      },
    }),
  } as unknown as FixtureRuntime;

  await assert.rejects(
    () => assertProviderConformance("FixtureRuntime", extraErrorDetail),
    /FixtureRuntime\.start.*only code and retryable/u,
  );
});

test("conformance rejects invented successes and error codes", async () => {
  const valid = contractFakeFactories.FixtureRuntime().port;
  const inventedSuccess = {
    ...valid,
    start: async () => ({ ok: true, value: { invented: true } }),
  } as unknown as FixtureRuntime;
  const inventedError = {
    ...valid,
    start: async () => ({
      ok: false,
      error: { code: "invented_error", retryable: false },
    }),
  } as unknown as FixtureRuntime;

  await assert.rejects(
    () => assertProviderConformance("FixtureRuntime", inventedSuccess),
    /FixtureRuntime\.start.*success invariant/u,
  );
  await assert.rejects(
    () => assertProviderConformance("FixtureRuntime", inventedError),
    /FixtureRuntime\.start.*live synthetic case.*invented_error/u,
  );
});

test("cancellation is allowed only for an already-aborted signal", async () => {
  const valid = contractFakeFactories.FixtureRuntime().port;
  const cancelsLiveWork = {
    ...valid,
    start: async () => ({
      ok: false,
      error: { code: "operation_cancelled", retryable: false },
    }),
  } as unknown as FixtureRuntime;
  const ignoresCancellation = {
    ...valid,
    start: async () => ({
      ok: true,
      value: {
        fixtureRunId: "fixture-run-synthetic",
        origin: "https://fixture.invalid",
        pageId: "fixture-account",
      },
    }),
  } as unknown as FixtureRuntime;

  await assert.rejects(
    () => assertProviderConformance("FixtureRuntime", cancelsLiveWork),
    /FixtureRuntime\.start.*live signal.*operation_cancelled/u,
  );
  await assert.rejects(
    () => assertProviderConformance("FixtureRuntime", ignoresCancellation),
    /FixtureRuntime\.start.*aborted signal.*operation_cancelled/u,
  );
});

test("success invariants reject an invented nested stable error code", async () => {
  const valid = contractFakeFactories.FailureReporter().port;
  const invalid = {
    ...valid,
    report: async (
      _request: Parameters<FailureReporter["report"]>[0],
      signal: AbortSignal,
    ) =>
      signal.aborted
        ? {
            ok: false,
            error: {
              code: "operation_cancelled",
              retryable: false,
            },
          }
        : {
            ok: true,
            value: {
              report: {
                reportId: "report-synthetic",
                context: {
                  journeyId: "journey-synthetic",
                  component: "F9",
                  phase: "orchestration",
                  step: "start",
                  code: "invented_nested_error",
                  retryable: false,
                  source: {
                    kind: "operation",
                    id: "operation-synthetic",
                  },
                },
              },
              notification: {
                reportId: "report-synthetic",
                delivered: true,
              },
            },
          },
  } as unknown as FailureReporter;

  await assert.rejects(
    () => assertProviderConformance("FailureReporter", invalid),
    /FailureReporter\.report.*success invariant/u,
  );
});

test("synthetic success cases reject declared live provider errors", async () => {
  const declaredFailure = (signal: AbortSignal) =>
    signal.aborted
      ? {
          ok: false,
          error: {
            code: "operation_cancelled",
            retryable: false,
          },
        }
      : {
          ok: false,
          error: {
            code: "fixture_not_found",
            retryable: false,
          },
        };
  const invalid = {
    start: async (
      _request: Parameters<FixtureRuntime["start"]>[0],
      signal: AbortSignal,
    ) => declaredFailure(signal),
    reset: async (
      _request: Parameters<FixtureRuntime["reset"]>[0],
      signal: AbortSignal,
    ) => declaredFailure(signal),
    setFault: async (
      _request: Parameters<FixtureRuntime["setFault"]>[0],
      signal: AbortSignal,
    ) => declaredFailure(signal),
  } as unknown as FixtureRuntime;

  await assert.rejects(
    () => assertProviderConformance("FixtureRuntime", invalid),
    /FixtureRuntime\.start.*live synthetic case.*fixture_not_found/u,
  );
});

test("conformance accepts runtime-owned F2 origin and hashes", async () => {
  const provider = {
    start: async (request, signal) =>
      result(signal, {
        fixtureRunId: request.fixtureRunId,
        origin: "http://127.0.0.1:43123",
        pageId: fixturePageId("runtime-account"),
      }),
    reset: async (request, signal) =>
      result(signal, {
        fixtureRunId: request.fixtureRunId,
        semanticHash: fixtureSemanticHash("sha256.runtime-reset"),
      }),
    setFault: async (_request, signal) => result(signal, undefined),
  } satisfies FixtureRuntime;

  await assert.doesNotReject(() =>
    assertProviderConformance("FixtureRuntime", provider),
  );
});

test("conformance chains runtime-owned F3 session and page IDs", async () => {
  const ids = createGeneratedIdAllocator({
    next: () => "abcdef0123456789",
  });
  const sessionId = generatedValue(generatedSessionId(ids));
  const pageId = browserPageId("runtime-page-11");
  const provider = {
    start: async (_request, signal) =>
      result(signal, { sessionId, pageId }),
    observe: async (request, signal) =>
      result(signal, {
        ...contractFixtures.browserObservation,
        sessionId: request.sessionId,
        pageId: request.pageId,
      }),
    mutate: async (request, signal) => {
      if (signal.aborted) return { ok: false, error: { code: "operation_cancelled", retryable: false } } as const;
      const consumed = consumeBrowserMutationAdmission(request);
      if (!consumed.ok) return consumed;
      return result(signal, {
        operationId: consumed.value.effect.operationId,
        pageId: consumed.value.effect.pageId,
        attempted: true,
      });
    },
    navigate: async (request, signal) => {
      if (signal.aborted) return { ok: false, error: { code: "operation_cancelled", retryable: false } } as const;
      const consumed = consumeBrowserNavigationAdmission(request);
      if (!consumed.ok) return consumed;
      return result(signal, {
        operationId: consumed.value.effect.operationId,
        fromPageId: consumed.value.effect.pageId,
        pageId: browserPageId("runtime-page-12"),
      });
    },
    close: async (_request, signal) => result(signal, undefined),
  } satisfies BrowserSession;

  await assert.doesNotReject(() =>
    assertProviderConformance("BrowserSession", provider),
  );
});

test("the F3 start target describes the frozen observation page", () => {
  const start = contractOperationCases.BrowserSession.start.request;
  assert.equal(typeof start, "object");
  if (typeof start === "function") {
    return;
  }
  assert.equal(
    new URL(start.target).pathname,
    contractFixtures.browserObservation.path,
  );
});

test("conformance accepts a generated F4 bootstrap journey", async () => {
  const journeyId = generatedValue(generatedJourneyId(
    createGeneratedIdAllocator({ next: () => "abcdef0123456789" }),
  ));
  const provider = {
    bootstrap: async (request, signal) =>
      result(signal, {
        journeyId,
        inputs: contractFixtures.journeyInputs,
        state: {
          schemaVersion: 3,
          journeyId,
          status: "ready",
          pageId: null,
          revision: 0,
        },
      }),
  } satisfies JourneyIntake;

  await assert.doesNotReject(() =>
    assertProviderConformance("JourneyIntake", provider),
  );
});

test("conformance chains loaded F4 state into its transition", async () => {
  const provider = {
    load: async (request, signal) =>
      result(signal, {
        state: {
          schemaVersion: 3,
          journeyId: request.journeyId,
          status: "running",
          pageId: browserPageId("runtime-page-3"),
          revision: 3,
        },
      }),
    transition: async (request, signal) =>
      result(signal, {
        state: {
          schemaVersion: 3,
          journeyId: request.journeyId,
          status: request.status,
          pageId: request.pageId,
          revision: request.expectedRevision + 1,
        },
        applied: true,
      }),
  } satisfies JourneyStateStore;

  await assert.doesNotReject(() =>
    assertProviderConformance("JourneyStateStore", provider),
  );
});

test("conformance chains a generated JourneyControl identity", async () => {
  const journeyId = generatedValue(generatedJourneyId(
    createGeneratedIdAllocator({ next: () => "fedcba9876543210" }),
  ));
  let status: "running" | "cancelled" = "running";
  const provider = {
    start: async (request, signal) =>
      result(signal, {
        operationId: request.operationId,
        journeyId,
        accepted: true,
      }),
    status: async (request, signal) => {
      assert.equal(request.journeyId, journeyId);
      return result(signal, status);
    },
    cancel: async (request, signal) => {
      assert.equal(request.journeyId, journeyId);
      if (!signal.aborted) {
        status = "cancelled";
      }
      return result(signal, {
        operationId: request.operationId,
        journeyId: request.journeyId,
        accepted: true,
      });
    },
    result: async (request, signal) => {
      assert.equal(request.journeyId, journeyId);
      return result(signal, {
        schemaVersion: 3,
        journeyId: request.journeyId,
        status: "cancelled",
        completedPages: 2,
      });
    },
  } satisfies JourneyControl;

  await assert.doesNotReject(() =>
    assertProviderConformance("JourneyControl", provider),
  );
});

test("conformance accepts runtime-owned terminal progress", async () => {
  const provider = {
    handle: async (request, signal) => {
      if (request.method !== "journey_result") {
        throw new TypeError("journey_result request is required");
      }
      return result(signal, {
        schemaVersion: 3 as const,
        requestId: request.requestId,
        ok: true as const,
        result: {
          kind: "terminal" as const,
          terminal: {
            schemaVersion: 3 as const,
            journeyId: request.params.journeyId,
            status: "review_reached" as const,
            completedPages: 7,
          },
        },
      });
    },
  } satisfies McpJourneyApi;

  await assert.doesNotReject(() =>
    assertProviderConformance("McpJourneyApi", provider),
  );
});

test("conformance rejects an invented terminal error code", async () => {
  const provider = {
    handle: async (
      request: Parameters<McpJourneyApi["handle"]>[0],
      signal: AbortSignal,
    ) =>
      result(signal, {
        schemaVersion: 3,
        requestId: request.requestId,
        ok: true,
        result: {
          kind: "terminal",
          terminal: {
            schemaVersion: 3,
            journeyId: contractFixtures.journeyState.journeyId,
            status: "failed",
            completedPages: 1,
            errorCode: "invented_error",
          },
        },
      }),
  } as unknown as McpJourneyApi;

  await assert.rejects(
    () => assertProviderConformance("McpJourneyApi", provider),
    /McpJourneyApi\.handle.*success invariant/u,
  );
});

test("conformance accepts runtime-owned observability progress", async () => {
  const eventSink = {
    append: async (request, signal) =>
      result(signal, {
        appended: true,
        progress: {
          journeyId: request.event.journeyId,
          status: "running" as const,
          completedSteps: 7,
        },
      }),
  } satisfies EventSink;
  const progressReader = {
    read: async (request, signal) =>
      result(signal, {
        journeyId: request.journeyId,
        status: "cancelled" as const,
        completedSteps: 7,
      }),
  } satisfies ProgressReader;
  const failureReporter = {
    report: async (request, signal) =>
      result(signal, {
        report: request,
        notification: {
          reportId: request.reportId,
          delivered: false,
        },
      }),
  } satisfies FailureReporter;

  await assert.doesNotReject(() =>
    assertProviderConformance("EventSink", eventSink),
  );
  await assert.doesNotReject(() =>
    assertProviderConformance("ProgressReader", progressReader),
  );
  await assert.doesNotReject(() =>
    assertProviderConformance("FailureReporter", failureReporter),
  );
});

test("conformance accepts runtime-owned evidence results", async () => {
  const evidenceStore = {
    write: async (request, signal) => {
      if (signal.aborted) return { ok: false, error: { code: "operation_cancelled", retryable: false } } as const;
      const consumed = consumeEvidenceAdmission(request);
      if (!consumed.ok) return consumed;
      return result(signal, {
        recordId: consumed.value.record.id,
        written: true,
      });
    },
    read: async (request, signal) =>
      result(signal, {
        schemaVersion: 2 as const,
        journeyId: request.journeyId,
        records: [],
      }),
  } satisfies EvidenceStore;
  await assert.doesNotReject(() =>
    assertProviderConformance("EvidenceStore", evidenceStore),
  );
});

test("conformance rejects invented evidence kinds and coordinates", async () => {
  const provider = {
    write: async (
      request: Parameters<EvidenceStore["write"]>[0],
      signal: AbortSignal,
    ) =>
      result(signal, {
        recordId: request.snapshot.record.id,
        written: true,
      }),
    read: async (
      request: Parameters<EvidenceStore["read"]>[0],
      signal: AbortSignal,
    ) =>
      result(signal, {
        schemaVersion: 2,
        journeyId: request.journeyId,
        records: [
          {
            ...contractFixtures.evidenceRecord,
            kind: "invented_evidence",
            component: "F99",
            phase: "invented_phase",
            step: "invented_step",
          },
        ],
      }),
  } as unknown as EvidenceStore;

  await assert.rejects(
    () => assertProviderConformance("EvidenceStore", provider),
    /EvidenceStore\.read.*success invariant/u,
  );
});

function result<T>(
  signal: AbortSignal,
  value: T,
):
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: "operation_cancelled";
        readonly retryable: false;
      };
    } {
  return signal.aborted
    ? {
        ok: false,
        error: { code: "operation_cancelled", retryable: false },
      }
    : { ok: true, value };
}
