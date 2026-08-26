import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { deflateSync } from "node:zlib";

import { applicationPages } from "../../../src/ats/workday/application/page-walk-contract.ts";
import {
  createStage2ExternalMonitorRuntime,
  canonicalMonitorIdentityTitle,
  currentProcessStartedAt,
  processStartedAt,
  readStage2ExternalMonitorObservation,
  readStage2AuthMonitorChain,
  readStage2ReviewMonitorChain,
  type Stage2ExternalMonitorTraceDetails,
  writeStage2ExternalMonitorAcknowledgement as writeExternalMonitorAcknowledgement,
} from "../../../src/live/evidence/external-monitor-runtime.ts";
import { applicationMonitorPages } from "../../../src/live/evidence/review-monitor-chain.ts";
import { createStage2ExternalMonitorObserverAuthority } from
  "../../../src/live/evidence/external-monitor-authority.ts";
import {
  externalMonitorObserverFailureDiagnostic,
  externalMonitorObserverFailureCode,
  normalizeObservedAddressHost,
  normalizeObservedChromeTitle,
  observedActiveStageTitles,
  observedChromeIdentityTitleSha256s,
  observedStructureIdentityTitles,
  observedStructurePage,
  observedStructurePageFromIdentityTitle,
  reconcileObservedMonitorSurface,
  selectObservedChromeIdentityTitle,
  waitForReconciledMonitorSurface,
} from
  "../../../src/live/evidence/external-monitor-observer.ts";

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

test("application monitor page catalog matches the page-walk contract", () => {
  assert.deepEqual(applicationMonitorPages, applicationPages);
});

