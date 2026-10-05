import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, test } from "node:test";
import * as buildLib from "./build-lib.mjs";

const { buildPdf, detectEngine, getRepoRoot, parseArgs } = buildLib;

const tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

test("parseArgs reads flag values and boolean flags", () => {
  assert.deepEqual(
    parseArgs(["--source", "resume/source/current.tex", "--clean", "--engine", "pdflatex"]),
    {
      source: "resume/source/current.tex",
      clean: "true",
      engine: "pdflatex"
    }
  );
});

test("capability probe reports an absent command without running it", async () => {
  let ranCommand = false;
  const result = await buildLib.probeCommand("latexmk", {
    commandExistsImpl: async () => false,
    runCommandImpl: async () => {
      ranCommand = true;
    }
  });

  assert.deepEqual(result, {
    available: false,
    usable: false,
    reason: "latexmk is not installed.",
    metadata: { command: "latexmk" }
  });
  assert.equal(ranCommand, false);
});

test("capability probe invokes the Windows npm command shim", async () => {
  const calls = [];
  const result = await buildLib.probeCommand("npm", {
    commandExistsImpl: async () => true,
    runCommandImpl: async (command, args) => {
      calls.push({ command, args });
      return { code: 0, stdout: "11.9.0\n", stderr: "" };
    }
  });

  assert.equal(result.usable, true);
  assert.deepEqual(calls, [
    process.platform === "win32"
      ? {
          command: process.env.ComSpec || "cmd.exe",
          args: ["/d", "/s", "/c", "npm.cmd", "--version"]
        }
      : {
          command: "npm",
          args: ["--version"]
        }
  ]);
});

test("Docker capability requires valid daemon server evidence", async () => {
  const result = await buildLib.probeDockerDaemon({
    probeCommandImpl: async () => ({
      available: true,
      usable: true,
      reason: "docker is available.",
      metadata: { command: "docker" }
    }),
    runCommandImpl: async (command, args, options) => {
      assert.equal(command, "docker");
      assert.deepEqual(args, ["info", "--format", "{{json .ServerVersion}}"]);
      assert.equal(options.timeoutMs, 5000);
      return { code: 0, stdout: '"27.5.1"\n', stderr: "" };
    }
  });

  assert.deepEqual(result, {
    available: true,
    usable: true,
    reason: "Docker daemon is reachable.",
    metadata: { command: "docker", serverVersion: "27.5.1" }
  });
});

test("Docker capability rejects nonzero daemon results without leaking details", async () => {
  const error = Object.assign(new Error("failure"), {
    code: 1,
    stderr: "open //./pipe/docker_engine: access denied"
  });
  const result = await buildLib.probeDockerDaemon({
    probeCommandImpl: async () => ({ available: true, usable: true }),
    runCommandImpl: async () => {
      throw error;
    }
  });

  assert.deepEqual(result, {
    available: true,
    usable: false,
    reason: "Docker daemon probe failed.",
    metadata: { command: "docker", exitCode: 1 }
  });
  assert.doesNotMatch(JSON.stringify(result), /docker_engine|access denied/i);
});

test("Docker capability rejects zero-exit connection errors on either stream", async () => {
  const result = await buildLib.probeDockerDaemon({
    probeCommandImpl: async () => ({ available: true, usable: true }),
    runCommandImpl: async () => ({
      code: 0,
      stdout: '"27.5.1"\n',
      stderr: "Cannot connect to the Docker daemon at a machine-local socket."
    })
  });

  assert.deepEqual(result, {
    available: true,
    usable: false,
    reason: "Docker CLI is installed, but the daemon is not reachable.",
    metadata: { command: "docker" }
  });

  const stdoutResult = await buildLib.probeDockerDaemon({
    probeCommandImpl: async () => ({ available: true, usable: true }),
    runCommandImpl: async () => ({
      code: 0,
      stdout: "Cannot connect to the Docker daemon.",
      stderr: ""
    })
  });
  assert.equal(stdoutResult.usable, false);
  assert.match(stdoutResult.reason, /not reachable/);
});

test("Docker capability rejects empty and malformed server evidence", async () => {
  for (const stdout of ["", "not-json", '""']) {
    const result = await buildLib.probeDockerDaemon({
      probeCommandImpl: async () => ({ available: true, usable: true }),
      runCommandImpl: async () => ({ code: 0, stdout, stderr: "" })
    });

    assert.equal(result.available, true);
    assert.equal(result.usable, false);
    assert.match(result.reason, /server response/);
  }
});

