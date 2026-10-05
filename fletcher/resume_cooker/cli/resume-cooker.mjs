#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCheck, exitCodeForReport } from "../checker/scripts/check.mjs";
import { compareExitCode, runCompare } from "../checker/scripts/compare.mjs";
import { sanitizeProcessMessage, sanitizeReportValue } from "../checker/scripts/report-lib.mjs";
import { runTesterSuite, testerExitCode } from "../checker/scripts/tester-runner.mjs";
import { buildPdf, probeCommand, probeDockerDaemon } from "../generator/scripts/build-lib.mjs";
import { startPreviewServer } from "../generator/scripts/preview-server.mjs";
import packageJson from "../package.json" with { type: "json" };

export const EXIT = Object.freeze({
  quality: 2,
  usage: 64,
  unavailable: 69,
  internal: 70
});

const COMMANDS = new Set(["tools", "build", "preview", "check", "compare", "testers"]);
const BOOLEAN_OPTIONS = new Set(["allow-api", "build", "clean", "help", "json", "strict"]);
const GLOBAL_OPTIONS = new Set(["help", "json", "out"]);
const COMMAND_OPTIONS = {
  tools: new Set(["require-pdf-engine"]),
  build: new Set(["clean", "engine", "out-dir", "resume"]),
  preview: new Set(["engine", "host", "port", "resume"]),
  check: new Set([
    "allow-api",
    "build",
    "engine",
    "jd",
    "max-pages",
    "out-dir",
    "pdf",
    "profile",
    "resume",
    "suite",
    "tester-root",
    "text-out"
  ]),
  compare: new Set([
    "after",
    "after-facts",
    "before",
    "before-facts",
    "jd",
    "max-pages",
    "pdf",
    "policy",
    "profile",
    "profile-facts"
  ]),
  testers: new Set(["jd", "pdf", "profile", "required", "tester-root", "text", "tool"])
};
const EXISTING_PATH_OPTIONS = new Set([
  "after",
  "after-facts",
  "before",
  "before-facts",
  "jd",
  "pdf",
  "policy",
  "profile-facts",
  "resume",
  "text"
]);
const OUTPUT_PATH_OPTIONS = new Set(["out", "out-dir", "text-out"]);

const HELP = `Resume Cooker ${packageJson.version}

Usage:
  resume-cooker <command> [options]

Commands:
  tools      Report local tool readiness
  build      Build and verify an intentional PDF
  preview    Start the loopback editor and PDF preview
  check      Run preflight checks (--suite local|api|full)
  compare    Compare source and tailored artifacts
  testers    Run tester adapters (--profile normal|strict)

Global options:
  --json     Write exactly one JSON value to stdout
  --out PATH Atomically write the same report to PATH
  --help     Show help

Privacy:
  API/full checks require --allow-api and provider-specific explicit authorization.
  A key alone never authorizes a request. Reports sanitize secrets and absolute paths.

Exit codes: 0 pass/warnings, 2 quality fail, 64 usage, 69 capability, 70 internal.
`;

export function parseCli(argv, cwd = process.cwd()) {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    return { kind: "help" };
  }
  if (argv.length === 1 && ["--version", "-v"].includes(argv[0])) {
    return { kind: "version" };
  }
  const command = argv[0];
  if (!COMMANDS.has(command)) throw usage(`Unknown command: ${command || "(missing)"}.`);
  const options = {};
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw usage(`Unexpected argument: ${token}.`);
    const option = token.slice(2);
    const equalsIndex = option.indexOf("=");
    const rawName = equalsIndex === -1 ? option : option.slice(0, equalsIndex);
    const inlineValue = equalsIndex === -1 ? undefined : option.slice(equalsIndex + 1);
    if (!rawName) throw usage("Empty option name.");
    if (!GLOBAL_OPTIONS.has(rawName) && !COMMAND_OPTIONS[command].has(rawName)) {
      throw usage(`Unknown option for ${command}: --${rawName}.`);
    }
    if (Object.hasOwn(options, rawName)) throw usage(`Option repeated: --${rawName}.`);
    if (BOOLEAN_OPTIONS.has(rawName)) {
      if (inlineValue !== undefined && !["true", "false"].includes(inlineValue)) {
        throw usage(`--${rawName} accepts only true or false.`);
      }
      options[rawName] = inlineValue ?? "true";
      continue;
    }
    const value = inlineValue ?? argv[++index];
    if (!value || value.startsWith("--")) throw usage(`--${rawName} requires a value.`);
    options[rawName] = value;
  }
  normalizeAndValidate(command, options, cwd);
  return { kind: "command", command, options };
}

