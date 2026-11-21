import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setImmediate } from "node:timers";
import { EXIT, parseCli, runCli } from "./resume-cooker.mjs";

function capture() {
  let value = "";
  return {
    stream: { write: (chunk) => (value += chunk) },
    read: () => value
  };
}

function operations(overrides = {}) {
  const report = {
    schema_version: 1,
    status: "pass_with_warnings",
    content_left_machine: false,
    checks: []
  };
  return {
    tools: async () => [{ tool: "node", usable: true }],
    build: async () => ({ pdfPath: "", engine: "test" }),
    check: async () => report,
    compare: async () => report,
    testers: async () => report,
    preview: async () => {
      throw new Error("not used");
    },
    ...overrides
  };
}

test("CLI resolves caller paths and rejects API key without explicit consent", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "resume-cooker-cli-"));
  await writeFile(join(root, "resume.tex"), "synthetic", "utf8");
  const parsed = parseCli(["check", "--resume", "resume.tex", "--suite", "local"], root);
  assert.equal(parsed.options.resume, join(root, "resume.tex"));
  assert.equal(parsed.options["out-dir"], join(root, "resume", "output"));
  assert.equal(parsed.options["text-out"], join(root, "resume", "output", "current.txt"));
  assert.throws(
    () => parseCli(["check", "--resume", "resume.tex", "--suite", "api", "--json"], root),
    /explicit --allow-api/
  );
});

test("CLI maps quality, capability, and internal outcomes to D7 exits", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "resume-cooker-cli-"));
  await writeFile(join(root, "before.tex"), "before", "utf8");
  await writeFile(join(root, "after.tex"), "after", "utf8");
  const quality = operations({
    compare: async () => ({
      schema_version: 1,
      status: "fail",
      content_left_machine: false,
      checks: []
    })
  });
  assert.equal(
    await runCli(["compare", "--before", "before.tex", "--after", "after.tex", "--json"], {
      cwd: root,
      operations: quality,
      stdout: capture().stream
    }),
    EXIT.quality
  );
  const stderr = capture();
  assert.equal(
    await runCli(["tools", "--require-pdf-engine", "true"], {
      operations: operations({ tools: async () => [] }),
      stderr: stderr.stream
    }),
    EXIT.unavailable
  );
  assert.match(stderr.read(), /No usable PDF build engine/);
});

test("CLI sanitizer removes absolute paths and secrets from stable output", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "resume-cooker-cli-"));
  await writeFile(join(root, "resume.tex"), "synthetic", "utf8");
  const stdout = capture();
  await runCli(["check", "--resume", "resume.tex", "--json"], {
    cwd: root,
    stdout: stdout.stream,
    operations: operations({
      check: async () => ({
        schema_version: 1,
        status: "pass",
        content_left_machine: false,
        summary: `token=private C:\\Users\\person\\resume.tex ${root}`
      })
    })
  });
  assert.doesNotMatch(stdout.read(), /private|C:\\Users|resume-cooker-cli-/);
  assert.match(stdout.read(), /\[redacted\]|\[path\]/);
});
