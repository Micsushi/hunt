import assert from "node:assert/strict";
import test from "node:test";

import {
  formatStage2ReviewJourneyTerminal,
  formatStage2TerminalResult,
} from "../../../src/live/runner/terminal.ts";

test("review journey terminal preserves the stable inner error code", () => {
  assert.equal(formatStage2ReviewJourneyTerminal({
    ok: false,
    code: "account_verification_failed",
    terminal: {
      schemaVersion: 4,
      journeyId: "journey_1234567890abcdef" as never,
      status: "failed",
      completedPages: 0,
      errorCode: "secret_handle_expired",
    },
  } as never), '{"status":"failed","code":"account_verification_failed","terminalStatus":"failed","errorCode":"secret_handle_expired"}\n');
});

test("review journey terminal preserves success output", () => {
  assert.equal(formatStage2ReviewJourneyTerminal({ ok: true } as never),
    '{"status":"passed","checkpoint":"review","submitActivated":false}\n');
});

test("review journey terminal preserves outer failure for cancellation", () => {
  assert.equal(formatStage2ReviewJourneyTerminal({
    ok: false,
    code: "operation_cancelled",
    terminal: { status: "cancelled" },
  } as never),
  '{"status":"failed","code":"operation_cancelled","terminalStatus":"cancelled"}\n');
});

test("review journey terminal omits blocked factual details", () => {
  assert.equal(formatStage2ReviewJourneyTerminal({
    ok: false,
    code: "access_control",
    terminal: {
      status: "blocked",
      factualOutcome: { source: "account_access", result: { private: "value" } },
      journeyId: "journey_private",
      completedPages: 0,
    },
  } as never),
  '{"status":"failed","code":"access_control","terminalStatus":"blocked"}\n');
});

test("terminal output preserves bounded factual target details", () => {
  assert.equal(formatStage2TerminalResult({
    ok: false,
    code: "posting_unavailable",
    fact: { kind: "posting_unavailable", reason: "closed" },
  }), '{"status":"blocked","code":"posting_unavailable","fact":{"kind":"posting_unavailable","reason":"closed"}}\n');
});

test("terminal output emits only admitted success references", () => {
  assert.equal(formatStage2TerminalResult({
    ok: true,
    acceptance: {
      checkpoint: "account_access",
      sourceRevision: "0123456789abcdef0123456789abcdef01234567",
      revisionId: "revision_abcdefghijklmnop",
    },
  }), '{"status":"passed","checkpoint":"account_access","sourceRevision":"0123456789abcdef0123456789abcdef01234567","revisionId":"revision_abcdefghijklmnop"}\n');
});

test("terminal output admits mailbox-candidate success without mailbox values", () => {
  assert.equal(formatStage2TerminalResult({
    ok: true,
    acceptance: {
      checkpoint: "mailbox_candidate",
      sourceRevision: "0123456789abcdef0123456789abcdef01234567",
      revisionId: "revision_abcdefghijklmnop",
    },
  }), '{"status":"passed","checkpoint":"mailbox_candidate","sourceRevision":"0123456789abcdef0123456789abcdef01234567","revisionId":"revision_abcdefghijklmnop"}\n');
});

test("terminal output admits account-verified success without account or mailbox values", () => {
  assert.equal(formatStage2TerminalResult({
    ok: true,
    acceptance: {
      checkpoint: "account_verified",
      sourceRevision: "0123456789abcdef0123456789abcdef01234567",
      revisionId: "revision_abcdefghijklmnop",
    },
  }), '{"status":"passed","checkpoint":"account_verified","sourceRevision":"0123456789abcdef0123456789abcdef01234567","revisionId":"revision_abcdefghijklmnop"}\n');
});

test("terminal output admits pre-Review success without application values", () => {
  assert.equal(formatStage2TerminalResult({
    ok: true,
    acceptance: {
      checkpoint: "pre_review",
      sourceRevision: "0123456789abcdef0123456789abcdef01234567",
      revisionId: "revision_abcdefghijklmnop",
    },
  }), '{"status":"passed","checkpoint":"pre_review","sourceRevision":"0123456789abcdef0123456789abcdef01234567","revisionId":"revision_abcdefghijklmnop"}\n');
});

test("terminal output preserves only a bounded account-verification fact", () => {
  assert.equal(formatStage2TerminalResult({
    ok: false,
    code: "manual_intervention",
    fact: { kind: "manual_intervention", reason: "mfa" },
  }), '{"status":"blocked","code":"manual_intervention","fact":{"kind":"manual_intervention","reason":"mfa"}}\n');
});