export async function runCli(
  argv,
  {
    cwd = process.cwd(),
    stdout = process.stdout,
    stderr = process.stderr,
    idFactory = randomUUID,
    operations = defaultOperations
  } = {}
) {
  let parsed;
  try {
    parsed = parseCli(argv, cwd);
  } catch (error) {
    writeLine(stderr, sanitizeProcessMessage(error.message));
    return EXIT.usage;
  }
  if (parsed.kind === "help") {
    stdout.write(HELP);
    return 0;
  }
  if (parsed.kind === "version") {
    writeLine(stdout, packageJson.version);
    return 0;
  }

  const runId = idFactory();
  try {
    const execution = await execute(parsed.command, parsed.options, {
      cwd,
      runId,
      operations
    });
    const report = normalizeReport(parsed.command, runId, execution.report);
    if (execution.accessUrl) writeLine(stderr, `Resume Cooker editor: ${execution.accessUrl}`);
    if (parsed.options.out) await writeAtomicReport(parsed.options.out, report);
    if (parsed.options.json === "true") {
      writeLine(stdout, JSON.stringify(report));
    } else {
      writeLine(stdout, humanSummary(report));
    }
    if (execution.waitForClose) await execution.waitForClose();
    return execution.exitCode ?? exitForReport(report);
  } catch (error) {
    writeLine(stderr, sanitizeProcessMessage(error.message));
    return exitForError(error);
  }
}

async function execute(command, options, context) {
  const { operations, cwd } = context;
  if (command === "tools") {
    const tools = await operations.tools();
    const usablePdfEngine = tools.some(
      (item) => ["latexmk", "pdflatex", "docker"].includes(item.tool) && item.usable
    );
    if (options["require-pdf-engine"] === "true" && !usablePdfEngine) {
      throw capability("No usable PDF build engine is available.");
    }
    return {
      report: {
        schema_version: 1,
        status: usablePdfEngine ? "pass" : "pass_with_warnings",
        content_left_machine: false,
        tools
      }
    };
  }
  if (command === "build") {
    const result = await operations.build({
      source: options.resume,
      outDir: options["out-dir"],
      workspaceRoot: cwd,
      engine: options.engine || "auto",
      clean: options.clean === "true",
      quiet: true
    });
    const info = await stat(result.pdfPath);
    if (!info.isFile() || info.size === 0) throw internal("Build produced no non-empty PDF.");
    return {
      report: {
        schema_version: 1,
        status: "pass",
        content_left_machine: false,
        artifact: portablePath(cwd, result.pdfPath),
        bytes: info.size,
        engine: result.engine
      }
    };
  }
  if (command === "preview") {
    const running = await operations.preview({
      repoRoot: cwd,
      source: options.resume,
      engine: options.engine || "auto",
      port: Number(options.port || 4177),
      host: options.host || "127.0.0.1"
    });
    const state = await running.service.getStatus();
    return {
      report: {
        schema_version: 1,
        status: state.ok ? "pass" : "pass_with_warnings",
        content_left_machine: false,
        host: "127.0.0.1",
        port: Number(new URL(running.url).port),
        state: sanitizeReportValue(state)
      },
      accessUrl: running.url,
      waitForClose: () => waitForSignal(running.close)
    };
  }
  if (command === "check") {
    const report = await operations.check({ ...options, out: undefined, workspaceRoot: cwd });
    return { report, exitCode: exitCodeForReport(report) };
  }
  if (command === "compare") {
    const report = await operations.compare({ ...options, out: undefined, workspaceRoot: cwd });
    return { report, exitCode: compareExitCode(report) };
  }
  const report = await operations.testers({
    ...options,
    out: undefined,
    workspaceRoot: cwd,
    testerRoot: options["tester-root"]
  });
  return { report, exitCode: testerExitCode(report) };
}

const defaultOperations = {
  build: buildPdf,
  check: runCheck,
  compare: runCompare,
  preview: startPreviewServer,
  testers: runTesterSuite,
  async tools() {
    const names = [
      "latexmk",
      "pdflatex",
      "xelatex",
      "pdftotext",
      "pdfinfo",
      "docker",
      "node",
      "npm"
    ];
    return Promise.all(
      names.map(async (tool) => ({
        tool,
        ...(tool === "docker"
          ? await probeDockerDaemon()
          : await probeCommand(tool, {
              args: ["pdftotext", "pdfinfo"].includes(tool) ? ["-v"] : ["--version"]
            }))
      }))
    );
  }
};

