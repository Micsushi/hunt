import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  MONITOR_ACK_FILE,
  MONITOR_REQUEST_FILE,
  MONITOR_SCREENSHOT_FILE,
  readOperatorMonitorAcknowledgement,
  waitForOperatorMonitorAcknowledgement,
  writeOperatorMonitorRequest,
  writeOperatorMonitorAcknowledgement,
} from "../../../src/live/evidence/operator-monitor-ack.ts";

const png = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x00,
]);

test("operator monitor acknowledgement binds one exact screenshot and classification", () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-monitor-"));
  try {
    const monitorRequest = request(root);
    writeFileSync(join(root, MONITOR_SCREENSHOT_FILE), png, { flag: "wx" });
    const acknowledgement = writeOperatorMonitorAcknowledgement({
      root,
      monitorRequestPath: monitorRequest.path,
      classification: "application_ready",
      observedAt: "2026-08-03T20:00:00.000Z",
    });
    assert.deepEqual(readOperatorMonitorAcknowledgement(root, monitorRequest), acknowledgement);
    assert.equal(acknowledgement.screenshotFile, MONITOR_SCREENSHOT_FILE);
    assert.equal(acknowledgement.journeyId, "journey_abcdefghijklmnop");
    assert.equal(acknowledgement.targetHandleId, "target_ref_abcdefghijklmnop");
    assert.equal(acknowledgement.monitorRequestSha256, monitorRequest.sha256);
    assert.match(acknowledgement.screenshotSha256, /^[0-9a-f]{64}$/u);
    assert.deepEqual(
      JSON.parse(readFileSync(join(root, MONITOR_ACK_FILE), "utf8")),
      acknowledgement,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("monitor acknowledgement rejects missing and changed screenshot evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-monitor-"));
  try {
    const monitorRequest = request(root);
    assert.throws(() => writeOperatorMonitorAcknowledgement({
      root,
      monitorRequestPath: monitorRequest.path,
      classification: "posting_unavailable",
      observedAt: "2026-08-03T20:00:00.000Z",
    }), /monitor screenshot unavailable/u);

    writeFileSync(join(root, MONITOR_SCREENSHOT_FILE), png, { flag: "wx" });
    writeOperatorMonitorAcknowledgement({
      root,
      monitorRequestPath: monitorRequest.path,
      classification: "posting_unavailable",
      observedAt: "2026-08-03T20:00:00.000Z",
    });
    writeFileSync(join(root, MONITOR_SCREENSHOT_FILE), Buffer.concat([png, Buffer.from([1])]));
    assert.throws(
      () => readOperatorMonitorAcknowledgement(root),
      /monitor acknowledgement denied/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("monitor hold resolves only after a valid acknowledgement appears", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-monitor-"));
  try {
    const monitorRequest = request(root);
    const waiting = waitForOperatorMonitorAcknowledgement(root, monitorRequest, 2_000, 10);
    setTimeout(() => {
      writeFileSync(join(root, MONITOR_SCREENSHOT_FILE), png, { flag: "wx" });
      writeOperatorMonitorAcknowledgement({
        root,
        monitorRequestPath: monitorRequest.path,
        classification: "maintenance",
        observedAt: "2026-08-03T20:00:00.000Z",
      });
    }, 25);
    assert.equal((await waiting).classification, "maintenance");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("monitor acknowledgement rejects a valid screenshot bound to another run target", () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-monitor-"));
  const other = mkdtempSync(join(tmpdir(), "hunt-s2-monitor-other-"));
  try {
    const expected = request(root);
    const crossed = writeOperatorMonitorRequest({
      root: other,
      journeyId: "journey_qrstuvwxyzabcdef",
      targetHandleId: "target_ref_qrstuvwxyzabcdef",
      host: "other.wd1.myworkdayjobs.com",
      tenant: "other",
      posting: "OTHER123",
    });
    writeFileSync(join(root, MONITOR_SCREENSHOT_FILE), png, { flag: "wx" });
    writeOperatorMonitorAcknowledgement({
      root,
      monitorRequestPath: crossed.path,
      classification: "application_ready",
      observedAt: "2026-08-03T20:00:00.000Z",
    });
    assert.throws(
      () => readOperatorMonitorAcknowledgement(root, expected),
      /monitor acknowledgement denied/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});

function request(root: string) {
  const value = writeOperatorMonitorRequest({
    root,
    journeyId: "journey_abcdefghijklmnop",
    targetHandleId: "target_ref_abcdefghijklmnop",
    host: "blackrock.wd1.myworkdayjobs.com",
    tenant: "blackrock",
    posting: "R265422",
  });
  assert.equal(value.path, join(root, MONITOR_REQUEST_FILE));
  return value;
}
