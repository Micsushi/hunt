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

test("CLI help and version write only to stdout", async () => {
  for (const args of [["--help"], ["--version"]]) {
    const stdout = capture();
    const stderr = capture();
    assert.equal(await runCli(args, { stdout: stdout.stream, stderr: stderr.stream }), 0);
    assert.ok(stdout.read().trim());
    assert.equal(stderr.read(), "");
  }
});

test("CLI rejects unknown commands and missing inputs with usage exit", async () => {
  const stderr = capture();
  assert.equal(await runCli(["unknown"], { stderr: stderr.stream }), EXIT.usage);
  assert.match(stderr.read(), /Unknown command/);
  assert.throws(() => parseCli(["compare", "--before", "missing.tex"]), /does not exist/);
});

test("CLI preserves every character after the first equals sign in inline option values", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "resume-cooker-cli-"));
  const file = join(root, "resume=final.tex");
  await writeFile(file, "synthetic", "utf8");

  const parsed = parseCli(["build", "--resume=resume=final.tex"], root);

  assert.equal(parsed.options.resume, file);
});

test("CLI rejects invalid engines and preview sources outside the approved root before dispatch", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "resume-cooker-cli-"));
  await mkdir(join(root, "resume", "source"), { recursive: true });
  await writeFile(join(root, "resume", "source", "resume.tex"), "synthetic", "utf8");
  await writeFile(join(root, "outside.tex"), "synthetic", "utf8");
  assert.throws(
    () => parseCli(["build", "--resume", "outside.tex", "--engine", "typo"], root),
    /engine/i
  );
  assert.throws(
    () => parseCli(["preview", "--resume", "outside.tex"], root),
    /approved.*resume.*source/i
  );
  assert.equal(
    parseCli(["preview", "--resume", "resume/source/resume.tex", "--port", "0"], root).options.port,
    "0"
  );

  let dispatched = false;
  const stderr = capture();
  assert.equal(
    await runCli(["build", "--resume", "outside.tex", "--engine", "typo"], {
      cwd: root,
      stderr: stderr.stream,
      operations: operations({
        build: async () => {
          dispatched = true;
        }
      })
    }),
    EXIT.usage
  );
  assert.equal(dispatched, false);
});

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

test("CLI passes the caller workspace through build, check, and preview", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "resume-cooker-cli-"));
  await writeFile(join(root, "resume.tex"), "synthetic", "utf8");
  await mkdir(join(root, "resume", "source"), { recursive: true });
  await writeFile(join(root, "resume", "source", "resume.tex"), "synthetic", "utf8");
  const pdf = join(root, "resume", "output", "resume.pdf");
  const calls = [];
  const stderr = capture();
  const fakeOperations = operations({
    build: async (options) => {
      calls.push(["build", options]);
      await mkdir(join(root, "resume", "output"), { recursive: true });
      await writeFile(pdf, "pdf", "utf8");
      return { pdfPath: pdf, engine: "fixture" };
    },
    check: async (options) => {
      calls.push(["check", options]);
      return {
        schema_version: 1,
        status: "pass",
        content_left_machine: false,
        checks: []
      };
    },
    preview: async (options) => {
      calls.push(["preview", options]);
      setImmediate(() => process.emit("SIGTERM"));
      return {
        url: "http://127.0.0.1:4177",
        service: { getStatus: async () => ({ ok: true }) },
        close: async () => {}
      };
    }
  });

  await runCli(["build", "--resume", "resume.tex", "--json"], {
    cwd: root,
    stdout: capture().stream,
    operations: fakeOperations
  });
  await runCli(["check", "--resume", "resume.tex", "--json"], {
    cwd: root,
    stdout: capture().stream,
    operations: fakeOperations
  });
  const previewRun = runCli(["preview", "--resume", "resume/source/resume.tex", "--json"], {
    cwd: root,
    stdout: capture().stream,
    stderr: stderr.stream,
    operations: fakeOperations
  });
  await previewRun;

  assert.equal(calls[0][1].workspaceRoot, root);
  assert.equal(calls[0][1].outDir, join(root, "resume", "output"));
  assert.equal(calls[1][1].workspaceRoot, root);
  assert.equal(calls[2][1].repoRoot, root);
});

