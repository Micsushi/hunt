import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  analyzeExtractedText,
  checkPdfPageLimit,
  countPdfPages,
  extractPdfText
} from "./text-layer.mjs";

const tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

test("analyzeExtractedText passes non-empty ordered sections", () => {
  const checks = analyzeExtractedText(
    "Education\nUniversity\nExperience\nBuilt APIs\nProjects\nCompiler\nSkills\nTypeScript"
  );
  const byId = Object.fromEntries(checks.map((check) => [check.id, check]));

  assert.equal(byId.pdf_text_non_empty.status, "pass");
  assert.equal(byId.section_headings_present.status, "pass");
  assert.equal(byId.section_order_readable.status, "pass");
});

test("analyzeExtractedText warns on missing sections and configured terms", () => {
  const checks = analyzeExtractedText("Experience\nBuilt distributed systems", {
    criticalTerms: ["Kubernetes"]
  });

  assert.equal(checks.find((check) => check.id === "section_headings_present").status, "warning");
  assert.equal(checks.find((check) => check.metadata.term === "Kubernetes").status, "warning");
});

test("analyzeExtractedText fails empty text and warns on corrupt encoding or section order", () => {
  const empty = analyzeExtractedText("");
  assert.equal(empty.find((check) => check.id === "pdf_text_non_empty").status, "fail");

  const corrupt = analyzeExtractedText(
    "Experience\nWork\nEducation\nSchool\nProjects\nProject\nSkills\nTypeScript\uFFFD"
  );
  assert.equal(corrupt.find((check) => check.id === "section_order_readable").status, "warning");
  assert.equal(corrupt.find((check) => check.id === "encoding_noise_low").status, "warning");
});

test("checkPdfPageLimit passes at one page", async () => {
  const check = await checkPdfPageLimit({
    pdf: "resume/output/current.pdf",
    probeCommandImpl: async (command) => ({
      available: command === "pdfinfo",
      usable: command === "pdfinfo",
      reason: command === "pdfinfo" ? "ready" : "not installed"
    }),
    probeDockerDaemonImpl: async () => ({ available: false, usable: false }),
    runCommandImpl: async () => ({ stdout: "Title: Resume\nPages: 1\n" })
  });

  assert.equal(check.status, "pass");
  assert.equal(check.metadata.pages, 1);
});

test("checkPdfPageLimit hard fails over one page", async () => {
  const check = await checkPdfPageLimit({
    pdf: "resume/output/current.pdf",
    probeCommandImpl: async (command) => ({
      available: command === "pdfinfo",
      usable: command === "pdfinfo",
      reason: command === "pdfinfo" ? "ready" : "not installed"
    }),
    probeDockerDaemonImpl: async () => ({ available: false, usable: false }),
    runCommandImpl: async () => ({ stdout: "Pages: 2\n" })
  });

  assert.equal(check.status, "fail");
  assert.equal(check.severity, "blocker");
});

test("checkPdfPageLimit warns when no page counter is available", async () => {
  const check = await checkPdfPageLimit({
    pdf: "resume/output/current.pdf",
    probeCommandImpl: async () => ({
      available: false,
      usable: false,
      reason: "pdfinfo is not installed."
    }),
    probeDockerDaemonImpl: async () => ({
      available: false,
      usable: false,
      reason: "Docker is not installed."
    })
  });

  assert.equal(check.id, "pdf_page_count_unavailable");
  assert.equal(check.status, "warning");
});

test("checkPdfPageLimit fails as unavailable capability when strict mode requires a count", async () => {
  const check = await checkPdfPageLimit({
    pdf: "resume/output/current.pdf",
    required: true,
    probeCommandImpl: async () => ({
      available: false,
      usable: false,
      reason: "pdfinfo is not installed."
    }),
    probeDockerDaemonImpl: async () => ({
      available: false,
      usable: false,
      reason: "Docker is not installed."
    })
  });

  assert.equal(check.id, "pdf_page_count_unavailable");
  assert.equal(check.status, "fail");
  assert.equal(check.severity, "blocker");
  assert.equal(check.metadata.required_capability_unavailable, true);
});

test("extractPdfText does not run Docker when its daemon is unusable", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "resume-cooker-extract-unavailable-"));
  tempDirs.push(outDir);
  let ranCommand = false;

  await assert.rejects(
    extractPdfText({
      workspaceRoot: outDir,
      pdf: "public-fixture.pdf",
      out: join(outDir, "output.txt"),
      probeCommandImpl: async () => ({
        available: false,
        usable: false,
        reason: "pdftotext is not installed."
      }),
      probeDockerDaemonImpl: async () => ({
        available: true,
        usable: false,
        reason: "Docker CLI is installed, but the daemon is not reachable."
      }),
      runCommandImpl: async () => {
        ranCommand = true;
      }
    }),
    (error) =>
      error.code === "CAPABILITY_UNAVAILABLE" && /daemon is not reachable/.test(error.message)
  );
  assert.equal(ranCommand, false);
});

