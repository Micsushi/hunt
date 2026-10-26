import assert from "node:assert/strict";
import { readFile, readdir, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  mcpRequestId,
  providerError,
  upstreamJobId,
} from "../../../../src/contracts/index.ts";
import {
  createS1ControlledJourney,
  type S1ControlledJourneyConfig,
} from "../../../../src/composition/s1-controlled-journey.ts";
import {
  assertResumeArtifactDisposed,
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
  const { config, browser, fixture, resumeArtifacts, resumeSha256 } =
    controlledConfig(root, fixtureRoot);
  const created = await createS1ControlledJourney(config, signal);
  assert.equal(created.ok, true, JSON.stringify(created));
  if (!created.ok) throw new Error("S1 composition did not start");
  const runtime = created.value;

  try {
    assert.deepEqual(Object.keys(runtime).sort(), [
      "api",
      "close",
      "journeyId",
    ]);
    assert.deepEqual(fixture.lifecycle, ["fixture.start", "fixture.reset"]);
    assert.equal(resumeArtifacts.length, 1);
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
    )
      throw new Error("journey was not accepted");
    assert.equal(accepted.value.result.journeyId, runtime.journeyId);

    const terminal = await readTerminal(runtime.api, runtime.journeyId, signal);
    assert.deepEqual(terminal, {
      schemaVersion: 3,
      journeyId: runtime.journeyId,
      status: "review_reached",
      completedPages: 3,
    });

    const status = await runtime.api.handle(
      {
        schemaVersion: 2,
        requestId: mcpRequestId("request-f13-status"),
        method: "journey_status",
        params: { journeyId: runtime.journeyId },
      },
      signal,
    );
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
          : [],
      ),
    );
    assert.ok(uploadReadbacks.some(({ sha256 }) => sha256 === resumeSha256));

    const events = (
      await readFile(join(root, "events", "events.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            readonly kind: string;
            readonly status?: string;
          },
      );
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
    await assertResumeArtifactDisposed(resumeArtifacts[0]!);
    assert.deepEqual(fixture.lifecycle, [
      "fixture.start",
      "fixture.reset",
      "browser.start",
      "browser.close",
      "fixture.close",
    ]);
    await assert.rejects(
      fetch(startTarget, { signal: AbortSignal.timeout(1_000) }),
    );
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }

  for (const closePath of ["no-start", "rejected-bootstrap"] as const) {
    const closeRoot = await mkdtemp(
      join(tmpdir(), `hunt-f13-t1-${closePath}-`),
    );
    const controlled = controlledConfig(closeRoot, fixtureRoot);
    const closeCreated = await createS1ControlledJourney(
      controlled.config,
      signal,
    );
    assert.equal(closeCreated.ok, true, JSON.stringify(closeCreated));
    if (!closeCreated.ok)
      throw new Error(`${closePath} composition did not start`);
    try {
      assert.equal(controlled.resumeArtifacts.length, 1);
      if (closePath === "rejected-bootstrap") {
        const request = startRequest(controlled.config);
        if (request.method !== "start_journey") {
          throw new Error("expected the controlled start request");
        }
        const rejected = await closeCreated.value.api.handle(
          {
            ...request,
            params: {
              ...request.params,
              jobId: upstreamJobId("job-f13-rejected"),
            },
          },
          signal,
        );
        assert.equal(rejected.ok, true, JSON.stringify(rejected));
        assert.equal(
          rejected.ok && !rejected.value.ok ? rejected.value.error.code : null,
          "journey_request_conflict",
          JSON.stringify(rejected),
        );
        assert.equal(
          rejected.ok && !rejected.value.ok
            ? rejected.value.error.cause?.code
            : null,
          "journey_input_invalid",
          JSON.stringify(rejected),
        );
        assert.deepEqual(controlled.browser.starts, []);
      }
      await closeCreated.value.close();
      await closeCreated.value.close();
      await assertResumeArtifactDisposed(controlled.resumeArtifacts[0]!);
    } finally {
      await closeCreated.value.close();
      await rm(closeRoot, { recursive: true, force: true });
    }
  }

  const resetRoot = await mkdtemp(
    join(tmpdir(), "hunt-f13-t1-reset-rejected-"),
  );
  const controlled = controlledConfig(resetRoot, fixtureRoot);
  const createRealFixture = controlled.config.createFixtureRuntime;
  assert.ok(createRealFixture);
  let origin: string | undefined;
  const hostileBytes = new Proxy(controlled.config.resumeBytes, {
    get() {
      throw new Error("resume bytes were read after fixture reset failed");
    },
  });
  const resetRejectedConfig = {
    ...controlled.config,
    resumeBytes: hostileBytes,
    createFixtureRuntime(root: string) {
      const real = createRealFixture(root);
      return {
        ...real,
        async start(request, activeSignal) {
          const result = await real.start(request, activeSignal);
          if (result.ok) origin = result.value.origin;
          return result;
        },
        async reset() {
          controlled.fixture.lifecycle.push("fixture.reset");
          return {
            ok: false,
            error: providerError("fixture_timeout"),
          } as const;
        },
      };
    },
    onResumeArtifact() {
      throw new Error(
        "resume artifact was captured after fixture reset failed",
      );
    },
    wrapBrowser() {
      throw new Error("browser was created after fixture reset failed");
    },
  } satisfies S1ControlledJourneyConfig;
  try {
    assert.deepEqual(
      await createS1ControlledJourney(resetRejectedConfig, signal),
      {
        ok: false,
        error: providerError("fixture_timeout"),
      },
    );
    assert.deepEqual(controlled.fixture.lifecycle, [
      "fixture.start",
      "fixture.reset",
      "fixture.close",
    ]);
    assert.deepEqual(controlled.resumeArtifacts, []);
    assert.deepEqual(await readdir(resetRoot), []);
    assert.ok(origin);
    await assert.rejects(fetch(origin, { signal: AbortSignal.timeout(1_000) }));
  } finally {
    await rm(resetRoot, { recursive: true, force: true });
  }
});
