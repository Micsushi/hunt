import assert from "node:assert/strict";
import test from "node:test";

import {
  assertCurrentProcessIsOnIsolatedDesktop,
  windowsIsolatedDesktopAttestationScript,
} from "../../../src/browser/playwright-live/private/windows-isolated-desktop-attestation.ts";

test("desktop attestation compares the inherited thread desktop with the runner binding", () => {
  const source = windowsIsolatedDesktopAttestationScript();
  assert.match(source, /GetThreadDesktop/u);
  assert.match(source, /GetCurrentThreadId/u);
  assert.match(source, /GetUserObjectInformation/u);
  assert.match(source, /HUNT_C3_WINDOWS_DESKTOP_NAME/u);
  assert.doesNotMatch(source, /SwitchDesktop|SetThreadDesktop|SetForegroundWindow/u);
});

test("desktop attestation fails closed unless the trusted child confirms exact isolation", async () => {
  await assert.rejects(
    assertCurrentProcessIsOnIsolatedDesktop({
      expectedDesktop: "HuntC3_1234567890abcdef1234567890abcdef",
      inspect: async () => false,
    }),
    /isolated desktop attestation failed/u,
  );
  await assert.doesNotReject(
    assertCurrentProcessIsOnIsolatedDesktop({
      expectedDesktop: "HuntC3_1234567890abcdef1234567890abcdef",
      inspect: async () => true,
    }),
  );
});

test("native desktop attestation leaves heartbeat timers responsive", {
  skip: process.platform !== "win32",
}, async () => {
  let heartbeatTicks = 0;
  const heartbeat = setInterval(() => { heartbeatTicks += 1; }, 10);
  try {
    await assert.rejects(assertCurrentProcessIsOnIsolatedDesktop({
      expectedDesktop: "HuntC3_00000000000000000000000000000000",
    }), /isolated desktop attestation failed/u);
    assert.ok(heartbeatTicks > 0, "native inspection must not block heartbeat timers");
  } finally {
    clearInterval(heartbeat);
  }
});
