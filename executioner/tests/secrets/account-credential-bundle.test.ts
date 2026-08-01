import assert from "node:assert/strict";
import { test } from "node:test";

import {
  decodeAccountCredentialBundleV1,
  encodeAccountCredentialBundleV1,
} from "../../src/secrets/windows-dpapi/private/account-credential-bundle.ts";

const bytes = (...values: number[]) => Uint8Array.from(values);
const input = () => ({
  email: bytes(101, 109, 97, 105, 108),
  password: bytes(112, 97, 115, 115),
});

test("AccountCredentialBundleV1 round-trips named email then password without swapping", () => {
  const encoded = encodeAccountCredentialBundleV1(input());
  assert.notEqual(encoded, null);
  if (encoded === null) return;
  assert.deepEqual([...encoded.subarray(0, 7)], [72, 65, 67, 66, 1, 2, 1]);

  const decoded = decodeAccountCredentialBundleV1(encoded);
  assert.notEqual(decoded, null);
  assert.deepEqual([...(decoded?.email ?? [])], [...input().email]);
  assert.deepEqual([...(decoded?.password ?? [])], [...input().password]);
});

test("AccountCredentialBundleV1 rejects corrupt version, tag order, count, truncation, trailing data, and legacy payload", () => {
  const encoded = encodeAccountCredentialBundleV1(input());
  assert.notEqual(encoded, null);
  if (encoded === null) return;

  const version = encoded.slice();
  version[4] = 2;
  const firstTag = encoded.slice();
  firstTag[6] = 2;
  const secondTag = encoded.slice();
  secondTag[16] = 1;
  const count = encoded.slice();
  count[5] = 3;
  const truncated = encoded.subarray(0, encoded.length - 1);
  const trailing = Uint8Array.from([...encoded, 0]);
  const legacy = bytes(2, 0, 0, 0, 1, 0, 0, 0, 65, 1, 0, 0, 0, 66);

  for (const candidate of [
    version,
    firstTag,
    secondTag,
    count,
    truncated,
    trailing,
    legacy,
  ]) {
    assert.equal(decodeAccountCredentialBundleV1(candidate), null);
  }
});

test("AccountCredentialBundleV1 rejects empty, oversized, and invalid UTF-8 fields", () => {
  const oversizeEmail = new Uint8Array(321).fill(65);
  const oversizePassword = new Uint8Array(4097).fill(65);
  const invalidUtf8 = bytes(0xc0, 0xaf);

  for (const candidate of [
    { email: new Uint8Array(), password: input().password },
    { email: input().email, password: new Uint8Array() },
    { email: oversizeEmail, password: input().password },
    { email: input().email, password: oversizePassword },
    { email: invalidUtf8, password: input().password },
    { email: input().email, password: invalidUtf8 },
  ]) {
    assert.equal(encodeAccountCredentialBundleV1(candidate), null);
  }
});