test("preview emits its ephemeral launch URL outside the persisted JSON report", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "resume-cooker-cli-"));
  await mkdir(join(root, "resume", "source"), { recursive: true });
  await writeFile(join(root, "resume", "source", "resume.tex"), "synthetic", "utf8");
  const stdout = capture();
  const stderr = capture();
  const launchUrl = "http://127.0.0.1:4177/?launch=ephemeral-capability";

  const running = runCli(["preview", "--resume", "resume/source/resume.tex", "--json"], {
    cwd: root,
    stdout: stdout.stream,
    stderr: stderr.stream,
    operations: operations({
      preview: async () => {
        setImmediate(() => process.emit("SIGTERM"));
        return {
          url: launchUrl,
          service: { getStatus: async () => ({ state: "running", ok: false }) },
          close: async () => {}
        };
      }
    })
  });
  await running;

  const report = JSON.parse(stdout.read());
  assert.equal(report.port, 4177);
  assert.doesNotMatch(JSON.stringify(report), /ephemeral-capability|launch=/);
  assert.equal(stderr.read().trim(), `Resume Cooker editor: ${launchUrl}`);
});

test("CLI JSON stdout is one report and warning exits zero", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "resume-cooker-cli-"));
  await writeFile(join(root, "resume.tex"), "synthetic", "utf8");
  const stdout = capture();
  const stderr = capture();
  const exit = await runCli(["check", "--resume", "resume.tex", "--json"], {
    cwd: root,
    stdout: stdout.stream,
    stderr: stderr.stream,
    idFactory: () => "run-1",
    operations: operations()
  });
  assert.equal(exit, 0);
  assert.equal(stderr.read(), "");
  assert.deepEqual(JSON.parse(stdout.read()), {
    schema_version: 1,
    status: "pass_with_warnings",
    content_left_machine: false,
    checks: [],
    command: "check",
    run_id: "run-1"
  });
});

test("CLI dispatches the packaged testers command with caller-resolved inputs", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "resume-cooker-cli-"));
  await writeFile(join(root, "resume.pdf"), "%PDF fixture", "utf8");
  await writeFile(join(root, "resume.txt"), "Synthetic resume", "utf8");
  let received;
  const stdout = capture();
  const exit = await runCli(
    [
      "testers",
      "--pdf",
      "resume.pdf",
      "--text",
      "resume.txt",
      "--tester-root",
      "../shared-testers",
      "--json"
    ],
    {
      cwd: root,
      stdout: stdout.stream,
      operations: operations({
        testers: async (options) => {
          received = options;
          return {
            schema_version: 1,
            status: "pass_with_warnings",
            content_left_machine: false,
            checks: []
          };
        }
      })
    }
  );

  assert.equal(exit, 0);
  assert.equal(received.pdf, join(root, "resume.pdf"));
  assert.equal(received.text, join(root, "resume.txt"));
  assert.equal(received.workspaceRoot, root);
  assert.equal(received.testerRoot, join(root, "..", "shared-testers"));
  assert.equal(JSON.parse(stdout.read()).command, "testers");
});

test("CLI report file and stdout identify the same run", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "resume-cooker-cli-"));
  await writeFile(join(root, "resume.tex"), "synthetic", "utf8");
  const stdout = capture();
  const out = join(root, "reports", "result.json");
  const exit = await runCli(
    ["check", "--resume", "resume.tex", "--out", "reports/result.json", "--json"],
    {
      cwd: root,
      stdout: stdout.stream,
      idFactory: () => "run-equivalent",
      operations: operations()
    }
  );
  assert.equal(exit, 0);
  const fromStdout = JSON.parse(stdout.read());
  const fromFile = JSON.parse(await readFile(out, "utf8"));
  assert.deepEqual(fromFile, fromStdout);
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