test("Docker capability reports a bounded timeout", async () => {
  const error = Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
  const result = await buildLib.probeDockerDaemon({
    timeoutMs: 25,
    probeCommandImpl: async () => ({ available: true, usable: true }),
    runCommandImpl: async () => {
      throw error;
    }
  });

  assert.deepEqual(result, {
    available: true,
    usable: false,
    reason: "Docker daemon probe timed out after 25 ms.",
    metadata: { command: "docker", timedOut: true }
  });
});

test("runCommand terminates a timed-out child process", async () => {
  const startedAt = Date.now();
  let childPid;
  let timeoutError;
  try {
    await buildLib.runCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      quiet: true,
      timeoutMs: 50,
      onSpawn: (child) => {
        childPid = child.pid;
      }
    });
  } catch (error) {
    timeoutError = error;
  }

  assert.equal(timeoutError.code, "ETIMEDOUT");
  assert.ok(Date.now() - startedAt < 2000);
  assert.ok(Number.isInteger(childPid) && childPid > 0);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  assert.throws(
    () => process.kill(childPid, 0),
    (error) => error.code === "ESRCH"
  );
});

test("runCommand cancellation terminates its child process", async () => {
  const controller = new AbortController();
  let childPid;
  const running = buildLib.runCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    quiet: true,
    signal: controller.signal,
    onSpawn: (child) => {
      childPid = child.pid;
    }
  });
  controller.abort();
  await assert.rejects(running, (error) => error.code === "ABORT_ERR");
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  assert.throws(
    () => process.kill(childPid, 0),
    (error) => error.code === "ESRCH"
  );
});

test("runCommand enforces a combined output ceiling and terminates the producer", async () => {
  let childPid;
  const running = buildLib.runCommand(
    process.execPath,
    ["-e", 'process.stdout.write("x".repeat(200000)); setInterval(() => {}, 1000)'],
    {
      maxOutputBytes: 1024,
      onSpawn: (child) => {
        childPid = child.pid;
      },
      quiet: true,
      timeoutMs: 5000
    }
  );

  await assert.rejects(
    running,
    (error) =>
      error.code === "EOUTPUTLIMIT" &&
      Buffer.byteLength(error.stdout) <= 1100 &&
      /truncated/.test(error.stdout)
  );
  assert.ok(Number.isInteger(childPid) && childPid > 0);
  assert.equal(await isProcessRunning(childPid), false);
});

test("runCommand cancellation terminates descendant processes", async () => {
  const fixtureDir = await mkdtemp(join(tmpdir(), "resume-cooker-process-tree-"));
  tempDirs.push(fixtureDir);
  const pidPath = join(fixtureDir, "descendant.pid");
  const controller = new AbortController();
  const parentScript = [
    'const { spawn } = require("node:child_process");',
    'const { writeFileSync } = require("node:fs");',
    'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
    `writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));`,
    "setInterval(() => {}, 1000);"
  ].join("");
  const running = buildLib.runCommand(process.execPath, ["-e", parentScript], {
    quiet: true,
    signal: controller.signal
  });

  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await readFile(pidPath, "utf8");
      break;
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
  }
  const descendantPid = Number(await readFile(pidPath, "utf8"));
  controller.abort();
  await assert.rejects(running, (error) => error.code === "ABORT_ERR");
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  assert.equal(await isProcessRunning(descendantPid), false);
});

test(
  "runCommand timeout force-terminates a SIGTERM-resistant descendant process",
  { skip: process.platform === "win32" },
  async () => {
    const fixtureDir = await mkdtemp(join(tmpdir(), "resume-cooker-resistant-tree-"));
    tempDirs.push(fixtureDir);
    const pidPath = join(fixtureDir, "descendant.pid");
    const childScript = ['process.on("SIGTERM", () => {});', "setInterval(() => {}, 1000);"].join(
      ""
    );
    const parentScript = [
      'const { spawn } = require("node:child_process");',
      'const { writeFileSync } = require("node:fs");',
      'process.on("SIGTERM", () => {});',
      `const child = spawn(process.execPath, ["-e", ${JSON.stringify(childScript)}], { stdio: "ignore" });`,
      `writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));`,
      "setInterval(() => {}, 1000);"
    ].join("");
    const running = buildLib.runCommand(process.execPath, ["-e", parentScript], {
      quiet: true,
      timeoutMs: 100
    });

    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        await readFile(pidPath, "utf8");
        break;
      } catch {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
      }
    }
    const descendantPid = Number(await readFile(pidPath, "utf8"));
    await assert.rejects(running, (error) => error.code === "ETIMEDOUT");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    assert.equal(await isProcessRunning(descendantPid), false);
  }
);