test("extractPdfText falls back after a failed local tool", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "resume-cooker-extract-fallback-"));
  tempDirs.push(outDir);
  const out = join(outDir, "output.txt");
  const calls = [];

  const result = await extractPdfText({
    workspaceRoot: outDir,
    pdf: "public-fixture.pdf",
    out,
    probeCommandImpl: async () => ({ available: true, usable: true, reason: "ready" }),
    probeDockerDaemonImpl: async () => ({ available: true, usable: true, reason: "ready" }),
    runCommandImpl: async (command, args) => {
      calls.push(command);
      if (command === "pdftotext") throw new Error("local execution failed");
      const outputMount = args
        .map((arg, index) => (arg === "--mount" ? args[index + 1] : null))
        .filter(Boolean)
        .find((mount) => /target=\/output$/.test(mount));
      const staged = outputMount.match(/^type=bind,source=(.*),target=\/output$/)[1];
      await writeFile(join(staged, "extracted.txt"), "Education\nSynthetic University");
      return { code: 0, stdout: "", stderr: "" };
    }
  });

  assert.deepEqual(calls, ["pdftotext", "docker"]);
  assert.equal(result.tool, "docker:pdftotext");
  assert.match(result.text, /Synthetic University/);
});

test("Docker PDF tools mount the caller workspace", async () => {
  const base = await mkdtemp(join(tmpdir(), "resume-cooker-text-workspace-"));
  tempDirs.push(base);
  const workspaceRoot = join(base, "résumé workspace");
  const pdf = join(workspaceRoot, "resume", "output", "sample.pdf");
  const out = join(workspaceRoot, ".runtime", "sample.txt");
  await mkdir(join(workspaceRoot, "resume", "output"), { recursive: true });
  await writeFile(pdf, "%PDF fixture");
  const calls = [];

  await extractPdfText({
    workspaceRoot,
    pdf,
    out,
    probeCommandImpl: async () => ({ available: false, usable: false, reason: "missing" }),
    probeDockerDaemonImpl: async () => ({ available: true, usable: true, reason: "ready" }),
    runCommandImpl: async (command, args, options) => {
      calls.push([command, args, options]);
      const outputMount = args
        .map((arg, index) => (arg === "--mount" ? args[index + 1] : null))
        .filter(Boolean)
        .find((mount) => /target=\/output$/.test(mount));
      const staged = outputMount.match(/^type=bind,source=(.*),target=\/output$/)[1];
      await writeFile(join(staged, "extracted.txt"), "Stage 4 browser acceptance");
      return { code: 0, stdout: "", stderr: "" };
    }
  });

  const dockerArgs = calls[0][1];
  assert.ok(dockerArgs.includes("--network=none"));
  assert.ok(dockerArgs.includes("--read-only"));
  assert.ok(dockerArgs.includes("no-new-privileges"));
  assert.ok(dockerArgs.includes("--pids-limit=64"));
  assert.ok(dockerArgs.includes("--memory=256m"));
  assert.ok(dockerArgs.includes("--cpus=1"));
  assert.ok(dockerArgs.includes(`type=bind,source=${pdf},target=/input/resume.pdf,readonly`));
  assert.match(
    dockerArgs.find((arg) => arg.startsWith("minidocks/poppler@sha256:")),
    /^minidocks\/poppler@sha256:[a-f0-9]{64}$/
  );
  assert.equal(dockerArgs.at(-2), "/input/resume.pdf");
  assert.equal(dockerArgs.at(-1), "/output/extracted.txt");
  assert.ok(Number.isSafeInteger(calls[0][2].timeoutMs) && calls[0][2].timeoutMs > 0);
  assert.ok(Number.isSafeInteger(calls[0][2].maxOutputBytes) && calls[0][2].maxOutputBytes > 0);
});

