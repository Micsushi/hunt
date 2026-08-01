import assert from "node:assert/strict";
import test from "node:test";

import { mcpRequestId, upstreamProfileId } from "../../../src/contracts/index.ts";
import {
  createControlFixture,
  request,
  terminalResult,
} from "./support.ts";

const signal = new AbortController().signal;

test("real MCP lifecycle preserves replay, conflict, busy, retry, and terminal race semantics", async () => {
  const fixture = await createControlFixture("lifecycle", {
    retryFirstStart: true,
  });
  const start = fixture.startRequest("request-lifecycle-start");
  assert.equal(start.method, "start_journey");
  if (start.method !== "start_journey") throw new Error("expected start request");

  try {
    const pending = fixture.api.handle(start, signal);
    const pendingReplay = fixture.api.handle(start, signal);
    const conflict = fixture.api.handle({
      ...start,
      params: {
        ...start.params,
        profileId: upstreamProfileId("profile-f12-conflict"),
      },
    }, signal);
    const busyRequest = {
      ...start,
      requestId: mcpRequestId("request-lifecycle-busy"),
    };
    const busy = fixture.api.handle(busyRequest, signal);

    const [accepted, replayed, conflicted, rejectedBusy] = await Promise.all([
      pending,
      pendingReplay,
      conflict,
      busy,
    ]);
    assert.deepEqual(replayed, accepted);
    assert.equal(accepted.ok && accepted.value.ok, true, JSON.stringify(accepted));
    assert.equal(
      accepted.ok && accepted.value.ok && accepted.value.result.kind,
      "accepted",
    );
    assert.equal(
      conflicted.ok && !conflicted.value.ok && conflicted.value.error.code,
      "journey_request_conflict",
    );
    assert.equal(
      rejectedBusy.ok && !rejectedBusy.value.ok && rejectedBusy.value.error.code,
      "journey_busy",
    );
    assert.deepEqual(await fixture.api.handle(busyRequest, signal), rejectedBusy);

    const terminal = await terminalResult(fixture);
    assert.equal(terminal.status, "review_reached", JSON.stringify({
      terminal,
      browserCalls: fixture.browserCalls,
      driverCalls: fixture.driverCalls.count,
    }));
    assert.equal(fixture.browserCalls.startAttempts, 2);
    assert.equal(fixture.browserCalls.starts.length, 1);
    assert.ok(fixture.driverCalls.count > 0);
    assert.ok(fixture.browserCalls.navigations.length > 0);

    const statusRequest = request(
      "request-lifecycle-status",
      "journey_status",
      fixture.journeyId,
    );
    const status = await fixture.api.handle(statusRequest, signal);
    assert.equal(
      status.ok && status.value.ok && status.value.result.kind === "status"
        ? status.value.result.progress.status
        : null,
      "review_reached",
    );
    assert.deepEqual(await fixture.api.handle(statusRequest, signal), status);

    const resultRequest = request(
      "request-lifecycle-result",
      "journey_result",
      fixture.journeyId,
    );
    const result = await fixture.api.handle(resultRequest, signal);
    assert.equal(
      result.ok && result.value.ok && result.value.result.kind === "terminal"
        ? result.value.result.terminal.status
        : null,
      "review_reached",
    );
    assert.deepEqual(await fixture.api.handle(resultRequest, signal), result);

    const cancelled = await fixture.api.handle(request(
      "request-lifecycle-cancel-after-terminal",
      "cancel_journey",
      fixture.journeyId,
    ), signal);
    assert.equal(
      cancelled.ok && !cancelled.value.ok && cancelled.value.error.code,
      "journey_already_terminal",
    );
  } finally {
    await fixture.close();
  }
});
