import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  WindowsLegacyV2AccountSealer,
  type LegacyV2AccountProcess,
} from "../../src/secrets/windows-dpapi/private/legacy-v2-account-sealer.ts";

const SOURCE = "C:\\preserved\\scripts\\c3_p_chrome_defaults.js";
const DIGEST = "a".repeat(64);

class ReplyProcess implements LegacyV2AccountProcess {
  input?: Uint8Array;
  sourcePath?: string;
  expectedSha256?: string;

  async run(
    input: Uint8Array,
    sourcePath: string,
    expectedSha256: string,
  ): Promise<Uint8Array> {
    this.input = input;
    this.sourcePath = sourcePath;
    this.expectedSha256 = expectedSha256;
    const output = Buffer.alloc(12);
    output.write("HACS", 0, "ascii");
    output.writeUInt8(1, 4);
    output.writeUInt32LE(3, 5);
    output.set([17, 19, 23], 9);
    return output;
  }
}

test("migrates by opaque source path and digest while clearing helper input", async () => {
  const process = new ReplyProcess();
  const entropy = Uint8Array.from([29, 31, 37]);
  const sealed = await new WindowsLegacyV2AccountSealer({
    sourcePath: SOURCE,
    expectedSha256: DIGEST,
    process,
  }).seal(entropy, new AbortController().signal);

  assert.deepEqual([...sealed], [17, 19, 23]);
  assert.equal(process.sourcePath, SOURCE);
  assert.equal(process.expectedSha256, DIGEST);
  assert.equal(process.input?.every((value) => value === 0), true);
  assert.deepEqual([...entropy], [29, 31, 37]);
});

test("rejects invalid migration authority before starting the helper", async () => {
  for (const options of [
    { sourcePath: "relative.js", expectedSha256: DIGEST },
    { sourcePath: SOURCE, expectedSha256: "not-a-digest" },
  ]) {
    const process = new ReplyProcess();
    assert.throws(
      () => new WindowsLegacyV2AccountSealer({ ...options, process }),
      /legacy v2 account migration invalid/u,
    );
    assert.equal(process.input, undefined);
  }
});

test("trusted migration helper reads the pinned legacy file and emits ciphertext only", async () => {
  const source = await readFile(
    "src/secrets/windows-dpapi/private/legacy-v2-account-sealer.ts",
    "utf8",
  );
  assert.match(source, /DataProtectionScope\.CurrentUser/u);
  assert.match(source, /ReadAllBytes/u);
  assert.match(source, /SHA256/u);
  assert.match(source, /ReparsePoint/u);
  assert.match(source, /legacyBytes\.Length -gt 65536/u);
  assert.match(source, /expectedSha256/u);
  assert.match(source, /DEFAULT_ACCOUNT_EMAIL/u);
  assert.match(source, /DEFAULT_ACCOUNT_PASSWORD/u);
  assert.match(source, /windowsHide:\s*true/u);
  assert.match(source, /shell:\s*false/u);
  assert.match(source, /stdio:\s*\["pipe",\s*"pipe",\s*"ignore"\]/u);
  assert.doesNotMatch(source, /process\.env/u);
  assert.doesNotMatch(source, /Get-FileHash/u);
  assert.doesNotMatch(source, /Write-(?:Output|Error|Host)|console\.(?:log|error)|stderr:/iu);
});

test("production child seals a pinned synthetic v2 defaults file", async () => {
  const root = await mkdtemp(join(tmpdir(), "hunt-v2-account-migration-"));
  try {
    const sourcePath = join(root, "c3_p_chrome_defaults.js");
    const source = [
      'const DEFAULT_ACCOUNT_EMAIL = "synthetic@example.invalid";',
      'const DEFAULT_ACCOUNT_PASSWORD = process.env.IGNORED || "synthetic-only";',
    ].join("\n");
    await writeFile(sourcePath, source, "utf8");
    const expectedSha256 = createHash("sha256").update(source).digest("hex");
    const sealed = await new WindowsLegacyV2AccountSealer({
      sourcePath,
      expectedSha256,
    }).seal(Uint8Array.from([41, 43, 47]), new AbortController().signal);
    assert.ok(sealed.byteLength > 32);
    sealed.fill(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