test("Docker PDF tools reject input and output paths outside the selected workspace", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "resume-cooker-text-contained-"));
  const outsideRoot = await mkdtemp(join(tmpdir(), "resume-cooker-text-outside-"));
  tempDirs.push(workspaceRoot, outsideRoot);
  const outsidePdf = join(outsideRoot, "outside.pdf");
  const outsideOut = join(outsideRoot, "outside.txt");
  await writeFile(outsidePdf, "%PDF fixture");

  for (const operation of [
    () =>
      extractPdfText({
        workspaceRoot,
        pdf: outsidePdf,
        out: join(workspaceRoot, ".runtime", "inside.txt"),
        probeCommandImpl: async () => ({ available: false, usable: false, reason: "missing" }),
        probeDockerDaemonImpl: async () => {
          throw new Error("Docker probe must not run");
        },
        runCommandImpl: async () => {
          throw new Error("Docker must not run");
        }
      }),
    () =>
      extractPdfText({
        workspaceRoot,
        pdf: join(workspaceRoot, "inside.pdf"),
        out: outsideOut,
        probeCommandImpl: async () => ({ available: false, usable: false, reason: "missing" }),
        probeDockerDaemonImpl: async () => {
          throw new Error("Docker probe must not run");
        },
        runCommandImpl: async () => {
          throw new Error("Docker must not run");
        }
      }),
    () =>
      countPdfPages({
        workspaceRoot,
        pdf: outsidePdf,
        probeCommandImpl: async () => ({ available: false, usable: false, reason: "missing" }),
        probeDockerDaemonImpl: async () => {
          throw new Error("Docker probe must not run");
        },
        runCommandImpl: async () => {
          throw new Error("Docker must not run");
        }
      })
  ]) {
    await assert.rejects(
      operation(),
      (error) => error.code === "INVALID_USAGE" && /selected workspace/.test(error.message)
    );
  }
});

test("extractPdfText rejects empty output without exposing content", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "resume-cooker-extract-empty-"));
  tempDirs.push(outDir);
  const out = join(outDir, "output.txt");

  await assert.rejects(
    extractPdfText({
      workspaceRoot: outDir,
      pdf: "public-fixture.pdf",
      out,
      probeCommandImpl: async () => ({ available: true, usable: true, reason: "ready" }),
      probeDockerDaemonImpl: async () => ({
        available: false,
        usable: false,
        reason: "Docker is not installed."
      }),
      runCommandImpl: async () => {
        await writeFile(out, "");
        return { code: 0, stdout: "", stderr: "" };
      }
    }),
    (error) => error.code === "EMPTY_EXTRACTION" && /empty output/.test(error.message)
  );
});

test("countPdfPages falls back after malformed local output", async () => {
  const calls = [];
  const result = await countPdfPages({
    pdf: "public-fixture.pdf",
    probeCommandImpl: async () => ({ available: true, usable: true, reason: "ready" }),
    probeDockerDaemonImpl: async () => ({ available: true, usable: true, reason: "ready" }),
    runCommandImpl: async (command) => {
      calls.push(command);
      return {
        code: 0,
        stdout: command === "pdfinfo" ? "Title: Synthetic\n" : "Pages: 2\n",
        stderr: ""
      };
    }
  });

  assert.deepEqual(calls, ["pdfinfo", "docker"]);
  assert.deepEqual(result, {
    available: true,
    usable: true,
    tool: "docker:pdfinfo",
    pages: 2
  });
});

test("countPdfPages reports unusable Docker without executing it", async () => {
  let ranCommand = false;
  const result = await countPdfPages({
    pdf: "public-fixture.pdf",
    probeCommandImpl: async () => ({
      available: false,
      usable: false,
      reason: "pdfinfo is not installed."
    }),
    probeDockerDaemonImpl: async () => ({
      available: true,
      usable: false,
      reason: "Docker CLI is installed, but the daemon is not reachable."
    }),
    runCommandImpl: async () => {
      ranCommand = true;
    }
  });

  assert.equal(result.available, false);
  assert.equal(result.usable, false);
  assert.match(result.reason, /daemon is not reachable/);
  assert.equal(ranCommand, false);
});

test("countPdfPages rejects zero and unsafe page counts", async () => {
  for (const stdout of ["Pages: 0\n", `Pages: ${"9".repeat(400)}\n`]) {
    const result = await countPdfPages({
      pdf: "public-fixture.pdf",
      probeCommandImpl: async () => ({ available: true, usable: true, reason: "ready" }),
      probeDockerDaemonImpl: async () => ({
        available: false,
        usable: false,
        reason: "Docker is not installed."
      }),
      runCommandImpl: async () => ({ code: 0, stdout, stderr: "" })
    });

    assert.equal(result.available, false);
    assert.equal(result.usable, false);
    assert.match(result.reason, /valid page count/);
  }
});

test("extractPdfText classifies local execution failure when Docker is unusable", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "resume-cooker-extract-failed-"));
  tempDirs.push(outDir);

  await assert.rejects(
    extractPdfText({
      workspaceRoot: outDir,
      pdf: "public-fixture.pdf",
      out: join(outDir, "output.txt"),
      probeCommandImpl: async () => ({ available: true, usable: true, reason: "ready" }),
      probeDockerDaemonImpl: async () => ({
        available: true,
        usable: false,
        reason: "Docker CLI is installed, but the daemon is not reachable."
      }),
      runCommandImpl: async () => {
        throw new Error("private machine detail");
      }
    }),
    (error) =>
      error.code === "EXTRACTION_FAILED" &&
      /local pdftotext execution failed/i.test(error.message) &&
      /daemon is not reachable/.test(error.message) &&
      !/private machine detail/.test(error.message)
  );
});
