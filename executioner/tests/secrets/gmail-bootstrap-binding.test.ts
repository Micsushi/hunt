import assert from "node:assert/strict";
import test from "node:test";

import {
  admitGmailBootstrapInput,
  deriveSenderPolicyId,
} from "../../src/composition/private/s2-gmail-bootstrap-binding.ts";

const expected = {
  revisionId: "revision_abcdefghijklmnop",
  journeyId: "journey_abcdefghijklmnop",
  gmailHandleId: "secret_handle_fedcba9876543210fedcba9876543210",
};

test("admits exact bound installed-client and sender-policy paths", () => {
  const input = {
    schemaVersion: 1,
    contractRevision: "s2-gmail-bootstrap-v3",
    ...expected,
    desktopClientId: "1234567890-example1.apps.googleusercontent.com",
    installedClientConfigPath: "C:\\Users\\example\\AppData\\Local\\Hunt\\google-installed-client.json",
    senderPolicyConfigPath: "C:\\Users\\example\\AppData\\Local\\Hunt\\gmail-sender-policy.json",
    verificationHost: "wd5.myworkday.com",
  };
  assert.deepEqual(admitGmailBootstrapInput(input, expected), input);
  assert.match(
    deriveSenderPolicyId(expected),
    /^sender_policy_[0-9a-f]{32}$/u,
  );
  assert.equal(deriveSenderPolicyId(expected), deriveSenderPolicyId(expected));
});

test("rejects extra fields, wrong binding, web clients, and unsafe hosts", () => {
  const base = {
    schemaVersion: 1,
    contractRevision: "s2-gmail-bootstrap-v3",
    ...expected,
    desktopClientId: "1234567890-example1.apps.googleusercontent.com",
    installedClientConfigPath: "C:\\Users\\example\\AppData\\Local\\Hunt\\google-installed-client.json",
    senderPolicyConfigPath: "C:\\Users\\example\\AppData\\Local\\Hunt\\gmail-sender-policy.json",
    verificationHost: "wd5.myworkday.com",
  };
  for (const value of [
    { ...base, senderAddress: "private@example.invalid" },
    { ...base, journeyId: "journey_fedcba9876543210" },
    { ...base, desktopClientId: "client-secret-value" },
    { ...base, installedClientConfigPath: "relative.json" },
    { ...base, installedClientConfigPath: "C:\\Users\\example\\..\\google.json" },
    { ...base, installedClientConfigPath: `C:\\${"x".repeat(4094)}` },
    { ...base, senderPolicyConfigPath: "relative.json" },
    { ...base, senderPolicyConfigPath: "C:\\Users\\example\\..\\sender.json" },
    { ...base, senderPolicyConfigPath: `C:\\${"x".repeat(4094)}` },
    { ...base, senderPolicyConfigPath: base.installedClientConfigPath.toUpperCase() },
    { ...base, verificationHost: "https://wd5.myworkday.com/token" },
    { ...base, verificationHost: "127.0.0.1" },
  ]) {
    assert.equal(admitGmailBootstrapInput(value, expected), null);
  }
});
