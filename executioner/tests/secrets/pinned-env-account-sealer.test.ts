import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  WindowsPinnedEnvAccountSealer,
  type PinnedEnvAccountProcess,
} from "../../src/secrets/windows-dpapi/private/pinned-env-account-sealer.ts";

const SOURCE = "C:\\preserved\\hunt\\.env";
const DIGEST = "b".repeat(64);

class ReplyProcess implements PinnedEnvAccountProcess {
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

test("seals account keys from only a pinned absolute env file", async () => {
  const process = new ReplyProcess();
  const entropy = Uint8Array.from([29, 31, 37]);
  const sealed = await new WindowsPinnedEnvAccountSealer({
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

test("rejects invalid pinned env authority before starting the helper", () => {
  for (const options of [
    { sourcePath: "relative.env", expectedSha256: DIGEST },
    { sourcePath: SOURCE, expectedSha256: "not-a-digest" },
  ]) {
    const process = new ReplyProcess();
    assert.throws(
      () => new WindowsPinnedEnvAccountSealer({ ...options, process }),
      /pinned env account migration invalid/u,
    );
    assert.equal(process.input, undefined);
  }
});

test("trusted helper reads only exact test-account keys and emits ciphertext only", async () => {
  const source = await readFile(
    "src/secrets/windows-dpapi/private/pinned-env-account-sealer.ts",
    "utf8",
  );
  assert.match(source, /DataProtectionScope\.CurrentUser/u);
  assert.match(source, /ReadAllBytes/u);
  assert.match(source, /SHA256/u);
  assert.match(source, /ReparsePoint/u);
  assert.match(source, /envBytes\.Length -gt 65536/u);
  assert.match(source, /expectedSha256/u);
  assert.match(source, /HUNT_C3_TEST_ACCOUNT_EMAIL/u);
  assert.match(source, /HUNT_C3_TEST_ACCOUNT_PASSWORD/u);
  assert.doesNotMatch(source, /HUNT_C3_MAIL_(?:EMAIL|PASSWORD)/u);
  assert.match(source, /windowsHide:\s*true/u);
  assert.match(source, /shell:\s*false/u);
  assert.match(source, /stdio:\s*\["pipe",\s*"pipe",\s*"ignore"\]/u);
  assert.doesNotMatch(source, /process\.env/u);
  assert.doesNotMatch(source, /Get-FileHash/u);
  assert.doesNotMatch(source, /Write-(?:Output|Error|Host)|console\.(?:log|error)|stderr:/iu);
});

test("production child seals a pinned synthetic env file", async () => {
  const root = await mkdtemp(join(tmpdir(), "hunt-env-account-migration-"));
  try {
    const sourcePath = join(root, ".env");
    const source = [
      "HUNT_C3_MAIL_EMAIL=wrong-mailbox@example.invalid",
      "HUNT_C3_MAIL_PASSWORD=wrong-mailbox-secret",
      "HUNT_C3_TEST_ACCOUNT_EMAIL=synthetic@example.invalid",
      "HUNT_C3_TEST_ACCOUNT_PASSWORD=synthetic-only",
    ].join("\n");
    await writeFile(sourcePath, source, "utf8");
    const expectedSha256 = createHash("sha256").update(source).digest("hex");
    const sealed = await new WindowsPinnedEnvAccountSealer({
      sourcePath,
      expectedSha256,
    }).seal(Uint8Array.from([41, 43, 47]), new AbortController().signal);
    assert.ok(sealed.byteLength > 32);
    sealed.fill(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

