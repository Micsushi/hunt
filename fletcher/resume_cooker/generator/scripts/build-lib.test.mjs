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
