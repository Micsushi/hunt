import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  providerError,
  type BrowserSession,
  type FailureReport,
} from "../../../../src/contracts/index.ts";
import {
  createS1ControlledJourney,
  type S1ControlledJourneyConfig,
} from "../../../../src/composition/s1-controlled-journey.ts";
import {
  controlledConfig,
  readTerminal,
  startRequest,
} from "../journey/support.ts";

const fixtureRoot = resolve("fixtures/workday/s1");
const signal = new AbortController().signal;

test("an invalid observation exposes its exact F3 failure report", async () => {
  const root = await mkdtemp(join(tmpdir(), "hunt-f13-t2-f3-observe-"));
  const { config } = controlledConfig(root, fixtureRoot);
  const reports: FailureReport[] = [];
  let observeCalls = 0;
  const traceBrowser = config.wrapBrowser;
  const faultConfig = {
    ...config,
    notifyFailure: async (report: FailureReport) => {
      reports.push(report);
    },
    wrapBrowser(real: BrowserSession): BrowserSession {
      const traced = traceBrowser?.(real) ?? real;
      return {
        start: traced.start.bind(traced),
        async observe(_request, activeSignal) {
          observeCalls += 1;
          return {
            ok: false,
            error: providerError(
              activeSignal.aborted
                ? "operation_cancelled"
                : "browser_target_invalid",
            ),
          };
        },
        mutate: traced.mutate.bind(traced),
        navigate: traced.navigate.bind(traced),
        close: traced.close.bind(traced),
      };
    },
  } satisfies S1ControlledJourneyConfig;
  const created = await createS1ControlledJourney(faultConfig, signal);
  assert.equal(created.ok, true, JSON.stringify(created));
  if (!created.ok) throw new Error("S1 composition did not start");
  const runtime = created.value;

  try {
    const accepted = await runtime.api.handle(startRequest(faultConfig), signal);
    assert.equal(
      accepted.ok && accepted.value.ok && accepted.value.result.kind,
      "accepted",
      JSON.stringify(accepted),
    );

    assert.deepEqual(
      await readTerminal(runtime.api, runtime.journeyId, signal),
      {
        schemaVersion: 3,
        journeyId: runtime.journeyId,
        status: "failed",
        completedPages: 0,
        errorCode: "browser_target_invalid",
      },
    );
    assert.equal(observeCalls, 1);
    assert.equal(reports.length, 1, "F10 must expose the factual report");
    const report = reports[0]!;
    assert.deepEqual(report.context, {
      journeyId: runtime.journeyId,
      component: "F3",
      phase: "browser",
      step: "observe",
      code: "browser_target_invalid",
      retryable: false,
      source: report.context.source,
    });
    assert.equal(report.context.source.kind, "operation");
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});
