import assert from "node:assert/strict";
import { test } from "node:test";

import {
  contractProviderFactories,
  createBrowserSessionFake,
  createContractProviderFactory,
  contractFixtures,
  statefulScenarioProviderFactories,
  runAdmissionOneUseScenario,
  runBrowserInvalidationScenario,
  runEventEvidenceScenario,
  runJourneyStateScenario,
  runJourneyControlScenario,
  runMcpLifecycleScenario,
  runSafetyGuardScenario,
  executeContractScenarioRegistry,
} from "../../../src/testing/contracts/index.ts";

test("browser cancellation and uncertain mutation invalidate the owned session", async () => {
  assert.deepEqual(await runBrowserInvalidationScenario(statefulScenarioProviderFactories.BrowserSession), {
    name: "browser-invalidation",
    ports: ["BrowserSession"],
    edges: [
      "mutation-uncertain",
      "session-invalidated",
      "post-invalidation-mutation-rejected",
      "cancellation-invalidated-session",
      "post-cancel-mutation-rejected",
    ],
  });
});

test("journey state replay, concurrency, and terminal state are deterministic", async () => {
  assert.deepEqual(await runJourneyStateScenario(statefulScenarioProviderFactories.JourneyStateStore), {
    name: "journey-state-replay",
    ports: ["JourneyStateStore"],
    edges: [
      "transition-applied-once",
      "duplicate-replayed",
      "concurrent-revision-rejected",
      "terminal-transition-rejected",
    ],
  });
});

test("MCP duplicate, conflict, busy, cancel, and terminal rules are stateful", async () => {
  assert.deepEqual(await runMcpLifecycleScenario(statefulScenarioProviderFactories.McpJourneyApi), {
    name: "mcp-lifecycle",
    ports: ["McpJourneyApi"],
    edges: [
      "duplicate-replayed",
      "changed-request-conflict",
      "distinct-request-busy-recorded",
      "cancel-recorded",
      "terminal-replayed",
    ],
  });
});

test("event and evidence duplicates and concurrency do not repeat side effects", async () => {
  assert.deepEqual(await runEventEvidenceScenario(
    statefulScenarioProviderFactories.EventSink,
    statefulScenarioProviderFactories.EvidenceStore,
  ), {
    name: "event-evidence-idempotency",
    ports: ["EventSink", "EvidenceStore"],
    edges: [
      "event-appended-once",
      "event-duplicate-replayed",
      "evidence-written-once",
      "evidence-concurrent-duplicate-rejected",
    ],
  });
});

test("admission capabilities are immutable and consumable once", async () => {
  assert.deepEqual(await runAdmissionOneUseScenario(statefulScenarioProviderFactories.PrivacyGuard), {
    name: "admission-one-use",
    ports: ["PrivacyGuard"],
    edges: [
      "snapshot-copied-and-frozen",
      "capability-consumed-once",
      "substitute-snapshot-rejected",
    ],
  });
});

test("JourneyControl lifecycle invokes start, cancel, status, and result with stable replay", async () => {
  assert.deepEqual(
    await runJourneyControlScenario(statefulScenarioProviderFactories.JourneyControl),
    {
      name: "journey-control-lifecycle",
      ports: ["JourneyControl"],
      edges: ["start-replayed", "cancel-replayed", "cancelled-status", "cancelled-terminal"],
    },
  );
  await assert.rejects(
    () => runJourneyControlScenario(contractProviderFactories.JourneyControl),
    /post-cancel status must be cancelled/u,
  );
});

test("SafetyGuard scenario invokes exact fresh admissions and consumes each capability once", async () => {
  assert.deepEqual(
    await runSafetyGuardScenario(statefulScenarioProviderFactories.SafetyGuard),
    {
      name: "safety-admission-one-use",
      ports: ["SafetyGuard"],
      edges: ["exact-request-admitted", "capability-consumed-once", "fresh-request-fresh-capability"],
    },
  );
  await assert.rejects(
    () => runSafetyGuardScenario(contractProviderFactories.SafetyGuard),
    /fresh safety admission must produce a fresh capability|safety admission request mismatch/u,
  );
});

test("a browser provider that keeps accepting effects after uncertainty fails its scenario", async () => {
  const broken = createContractProviderFactory("BrowserSession", () =>
    createBrowserSessionFake({
      mutate: {
        ok: true,
        value: {
          operationId: "operation_0123456789abcdef" as never,
          pageId: "page-profile" as never,
          attempted: true,
        },
      },
    }),
  );
  await assert.rejects(
    () => runBrowserInvalidationScenario(broken),
    /uncertain mutation/u,
  );
});

test("each stateful scenario rejects the corresponding stateless or malformed provider", async () => {
  await assert.rejects(
    () => runJourneyStateScenario(contractProviderFactories.JourneyStateStore),
    /concurrent journey transition/u,
  );
  await assert.rejects(
    () => runMcpLifecycleScenario(contractProviderFactories.McpJourneyApi),
    /identical MCP request|changed MCP request/u,
  );
  await assert.rejects(
    () => runEventEvidenceScenario(
      contractProviderFactories.EventSink,
      contractProviderFactories.EvidenceStore,
    ),
    /event duplicate|evidence duplicate/u,
  );
  await assert.rejects(
    () => runAdmissionOneUseScenario(contractProviderFactories.PrivacyGuard),
    /fresh admission|substitute snapshot/u,
  );
});

test("MCP scenario rejects a provider that reports a fixed non-cancelled terminal after cancel", async () => {
  const broken = createContractProviderFactory("McpJourneyApi", () => {
    const base = statefulScenarioProviderFactories.McpJourneyApi.create();
    return {
      port: {
        handle: async (request, signal) => {
          const result = await base.provider.handle(request, signal);
          if (!result.ok || !result.value.ok) return result;
          if (request.method === "journey_status") {
            return {
              ok: true,
              value: {
                schemaVersion: 2,
                requestId: request.requestId,
                ok: true,
                result: { kind: "status", progress: contractFixtures.progress },
              },
            } as const;
          }
          if (request.method === "journey_result") {
            return {
              ok: true,
              value: {
                schemaVersion: 2,
                requestId: request.requestId,
                ok: true,
                result: { kind: "terminal", terminal: contractFixtures.terminalResult },
              },
            } as const;
          }
          return result;
        },
      },
      calls: base.calls,
    };
  });

  await assert.rejects(
    () => runMcpLifecycleScenario(broken),
    /post-cancel status must be cancelled|post-cancel terminal must be cancelled/u,
  );
});

test("the public scenario registry executes every entry and reports only invoked ports", async () => {
  const results = await executeContractScenarioRegistry();
  assert.ok(results.length > 0);
  for (const scenario of results) {
    assert.ok(scenario.edges.length > 0, `${scenario.name} must have edges`);
    assert.ok(scenario.ports.length > 0, `${scenario.name} must report invoked ports`);
  }
});