test("detectEngine prefers latexmk, then pdflatex, then docker", async () => {
  const probe = (usable) => async (engine) => ({
    available: usable.includes(engine),
    usable: usable.includes(engine),
    reason: usable.includes(engine) ? `${engine} is available.` : `${engine} is unavailable.`
  });

  assert.equal(await detectEngine("auto", probe(["latexmk", "pdflatex", "docker"])), "latexmk");
  assert.equal(await detectEngine("auto", probe(["pdflatex", "docker"])), "pdflatex");
  assert.equal(await detectEngine("auto", probe(["docker"])), "docker");
  assert.equal(await detectEngine("auto", probe([])), "missing");
});

test("detectEngine validates explicit engines before selection", async () => {
  const calls = [];
  const engine = await detectEngine("pdflatex", async (candidate) => {
    calls.push(candidate);
    return { available: true, usable: true, reason: `${candidate} is available.` };
  });

  assert.equal(engine, "pdflatex");
  assert.deepEqual(calls, ["pdflatex"]);
});

test("detectEngine rejects an explicit unusable Docker daemon", async () => {
  await assert.rejects(
    detectEngine("docker", async () => ({
      available: true,
      usable: false,
      reason: "Docker CLI is installed, but the daemon is not reachable."
    })),
    (error) =>
      error.code === "CAPABILITY_UNAVAILABLE" &&
      /Docker CLI is installed, but the daemon is not reachable/.test(error.message)
  );
});

test("buildPdf resolves source, output directory, and pdf path without real TeX", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "resume-cooker-build-"));
  tempDirs.push(outDir);

  const calls = [];
  const result = await buildPdf({
    source: "resume/source/current.tex",
    outDir,
    engine: "pdflatex",
    probeEngine: async () => ({ available: true, usable: true, reason: "ready" }),
    runCommand: async (command, args, options) => {
      calls.push({ command, args, options });
      const outputArg = args.find((arg) => arg.startsWith("-output-directory="));
      const commandOutDir = outputArg.slice("-output-directory=".length);
      await writeFile(join(commandOutDir, "current.pdf"), "public fixture PDF");
      return { code: 0, stdout: "", stderr: "" };
    }
  });

  assert.equal(result.engine, "pdflatex");
  assert.equal(result.source, resolve(getRepoRoot(), "resume/source/current.tex"));
  assert.equal(result.outDir, outDir);
  assert.equal(result.pdfPath, join(outDir, "current.pdf"));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "pdflatex");
  assert.deepEqual(calls[0].args.slice(0, 2), ["-interaction=nonstopmode", "-halt-on-error"]);
  assert.match(calls[0].args[2], /^-output-directory=/);
  assert.equal(calls[0].args[3], resolve(getRepoRoot(), "resume/source/current.tex"));
  assert.equal(calls[0].options.cwd, getRepoRoot());
});