function normalizeAndValidate(command, options, cwd) {
  for (const [name, value] of Object.entries(options)) {
    if (EXISTING_PATH_OPTIONS.has(name)) {
      const path = resolve(cwd, value);
      if (!existsSync(path)) throw usage(`--${name} does not exist.`);
      options[name] = path;
    } else if (OUTPUT_PATH_OPTIONS.has(name)) {
      options[name] = resolve(cwd, value);
    }
  }
  if (options["tester-root"]) options["tester-root"] = resolve(cwd, options["tester-root"]);
  if (["build", "preview", "check"].includes(command)) {
    requireOption(options, "resume", command);
    requireExtension(options.resume, [".tex"], "--resume");
  }
  if (
    ["build", "preview", "check"].includes(command) &&
    options.engine &&
    !["auto", "latexmk", "pdflatex", "docker"].includes(options.engine)
  ) {
    throw usage("--engine must be auto, latexmk, pdflatex, or docker.");
  }
  if (command === "preview") {
    let sourceRoot;
    let sourcePath;
    try {
      sourceRoot = realpathSync(resolve(cwd, "resume", "source"));
      sourcePath = realpathSync(options.resume);
    } catch {
      throw usage("Preview source must be an approved file under resume/source.");
    }
    if (!isInsidePath(sourceRoot, sourcePath)) {
      throw usage("Preview source must be an approved file under resume/source.");
    }
  }
  if (command === "build" && !options["out-dir"]) {
    options["out-dir"] = resolve(cwd, "resume", "output");
  }
  if (command === "check") {
    options["out-dir"] ||= resolve(cwd, "resume", "output");
    options["text-out"] ||= resolve(cwd, "resume", "output", "current.txt");
  }
  if (command === "compare") {
    requireOption(options, "before", command);
    requireOption(options, "after", command);
    requireExtension(options.before, [".tex", ".json"], "--before");
    requireExtension(options.after, [".tex", ".json"], "--after");
  }
  if (command === "testers") {
    requireOption(options, "pdf", command);
    requireOption(options, "text", command);
    requireExtension(options.pdf, [".pdf"], "--pdf");
  }
  if (options.pdf) requireExtension(options.pdf, [".pdf"], "--pdf");
  if (options.profile && !["normal", "strict"].includes(options.profile)) {
    throw usage("--profile must be normal or strict.");
  }
  if (command === "check") {
    options.suite ||= "local";
    if (!["local", "api", "full"].includes(options.suite)) {
      throw usage("--suite must be local, api, or full.");
    }
    if (["api", "full"].includes(options.suite) && options["allow-api"] !== "true") {
      throw usage("API/full checks require explicit --allow-api.");
    }
  }
  for (const name of ["max-pages", "port", "require-pdf-engine"]) {
    if (options[name] === undefined || name === "require-pdf-engine") continue;
    const value = Number(options[name]);
    const invalid =
      !Number.isSafeInteger(value) || (name === "port" ? value < 0 || value > 65535 : value < 1);
    if (invalid) {
      throw usage(
        name === "port"
          ? "--port must be an integer from 0 to 65535."
          : `--${name} must be a positive integer.`
      );
    }
  }
  if (command === "preview" && options.host && options.host !== "127.0.0.1") {
    throw usage("Preview host must be 127.0.0.1.");
  }
}

function requireOption(options, name, command) {
  if (!options[name]) throw usage(`${command} requires --${name}.`);
}

function requireExtension(path, allowed, label) {
  if (!allowed.includes(extname(path).toLowerCase())) {
    throw usage(`${label} must use ${allowed.join(" or ")}.`);
  }
}

function normalizeReport(command, runId, report) {
  return sanitizeReportValue({
    ...report,
    schema_version: 1,
    command,
    run_id: runId,
    content_left_machine: report.content_left_machine === true
  });
}

function humanSummary(report) {
  const detail = report.summary ? `: ${report.summary}` : "";
  return `${report.command} ${report.status}${detail}`;
}

function exitForReport(report) {
  if (report.status === "fail") return EXIT.quality;
  return 0;
}

function exitForError(error) {
  if (
    [
      "INVALID_USAGE",
      "INVALID_ENGINE",
      "INVALID_HOST",
      "INVALID_OUTPUT",
      "INVALID_SOURCE"
    ].includes(error.code)
  ) {
    return EXIT.usage;
  }
  if (error.code === "CAPABILITY_UNAVAILABLE") return EXIT.unavailable;
  return EXIT.internal;
}

function isInsidePath(root, candidate) {
  const value = relative(root, candidate);
  return (
    value === "" ||
    (!isAbsolute(value) && value !== ".." && !value.startsWith(`..\\`) && !value.startsWith("../"))
  );
}

async function writeAtomicReport(path, report) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx"
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function waitForSignal(close) {
  return new Promise((resolvePromise, reject) => {
    let closing = false;
    const stop = async () => {
      if (closing) return;
      closing = true;
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      try {
        await close();
        resolvePromise();
      } catch (error) {
        reject(error);
      }
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

function portablePath(cwd, path) {
  const value = relative(cwd, resolve(path));
  if (
    !value ||
    (!isAbsolute(value) && value !== ".." && !value.startsWith(`..\\`) && !value.startsWith("../"))
  ) {
    return value.replaceAll("\\", "/") || ".";
  }
  return "[path]";
}

function writeLine(stream, value) {
  stream.write(`${value}\n`);
}

function usage(message) {
  const error = new Error(message);
  error.code = "INVALID_USAGE";
  return error;
}

function capability(message) {
  const error = new Error(message);
  error.code = "CAPABILITY_UNAVAILABLE";
  return error;
}

function internal(message) {
  const error = new Error(message);
  error.code = "INTERNAL";
  return error;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await runCli(process.argv.slice(2));
}