test("external monitor canonicalizes Workday posting URL case", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-external-monitor-posting-case-"));
  try {
    const runtime = createStage2ExternalMonitorRuntime({
      ...binding,
      posting: "R67871",
      evidenceRoot: root,
      runtimeRoot: root,
      now: ordinalClock(),
      waitForAcknowledgement: async (request) => writeStage2ExternalMonitorAcknowledgement({
        runtimeRoot: root,
        evidenceRoot: root,
        requestPath: request.path,
        classification: "safe_to_continue",
        observedIdentity: {
          ...observedIdentity(),
          posting: "r67871",
        },
        structuralDescriptionIds: [structuralIdFor(request.page)],
        observedAt: "2026-08-10T12:00:00.010Z",
      }),
    });

    await runtime.auth(
      fixturePage(`https://${binding.host}/en-US/Careers/job/Example_r67871`),
      "job_posting",
      "before_navigation",
      taxonomy(),
      { operationId: "operation_posting_case_0001", attempt: 1 },
      new AbortController().signal,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
          observedIdentity: observedIdentity(),
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

test("external monitor retains the complete password-recovery graph", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-external-monitor-password-reset-"));
  const moments = [
    ["account_entry", "before_mutation", "operation_password_reset_open_0001"],
    ["password_reset_request", "after_readback", "operation_password_reset_open_0001"],
    ["password_reset_request", "before_mutation", "operation_password_reset_request_01"],
    ["password_reset_email_sent", "after_readback", "operation_password_reset_request_01"],
    ["password_reset_email_sent", "before_navigation", "operation_password_reset_email_001"],
    ["verification_navigation", "transition", "operation_password_reset_email_001"],
    ["verification_navigation", "before_navigation", "operation_password_reset_link_0001"],
    ["password_reset_set", "transition", "operation_password_reset_link_0001"],
    ["password_reset_set", "before_mutation", "operation_password_reset_set_0001"],
    ["sign_in", "after_readback", "operation_password_reset_set_0001"],
    ["sign_in", "before_mutation", "operation_password_reset_signin_01"],
    ["application_ready", "after_readback", "operation_password_reset_signin_01"],
    ["application_ready", "state_observed", "operation_password_reset_state_001"],
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
        classification: request.page === "application_ready" && request.moment === "state_observed"
          ? "account_verified"
          : "safe_to_continue",
        observedIdentity: observedIdentity(),
        structuralDescriptionIds: [structuralIdFor(request.page)],
        observedAt: `2026-08-10T12:00:00.${String(request.ordinal * 2).padStart(3, "0")}Z`,
      }),
    });

    for (const [page, moment, operationId] of moments) {
      await runtime.auth(
        fixturePage(),
        page,
        moment,
        taxonomy(),
        { operationId, attempt: 1 },
        new AbortController().signal,
      );
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
  } finally {
    rmSync(root, { recursive: true, force: true });
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
  const trace: string[] = [];
  try {
    const runtime = createStage2ExternalMonitorRuntime({
      ...binding,
      evidenceRoot: root,
      runtimeRoot: root,
      now: ordinalClock(),
      trace: (event) => trace.push(event),
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
    assert.deepEqual(trace, [
      "external_monitor_capture_started",
      "external_monitor_url_before_read",
      "external_monitor_screenshot_received",
      "external_monitor_screenshot_captured",
      "external_monitor_title_captured",
      "external_monitor_url_after_read",
      "external_monitor_capture_failed",
    ]);
    assert.equal(trace.includes("external_monitor_identity_verified"), false);
    assert.equal(trace.includes("external_monitor_evidence_published"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a reviewed posting-free sign-in descendant keeps the approved posting binding", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-external-monitor-posting-free-"));
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
        observedIdentity: observedIdentity(),
        structuralDescriptionIds: [structuralIdFor(request.page)],
        observedAt: "2026-08-10T12:00:00.002Z",
      }),
    });
    await runtime.auth(
      fixturePage(`https://${binding.host}/en-US/Careers/login`),
      "sign_in",
      "before_mutation",
      taxonomy(),
      { operationId: "operation_posting_free_signin_01", attempt: 1 },
      new AbortController().signal,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a posting-free URL never satisfies a job-posting monitor", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-external-monitor-posting-required-"));
  try {
    const runtime = createStage2ExternalMonitorRuntime({
      ...binding,
      evidenceRoot: root,
      runtimeRoot: root,
      now: ordinalClock(),
      waitForAcknowledgement: async () => assert.fail("posting-free job page reached ACK"),
    });
    await assert.rejects(() => runtime.auth(
      fixturePage(`https://${binding.host}/en-US/Careers/login`),
      "job_posting",
      "before_navigation",
      taxonomy(),
      { operationId: "operation_posting_required_001", attempt: 1 },
      new AbortController().signal,
    ), /external monitor runtime denied/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("external monitor hashes independently supplied title and posting text", async () => {
  for (const [dimension, observedIdentityValue] of [
    ["posting", { ...observedIdentity(), posting: "99999999" }],
    ["title", { ...observedIdentity(), title: "Copied digest cannot stand in for a title" }],
  ] as const) {
    const root = mkdtempSync(join(tmpdir(), `hunt-s2-monitor-observed-${dimension}-`));
    try {
      const runtime = createStage2ExternalMonitorRuntime({
        ...binding,
        evidenceRoot: root,
        runtimeRoot: root,
        now: ordinalClock(),
        waitForAcknowledgement: async (request) => assert.throws(
          () => writeStage2ExternalMonitorAcknowledgement({
            runtimeRoot: root,
            evidenceRoot: root,
            requestPath: request.path,
            classification: "safe_to_continue",
            observedIdentity: observedIdentityValue,
            structuralDescriptionIds: [structuralIdFor(request.page)],
            observedAt: "2026-08-10T12:00:00.002Z",
          }),
          /external monitor acknowledgement denied/u,
        ),
      });
      await assert.rejects(
        () => runtime.auth(fixturePage(), "account_entry", "before_mutation", taxonomy(), {
          operationId: `operation_observed_${dimension}_01`,
          attempt: 1,
        }, new AbortController().signal),
        /external monitor acknowledgement denied/u,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("external monitor ignores site underscores before the Workday job route", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-external-monitor-site-underscore-"));
  const target = {
    host: "manulife.wd3.myworkdayjobs.com",
    tenant: "manulife",
    posting: "JR26071419",
    title: "Back-End Software Engineer",
    url: "https://manulife.wd3.myworkdayjobs.com/MFCJH_Jobs/job/Toronto-Ontario/Back-End-Software-Engineer_JR26071419",
  } as const;
  try {
    const runtime = createStage2ExternalMonitorRuntime({
      ...binding,
      host: target.host,
      tenant: target.tenant,
      posting: target.posting,
      evidenceRoot: root,
      runtimeRoot: root,
      now: ordinalClock(),
      waitForAcknowledgement: async (request) => writeStage2ExternalMonitorAcknowledgement({
        runtimeRoot: root,
        evidenceRoot: root,
        requestPath: request.path,
        classification: "safe_to_continue",
        observedIdentity: {
          host: target.host,
          tenant: target.tenant,
          posting: target.posting,
          title: target.title,
        },
        structuralDescriptionIds: [structuralIdFor(request.page)],
        observedAt: "2026-08-10T12:00:00.002Z",
      }),
    });
    const page = fixturePage(target.url);
    page.title = async () => target.title;
    await runtime.auth(page, "job_posting", "before_navigation", taxonomy(), {
      operationId: "operation_site_underscore_0001",
      attempt: 1,
    }, new AbortController().signal);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("external monitor admits an exact zero-control job-posting taxonomy", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-external-monitor-zero-controls-"));
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
        observedIdentity: observedIdentity(),
        structuralDescriptionIds: [structuralIdFor(request.page)],
        observedAt: "2026-08-10T12:00:00.002Z",
      }),
    });
    await runtime.auth(fixturePage(), "job_posting", "before_navigation", {
      fieldCount: 0,
      requiredFieldCount: 0,
      controlTypes: [],
      questionTypes: [],
      answerTypes: [],
      validationState: "clear",
      submitPresent: false,
      submitActivated: false,
    }, { operationId: "operation_zero_controls_0001", attempt: 1 },
    new AbortController().signal);
    const taxonomyFile = readdirSync(join(root, "auth-monitor"))
      .find((name) => name.endsWith(".taxonomy.json"));
    assert.notEqual(taxonomyFile, undefined);
    const taxonomy = JSON.parse(readFileSync(
      join(root, "auth-monitor", taxonomyFile!), "utf8",
    )) as Record<string, unknown>;
    assert.deepEqual(taxonomy.controlTypes, []);
    assert.deepEqual(taxonomy.questionTypes, []);
    assert.deepEqual(taxonomy.answerTypes, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("external monitor admits a direct job-posting to sign-in transition", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-external-monitor-direct-sign-in-"));
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
        observedIdentity: observedIdentity(),
        structuralDescriptionIds: [structuralIdFor(request.page)],
        observedAt: "2026-08-10T12:00:00.010Z",
      }),
    });
    const event = { operationId: "operation_direct_sign_in_0001", attempt: 1 } as const;
    await runtime.auth(
      fixturePage(), "job_posting", "before_navigation", taxonomy(), event,
      new AbortController().signal,
    );
    await runtime.auth(
      fixturePage(), "sign_in", "transition", taxonomy(), event,
      new AbortController().signal,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("external monitor admits sign-in returning to the exact job posting", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-external-monitor-sign-in-return-"));
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
        observedIdentity: observedIdentity(),
        structuralDescriptionIds: [structuralIdFor(request.page)],
        observedAt: "2026-08-10T12:00:00.010Z",
      }),
    });
    const event = { operationId: "operation_sign_in_return_0001", attempt: 1 } as const;
    await runtime.auth(
      fixturePage(), "sign_in", "before_mutation", taxonomy(), event,
      new AbortController().signal,
    );
    await runtime.auth(
      fixturePage(), "job_posting", "after_readback", taxonomy(), event,
      new AbortController().signal,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("external monitor rejects incomplete or malformed taxonomy arrays before evidence", async () => {
  const base = taxonomy();
  const cases: unknown[] = [
    { ...base, fieldCount: 1, requiredFieldCount: 0, controlTypes: [], questionTypes: [], answerTypes: [] },
    { ...base, fieldCount: 0, requiredFieldCount: 0, controlTypes: ["text"], questionTypes: [], answerTypes: [] },
    { ...base, controlTypes: ["text", "text"] },
    { ...base, controlTypes: Array.from({ length: 17 }, (_, index) => `type_${index}`) },
    { ...base, controlTypes: ["text", 1] },
    { ...base, questionTypes: ["raw label text"] },
  ];
  for (const [index, malformed] of cases.entries()) {
    const root = mkdtempSync(join(tmpdir(), `hunt-s2-external-monitor-taxonomy-${index}-`));
    try {
      const runtime = createStage2ExternalMonitorRuntime({
        ...binding,
        evidenceRoot: root,
        runtimeRoot: root,
        waitForAcknowledgement: async () => assert.fail("malformed taxonomy reached ACK"),
      });
      await assert.rejects(() => runtime.auth(
        fixturePage(),
        "job_posting",
        "before_navigation",
        malformed as ReturnType<typeof taxonomy>,
        { operationId: `operation_bad_taxonomy_${index}`, attempt: 1 },
        new AbortController().signal,
      ));
      const monitorRoot = join(root, "auth-monitor");
      assert.deepEqual(existsSync(monitorRoot) ? readdirSync(monitorRoot) : [], []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("external monitor rejects fabricated, missing, duplicate, and unsafe job routes", async () => {
  const validPath = `/Careers/job/Location/Business-Manager_${binding.posting}`;
  const cases = [
    `https://${binding.host}/Careers/Business-Manager_${binding.posting}`,
    `https://${binding.host}/Careers/job/Location/Business-Manager`,
    `https://${binding.host}${validPath}/Copy_${binding.posting}`,
    `http://${binding.host}${validPath}`,
    `https://user@${binding.host}${validPath}`,
    `https://${binding.host}:444${validPath}`,
    `https://${binding.host}/Careers%2Fjob%2FBusiness-Manager_${binding.posting}`,
  ] as const;
  for (const [index, url] of cases.entries()) {
    const root = mkdtempSync(join(tmpdir(), `hunt-s2-external-monitor-route-${index}-`));
    try {
      const runtime = createStage2ExternalMonitorRuntime({
        ...binding,
        evidenceRoot: root,
        runtimeRoot: root,
        waitForAcknowledgement: async () => assert.fail("unsafe route reached ACK"),
      });
      await assert.rejects(
        () => runtime.auth(fixturePage(url), "job_posting", "before_navigation", taxonomy(), {
          operationId: `operation_unsafe_job_route_${index}`,
          attempt: 1,
        }, new AbortController().signal),
      );
      assert.deepEqual(readdirSync(join(root, "auth-monitor")), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("external monitor traces the exact capture boundary without changing behavior", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-external-monitor-trace-"));
  const trace: string[] = [];
  const details: Stage2ExternalMonitorTraceDetails[] = [];
  try {
    const runtime = createStage2ExternalMonitorRuntime({
      ...binding,
      evidenceRoot: root,
      runtimeRoot: root,
      now: ordinalClock(),
      trace: (event, detail) => {
        trace.push(event);
        if (detail !== undefined) details.push(detail);
      },
      waitForAcknowledgement: async (request) => writeStage2ExternalMonitorAcknowledgement({
        runtimeRoot: root,
        evidenceRoot: root,
        requestPath: request.path,
        classification: "safe_to_continue",
        observedIdentity: observedIdentity(),
        structuralDescriptionIds: [structuralIdFor(request.page)],
        observedAt: "2026-08-10T12:00:00.002Z",
      }),
    });
    await runtime.auth(fixturePage(), "account_entry", "before_mutation", taxonomy(), {
      operationId: "operation_capture_trace_0001",
      attempt: 1,
    }, new AbortController().signal);
    assert.deepEqual(trace, [
      "external_monitor_capture_started",
      "external_monitor_url_before_read",
      "external_monitor_screenshot_received",
      "external_monitor_screenshot_captured",
      "external_monitor_title_captured",
      "external_monitor_url_after_read",
      "external_monitor_identity_verified",
      "external_monitor_taxonomy_admitted",
      "external_monitor_screenshot_written",
      "external_monitor_taxonomy_written",
      "external_monitor_request_written",
      "external_monitor_evidence_published",
      "external_monitor_acknowledged",
    ]);
    assert.equal(details.length, trace.length);
    assert.deepEqual(details[0], {
      chain: "auth",
      page: "account_entry",
      moment: "before_mutation",
      ordinal: 1,
      operationId: "operation_capture_trace_0001",
      attempt: 1,
      submitActivated: false,
    });
    assert.deepEqual(details.at(-1), {
      ...details[0],
      fieldCount: 2,
      requiredFieldCount: 2,
      controlTypes: ["text"],
      questionTypes: ["identity"],
      answerTypes: ["text"],
      validationState: "clear",
      submitPresent: false,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("external monitor trace observer failure cannot change capture behavior", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-external-monitor-trace-throw-"));
  try {
    const runtime = createStage2ExternalMonitorRuntime({
      ...binding,
      evidenceRoot: root,
      runtimeRoot: root,
      now: ordinalClock(),
      trace: () => { throw new Error("observer failure"); },
      waitForAcknowledgement: async (request) => writeStage2ExternalMonitorAcknowledgement({
        runtimeRoot: root,
        evidenceRoot: root,
        requestPath: request.path,
        classification: "safe_to_continue",
        observedIdentity: observedIdentity(),
        structuralDescriptionIds: [structuralIdFor(request.page)],
        observedAt: "2026-08-10T12:00:00.002Z",
      }),
    });
    await runtime.auth(fixturePage(), "account_entry", "before_mutation", taxonomy(), {
      operationId: "operation_capture_trace_throw1",
      attempt: 1,
    }, new AbortController().signal);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("external monitor accepts the standard RGB PNG emitted by Playwright", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-external-monitor-rgb-png-"));
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
        observedIdentity: observedIdentity(),
        structuralDescriptionIds: [structuralIdFor(request.page)],
        observedAt: "2026-08-10T12:00:00.002Z",
      }),
    });
    await runtime.auth(fixturePage(undefined, 2), "account_entry", "before_mutation", taxonomy(), {
      operationId: "operation_rgb_png_capture_01",
      attempt: 1,
    }, new AbortController().signal);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("external monitor rejects otherwise valid unsupported PNG color types", async () => {
  for (const colorType of [0, 3, 4] as const) {
    const root = mkdtempSync(join(tmpdir(), `hunt-s2-external-monitor-png-type-${colorType}-`));
    try {
      const runtime = createStage2ExternalMonitorRuntime({
        ...binding,
        evidenceRoot: root,
        runtimeRoot: root,
        waitForAcknowledgement: async () => assert.fail("unsupported PNG reached ACK"),
      });
      await assert.rejects(
        () => runtime.auth(fixturePage(undefined, colorType), "account_entry", "before_mutation", taxonomy(), {
          operationId: `operation_unsupported_png_${colorType}`,
          attempt: 1,
        }, new AbortController().signal),
        /review monitor chain denied/u,
      );
      assert.deepEqual(readdirSync(join(root, "auth-monitor")), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
        observedIdentity: observedIdentity(),
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

test("external monitor ACK independently rehashes the retained screenshot", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-external-monitor-screenshot-"));
  try {
    const runtime = createStage2ExternalMonitorRuntime({
      ...binding,
      evidenceRoot: root,
      runtimeRoot: root,
      now: ordinalClock(),
      waitForAcknowledgement: async (request) => {
        const common = {
          runtimeRoot: root,
          evidenceRoot: root,
          requestPath: request.path,
          classification: "safe_to_continue" as const,
          observedIdentity: observedIdentity(),
          structuralDescriptionIds: [structuralIdFor(request.page)],
          observedAt: "2026-08-10T12:00:00.002Z",
        };
        assert.throws(
          () => writeExternalMonitorAcknowledgement({
            ...common,
            observedScreenshotSha256: "0".repeat(64),
          }),
          /external monitor acknowledgement denied/u,
        );
        const monitorRequest = JSON.parse(readFileSync(request.path, "utf8")) as {
          readonly screenshotFile: string;
        };
        const screenshotPath = join(dirname(request.path), monitorRequest.screenshotFile);
        writeFileSync(screenshotPath, png(321, 200));
        assert.throws(
          () => writeExternalMonitorAcknowledgement({
            ...common,
            observedScreenshotSha256: digest(readFileSync(screenshotPath)),
          }),
          /external monitor acknowledgement denied/u,
        );
      },
    });
    await assert.rejects(
      () => runtime.auth(fixturePage(), "account_entry", "before_mutation", taxonomy(), {
        operationId: "operation_screenshot_rehash_01",
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
          observedIdentity: observedIdentity(),
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

test("external monitor distinguishes a screenshot call failure from PNG rejection", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-external-monitor-screenshot-failure-"));
  const trace: string[] = [];
  const details: Stage2ExternalMonitorTraceDetails[] = [];
  try {
    const runtime = createStage2ExternalMonitorRuntime({
      ...binding,
      evidenceRoot: root,
      runtimeRoot: root,
      trace: (event, detail) => {
        trace.push(event);
        if (detail !== undefined) details.push(detail);
      },
      waitForAcknowledgement: async () => assert.fail("screenshot failure reached ACK"),
    });
    await assert.rejects(
      () => runtime.auth({
        async url() { return `https://${binding.host}/en-US/Careers/job/Business-Manager_${binding.posting}`; },
        async screenshot(): Promise<Buffer> { throw new Error("screenshot failed"); },
        async title() { return assert.fail("screenshot failure reached title"); },
      }, "account_entry", "before_mutation", taxonomy(), {
        operationId: "operation_screenshot_failure_01",
        attempt: 1,
      }, new AbortController().signal),
      /screenshot failed/u,
    );
    assert.deepEqual(trace, [
      "external_monitor_capture_started",
      "external_monitor_url_before_read",
      "external_monitor_capture_failed",
    ]);
    assert.equal(details.at(-1)?.failureStage, "screenshot_capture");
    assert.equal(details.at(-1)?.submitActivated, false);
    assert.deepEqual(readdirSync(join(root, "auth-monitor")), []);
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
          observedIdentity: observedIdentity(),
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
          observedIdentity: observedIdentity(),
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
    const malformedTrace: string[] = [];
    try {
      const malformed = createStage2ExternalMonitorRuntime({
        ...binding,
        evidenceRoot: malformedRoot,
        runtimeRoot: malformedRoot,
        trace: (event) => malformedTrace.push(event),
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
      assert.deepEqual(malformedTrace, [
        "external_monitor_capture_started",
        "external_monitor_url_before_read",
        "external_monitor_screenshot_received",
        "external_monitor_capture_failed",
      ]);
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
    ["profile", "before_mutation", "operation_profile_mutation_001", 1],
    ["profile", "after_readback", "operation_profile_mutation_001", 1],
    ["profile", "before_navigation", "operation_profile_reload_00001", 1],
    ["profile", "transition", "operation_profile_reload_00001", 1],
    ["profile", "before_navigation", "operation_profile_navigation_1", 2],
    ["resume", "transition", "operation_profile_navigation_1", 2],
    ["resume", "before_mutation", "operation_resume_mutation_0001", 1],
    ["resume", "after_readback", "operation_resume_mutation_0001", 1],
    ["resume", "before_navigation", "operation_resume_navigation_01", 1],
    ["questionnaire", "transition", "operation_resume_navigation_01", 1],
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
        observedIdentity: observedIdentity(),
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

test("application monitor admits a value-free page-state observation before any mutation", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-external-monitor-page-state-"));
  try {
    const runtime = createStage2ExternalMonitorRuntime({
      ...binding,
      evidenceRoot: root,
      runtimeRoot: root,
      waitForAcknowledgement: async (request) => writeStage2ExternalMonitorAcknowledgement({
        runtimeRoot: root,
        evidenceRoot: root,
        requestPath: request.path,
        classification: "safe_to_continue",
        observedIdentity: observedIdentity(),
        structuralDescriptionIds: [structuralIdFor(request.page)],
      }),
    });
    await runtime.application(
      fixturePage(),
      "profile",
      "state_observed",
      taxonomy(),
      { operationId: "operation_profile_state_0001", attempt: 1 },
      new AbortController().signal,
    );
    runtime.close();
    const files = readdirSync(join(root, "monitor"));
    assert.equal(files.some((file) => file === "0001-profile-state_observed.ack.json"), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const [name, route, mutationCounts] of [
  ["Resume-first with forty profile mutations", ["resume", "profile", "questionnaire"], [1, 40, 1]],
  ["skipped Resume with repeated Questionnaire", ["profile", "questionnaire", "questionnaire"], [1, 1, 1]],
  ["combined Resume/Profile", ["resume", "questionnaire"], [2, 1]],
] as const) {
  test(`application monitor binds the exact observed ${name} route`, async () => {
    const root = mkdtempSync(join(tmpdir(), "hunt-s2-external-monitor-route-"));
    const moments: [string, string, string, number][] = [];
    const attempts = new Map<string, number>();
    for (const [index, page] of route.entries()) {
      for (let mutation = 0; mutation < mutationCounts[index]!; mutation += 1) {
        const kind = "mutation" as const;
        const attempt = (attempts.get(`${page}:${kind}`) ?? 0) + 1;
        attempts.set(`${page}:${kind}`, attempt);
        const operationId = `operation_${name.replace(/\W/gu, "_")}_${index}_${kind}_${mutation}`;
        moments.push([page, "before_mutation", operationId, attempt]);
        moments.push([
          page,
          "after_readback",
          operationId,
          attempt,
        ]);
      }
      const attempt = (attempts.get(`${page}:navigation`) ?? 0) + 1;
      attempts.set(`${page}:navigation`, attempt);
      const operationId = `operation_${name.replace(/\W/gu, "_")}_${index}_navigation_0001`;
      moments.push([page, "before_navigation", operationId, attempt]);
      moments.push([route[index + 1] ?? "review", "transition", operationId, attempt]);
    }
    moments.push(["review", "review_readback", `operation_${name.replace(/\W/gu, "_")}_review_0001`, 1]);
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
          observedIdentity: observedIdentity(),
          structuralDescriptionIds: [structuralIdFor(request.page)],
          observedAt: `2026-08-10T12:00:00.${String(request.ordinal * 2).padStart(3, "0")}Z`,
        }),
      });
      for (const [page, moment, operationId, attempt] of moments) {
        await runtime.application(
          fixturePage(),
          page as "resume" | "profile" | "questionnaire" | "review",
          moment,
          { ...taxonomy(), submitPresent: page === "review" },
          { operationId, attempt },
          new AbortController().signal,
        );
      }
      runtime.close();
      assert.equal(readStage2ReviewMonitorChain(join(root, "monitor"), {
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
      }).classification, "review_verified");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("application monitor admits a directly and independently observed Review", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-external-monitor-direct-review-"));
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
        classification: "review_verified",
        observedIdentity: observedIdentity(),
        structuralDescriptionIds: [structuralIdFor("review")],
        observedAt: "2026-08-10T12:00:00.002Z",
      }),
    });
    await runtime.application(
      fixturePage(),
      "review",
      "review_readback",
      { ...taxonomy(), submitPresent: true },
      { operationId: "operation_direct_review_0001", attempt: 1 },
      new AbortController().signal,
    );
    runtime.close();
    assert.equal(readStage2ReviewMonitorChain(join(root, "monitor"), {
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
    }).classification, "review_verified");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("application monitor reserves full-page capture for the final Review readback", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-external-monitor-capture-scope-"));
  const screenshotOptions: { readonly type?: "png"; readonly fullPage?: boolean }[] = [];
  const page = {
    ...fixturePage(),
    async screenshot(options?: { readonly type?: "png"; readonly fullPage?: boolean }) {
      screenshotOptions.push(options ?? {});
      return png(320, 200);
    },
  };
  try {
    const runtime = createStage2ExternalMonitorRuntime({
      ...binding,
      evidenceRoot: root,
      runtimeRoot: root,
      waitForAcknowledgement: async (request) => writeStage2ExternalMonitorAcknowledgement({
        runtimeRoot: root,
        evidenceRoot: root,
        requestPath: request.path,
        classification: request.page === "review" && request.moment === "review_readback"
          ? "review_verified"
          : "safe_to_continue",
        observedIdentity: observedIdentity(),
        structuralDescriptionIds: [structuralIdFor(request.page)],
      }),
    });
    await runtime.application(
      page, "profile", "state_observed", taxonomy(),
      { operationId: "operation_capture_scope_profile_01", attempt: 1 },
      new AbortController().signal,
    );
    await runtime.application(
      page, "profile", "before_navigation", taxonomy(),
      { operationId: "operation_capture_scope_navigation_01", attempt: 1 },
      new AbortController().signal,
    );
    await runtime.application(
      page, "review", "transition", { ...taxonomy(), submitPresent: true },
      { operationId: "operation_capture_scope_navigation_01", attempt: 1 },
      new AbortController().signal,
    );
    await runtime.application(
      page, "review", "review_readback", { ...taxonomy(), submitPresent: true },
      { operationId: "operation_capture_scope_review_01", attempt: 1 },
      new AbortController().signal,
    );
    runtime.close();
    assert.deepEqual(screenshotOptions, [
      { type: "png" },
      { type: "png" },
      { type: "png" },
      { type: "png", fullPage: true },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("application monitor admits My Experience then rejects a repeated Resume regression", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-external-monitor-regression-"));
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
        observedIdentity: observedIdentity(),
        structuralDescriptionIds: [structuralIdFor(request.page)],
        observedAt: `2026-08-10T12:00:00.${String(request.ordinal * 2).padStart(3, "0")}Z`,
      }),
    });
    const signal = new AbortController().signal;
    for (const [page, moment, operationId] of [
      ["profile", "before_mutation", "operation_regression_profile_mutation"],
      ["profile", "after_readback", "operation_regression_profile_mutation"],
      ["profile", "before_navigation", "operation_regression_profile_next_01"],
      ["resume", "transition", "operation_regression_profile_next_01"],
      ["resume", "before_mutation", "operation_regression_resume_mutation1"],
      ["resume", "after_readback", "operation_regression_resume_mutation1"],
      ["resume", "before_navigation", "operation_regression_resume_next_001"],
    ] as const) {
      await runtime.application(
        fixturePage(), page, moment, taxonomy(),
        { operationId, attempt: 1 }, signal,
      );
    }
    await runtime.application(
      fixturePage(), "profile", "transition", taxonomy(),
      { operationId: "operation_regression_resume_next_001", attempt: 1 }, signal,
    );
    await runtime.application(
      fixturePage(), "profile", "before_navigation", taxonomy(),
      { operationId: "operation_regression_profile_next_02", attempt: 1 }, signal,
    );
    await assert.rejects(() => runtime.application(
      fixturePage(), "resume", "transition", taxonomy(),
      { operationId: "operation_regression_profile_next_02", attempt: 1 }, signal,
    ), /external monitor runtime denied/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ordinal CLI observation input is protected, independently derived, and exact", () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-external-monitor-observation-"));
  try {
    const path = join(root, "0001-account_entry-before_mutation.observation.json");
    writeFileSync(path, `${JSON.stringify({
      schemaVersion: 2,
      evidenceRevision: "s2-external-monitor-observation-v2",
      observer: "independent_visual_monitor",
      observedScreenshotSha256: digest(Buffer.from("independent screenshot")),
      observedIdentity: observedIdentity(),
      structuralDescriptionIds: ["monitor_structure_account_entry_v1"],
      observedAt: "2026-08-10T12:00:00.002Z",
    })}\n`, { flag: "wx", mode: 0o600 });
    assert.deepEqual(readStage2ExternalMonitorObservation(root, path), {
      observedScreenshotSha256: digest(Buffer.from("independent screenshot")),
      observedIdentity: observedIdentity(),
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
      observedIdentity: observedIdentity(),
      structuralDescriptionIds: ["monitor_structure_account_entry_v1"],
      observedAt: "2026-08-10T12:00:00.001Z",
      journeyId: "journey_crossed_monitor_01",
    }), /external monitor acknowledgement denied/u);
    const unknownPath = join(root, "0002-account_entry-before_mutation.observation.json");
    writeFileSync(unknownPath, `${JSON.stringify({
      schemaVersion: 2,
      evidenceRevision: "s2-external-monitor-observation-v2",
      observer: "independent_visual_monitor",
      observedScreenshotSha256: digest(Buffer.from("independent screenshot")),
      observedIdentity: observedIdentity(),
      structuralDescriptionIds: ["monitor_structure_unreviewed_v1"],
      observedAt: "2026-08-10T12:00:00.003Z",
    })}\n`, { flag: "wx", mode: 0o600 });
    assert.throws(
      () => readStage2ExternalMonitorObservation(root, unknownPath),
      /external monitor observation denied/u,
    );
    const wrongPagePath = join(root, "0003-account_entry-before_mutation.observation.json");
    writeFileSync(wrongPagePath, `${JSON.stringify({
      schemaVersion: 2,
      evidenceRevision: "s2-external-monitor-observation-v2",
      observer: "independent_visual_monitor",
      observedScreenshotSha256: digest(Buffer.from("independent screenshot")),
      observedIdentity: observedIdentity(),
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
        observedIdentity: observedIdentity(),
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
        observedIdentity: observedIdentity(),
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
          observedIdentity: observedIdentity(),
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

test("authenticated Workday Chrome title normalization preserves the identity title", async () => {
  const observerSource = readFileSync("src/live/evidence/external-monitor-observer.ts", "utf8");
  assert.match(observerSource, /\$visible = -not \$element\.Current\.IsOffscreen/u);
  assert.match(observerSource, /if \(\$visible -and \$allow -contains \$name\)/u);
  assert.doesNotMatch(observerSource, /if \(\$visible\) \{\s*switch \(\$name\)/u);
  assert.match(observerSource, /\[void\]\$selectedTabTitles\.Add\(\$name\)/u);
  assert.match(observerSource, /ControlType\.Id -eq 50030/u);
  assert.match(observerSource, /\[void\]\$documentTitles\.Add\(\$name\)/u);
  assert.match(observerSource, /s2-external-monitor-observer-failure-v1/u);
  assert.match(observerSource, /submitActivated: false/u);
  assert.equal(
    normalizeObservedChromeTitle("  Business   Manager - Google Chrome for Testing"),
    "Business Manager",
  );
  assert.equal(normalizeObservedChromeTitle("My Information"), "My Information");
  const staleWindow = "Create Account - Google Chrome for Testing";
  assert.equal(selectObservedChromeIdentityTitle(
    digest(Buffer.from("My Information", "utf8")),
    staleWindow,
    ["My Information"],
  ), "My Information");
  assert.equal(selectObservedChromeIdentityTitle(
    digest(Buffer.from("My Information", "utf8")),
    staleWindow,
    ["My Experience"],
  ), "Create Account");
  assert.deepEqual(observedChromeIdentityTitleSha256s(staleWindow, ["My Information"]), [
    digest(Buffer.from("Create Account", "utf8")),
    digest(Buffer.from("My Information", "utf8")),
  ]);
  assert.deepEqual(
    observedStructureIdentityTitles("profile", new Set(["My Information", "Review"]), ["My Information"]),
    ["My Information"],
  );
  assert.deepEqual(
    observedStructureIdentityTitles("questionnaire", new Set(["My Information", "Self Identify"]), ["Self Identify"]),
    ["Self Identify"],
  );
  assert.deepEqual(observedActiveStageTitles({
    myInformation: 2,
    myExperience: 1,
    applicationQuestions: 1,
    voluntaryDisclosures: 1,
    selfIdentify: 1,
    review: 1,
  }), ["My Information"]);
  assert.equal(observedStructurePage(
    new Set(["My Information", "My Experience", "Application Questions"]),
    ["My Information"],
  ), "profile");
  assert.equal(observedStructurePage(
    new Set(["My Experience", "Resume, Cover Letter and References"]),
    ["My Experience"],
  ), "resume");
  assert.deepEqual(observedActiveStageTitles({
    myInformation: 2,
    myExperience: 2,
    applicationQuestions: 1,
    voluntaryDisclosures: 1,
    selfIdentify: 1,
    review: 1,
  }), []);
  assert.throws(() => selectObservedChromeIdentityTitle(
    digest(Buffer.from("My Information", "utf8")),
    staleWindow,
    Array.from({ length: 9 }, () => "My Information"),
  ), /external monitor observer denied/u);
  assert.throws(() => normalizeObservedChromeTitle("\u0000"), /external monitor observer denied/u);
  assert.equal(
    normalizeObservedAddressHost("readiness.wd5.myworkdayjobs.com/en-US/Careers/apply"),
    "readiness.wd5.myworkdayjobs.com",
  );
  assert.equal(
    normalizeObservedAddressHost("https://readiness.wd5.myworkdayjobs.com/en-US/Careers/apply"),
    "readiness.wd5.myworkdayjobs.com",
  );
  assert.equal(observedStructurePage(new Set(["Review", "Submit application"])), "review");
  assert.equal(observedStructurePage(new Set(["My Information", "Next"])), "profile");
  assert.equal(observedStructurePageFromIdentityTitle("My Information"), "profile");
  assert.equal(observedStructurePageFromIdentityTitle("My Experience"), "profile");
  assert.equal(observedStructurePageFromIdentityTitle("Application Questions"), "questionnaire");
  assert.equal(observedStructurePageFromIdentityTitle("Voluntary Disclosures"), "questionnaire");
  assert.equal(observedStructurePageFromIdentityTitle("Self Identify"), "questionnaire");
  assert.equal(observedStructurePageFromIdentityTitle("Review"), "review");
  assert.throws(() => observedStructurePageFromIdentityTitle("Environmental Services Technician"),
    /external monitor observer denied/u);
  assert.equal(observedStructurePage(new Set([
    "Create Account", "Email Address", "Password", "My Information", "My Experience",
    "Application Questions", "Voluntary Disclosures", "Self Identify", "Review",
  ])), "account_entry");
  assert.equal(observedStructurePage(new Set([
    "Sign In", "Email Address", "Password", "My Information", "Application Questions", "Review",
  ])), "account_entry");
  assert.equal(observedStructurePage(new Set([
    "Sign In", "Create Account", "Forgot your password?",
  ])), "sign_in");
  assert.equal(
    externalMonitorObserverFailureCode(new Error("external monitor observer failed: owned_browser_observation")),
    "owned_browser_observation",
  );
  assert.equal(externalMonitorObserverFailureCode(new Error("private value")), undefined);
  const title = "Process Tech & Launch";
  const observedTitle = "Process Tech Launch";
  assert.equal(canonicalMonitorIdentityTitle(title), observedTitle);
  assert.doesNotThrow(() => reconcileObservedMonitorSurface({
    page: "job_posting",
    capturedIdentityDigests: {
      titleSha256: digest(Buffer.from(canonicalMonitorIdentityTitle(title), "utf8")),
    },
  }, { title: observedTitle, submitPresent: false }));
  let mismatch: unknown;
  try {
    reconcileObservedMonitorSurface({
      page: "job_posting",
      capturedIdentityDigests: { titleSha256: "0".repeat(64) },
    }, { title: observedTitle, submitPresent: false });
  } catch (error) {
    mismatch = error;
  }
  assert.match(String(mismatch), /title_identity_reconciliation/u);
  assert.deepEqual(externalMonitorObserverFailureDiagnostic(mismatch), {
    expectedTitleSha256: "0".repeat(64),
    observedTitleSha256: digest(Buffer.from(observedTitle, "utf8")),
  });
  assert.doesNotMatch(JSON.stringify(externalMonitorObserverFailureDiagnostic(mismatch)),
    /Process Tech/u);
  assert.throws(() => reconcileObservedMonitorSurface({
    page: "job_posting",
    capturedIdentityDigests: {
      titleSha256: digest(Buffer.from(canonicalMonitorIdentityTitle(title), "utf8")),
    },
  }, { title: observedTitle, submitPresent: true }), /submit_state_reconciliation/u);

  const authenticatedTitle = "My Information";
  const observedTitles = ["Sign In", authenticatedTitle];
  let waits = 0;
  const reconciled = await waitForReconciledMonitorSurface({
    page: "application_ready",
    capturedIdentityDigests: {
      titleSha256: digest(Buffer.from(authenticatedTitle, "utf8")),
    },
  }, () => ({
    title: observedTitles.shift() ?? authenticatedTitle,
    page: "profile",
    submitPresent: false,
  }), {
    attempts: 2,
    pause: async () => { waits += 1; },
  });
  assert.equal(reconciled.title, authenticatedTitle);
  assert.equal(waits, 1);

  const experienceSurface = await waitForReconciledMonitorSurface({
    page: "resume",
    capturedIdentityDigests: {
      titleSha256: digest(Buffer.from("My Experience", "utf8")),
    },
  }, () => ({
    title: "My Experience",
    page: "profile",
    submitPresent: false,
  }));
  assert.equal(experienceSurface.page, "profile");
  const transientStructureSurfaces = [
    new Error("external monitor observer failed: structure_classification"),
    {
      title: "My Information",
      page: "profile",
      submitPresent: false,
    },
  ];
  let structureWaits = 0;
  const settledStructure = await waitForReconciledMonitorSurface({
    page: "resume",
    capturedIdentityDigests: {
      titleSha256: digest(Buffer.from("My Information", "utf8")),
    },
  }, () => {
    const surface = transientStructureSurfaces.shift();
    if (surface instanceof Error) throw surface;
    return surface!;
  }, {
    attempts: 2,
    pause: async () => { structureWaits += 1; },
  });
  assert.equal(settledStructure.page, "profile");
  assert.equal(structureWaits, 1);
  await assert.rejects(() => waitForReconciledMonitorSurface({
    page: "profile",
    capturedIdentityDigests: {
      titleSha256: digest(Buffer.from("My Experience", "utf8")),
    },
  }, () => ({
    title: "My Experience",
    page: "resume",
    submitPresent: false,
  })), /structure_classification/u);
});

test("production-bound monitor creates and consumes an independently signed ACK", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-signed-monitor-"));
  const authority = createBoundTestAuthority(root);
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    const runtime = createStage2ExternalMonitorRuntime({
      ...binding,
      runtimeRoot: root,
      evidenceRoot: root,
      observer: authority.binding,
      now: ordinalClock(),
      acknowledgementTimeoutMs: 2_000,
      acknowledgementPollMs: 10,
    });
    timer = setInterval(() => {
      const requestName = readdirSync(join(root, "auth-monitor"))
        .find((name) => name.endsWith(".request.json"));
      if (requestName === undefined) return;
      clearInterval(timer);
      timer = undefined;
      const requestPath = join(root, "auth-monitor", requestName);
      writeStage2ExternalMonitorAcknowledgement({
        runtimeRoot: root,
        evidenceRoot: root,
        requestPath,
        classification: "account_verified",
        observedIdentity: observedIdentity(),
        structuralDescriptionIds: [structuralIdFor("application_ready")],
        observer: authority,
        observedStructurePage: "profile",
        observedSubmitPresent: false,
        privacyScan: "separate_evidence_required",
        observedAt: "2026-08-10T12:00:00.010Z",
      });
    }, 10);
    await runtime.auth(fixturePage(), "application_ready", "state_observed", taxonomy(), {
      operationId: "operation_signed_monitor_ack_01", attempt: 1,
    }, new AbortController().signal);
    const ackName = readdirSync(join(root, "auth-monitor")).find((name) => name.endsWith(".ack.json"));
    assert.ok(ackName);
    const ack = JSON.parse(readFileSync(join(root, "auth-monitor", ackName), "utf8"));
    assert.equal(ack.schemaVersion, 3);
    assert.equal(ack.evidenceRevision, "s2-external-monitor-ack-v3");
    assert.match(ack.observerSignature, /^[A-Za-z0-9_-]{80,128}$/u);
    runtime.close();
    const chain = readStage2AuthMonitorChain(join(root, "auth-monitor"), {
      journeyId: binding.journeyId,
      targetHandleId: binding.targetHandleId,
      sourceRevision: binding.sourceRevision,
      configSha256: binding.configSha256,
      hostSha256: digest(Buffer.from(binding.host)),
      tenantSha256: digest(Buffer.from(binding.tenant)),
      postingSha256: digest(Buffer.from(binding.posting)),
      processLiveNonceSha256: binding.processLiveNonceSha256,
      processIssuedAt: binding.processIssuedAt,
      processInstanceSha256: processInstanceSha256(),
      processExitObservedAt: "2026-08-10T12:00:01.000Z",
      processCheckedAt: "2026-08-10T12:00:02.000Z",
    });
    assert.equal(chain.classification, "account_verified");
  } finally {
    if (timer !== undefined) clearInterval(timer);
    authority.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("production-bound monitor rejects owner-style unsigned and mismatched-title ACKs", async () => {
  for (const mismatch of [false, true]) {
    const root = mkdtempSync(join(tmpdir(), "hunt-s2-signed-monitor-deny-"));
    const authority = createBoundTestAuthority(root);
    try {
      const runtime = createStage2ExternalMonitorRuntime({
        ...binding,
        runtimeRoot: root,
        evidenceRoot: root,
        observer: authority.binding,
        now: ordinalClock(),
        waitForAcknowledgement: async (request) => writeStage2ExternalMonitorAcknowledgement({
          runtimeRoot: root,
          evidenceRoot: root,
          requestPath: request.path,
          classification: "account_verified",
          observedIdentity: mismatch
            ? { ...observedIdentity(), title: "Public posting title" }
            : observedIdentity(),
          structuralDescriptionIds: [structuralIdFor(request.page)],
          ...(mismatch ? { observer: authority } : {}),
          ...(mismatch
            ? {
                observedStructurePage: "profile",
                observedSubmitPresent: false,
                privacyScan: "separate_evidence_required" as const,
              }
            : {}),
          observedAt: "2026-08-10T12:00:00.010Z",
        }),
      });
      await assert.rejects(() => runtime.auth(
        fixturePage(), "application_ready", "state_observed", taxonomy(),
        { operationId: `operation_signed_monitor_deny_${mismatch ? "title" : "owner"}`, attempt: 1 },
        new AbortController().signal,
      ), /external monitor acknowledgement denied/u);
      runtime.close();
    } finally {
      authority.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("production-bound monitor fails promptly when its observer exits", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-monitor-observer-exit-"));
  const authority = createBoundTestAuthority(root);
  try {
    const runtime = createStage2ExternalMonitorRuntime({
      ...binding,
      runtimeRoot: root,
      evidenceRoot: root,
      observer: authority.binding,
      now: ordinalClock(),
      acknowledgementTimeoutMs: 5_000,
      acknowledgementPollMs: 10,
    });
    authority.close();
    const startedAt = Date.now();
    await assert.rejects(() => runtime.auth(
      fixturePage(), "application_ready", "state_observed", taxonomy(),
      { operationId: "operation_observer_exit_0001", attempt: 1 },
      new AbortController().signal,
    ), /external monitor observer unavailable/u);
    assert.ok(Date.now() - startedAt < 1_000);
    runtime.close();
  } finally {
    authority.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("owner-process authority creation is denied without the wrapper capability", () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-monitor-owner-authority-deny-"));
  const token = writeTestDesktopBinding(root);
  try {
    assert.throws(() => createStage2ExternalMonitorObserverAuthority({
      runtimeRoot: root,
      journeyId: binding.journeyId,
      targetHandleId: binding.targetHandleId,
      authorityToken: Buffer.alloc(32, 9).toString("base64"),
    }), /external monitor observer authority denied/u);
    assert.notEqual(token, Buffer.alloc(32, 9).toString("base64"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function createBoundTestAuthority(root: string) {
  const authorityToken = writeTestDesktopBinding(root);
  return createStage2ExternalMonitorObserverAuthority({
    runtimeRoot: root,
    journeyId: binding.journeyId,
    targetHandleId: binding.targetHandleId,
    authorityToken,
  });
}

function writeTestDesktopBinding(root: string): string {
  const authorityToken = Buffer.alloc(32, 7).toString("base64");
  writeFileSync(join(root, "isolated-desktop.json"), `${JSON.stringify({
    schemaVersion: 1,
    bindingRevision: "s2-isolated-desktop-binding-v2",
    runKey: "run_20260824_0123456789abcdef",
    journeyId: binding.journeyId,
    targetHandleId: binding.targetHandleId,
    desktopName: `HuntC3_${"1".repeat(32)}`,
    host: binding.host,
    tenant: binding.tenant,
    posting: binding.posting,
    browserProfilePath: join(root, "browser-profiles", binding.journeyId, binding.targetHandleId),
    observerAuthorityTokenSha256: digest(Buffer.from(authorityToken, "base64")),
  })}\n`);
  return authorityToken;
}

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

function observedIdentity() {
  return {
    host: binding.host,
    tenant: binding.tenant,
    posting: binding.posting,
    title: "Business Manager",
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

function writeStage2ExternalMonitorAcknowledgement(
  request: Omit<
    Parameters<typeof writeExternalMonitorAcknowledgement>[0],
    "observedScreenshotSha256"
  >,
): void {
  const monitorRequest = JSON.parse(readFileSync(request.requestPath, "utf8")) as {
    readonly screenshotFile: string;
  };
  const screenshot = readFileSync(join(dirname(request.requestPath), monitorRequest.screenshotFile));
  writeExternalMonitorAcknowledgement({
    ...request,
    observedScreenshotSha256: digest(screenshot),
  });
}

function processInstanceSha256() {
  return digest(Buffer.from(
    `s2-process-instance-v1\0${binding.processOwnerPid}\0${binding.processOwnerStartedAt}`,
  ));
}

function fixturePage(
  url = `https://${binding.host}/en-US/Careers/job/Business-Manager_${binding.posting}/apply/applyManually`,
  colorType: PngColorType = 6,
) {
  return {
    screenshotCalls: 0,
    titleCalls: 0,
    urlCalls: 0,
    async screenshot() {
      this.screenshotCalls += 1;
      return png(320, 200, colorType);
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

type PngColorType = 0 | 2 | 3 | 4 | 6;

function png(width: number, height: number, colorType: PngColorType = 6): Buffer {
  const channels = colorType === 0 || colorType === 3 ? 1 : colorType === 4 ? 2 : colorType === 2 ? 3 : 4;
  const scanlines = Buffer.alloc((width * channels + 1) * height, colorType === 3 ? 0 : 0xff);
  for (let row = 0; row < height; row += 1) scanlines[row * (width * channels + 1)] = 0;
  const chunks = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", Buffer.concat([u32(width), u32(height), Buffer.from([8, colorType, 0, 0, 0])])),
    ...(colorType === 3 ? [chunk("PLTE", Buffer.from([0, 0, 0]))] : []),
    chunk("IDAT", deflateSync(scanlines)),
    chunk("IEND", Buffer.alloc(0)),
  ];
  return Buffer.concat(chunks);
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
