import assert from "node:assert/strict";
import { test } from "node:test";

import {
  portNames,
  type BrowserSession,
  type FailureReporter,
  type FixtureRuntime,
} from "../../../src/contracts/index.ts";
import {
  assertProviderConformance,
  contractFakeFactories,
  contractFixtures,
  contractPortOperations,
} from "../../../src/testing/contracts/index.ts";

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

test("exact success fixtures reject an invented nested stable error code", async () => {
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
    /FailureReporter\.report.*expected success fixture/u,
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
    transition: async (
      _request: Parameters<FixtureRuntime["transition"]>[0],
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
        pageId: "runtime-account",
      }),
    transition: async (request, signal) =>
      result(signal, {
        transitionId: request.transitionId,
        pageId: request.toPageId,
        semanticHash: `sha256:${request.toPageId}`,
      }),
    reset: async (request, signal) =>
      result(signal, {
        fixtureRunId: request.fixtureRunId,
        semanticHash: "sha256:runtime-reset",
      }),
    setFault: async (_request, signal) => result(signal, undefined),
  } satisfies FixtureRuntime;

  await assert.doesNotReject(() =>
    assertProviderConformance("FixtureRuntime", provider),
  );
});

test("conformance chains runtime-owned F3 session and page IDs", async () => {
  const sessionId = "runtime-session-7";
  const pageId = "runtime-page-11";
  const provider = {
    start: async (_request, signal) =>
      result(signal, { sessionId, pageId }),
    observe: async (request, signal) =>
      result(signal, {
        ...contractFixtures.browserObservation,
        sessionId: request.sessionId,
        pageId: request.pageId,
      }),
    mutate: async (request, signal) =>
      result(signal, {
        operationId: request.operationId,
        pageId: request.pageId,
        attempted: true,
      }),
    navigate: async (request, signal) =>
      result(signal, {
        operationId: request.operationId,
        fromPageId: request.pageId,
        pageId: "runtime-page-12",
      }),
    close: async (_request, signal) => result(signal, undefined),
  } satisfies BrowserSession;

  await assert.doesNotReject(() =>
    assertProviderConformance("BrowserSession", provider),
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
