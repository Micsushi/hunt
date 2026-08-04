import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  Stage2VerificationReplayLedger,
  sweepExpiredVerificationReplayClaims,
} from "../../src/composition/private/s2-verification-replay-ledger.ts";

const signal = () => new AbortController().signal;
const coordinate = (value: number) => new Uint8Array(32).fill(value);

test("verification replay claims survive reconstruction and concurrent claims", async () => {
  const root = await mkdtemp(join(tmpdir(), "hunt-replay-ledger-"));
  try {
    const options = {
      root,
      recipientBindingId: "recipient_0123456789abcdef0123456789abcdef",
      host: "tenant.example.invalid",
      tenant: "tenant",
      now: () => "2026-08-04T12:00:00.000Z",
    } as const;
    const first = new Stage2VerificationReplayLedger(options);
    const second = new Stage2VerificationReplayLedger(options);
    assert.equal(await first.claim(coordinate(1), signal()), "claimed");
    assert.equal(await second.claim(coordinate(1), signal()), "replayed");

    const raced = await Promise.all([
      first.claim(coordinate(2), signal()),
      second.claim(coordinate(2), signal()),
    ]);
    assert.deepEqual([...raced].sort(), ["claimed", "replayed"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verification replay ledger persists only bounded value-free records", async () => {
  const root = await mkdtemp(join(tmpdir(), "hunt-replay-ledger-private-"));
  const sentinels = {
    recipientBindingId: "recipient_0123456789abcdef0123456789abcdef",
    host: "private-tenant.example.invalid",
    tenant: "private-tenant",
  } as const;
  try {
    const ledger = new Stage2VerificationReplayLedger({
      root,
      ...sentinels,
      now: () => "2026-08-04T12:00:00.000Z",
    });
    assert.equal(await ledger.claim(coordinate(7), signal()), "claimed");
    const names = await readdir(root);
    assert.equal(names.length, 1);
    const stored = await readFile(join(root, names[0]!), "utf8");
    assert.deepEqual(JSON.parse(stored), {
      schemaVersion: 1,
      replayRevision: "s2-verification-replay-v1",
      consumedAt: "2026-08-04T12:00:00.000Z",
      retainUntil: "2026-09-03T12:00:00.000Z",
    });
    assert.doesNotMatch(
      `${names[0]}\n${stored}`,
      /private-tenant|recipient_|token|message|https?:/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verification replay ledger fails closed for unsafe roots and malformed coordinates", async () => {
  const root = await mkdtemp(join(tmpdir(), "hunt-replay-ledger-denied-"));
  const outside = await mkdtemp(join(tmpdir(), "hunt-replay-ledger-outside-"));
  try {
    const link = join(root, "linked");
    await symlink(outside, link, "junction");
    const ledger = new Stage2VerificationReplayLedger({
      root: link,
      recipientBindingId: "recipient_0123456789abcdef0123456789abcdef",
      host: "tenant.example.invalid",
      tenant: "tenant",
      now: () => "2026-08-04T12:00:00.000Z",
    });
    await assert.rejects(ledger.claim(coordinate(3), signal()));

    await mkdir(join(root, "safe"));
    const safe = new Stage2VerificationReplayLedger({
      root: join(root, "safe"),
      recipientBindingId: "recipient_0123456789abcdef0123456789abcdef",
      host: "tenant.example.invalid",
      tenant: "tenant",
      now: () => "2026-08-04T12:00:00.000Z",
    });
    await assert.rejects(safe.claim(new Uint8Array(31), signal()));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("verification replay retention sweep removes only expired opaque claims", async () => {
  const root = await mkdtemp(join(tmpdir(), "hunt-replay-ledger-sweep-"));
  let now = "2026-08-01T12:00:00.000Z";
  try {
    const ledger = new Stage2VerificationReplayLedger({
      root,
      recipientBindingId: "recipient_0123456789abcdef0123456789abcdef",
      host: "tenant.example.invalid",
      tenant: "tenant",
      now: () => now,
    });
    assert.equal(await ledger.claim(coordinate(11), signal()), "claimed");
    now = "2026-08-20T12:00:00.000Z";
    assert.equal(await ledger.claim(coordinate(12), signal()), "claimed");
    assert.deepEqual(
      sweepExpiredVerificationReplayClaims(root, "2026-09-05T12:00:00.000Z"),
      { removed: 1, retained: 1 },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
