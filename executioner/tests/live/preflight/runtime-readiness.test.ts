import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  verifyStage2RuntimeReadiness,
  type RuntimeReadinessOptions,
} from "../../../src/live/preflight/runtime-readiness.ts";

const nodePath = process.execPath;
const profilePath = join(tmpdir(), "hunt-c3-readiness-0123456789abcdef");
const base: RuntimeReadinessOptions = {
  nodeVersion: "22.23.2",
  npmVersion: "10.9.8",
  nodePath,
  pairedNodePath: nodePath,
  profilePath,
  headroom: {
    availablePhysicalBytes: 4 * 1024 ** 3,
    commitHeadroomBytes: 12 * 1024 ** 3,
  },
  pathExists: (path) => path === "browser.exe",
  removeProfile: async () => undefined,
};

test("runtime readiness classifies every setup boundary and keeps low RAM diagnostic", async () => {
  assert.equal((await verifyStage2RuntimeReadiness({
    ...base,
    nodeVersion: "25.6.1",
  })).code, "runtime_mismatch");
  assert.equal((await verifyStage2RuntimeReadiness({
    ...base,
    nodeVersion: "22.18.0",
  })).code, "runtime_mismatch");
  assert.equal((await verifyStage2RuntimeReadiness({
    ...base,
    npmVersion: "11.9.0",
  })).code, "runtime_mismatch");
  assert.equal((await verifyStage2RuntimeReadiness({
    ...base,
    loadPlaywright: async () => { throw new Error("missing"); },
  })).code, "missing_dependency");
  assert.equal((await verifyStage2RuntimeReadiness({
    ...base,
    pathExists: () => false,
    loadPlaywright: async () => runtime(),
  })).code, "missing_browser");
  assert.equal((await verifyStage2RuntimeReadiness({
    ...base,
    loadPlaywright: async () => runtime({ launchFailure: true }),
  })).code, "launch_failure");
  assert.equal((await verifyStage2RuntimeReadiness({
    ...base,
    loadPlaywright: async () => runtime({ title: "wrong" }),
  })).code, "evidence_failure");
  assert.equal((await verifyStage2RuntimeReadiness({
    ...base,
    loadPlaywright: async () => runtime({ evidenceFailure: true }),
  })).code, "evidence_failure");
  assert.equal((await verifyStage2RuntimeReadiness({
    ...base,
    removeProfile: async () => { throw new Error("cleanup failed"); },
    loadPlaywright: async () => runtime(),
  })).code, "evidence_failure");

  const ready = await verifyStage2RuntimeReadiness({
    ...base,
    loadPlaywright: async () => runtime(),
  });
  assert.equal(ready.code, "ready");
  assert.equal(ready.status, "ready");
  assert.equal(ready.headroom.low, true);
  assert.equal(ready.cleanup.profileRemoved, true);
  assert.equal(ready.cleanup.browserProcessExited, true);
});

test("runtime readiness is idempotent and closes every throwaway context", async () => {
  let closes = 0;
  const options: RuntimeReadinessOptions = {
    ...base,
    loadPlaywright: async () => runtime({ close: () => { closes += 1; } }),
  };
  assert.equal((await verifyStage2RuntimeReadiness(options)).code, "ready");
  assert.equal((await verifyStage2RuntimeReadiness(options)).code, "ready");
  assert.equal(closes, 2);
});

function runtime(options: {
  readonly title?: string;
  readonly launchFailure?: boolean;
  readonly evidenceFailure?: boolean;
  readonly close?: () => void;
} = {}) {
  const page = {
    async goto() {},
    async title() { return options.title ?? "hunt-c3-runtime-ready"; },
  };
  return {
    version: "1.62.1",
    chromium: {
      executablePath: () => "browser.exe",
      async launchPersistentContext() {
        if (options.launchFailure) throw new Error("launch failed");
        return {
          pages: () => [page],
          async newPage() { return page; },
          browser: () => ({
            version: () => "Chromium 140.0",
            async newBrowserCDPSession() {
              return {
                async send() {
                  if (options.evidenceFailure) throw new Error("evidence failed");
                  return { processInfo: [{ type: "browser", id: 2_000_000_000 }] };
                },
                async detach() {},
              };
            },
          }),
          async close() { options.close?.(); },
        };
      },
    },
  };
}
