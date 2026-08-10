import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deflateSync } from "node:zlib";

import {
  createStage2ExternalMonitorRuntime,
  currentProcessStartedAt,
  processStartedAt,
  readStage2ExternalMonitorObservation,
  readStage2AuthMonitorChain,
  readStage2ReviewMonitorChain,
  writeStage2ExternalMonitorAcknowledgement,
} from "../../../src/live/evidence/external-monitor-runtime.ts";

const binding = {
  journeyId: "journey_monitor_runtime_01",
  targetHandleId: "target_ref_monitor_runtime_01",
  sourceRevision: "0123456789abcdef0123456789abcdef01234567",
  configSha256: "a".repeat(64),
  host: "bank.wd5.myworkdayjobs.com",
  tenant: "bank",
  posting: "26016513",
  processLiveNonceSha256: digest(Buffer.from("live-monitor-process-nonce")),
  processIssuedAt: "2026-08-10T11:59:59.000Z",
  processOwnerPid: process.pid,
  processOwnerStartedAt: currentProcessStartedAt(),
} as const;

const authMoments = [
  ["account_entry", "before_mutation"],
  ["application_ready", "after_readback"],
  ["application_ready", "state_observed"],
] as const;

test("external monitor blocks each auth effect until the exact independent ACK", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-external-monitor-"));
  let release: (() => void) | undefined;
  const page = fixturePage();
  try {
    const runtime = createStage2ExternalMonitorRuntime({
      ...binding,
      evidenceRoot: root,
      runtimeRoot: root,
      now: ordinalClock(),
      waitForAcknowledgement: async (request) => {
        await new Promise<void>((resolve) => { release = resolve; });
        writeStage2ExternalMonitorAcknowledgement({
          runtimeRoot: root,
          evidenceRoot: root,
          requestPath: request.path,
          classification: request.ordinal === 3 ? "account_verified" : "safe_to_continue",
          observedIdentityDigests: identityDigests(),
          structuralDescriptionIds: [structuralIdFor(request.page)],
          observedAt: `2026-08-10T12:00:00.00${request.ordinal * 2}Z`,
        });
      },
    });

    for (const [index, [pageName, moment]] of authMoments.entries()) {
      let effectStarted = false;
      const operationId = index < 2
        ? "operation_account_mutation_01"
        : "operation_account_state_0001";
      const gated = runtime.auth(
        page,
        pageName,
        moment,
        taxonomy(),
        { operationId, attempt: 1 },
        new AbortController().signal,
      )
        .then(() => { effectStarted = true; });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(effectStarted, false);
      release?.();
      await gated;
      assert.equal(effectStarted, true);
    }
    runtime.close();

    const read = readStage2AuthMonitorChain(join(root, "auth-monitor"), {
      journeyId: binding.journeyId,
      targetHandleId: binding.targetHandleId,
      sourceRevision: binding.sourceRevision,
      configSha256: binding.configSha256,
      hostSha256: digest(Buffer.from(binding.host)),
      tenantSha256: digest(Buffer.from(binding.tenant)),
      postingSha256: digest(Buffer.from(binding.posting)),
      processLiveNonceSha256: binding.processLiveNonceSha256,
      processIssuedAt: binding.processIssuedAt,
      processCheckedAt: "2026-08-10T12:00:01.000Z",
      processExitObservedAt: "2026-08-10T12:00:00.999Z",
      processInstanceSha256: processInstanceSha256(),
    });
    assert.equal(read.classification, "account_verified");
    assert.equal(read.files.length, 12);
    assert.equal(page.screenshotCalls, 3);
    assert.equal(page.titleCalls, 3);
    assert.equal(page.urlCalls, 6);
    assert.doesNotMatch(readFileSync(join(root, "auth-monitor", "0001-account_entry-before_mutation.request.json"), "utf8"), /Business Manager|bank\.wd|26016513/u);
  } finally {
    if (process.env.HUNT_KEEP_MONITOR_FIXTURE !== "1") {
      rmSync(root, { recursive: true, force: true });
    } else process.stderr.write(`${root}\n`);
  }
});

