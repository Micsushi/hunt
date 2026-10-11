import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { readProcessStartTime } from "../../../src/live/evidence/process-start-time.ts";

test("Windows process identity retries a timed-out probe without accepting stale identity", {
  skip: process.platform !== "win32",
}, (t) => {
  const timedOut = Object.assign(new Error("probe timed out"), { code: "ETIMEDOUT" });
  const denied = Object.assign(new Error("process absent"), { code: 1 });
  let results: (Error | string)[] = [];
  const timeouts: number[] = [];
  t.mock.method(childProcess, "execFileSync", (_file: string, _args: string[], options: { timeout: number }) => {
    timeouts.push(options.timeout);
    const result = results.shift();
    if (result instanceof Error) throw result;
    assert.equal(typeof result, "string");
    return result;
  });
  syncBuiltinESMExports();
  try {
    results = [timedOut, "2026-10-11T22:00:00.000Z\n"];
    assert.equal(readProcessStartTime(123), "2026-10-11T22:00:00.000Z");
    assert.deepEqual(timeouts.splice(0), [5_000, 15_000]);
    results = [timedOut, timedOut];
    assert.throws(() => readProcessStartTime(123), error => error === timedOut);
    assert.equal(timeouts.splice(0).length, 2);
    results = [denied];
    assert.throws(() => readProcessStartTime(123), error => error === denied);
    assert.equal(timeouts.length, 1);
    assert.throws(() => readProcessStartTime(-1), /process identity denied/u);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});
