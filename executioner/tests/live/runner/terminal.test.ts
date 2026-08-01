import assert from "node:assert/strict";
import test from "node:test";

import { formatStage2TerminalResult } from "../../../src/live/runner/terminal.ts";

test("terminal output preserves bounded factual target details", () => {
  assert.equal(formatStage2TerminalResult({
    ok: false,
    code: "posting_unavailable",
    fact: { kind: "posting_unavailable", reason: "closed" },
  }), '{"status":"failed","code":"posting_unavailable","fact":{"kind":"posting_unavailable","reason":"closed"}}\n');
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
