import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { spawnSync } from "node:child_process";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { setImmediate } from "node:timers/promises";

import { encodeGmailImapQueryRequest, GmailImapClient } from "../../../../src/mailbox/providers/gmail/private/imap-client.ts";

test("connection check logs in and opens inbox read-only without searching or fetching mail", async () => {
  const source = await readFile("src/mailbox/providers/gmail/private/imap-client.ts", "utf8");
  const script = source.split("const imapQueryScript = String.raw`")[1]!.split("`;", 1)[0]!;
  for (const scenario of ["success", "auth", "network"]) {
    const setup = `
import imaplib
class FakeImap:
    def __init__(self, host, port, timeout):
        assert host == 'imap.gmail.com' and port == 993
        if '${scenario}' == 'network': raise OSError('synthetic')
    def login(self, address, password):
        assert address == 'fixture@example.invalid' and password == 'synthetic'
        if '${scenario}' == 'auth': raise imaplib.IMAP4.error('synthetic')
        return ('OK', [])
    def select(self, mailbox, readonly):
        assert mailbox == 'INBOX' and readonly is True
        return ('OK', [])
    def search(self, *args): raise AssertionError('must not search mail')
    def fetch(self, *args): raise AssertionError('must not fetch mail')
    def logout(self): pass
imaplib.IMAP4_SSL = FakeImap
`;
    const result = spawnSync(process.platform === "win32" ? "python.exe" : "python3", ["-c", setup + script], {
      input: JSON.stringify({ recipientAddress: "fixture@example.invalid", accountPassword: "synthetic" }),
      encoding: "utf8", windowsHide: true, timeout: 10_000,
    });
    assert.equal(result.status, scenario === "success" ? 0 : scenario === "auth" ? 2 : 3, result.stderr);
    assert.equal(result.stdout, scenario === "success" ? '{"connected":true}' : "");
  }
});

test("shared IMAP client caps processes and cancels waiting and active queries without early permit release", async t => {
  const children: Array<EventEmitter & { stdout: EventEmitter; stdin: EventEmitter & { end(): void }; kill(): boolean }> = [];
  let alive = 0, maximum = 0, kills = 0;
  t.mock.method(childProcess, "spawn", (() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(), stdin: Object.assign(new EventEmitter(), { end() {} }),
      kill() { kills++; return true; },
    });
    children.push(child); maximum = Math.max(maximum, ++alive);
    child.once("close", () => { alive--; });
    return child;
  }) as unknown as typeof childProcess.spawn);
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const client = new GmailImapClient();
  const controllers = Array.from({ length: 7 }, () => new AbortController());
  const queries = controllers.map(controller => client.query({ accountPassword: "synthetic", companyName: "Example",
    recipientAddress: "fixture@example.invalid", verificationHost: "example.wd5.myworkdayjobs.com" },
    { notBefore: "2026-08-15T12:00:00Z", notAfter: "2026-08-15T12:05:00Z" }, controller.signal));
  const settled = Promise.allSettled(queries);
  await setImmediate();
  assert.equal(children.length, 4);
  controllers[5]!.abort(); // Waiting caller must never spawn.
  controllers[0]!.abort();
  await setImmediate();
  assert.equal(kills, 1);
  assert.equal(children.length, 4); // Kill requested, but process has not closed.
  children[0]!.emit("close", null);
  await setImmediate();
  assert.equal(children.length, 5);
  let finished = 1;
  while (finished < 6) {
    const batch = children.slice(finished);
    for (const child of batch) { child.stdout.emit("data", Buffer.from('{"messages":[]}')); child.emit("close", 0); finished++; }
    await setImmediate();
  }
  const results = await settled;
  assert.equal(maximum, 4);
  assert.equal(children.length, 6);
  assert.equal(alive, 0);
  assert.deepEqual(results.map(result => result.status), ["rejected", "fulfilled", "fulfilled", "fulfilled", "fulfilled", "rejected", "fulfilled"]);
});


test("IMAP scopes a busy inbox to the verification host before applying its message bound", async () => {
  const source = await readFile("src/mailbox/providers/gmail/private/imap-client.ts", "utf8");
  const script = source.split("const imapQueryScript = String.raw`")[1]!.split("`;", 1)[0]!;
  const setup = `
import imaplib
from email.message import EmailMessage
message = EmailMessage()
message['To'] = 'applicant@example.invalid'
message['Date'] = 'Sat, 15 Aug 2026 12:02:00 +0000'
message['Subject'] = 'Account recovery'
message.set_content('https://example.wd5.myworkdayjobs.com/resetPassword?token=synthetic')
class FakeImap:
    def __init__(self, *args, **kwargs): pass
    def login(self, *args): return ('OK', [])
    def select(self, *args, **kwargs): return ('OK', [])
    def search(self, *args):
        scoped = 'TEXT' in args and args[args.index('TEXT') + 1] == '"example.wd5.myworkdayjobs.com"'
        return ('OK', [b'17' if scoped else b'1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17'])
    def fetch(self, message_id, *args):
        assert message_id == b'17'
        return ('OK', [(b'17', message.as_bytes())])
    def logout(self): pass
imaplib.IMAP4_SSL = FakeImap
`;
  const result = spawnSync(process.platform === "win32" ? "python.exe" : "python3", ["-c", setup + script], {
    input: encodeGmailImapQueryRequest({
      accountPassword: "synthetic-password", companyName: "Example",
      recipientAddress: "applicant@example.invalid", verificationHost: "example.wd5.myworkdayjobs.com",
    }, { notBefore: "2026-08-15T12:00:00.000Z", notAfter: "2026-08-15T12:05:00.000Z" }),
    encoding: "utf8", windowsHide: true, timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).messages.length, 1);
});
