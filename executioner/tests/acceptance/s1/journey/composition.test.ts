import assert from "node:assert/strict";
import { readFile, readdir, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { mcpRequestId } from "../../../../src/contracts/index.ts";
import { createS1ControlledJourney } from "../../../../src/composition/s1-controlled-journey.ts";
import {
  controlledConfig,
  privateSentinels,
  readTerminal,
  resumeText,
  startRequest,
} from "./support.ts";

const fixtureRoot = resolve("fixtures/workday/s1");
const signal = new AbortController().signal;

test("one real MCP request reaches Review through the explicit S1 composition", async () => {
  const root = await mkdtemp(join(tmpdir(), "hunt-f13-t1-"));
  const { config, browser, resumeSha256 } = controlledConfig(root, fixtureRoot);
  const created = await createS1ControlledJourney(config, signal);
  assert.equal(created.ok, true, JSON.stringify(created));
  if (!created.ok) throw new Error("S1 composition did not start");
  const runtime = created.value;

  try {
    assert.deepEqual(Object.keys(runtime).sort(), [
      "api",
      "close",
      "fixture",
      "journeyId",
    ]);
    const accepted = await runtime.api.handle(startRequest(config), signal);
    assert.equal(
      accepted.ok && accepted.value.ok && accepted.value.result.kind,
      "accepted",
      JSON.stringify(accepted),
    );
    if (
      !accepted.ok ||
      !accepted.value.ok ||
      accepted.value.result.kind !== "accepted"
    ) throw new Error("journey was not accepted");
    assert.equal(accepted.value.result.journeyId, runtime.journeyId);

    const terminal = await readTerminal(runtime.api, runtime.journeyId, signal);
    assert.deepEqual(terminal, {
      schemaVersion: 3,
      journeyId: runtime.journeyId,
      status: "review_reached",
      completedPages: 3,
    });

    const status = await runtime.api.handle({
      schemaVersion: 2,
      requestId: mcpRequestId("request-f13-status"),
      method: "journey_status",
      params: { journeyId: runtime.journeyId },
    }, signal);
    assert.equal(
      status.ok && status.value.ok && status.value.result.kind === "status"
        ? status.value.result.progress.status
        : null,
      "review_reached",
      JSON.stringify(status),
    );

    assert.equal(browser.starts.length, 1);
    const startTarget = new URL(browser.starts[0]!);
    assert.equal(startTarget.protocol, "http:");
    assert.equal(startTarget.hostname, "127.0.0.1");
    assert.notEqual(startTarget.port, "");
    assert.equal(startTarget.pathname, "/account");
    assert.deepEqual(browser.navigations, ["next", "next", "next"]);
    assert.deepEqual(
      [...new Set(browser.observations.map(({ path }) => path))],
      ["/account", "/profile", "/questionnaire", "/review"],
    );
    assert.equal(browser.closes.length, 1);
    assert.equal(
      JSON.stringify({
        mutations: browser.mutations,
        navigations: browser.navigations,
      }).includes("Submit"),
      false,
    );

    const uploadReadbacks = browser.observations.flatMap(({ targets }) =>
      targets.flatMap(({ readback }) =>
        readback.kind === "upload" && readback.sha256 !== null
          ? [readback]
          : []
      )
    );
    assert.ok(uploadReadbacks.some(({ sha256 }) => sha256 === resumeSha256));

    const events = (await readFile(
      join(root, "events", "events.jsonl"),
      "utf8",
    )).trim().split("\n").map((line) => JSON.parse(line) as {
      readonly kind: string;
      readonly status?: string;
    });
    assert.equal(
      events.filter(({ kind }) => kind === "journey_terminal").length,
      1,
    );
    const evidenceFiles = await readdir(join(root, "evidence"));
    assert.equal(evidenceFiles.length, 1);
    const evidence = await readFile(
      join(root, "evidence", evidenceFiles[0]!),
      "utf8",
    );
    assert.match(evidence, /"sha256":"[a-f0-9]{64}"/u);
    const durable = `${JSON.stringify(events)}\n${evidence}`;
    for (const sentinel of privateSentinels) {
      assert.equal(durable.includes(sentinel), false, sentinel);
    }
    assert.equal(durable.includes(resumeText), false);

    await runtime.close();
    await runtime.close();
    await assert.rejects(fetch(startTarget, { signal: AbortSignal.timeout(1_000) }));
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});