test("buildPdf mounts and stages within an explicit caller workspace", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "resume-cooker-workspace-"));
  tempDirs.push(workspaceRoot);
  const source = join(workspaceRoot, "resume", "source", "sample.tex");
  const outDir = join(workspaceRoot, "resume", "output");
  await mkdir(dirname(source), { recursive: true });
  await writeFile(source, "\\documentclass{article}");
  let dockerArgs;

  const result = await buildPdf({
    workspaceRoot,
    source: "resume/source/sample.tex",
    outDir: "resume/output",
    engine: "docker",
    probeEngine: async () => ({ available: true, usable: true, reason: "ready" }),
    runCommand: async (command, args) => {
      assert.equal(command, "docker");
      dockerArgs = args;
      const outputMount = args
        .map((arg, index) => (arg === "--mount" ? args[index + 1] : null))
        .filter(Boolean)
        .find((mount) => /target=\/output$/.test(mount));
      const staged = outputMount.match(/^type=bind,source=(.*),target=\/output$/)[1];
      await writeFile(join(staged, "sample.pdf"), "fixture");
      return { code: 0, stdout: "", stderr: "" };
    }
  });

  assert.ok(dockerArgs.includes("--network=none"));
  assert.ok(dockerArgs.includes("--read-only"));
  assert.deepEqual(
    dockerArgs.slice(dockerArgs.indexOf("--cap-drop"), dockerArgs.indexOf("--cap-drop") + 2),
    ["--cap-drop", "ALL"]
  );
  assert.ok(dockerArgs.includes("no-new-privileges"));
  assert.ok(dockerArgs.includes("--pids-limit=128"));
  assert.ok(dockerArgs.includes("--memory=1g"));
  assert.ok(dockerArgs.includes("--cpus=2"));
  const mounts = dockerArgs
    .map((arg, index) => (arg === "--mount" ? dockerArgs[index + 1] : null))
    .filter(Boolean);
  assert.equal(mounts.length, 2);
  assert.ok(
    mounts.includes(`type=bind,source=${dirname(source)},target=/workspace/source,readonly`)
  );
  assert.ok(mounts.some((mount) => /target=\/output$/.test(mount)));
  assert.doesNotMatch(dockerArgs.join(" "), /docker\.sock|\.ssh|\.aws|\.config/);
  assert.match(
    dockerArgs.find((arg) => arg.startsWith("texlive/texlive@sha256:")),
    /^texlive\/texlive@sha256:[a-f0-9]{64}$/
  );
  assert.equal(dockerArgs.at(-1), "/workspace/source/sample.tex");
  assert.equal(result.pdfPath, join(outDir, "sample.pdf"));
});

test("Docker build rejects source and output paths outside the selected workspace", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "resume-cooker-contained-workspace-"));
  const outsideRoot = await mkdtemp(join(tmpdir(), "resume-cooker-outside-workspace-"));
  tempDirs.push(workspaceRoot, outsideRoot);
  const outsideSource = join(outsideRoot, "sample.tex");
  await writeFile(outsideSource, "\\documentclass{article}");

  for (const options of [
    { source: outsideSource, outDir: "resume/output" },
    { source: "resume/source/sample.tex", outDir: outsideRoot }
  ]) {
    let ranCommand = false;
    let probedDocker = false;
    await assert.rejects(
      buildPdf({
        workspaceRoot,
        ...options,
        engine: "docker",
        probeEngine: async (engine) => {
          if (engine === "docker") probedDocker = true;
          return { available: true, usable: true, reason: "ready" };
        },
        runCommand: async () => {
          ranCommand = true;
        }
      }),
      (error) => error.code === "INVALID_USAGE" && /selected workspace/.test(error.message)
    );
    assert.equal(probedDocker, false);
    assert.equal(ranCommand, false);
  }
});

test("Docker build keeps spaces and non-ASCII workspace paths intact", async () => {
  const base = await mkdtemp(join(tmpdir(), "resume-cooker-portable-path-"));
  const workspaceRoot = join(base, "résumé workspace");
  tempDirs.push(base);
  const source = join(workspaceRoot, "resume", "source", "sample.tex");
  await mkdir(dirname(source), { recursive: true });
  await writeFile(source, "\\documentclass{article}");
  let dockerArgs;

  await buildPdf({
    workspaceRoot,
    source: "resume/source/sample.tex",
    outDir: "resume/output",
    engine: "docker",
    probeEngine: async () => ({ available: true, usable: true, reason: "ready" }),
    runCommand: async (_command, args) => {
      dockerArgs = args;
      const outputMount = args
        .map((arg, index) => (arg === "--mount" ? args[index + 1] : null))
        .filter(Boolean)
        .find((mount) => /target=\/output$/.test(mount));
      const staged = outputMount.match(/^type=bind,source=(.*),target=\/output$/)[1];
      await writeFile(join(staged, "sample.pdf"), "fixture");
      return { code: 0, stdout: "", stderr: "" };
    }
  });

  assert.ok(
    dockerArgs.includes(`type=bind,source=${dirname(source)},target=/workspace/source,readonly`)
  );
  assert.equal(dockerArgs.at(-1), "/workspace/source/sample.tex");
});

test("buildPdf reports a missing build engine before running a command", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "resume-cooker-missing-engine-"));
  tempDirs.push(outDir);

  let ranCommand = false;
  await assert.rejects(
    buildPdf({
      workspaceRoot: outDir,
      outDir,
      probeEngine: async () => ({ available: false, usable: false, reason: "not installed" }),
      runCommand: async () => {
        ranCommand = true;
      }
    }),
    /No usable LaTeX engine found/
  );
  assert.equal(ranCommand, false);
});