test("external monitor derives exact identity from the observed page URL", async () => {
  for (const url of [
    "https://other.wd5.myworkdayjobs.com/en-US/Careers/job/Business-Manager_26016513",
    "https://bank.wd5.myworkdayjobs.com/en-US/Careers/job/Business-Manager_99999999",
  ]) {
    const root = mkdtempSync(join(tmpdir(), "hunt-s2-external-monitor-identity-"));
    try {
      const runtime = createStage2ExternalMonitorRuntime({
        ...binding,
        evidenceRoot: root,
        runtimeRoot: root,
        now: ordinalClock(),
        waitForAcknowledgement: async () => assert.fail("identity mismatch reached ACK"),
      });
      await assert.rejects(
        () => runtime.auth(fixturePage(url), "account_entry", "before_mutation", taxonomy(), {
          operationId: "operation_observed_identity_01",
          attempt: 1,
        }, new AbortController().signal),
        /external monitor runtime denied/u,
      );
      assert.deepEqual(readdirSync(join(root, "auth-monitor")), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  const root = mkdtempSync(join(tmpdir(), "hunt-s2-external-monitor-url-drift-"));
  let reads = 0;
  try {
    const runtime = createStage2ExternalMonitorRuntime({
      ...binding,
      evidenceRoot: root,
      runtimeRoot: root,
      now: ordinalClock(),
      waitForAcknowledgement: async () => assert.fail("URL drift reached ACK"),
    });
    const page = fixturePage();
    page.url = async () => ++reads === 1
      ? `https://${binding.host}/en-US/Careers/job/Business-Manager_${binding.posting}`
      : `https://${binding.host}/en-US/Careers/job/Business-Manager_${binding.posting}/apply/applyManually`;
    await assert.rejects(
      () => runtime.auth(page, "account_entry", "before_mutation", taxonomy(), {
        operationId: "operation_observed_url_drift_1",
        attempt: 1,
      }, new AbortController().signal),
      /external monitor runtime denied/u,
    );
    assert.deepEqual(readdirSync(join(root, "auth-monitor")), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("external monitor accepts only the reviewed structure for the observed page", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-external-monitor-structure-"));
  try {
    const runtime = createStage2ExternalMonitorRuntime({
      ...binding,
      evidenceRoot: root,
      runtimeRoot: root,
      now: ordinalClock(),
      waitForAcknowledgement: async (request) => writeStage2ExternalMonitorAcknowledgement({
        runtimeRoot: root,
        evidenceRoot: root,
        requestPath: request.path,
        classification: "safe_to_continue",
        observedIdentityDigests: identityDigests(),
        structuralDescriptionIds: ["monitor_structure_profile_v1"],
        observedAt: "2026-08-10T12:00:00.002Z",
      }),
    });
    await assert.rejects(
      () => runtime.auth(fixturePage(), "account_entry", "before_mutation", taxonomy(), {
        operationId: "operation_wrong_structure_001",
        attempt: 1,
      }, new AbortController().signal),
      /external monitor acknowledgement denied/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("external monitor never acknowledges an unsafe auth page", async () => {
  for (const pageName of ["captcha", "mfa", "access_control", "unknown"] as const) {
    const root = mkdtempSync(join(tmpdir(), "hunt-s2-external-monitor-unsafe-"));
    try {
      const runtime = createStage2ExternalMonitorRuntime({
        ...binding,
        evidenceRoot: root,
        runtimeRoot: root,
        now: ordinalClock(),
        waitForAcknowledgement: async (request) => writeStage2ExternalMonitorAcknowledgement({
          runtimeRoot: root,
          evidenceRoot: root,
          requestPath: request.path,
          classification: "safe_to_continue",
          observedIdentityDigests: identityDigests(),
          structuralDescriptionIds: ["monitor_structure_account_entry_v1"],
          observedAt: "2026-08-10T12:00:00.002Z",
        }),
      });
      await assert.rejects(
        () => runtime.auth(fixturePage(), pageName, "state_observed", taxonomy(), {
          operationId: `operation_unsafe_${pageName}_01`,
          attempt: 1,
        }, new AbortController().signal),
        /external monitor (?:runtime|acknowledgement) denied/u,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("external monitor rechecks exact liveness after a pending independent ACK", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-external-monitor-close-"));
  let entered: (() => void) | undefined;
  let release: (() => void) | undefined;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  try {
    const runtime = createStage2ExternalMonitorRuntime({
      ...binding,
      evidenceRoot: root,
      runtimeRoot: root,
      now: ordinalClock(),
      waitForAcknowledgement: async () => {
        entered?.();
        await new Promise<void>((resolve) => { release = resolve; });
      },
    });
    const capture = runtime.auth(
      fixturePage(),
      "account_entry",
      "before_mutation",
      taxonomy(),
      { operationId: "operation_close_during_wait_01", attempt: 1 },
      new AbortController().signal,
    );
    await waiting;
    runtime.close();
    release?.();
    await assert.rejects(capture, /external monitor runtime denied/u);
    await assert.rejects(
      () => runtime.auth(fixturePage(), "account_entry", "before_mutation", taxonomy(), {
        operationId: "operation_close_during_wait_02", attempt: 1,
      }, new AbortController().signal),
      /external monitor runtime denied/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("external monitor denies crossed live roots, illegal page graphs, and malformed PNGs", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-external-monitor-graph-"));
  const crossed = mkdtempSync(join(tmpdir(), "hunt-s2-external-monitor-crossed-"));
  try {
    const other = createStage2ExternalMonitorRuntime({
      ...binding,
      journeyId: "journey_monitor_crossed_01",
      evidenceRoot: crossed,
      runtimeRoot: crossed,
    });
    const runtime = createStage2ExternalMonitorRuntime({
      ...binding,
      evidenceRoot: root,
      runtimeRoot: root,
      now: ordinalClock(),
      waitForAcknowledgement: async (request) => {
        writeStage2ExternalMonitorAcknowledgement({
          runtimeRoot: crossed,
          evidenceRoot: root,
          requestPath: request.path,
          classification: "safe_to_continue",
          observedIdentityDigests: identityDigests(),
          structuralDescriptionIds: [structuralIdFor(request.page)],
          observedAt: "2026-08-10T12:00:00.002Z",
        });
      },
    });
    await assert.rejects(
      () => runtime.auth(fixturePage(), "account_entry", "before_navigation", taxonomy(), {
        operationId: "operation_crossed_live_root_01", attempt: 1,
      }, new AbortController().signal),
      /external monitor acknowledgement denied/u,
    );
    other.close();

    const graphRoot = mkdtempSync(join(tmpdir(), "hunt-s2-external-monitor-illegal-"));
    try {
      const graph = createStage2ExternalMonitorRuntime({
        ...binding,
        evidenceRoot: graphRoot,
        runtimeRoot: graphRoot,
        now: ordinalClock(),
        waitForAcknowledgement: async (request) => writeStage2ExternalMonitorAcknowledgement({
          runtimeRoot: graphRoot,
          evidenceRoot: graphRoot,
          requestPath: request.path,
          classification: "safe_to_continue",
          observedIdentityDigests: identityDigests(),
          structuralDescriptionIds: [structuralIdFor(request.page)],
          observedAt: "2026-08-10T12:00:00.002Z",
        }),
      });
      await graph.auth(fixturePage(), "account_entry", "before_navigation", taxonomy(), {
        operationId: "operation_illegal_auth_graph_01", attempt: 1,
      }, new AbortController().signal);
      await assert.rejects(
        () => graph.auth(fixturePage(), "job_posting", "transition", taxonomy(), {
          operationId: "operation_illegal_auth_graph_01", attempt: 1,
        }, new AbortController().signal),
        /external monitor runtime denied/u,
      );
    } finally {
      rmSync(graphRoot, { recursive: true, force: true });
    }

    const malformedRoot = mkdtempSync(join(tmpdir(), "hunt-s2-external-monitor-png-"));
    try {
      const malformed = createStage2ExternalMonitorRuntime({
        ...binding,
        evidenceRoot: malformedRoot,
        runtimeRoot: malformedRoot,
        waitForAcknowledgement: async () => undefined,
      });
      await assert.rejects(
        () => malformed.auth({
          async url() { return `https://${binding.host}/en-US/Careers/job/Business-Manager_${binding.posting}`; },
          async screenshot() { return Buffer.concat([Buffer.from("\u0089PNG\r\n\u001a\n", "latin1"), Buffer.alloc(128)]); },
          async title() { return "Business Manager"; },
        }, "account_entry", "before_mutation", taxonomy(), {
          operationId: "operation_malformed_png_0001", attempt: 1,
        }, new AbortController().signal),
        /review monitor chain denied/u,
      );
    } finally {
      rmSync(malformedRoot, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(crossed, { recursive: true, force: true });
  }
});

test("application monitor retains the exact mutation, readback, navigation, transition, and Review sequence", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-external-monitor-application-"));
  const moments = [
    ["resume", "before_mutation", "operation_resume_mutation_0001", 1],
    ["resume", "after_readback", "operation_resume_mutation_0001", 1],
    ["resume", "before_navigation", "operation_resume_reload_000001", 1],
    ["resume", "transition", "operation_resume_reload_000001", 1],
    ["resume", "before_navigation", "operation_resume_navigation_01", 1],
    ["profile", "transition", "operation_resume_navigation_01", 1],
    ["profile", "before_mutation", "operation_profile_mutation_001", 1],
    ["profile", "after_readback", "operation_profile_mutation_001", 1],
    ["profile", "before_navigation", "operation_profile_navigation_1", 1],
    ["questionnaire", "transition", "operation_profile_navigation_1", 1],
    ["questionnaire", "before_mutation", "operation_question_mutation_01", 1],
    ["questionnaire", "after_readback", "operation_question_mutation_01", 1],
    ["questionnaire", "before_navigation", "operation_question_navigation1", 1],
    ["review", "transition", "operation_question_navigation1", 1],
    ["review", "review_readback", "operation_review_readback_0001", 1],
  ] as const;
  try {
    const runtime = createStage2ExternalMonitorRuntime({
      ...binding,
      evidenceRoot: root,
      runtimeRoot: root,
      now: ordinalClock(),
      waitForAcknowledgement: async (request) => writeStage2ExternalMonitorAcknowledgement({
        runtimeRoot: root,
        evidenceRoot: root,
        requestPath: request.path,
        classification: request.ordinal === moments.length ? "review_verified" : "safe_to_continue",
        observedIdentityDigests: identityDigests(),
        structuralDescriptionIds: [structuralIdFor(request.page)],
        observedAt: `2026-08-10T12:00:00.${String(request.ordinal * 2).padStart(3, "0")}Z`,
      }),
    });
    for (const [page, moment, operationId, attempt] of moments) {
      try {
        await runtime.application(
          fixturePage(),
          page,
          moment,
          { ...taxonomy(), submitPresent: page === "review" },
          { operationId, attempt },
          new AbortController().signal,
        );
      } catch (error) {
        throw new Error(`${page}/${moment} monitor failed`, { cause: error });
      }
    }
    runtime.close();
    const read = readStage2ReviewMonitorChain(join(root, "monitor"), {
      journeyId: binding.journeyId,
      targetHandleId: binding.targetHandleId,
      sourceRevision: binding.sourceRevision,
      configSha256: binding.configSha256,
      hostSha256: digest(Buffer.from(binding.host)),
      tenantSha256: digest(Buffer.from(binding.tenant)),
      postingSha256: digest(Buffer.from(binding.posting)),
      processLiveNonceSha256: binding.processLiveNonceSha256,
      processIssuedAt: binding.processIssuedAt,
      processCheckedAt: "2026-08-10T12:00:01.000Z",
      processExitObservedAt: "2026-08-10T12:00:00.999Z",
      processInstanceSha256: processInstanceSha256(),
    });
    assert.equal(read.classification, "review_verified");
    assert.equal(read.files.length, moments.length * 4);
    for (const file of read.files.filter((value) => value.endsWith(".ack.json"))) {
      assert.equal(JSON.parse(readFileSync(join(root, file), "utf8")).submitActivated, false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ordinal CLI observation input is protected, digest-only, and exact", () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-external-monitor-observation-"));
  try {
    const path = join(root, "0001-account_entry-before_mutation.observation.json");
    writeFileSync(path, `${JSON.stringify({
      schemaVersion: 1,
      evidenceRevision: "s2-external-monitor-observation-v1",
      observer: "independent_visual_monitor",
      observedIdentityDigests: identityDigests(),
      structuralDescriptionIds: ["monitor_structure_account_entry_v1"],
      observedAt: "2026-08-10T12:00:00.002Z",
    })}\n`, { flag: "wx", mode: 0o600 });
    assert.deepEqual(readStage2ExternalMonitorObservation(root, path), {
      observedIdentityDigests: identityDigests(),
      structuralDescriptionIds: ["monitor_structure_account_entry_v1"],
      observedAt: "2026-08-10T12:00:00.002Z",
    });
    const outside = mkdtempSync(join(tmpdir(), "hunt-s2-external-monitor-outside-"));
    try {
      const crossedPath = join(outside, "0001-account_entry-before_mutation.observation.json");
      writeFileSync(crossedPath, readFileSync(path));
      assert.throws(
        () => readStage2ExternalMonitorObservation(root, crossedPath),
        /external monitor observation denied/u,
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("external monitor rejects missing, crossed, replayed, late, and post-close ACKs", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-external-monitor-deny-"));
  const page = fixturePage();
  try {
    const runtime = createStage2ExternalMonitorRuntime({
      ...binding,
      evidenceRoot: root,
      runtimeRoot: root,
      now: ordinalClock(),
      acknowledgementTimeoutMs: 20,
      acknowledgementPollMs: 2,
    });
    await assert.rejects(
      () => runtime.auth(page, "account_entry", "before_mutation", taxonomy(), {
        operationId: "operation_account_mutation_01", attempt: 1,
      }, new AbortController().signal),
      /external monitor acknowledgement unavailable/u,
    );
    await assert.rejects(
      () => runtime.auth(page, "account_entry", "before_mutation", taxonomy(), {
        operationId: "operation_account_mutation_02", attempt: 1,
      }, new AbortController().signal),
      /external monitor runtime denied/u,
    );
    runtime.close();
    await assert.rejects(
      () => runtime.auth(page, "account_entry", "after_readback", taxonomy(), {
        operationId: "operation_account_mutation_01", attempt: 1,
      }, new AbortController().signal),
      /external monitor runtime denied/u,
    );

    const requestPath = join(root, "auth-monitor", "0001-account_entry-before_mutation.request.json");
    assert.throws(() => writeStage2ExternalMonitorAcknowledgement({
      runtimeRoot: root,
      evidenceRoot: root,
      requestPath,
      classification: "safe_to_continue",
      observedIdentityDigests: identityDigests(),
      structuralDescriptionIds: ["monitor_structure_account_entry_v1"],
      observedAt: "2026-08-10T12:00:00.001Z",
      journeyId: "journey_crossed_monitor_01",
    }), /external monitor acknowledgement denied/u);
    const unknownPath = join(root, "0002-account_entry-before_mutation.observation.json");
    writeFileSync(unknownPath, `${JSON.stringify({
      schemaVersion: 1,
      evidenceRevision: "s2-external-monitor-observation-v1",
      observer: "independent_visual_monitor",
      observedIdentityDigests: identityDigests(),
      structuralDescriptionIds: ["monitor_structure_unreviewed_v1"],
      observedAt: "2026-08-10T12:00:00.003Z",
    })}\n`, { flag: "wx", mode: 0o600 });
    assert.throws(
      () => readStage2ExternalMonitorObservation(root, unknownPath),
      /external monitor observation denied/u,
    );
    const wrongPagePath = join(root, "0003-account_entry-before_mutation.observation.json");
    writeFileSync(wrongPagePath, `${JSON.stringify({
      schemaVersion: 1,
      evidenceRevision: "s2-external-monitor-observation-v1",
      observer: "independent_visual_monitor",
      observedIdentityDigests: identityDigests(),
      structuralDescriptionIds: ["monitor_structure_profile_v1"],
      observedAt: "2026-08-10T12:00:00.004Z",
    })}\n`, { flag: "wx", mode: 0o600 });
    assert.throws(
      () => readStage2ExternalMonitorObservation(root, wrongPagePath),
      /external monitor observation denied/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("external monitor rejects abrupt owner exit, stale liveness, and PID-start reuse", async () => {
  const abruptRoot = mkdtempSync(join(tmpdir(), "hunt-s2-monitor-abrupt-"));
  let checks = 0;
  try {
    const abrupt = createStage2ExternalMonitorRuntime({
      ...binding,
      runtimeRoot: abruptRoot,
      evidenceRoot: abruptRoot,
      now: ordinalClock(),
      processLiveness: () => ++checks === 1,
      waitForAcknowledgement: async (request) => writeStage2ExternalMonitorAcknowledgement({
        runtimeRoot: abruptRoot,
        evidenceRoot: abruptRoot,
        requestPath: request.path,
        classification: "safe_to_continue",
        observedIdentityDigests: identityDigests(),
        structuralDescriptionIds: [structuralIdFor(request.page)],
        observedAt: "2026-08-10T12:00:00.002Z",
      }),
    });
    await assert.rejects(() => abrupt.auth(fixturePage(), "account_entry", "before_mutation", taxonomy(), {
      operationId: "operation_abrupt_owner_exit_01", attempt: 1,
    }, new AbortController().signal), /external monitor runtime denied/u);
  } finally { rmSync(abruptRoot, { recursive: true, force: true }); }

  const staleRoot = mkdtempSync(join(tmpdir(), "hunt-s2-monitor-stale-"));
  try {
    const stale = createStage2ExternalMonitorRuntime({
      ...binding,
      runtimeRoot: staleRoot,
      evidenceRoot: staleRoot,
      processLiveness: () => false,
    });
    const page = fixturePage();
    await assert.rejects(() => stale.auth(page, "account_entry", "before_mutation", taxonomy(), {
      operationId: "operation_stale_owner_marker_01", attempt: 1,
    }, new AbortController().signal), /external monitor runtime denied/u);
    assert.equal(page.screenshotCalls, 0);
  } finally { rmSync(staleRoot, { recursive: true, force: true }); }

  const reusedRoot = mkdtempSync(join(tmpdir(), "hunt-s2-monitor-pid-reuse-"));
  try {
    const reused = createStage2ExternalMonitorRuntime({
      ...binding,
      processOwnerStartedAt: "2026-08-10T00:00:00.000Z",
      runtimeRoot: reusedRoot,
      evidenceRoot: reusedRoot,
      now: ordinalClock(),
      processLiveness: () => true,
      waitForAcknowledgement: async (request) => writeStage2ExternalMonitorAcknowledgement({
        runtimeRoot: reusedRoot,
        evidenceRoot: reusedRoot,
        requestPath: request.path,
        classification: "safe_to_continue",
        observedIdentityDigests: identityDigests(),
        structuralDescriptionIds: [structuralIdFor(request.page)],
        observedAt: "2026-08-10T12:00:00.002Z",
      }),
    });
    await assert.rejects(() => reused.auth(fixturePage(), "account_entry", "before_mutation", taxonomy(), {
      operationId: "operation_reused_owner_pid_001", attempt: 1,
    }, new AbortController().signal), /external monitor acknowledgement denied/u);
  } finally { rmSync(reusedRoot, { recursive: true, force: true }); }
});

test("ACK CLI denies an abrupt Node producer exit before process audit", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-monitor-child-exit-"));
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
    stdio: "ignore", windowsHide: true,
  });
  await once(child, "spawn");
  try {
    const runtime = createStage2ExternalMonitorRuntime({
      ...binding,
      processOwnerPid: child.pid!,
      processOwnerStartedAt: processStartedAt(child.pid!),
      runtimeRoot: root,
      evidenceRoot: root,
      now: ordinalClock(),
      waitForAcknowledgement: async (request) => {
        child.kill();
        await once(child, "exit");
        writeStage2ExternalMonitorAcknowledgement({
          runtimeRoot: root,
          evidenceRoot: root,
          requestPath: request.path,
          classification: "safe_to_continue",
          observedIdentityDigests: identityDigests(),
          structuralDescriptionIds: [structuralIdFor(request.page)],
          observedAt: "2026-08-10T12:00:00.002Z",
        });
      },
    });
    await assert.rejects(() => runtime.auth(fixturePage(), "account_entry", "before_mutation", taxonomy(), {
      operationId: "operation_child_exit_before_audit", attempt: 1,
    }, new AbortController().signal), /external monitor acknowledgement denied/u);
  } finally {
    if (child.exitCode === null) child.kill();
    rmSync(root, { recursive: true, force: true });
  }
});

function taxonomy() {
  return {
    fieldCount: 2,
    requiredFieldCount: 2,
    controlTypes: ["text"] as const,
    questionTypes: ["identity"] as const,
    answerTypes: ["text"] as const,
    validationState: "clear" as const,
    submitPresent: false,
    submitActivated: false as const,
  };
}

function identityDigests() {
  return {
    hostSha256: digest(Buffer.from(binding.host)),
    tenantSha256: digest(Buffer.from(binding.tenant)),
    postingSha256: digest(Buffer.from(binding.posting)),
    titleSha256: digest(Buffer.from("Business Manager")),
  };
}

function processInstanceSha256() {
  return digest(Buffer.from(
    `s2-process-instance-v1\0${binding.processOwnerPid}\0${binding.processOwnerStartedAt}`,
  ));
}

function fixturePage(
  url = `https://${binding.host}/en-US/Careers/job/Business-Manager_${binding.posting}/apply/applyManually`,
) {
  return {
    screenshotCalls: 0,
    titleCalls: 0,
    urlCalls: 0,
    async screenshot() {
      this.screenshotCalls += 1;
      return png(320, 200);
    },
    async title() {
      this.titleCalls += 1;
      return "Business Manager";
    },
    async url() {
      this.urlCalls += 1;
      return url;
    },
  };
}

function structuralIdFor(page: string): string {
  return `monitor_structure_${page}_v1`;
}

function ordinalClock() {
  let millisecond = 0;
  return () => `2026-08-10T12:00:00.${String(++millisecond * 2 - 1).padStart(3, "0")}Z`;
}

function png(width: number, height: number): Buffer {
  const scanlines = Buffer.alloc((width * 4 + 1) * height, 0xff);
  for (let row = 0; row < height; row += 1) scanlines[row * (width * 4 + 1)] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", Buffer.concat([u32(width), u32(height), Buffer.from([8, 6, 0, 0, 0])])),
    chunk("IDAT", deflateSync(scanlines)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBytes, data]);
  return Buffer.concat([u32(data.byteLength), body, u32(crc32(body))]);
}

function u32(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
}

function crc32(value: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
