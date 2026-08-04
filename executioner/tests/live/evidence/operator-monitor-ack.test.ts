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
  MONITOR_SCREENSHOT_FILE,
  readOperatorMonitorAcknowledgement,
  waitForOperatorMonitorAcknowledgement,
  writeOperatorMonitorAcknowledgement,
} from "../../../src/live/evidence/operator-monitor-ack.ts";

const png = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x00,
]);

test("operator monitor acknowledgement binds one exact screenshot and classification", () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-monitor-"));
  try {
    writeFileSync(join(root, MONITOR_SCREENSHOT_FILE), png, { flag: "wx" });
    const acknowledgement = writeOperatorMonitorAcknowledgement({
      root,
      classification: "application_ready",
      observedAt: "2026-08-03T20:00:00.000Z",
    });
    assert.deepEqual(readOperatorMonitorAcknowledgement(root), acknowledgement);
    assert.equal(acknowledgement.screenshotFile, MONITOR_SCREENSHOT_FILE);
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
    assert.throws(() => writeOperatorMonitorAcknowledgement({
      root,
      classification: "posting_unavailable",
      observedAt: "2026-08-03T20:00:00.000Z",
    }), /monitor screenshot unavailable/u);

    writeFileSync(join(root, MONITOR_SCREENSHOT_FILE), png, { flag: "wx" });
    writeOperatorMonitorAcknowledgement({
      root,
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
    const waiting = waitForOperatorMonitorAcknowledgement(root, 2_000, 10);
    setTimeout(() => {
      writeFileSync(join(root, MONITOR_SCREENSHOT_FILE), png, { flag: "wx" });
      writeOperatorMonitorAcknowledgement({
        root,
        classification: "maintenance",
        observedAt: "2026-08-03T20:00:00.000Z",
      });
    }, 25);
    assert.equal((await waiting).classification, "maintenance");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