test("buildPdf rejects an explicit unavailable engine before running a command", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "resume-cooker-unusable-engine-"));
  tempDirs.push(outDir);

  let ranCommand = false;
  await assert.rejects(
    buildPdf({
      workspaceRoot: outDir,
      outDir,
      engine: "docker",
      probeEngine: async () => ({
        available: true,
        usable: false,
        reason: "Docker CLI is installed, but the daemon is not reachable."
      }),
      runCommand: async () => {
        ranCommand = true;
      }
    }),
    (error) => error.code === "CAPABILITY_UNAVAILABLE"
  );
  assert.equal(ranCommand, false);
});

test("buildPdf rejects runner success without a non-empty PDF", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "resume-cooker-empty-artifact-"));
  tempDirs.push(outDir);

  await assert.rejects(
    buildPdf({
      outDir,
      engine: "pdflatex",
      probeEngine: async () => ({ available: true, usable: true, reason: "ready" }),
      runCommand: async () => ({ code: 0, stdout: "", stderr: "" })
    }),
    (error) => error.code === "ARTIFACT_MISSING"
  );

  await writeFile(join(outDir, "current.pdf"), "");
  await assert.rejects(
    buildPdf({
      outDir,
      engine: "pdflatex",
      probeEngine: async () => ({ available: true, usable: true, reason: "ready" }),
      runCommand: async () => ({ code: 0, stdout: "", stderr: "" })
    }),
    (error) => error.code === "ARTIFACT_MISSING"
  );
});

test("buildPdf rejects a stale existing PDF when the current run writes nothing", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "resume-cooker-stale-artifact-"));
  tempDirs.push(outDir);
  const pdfPath = join(outDir, "current.pdf");
  await writeFile(pdfPath, "previous valid PDF");

  await assert.rejects(
    buildPdf({
      outDir,
      engine: "pdflatex",
      probeEngine: async () => ({ available: true, usable: true, reason: "ready" }),
      runCommand: async () => ({ code: 0, stdout: "", stderr: "" })
    }),
    (error) => error.code === "ARTIFACT_MISSING"
  );
  assert.equal(await readFile(pdfPath, "utf8"), "previous valid PDF");
});

test("buildPdf clean failure preserves an earlier valid PDF", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "resume-cooker-clean-failure-"));
  tempDirs.push(outDir);
  const pdfPath = join(outDir, "current.pdf");
  await writeFile(pdfPath, "previous valid PDF");

  await assert.rejects(
    buildPdf({
      outDir,
      clean: true,
      engine: "pdflatex",
      probeEngine: async () => ({ available: true, usable: true, reason: "ready" }),
      runCommand: async () => {
        throw new Error("synthetic compile failure");
      }
    }),
    /synthetic compile failure/
  );
  assert.equal(await readFile(pdfPath, "utf8"), "previous valid PDF");
});

test("buildPdf clean preserves source and unrelated same-basename files", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "resume-cooker-clean-safe-"));
  tempDirs.push(workspaceRoot);
  const source = join(workspaceRoot, "current.tex");
  const notes = join(workspaceRoot, "current.notes");
  const auxiliary = join(workspaceRoot, "current.aux");
  await writeFile(source, "source");
  await writeFile(notes, "notes");
  await writeFile(auxiliary, "old aux");

  await buildPdf({
    workspaceRoot,
    source,
    outDir: workspaceRoot,
    clean: true,
    engine: "pdflatex",
    probeEngine: async () => ({ available: true, usable: true, reason: "ready" }),
    runCommand: async (_command, args, options) => {
      assert.ok(Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0);
      assert.ok(Number.isSafeInteger(options.maxOutputBytes) && options.maxOutputBytes > 0);
      const outputArg = args.find((arg) => arg.startsWith("-output-directory="));
      await writeFile(join(outputArg.slice("-output-directory=".length), "current.pdf"), "new pdf");
      return { code: 0, stdout: "", stderr: "" };
    }
  });

  assert.equal(await readFile(source, "utf8"), "source");
  assert.equal(await readFile(notes, "utf8"), "notes");
  await assert.rejects(readFile(auxiliary, "utf8"), (error) => error.code === "ENOENT");
});

async function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
  if (process.platform !== "linux") return true;
  try {
    const statLine = await readFile(`/proc/${pid}/stat`, "utf8");
    const state = statLine.slice(statLine.lastIndexOf(")") + 2).split(" ", 1)[0];
    return state !== "Z";
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
