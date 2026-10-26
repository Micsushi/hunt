import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { WindowsDpapiBridge } from "../../src/secrets/windows-dpapi/bridge.ts";

const syntheticBytes = (...values: number[]) => Uint8Array.from(values);

test("the Windows bridge round-trips bounded bytes through DPAPI CurrentUser", async () => {
  const bridge = new WindowsDpapiBridge();
  const value = syntheticBytes(17, 29, 43, 71, 113);
  const entropy = syntheticBytes(3, 5, 7, 11, 13);

  const sealed = await bridge.protect(value, entropy);
  assert.notDeepEqual(sealed, value);
  assert.deepEqual(await bridge.unprotect(sealed, entropy), value);
  await assert.rejects(
    bridge.unprotect(sealed, syntheticBytes(2, 3, 5, 7, 11)),
    /DPAPI operation failed/u,
  );
});

test("the Windows bridge rejects oversized input before starting PowerShell", async () => {
  const bridge = new WindowsDpapiBridge({ maxInputBytes: 4 });

  await assert.rejects(
    bridge.protect(syntheticBytes(1, 2, 3, 4, 5), syntheticBytes(1)),
    /DPAPI input exceeds the configured bound/u,
  );
});

test("the bridge source pins CurrentUser and never permits LocalMachine scope", async () => {
  const source = await readFile("src/secrets/windows-dpapi/bridge.ts", "utf8");
  assert.match(source, /DataProtectionScope\.CurrentUser/u);
  assert.doesNotMatch(source, /DataProtectionScope\.LocalMachine/u);
  assert.match(source, /windowsHide:\s*true/u);
  assert.match(source, /shell:\s*false/u);
});
