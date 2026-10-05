import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const defaultProbeTimeoutMs = 5000;
export const defaultOperationTimeoutMs = 120_000;
export const defaultMaxOutputBytes = 1024 * 1024;
export const texliveImage =
  "texlive/texlive@sha256:f69ee97de275fd4a2f0f84d7d432063e5a7f79b35512cf3e601b5b95224f3dec";
const compilerArtifactExtensions = new Set([
  ".aux",
  ".bbl",
  ".bcf",
  ".blg",
  ".fdb_latexmk",
  ".fls",
  ".log",
  ".out",
  ".run.xml",
  ".synctex.gz",
  ".toc"
]);
const outputTruncatedMarker = "\n[output truncated: byte limit exceeded]\n";

export function getRepoRoot() {
  return repoRoot;
}

export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = "true";
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

export function commandExists(command, options = {}) {
  const probe = process.platform === "win32" ? "where.exe" : "sh";
  const probeArgs = process.platform === "win32" ? [command] : ["-lc", `command -v ${command}`];
  return runCommand(probe, probeArgs, {
    quiet: true,
    timeoutMs: options.timeoutMs || defaultProbeTimeoutMs
  })
    .then(() => true)
    .catch(() => false);
}

export function runCommand(command, args, options = {}) {
  const timeoutMs = positiveInteger(options.timeoutMs, defaultOperationTimeoutMs);
  const maxOutputBytes = positiveInteger(options.maxOutputBytes, defaultMaxOutputBytes);
  const killGraceMs = positiveInteger(options.killGraceMs, 500);
  return new Promise((resolvePromise, reject) => {
    if (options.signal?.aborted) {
      const error = new Error(`${command} was cancelled`);
      error.code = "ABORT_ERR";
      reject(error);
      return;
    }
    const child = spawn(command, args, {
      cwd: options.cwd || repoRoot,
      shell: options.shell || false,
      env: { ...process.env, ...(options.env || {}) },
      detached: process.platform !== "win32",
      windowsHide: true
    });

    const stdoutChunks = [];
    const stderrChunks = [];
    let outputBytes = 0;
    let settled = false;
    let stopping = false;
    let timeout;
    const output = () => ({
      stdout: Buffer.concat(stdoutChunks).toString("utf8"),
      stderr: Buffer.concat(stderrChunks).toString("utf8")
    });
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
      callback(value);
    };
    const stop = async (error) => {
      if (settled || stopping) return;
      stopping = true;
      if (timeout) clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
      try {
        await terminateChild(child, killGraceMs);
      } finally {
        Object.assign(error, output());
        finish(reject, error);
      }
    };
    const abort = () => {
      const error = new Error(`${command} was cancelled`);
      error.code = "ABORT_ERR";
      void stop(error);
    };
    options.signal?.addEventListener("abort", abort, { once: true });

    try {
      options.onSpawn?.(child);
    } catch (error) {
      void stop(error);
      return;
    }

    timeout = setTimeout(() => {
      const error = new Error(`${command} timed out after ${timeoutMs} ms`);
      error.code = "ETIMEDOUT";
      void stop(error);
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      captureOutput(chunk, stdoutChunks, process.stdout);
    });
    child.stderr.on("data", (chunk) => {
      captureOutput(chunk, stderrChunks, process.stderr);
    });
    child.on("error", (error) => {
      if (!stopping) finish(reject, Object.assign(error, output()));
    });
    child.on("close", (code) => {
      if (stopping) return;
      const captured = output();
      if (code === 0) {
        finish(resolvePromise, { code, ...captured });
      } else {
        const error = new Error(`${command} exited with code ${code}`);
        error.code = code;
        Object.assign(error, captured);
        finish(reject, error);
      }
    });

    function captureOutput(chunk, chunks, stream) {
      if (settled || stopping) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = maxOutputBytes - outputBytes;
      const accepted = remaining > 0 ? bytes.subarray(0, remaining) : Buffer.alloc(0);
      if (accepted.length > 0) {
        chunks.push(accepted);
        outputBytes += accepted.length;
        if (!options.quiet) safeWrite(stream, accepted);
      }
      if (accepted.length < bytes.length) {
        chunks.push(Buffer.from(outputTruncatedMarker));
        const error = new Error(`${command} exceeded the ${maxOutputBytes}-byte output limit`);
        error.code = "EOUTPUTLIMIT";
        void stop(error);
      }
    }
  });
}

async function terminateChild(child, graceMs) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32" && child.pid) {
    const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true
    });
    await waitForProcessClose(killer, graceMs);
    await waitForProcessClose(child, graceMs);
    return;
  } else if (child.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
      if (await waitForProcessClose(child, graceMs)) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") child.kill("SIGKILL");
      }
      await waitForProcessClose(child, graceMs);
      return;
    } catch {
      // Fall back to the direct child when the process group is already unavailable.
    }
  }
  child.kill("SIGKILL");
  await waitForProcessClose(child, graceMs);
}

function waitForProcessClose(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolvePromise) => {
    let timer;
    const finish = (closed) => {
      clearTimeout(timer);
      child.removeListener("close", onClose);
      resolvePromise(closed);
    };
    const onClose = () => finish(true);
    child.once("close", onClose);
    timer = setTimeout(() => finish(false), timeoutMs);
  });
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function safeWrite(stream, chunk) {
  try {
    stream.write(chunk);
  } catch (error) {
    if (error.code !== "EPIPE") throw error;
  }
}

const xpdfVersionExit = new Set(["pdftotext", "pdfinfo"]);

export async function probeCommand(command, options = {}) {
  const timeoutMs = options.timeoutMs || defaultProbeTimeoutMs;
  const metadata = { command };
  const available = await (options.commandExistsImpl || commandExists)(command, { timeoutMs });

  if (!available) {
    return {
      available: false,
      usable: false,
      reason: `${command} is not installed.`,
      metadata
    };
  }

  try {
    const args = options.args || ["--version"];
    const windowsCommandShim = process.platform === "win32" && ["npm", "npx"].includes(command);
    const invocation = windowsCommandShim ? process.env.ComSpec || "cmd.exe" : command;
    const invocationArgs = windowsCommandShim
      ? ["/d", "/s", "/c", `${command}.cmd`, ...args]
      : args;
    await (options.runCommandImpl || runCommand)(invocation, invocationArgs, {
      quiet: true,
      timeoutMs
    });
    return {
      available: true,
      usable: true,
      reason: `${command} is available.`,
      metadata
    };
  } catch (error) {
    if (error.code === "ETIMEDOUT") {
      return {
        available: true,
        usable: false,
        reason: `${command} probe timed out after ${timeoutMs} ms.`,
        metadata: { ...metadata, timedOut: true }
      };
    }
    // xpdf's pdftotext/pdfinfo print their version banner and then exit 99, so a
    // non-zero `-v` exit is not evidence that the binary is unusable.
    if (xpdfVersionExit.has(command) && error.code === 99) {
      return {
        available: true,
        usable: true,
        reason: `${command} is available.`,
        metadata: { ...metadata, exitCode: 99 }
      };
    }
    return {
      available: true,
      usable: false,
      reason: `${command} is installed but not usable.`,
      metadata: {
        ...metadata,
        ...(Number.isInteger(error.code) ? { exitCode: error.code } : {})
      }
    };
  }
}

export async function probeDockerDaemon(options = {}) {
  const timeoutMs = options.timeoutMs || defaultProbeTimeoutMs;
  const metadata = { command: "docker" };
  const commandResult = await (options.probeCommandImpl || probeCommand)("docker", {
    commandExistsImpl: options.commandExistsImpl,
    runCommandImpl: options.runCommandImpl,
    timeoutMs
  });

  if (!commandResult.available || !commandResult.usable) return commandResult;

  try {
    const result = await (options.runCommandImpl || runCommand)(
      "docker",
      ["info", "--format", "{{json .ServerVersion}}"],
      { quiet: true, timeoutMs }
    );
    const combinedOutput = `${result.stdout || ""}\n${result.stderr || ""}`;
    if (isDockerConnectionError(combinedOutput)) {
      return {
        available: true,
        usable: false,
        reason: "Docker CLI is installed, but the daemon is not reachable.",
        metadata
      };
    }

    const serverVersion = parseDockerServerVersion(result.stdout);
    if (!serverVersion) {
      return {
        available: true,
        usable: false,
        reason: "Docker daemon server response was empty or malformed.",
        metadata
      };
    }

    return {
      available: true,
      usable: true,
      reason: "Docker daemon is reachable.",
      metadata: { ...metadata, serverVersion }
    };
  } catch (error) {
    if (error.code === "ETIMEDOUT") {
      return {
        available: true,
        usable: false,
        reason: `Docker daemon probe timed out after ${timeoutMs} ms.`,
        metadata: { ...metadata, timedOut: true }
      };
    }
    if (isDockerConnectionError(`${error.stdout || ""}\n${error.stderr || ""}`)) {
      return {
        available: true,
        usable: false,
        reason: "Docker CLI is installed, but the daemon is not reachable.",
        metadata
      };
    }
    return {
      available: true,
      usable: false,
      reason: "Docker daemon probe failed.",
      metadata: {
        ...metadata,
        ...(Number.isInteger(error.code) ? { exitCode: error.code } : {})
      }
    };
  }
}

function isDockerConnectionError(output) {
  return /cannot connect|connection refused|error during connect|failed to connect|is the docker daemon running|docker desktop is not running|the system cannot find the file specified/i.test(
    output
  );
}

function parseDockerServerVersion(stdout) {
  try {
    const value = JSON.parse(stdout.trim());
    return typeof value === "string" && /^\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?$/.test(value)
      ? value
      : null;
  } catch {
    return null;
  }
}

export async function probePdfEngine(engine, options = {}) {
  if (engine === "docker") return probeDockerDaemon(options);
  return probeCommand(engine, { ...options, args: ["--version"] });
}

export async function detectEngine(requested = "auto", probeEngineImpl = probePdfEngine) {
  const supportedEngines = ["latexmk", "pdflatex", "docker"];
  if (requested !== "auto") {
    if (!supportedEngines.includes(requested)) {
      const error = new Error(`Unsupported PDF engine "${requested}".`);
      error.code = "INVALID_ENGINE";
      throw error;
    }
    const capability = await probeEngineImpl(requested);
    if (capability.usable) return requested;
    throw capabilityUnavailable(
      `PDF engine "${requested}" is unavailable. ${capability.reason || ""}`.trim(),
      requested
    );
  }

  for (const engine of supportedEngines) {
    if ((await probeEngineImpl(engine)).usable) return engine;
  }
  return "missing";
}

export async function buildPdf(options = {}) {
  const workspaceRoot = resolve(options.workspaceRoot || repoRoot);
  const source = resolve(workspaceRoot, options.source || "resume/source/current.tex");
  const outDir = resolve(workspaceRoot, options.outDir || "resume/output");
  const runCommandImpl = options.runCommand || runCommand;
  const probeEngineImpl =
    options.probeEngine ||
    ((engine) =>
      probePdfEngine(engine, {
        commandExistsImpl: options.commandExists,
        runCommandImpl,
        timeoutMs: options.timeoutMs
      }));
  const guardedProbeEngine = async (candidate) => {
    if (candidate === "docker") {
      relativeForDocker(source, workspaceRoot);
      relativeForDocker(outDir, workspaceRoot);
    }
    return probeEngineImpl(candidate);
  };
  const engine = await detectEngine(options.engine || "auto", guardedProbeEngine);
  const jobName = basename(source, extname(source));
  const pdfPath = join(outDir, `${jobName}.pdf`);
  const stagingRoot = join(workspaceRoot, ".runtime", "builds");
  await mkdir(stagingRoot, { recursive: true });
  const stagingDir = await mkdtemp(join(stagingRoot, `${jobName}-`));
  const stagedPdfPath = join(stagingDir, `${jobName}.pdf`);
  const replacementPath = join(outDir, `.${jobName}-${randomUUID()}.pdf.tmp`);
  const timeoutMs = positiveInteger(options.timeoutMs, defaultOperationTimeoutMs);
  const maxOutputBytes = positiveInteger(options.maxOutputBytes, defaultMaxOutputBytes);
  const runOptions = {
    quiet: options.quiet,
    signal: options.signal,
    timeoutMs,
    maxOutputBytes
  };

  try {
    if (engine === "latexmk") {
      await runCommandImpl(
        "latexmk",
        ["-pdf", "-interaction=nonstopmode", "-halt-on-error", `-outdir=${stagingDir}`, source],
        { ...runOptions, cwd: workspaceRoot }
      );
    } else if (engine === "pdflatex") {
      await runCommandImpl(
        "pdflatex",
        ["-interaction=nonstopmode", "-halt-on-error", `-output-directory=${stagingDir}`, source],
        { ...runOptions, cwd: workspaceRoot }
      );
    } else if (engine === "docker") {
      await runCommandImpl(
        "docker",
        [
          "run",
          "--rm",
          "--network=none",
          "--read-only",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          "--pids-limit=128",
          "--memory=1g",
          "--cpus=2",
          "--user",
          dockerUser(),
          "--env",
          "HOME=/tmp",
          "--tmpfs",
          "/tmp:rw,noexec,nosuid,nodev,size=256m",
          "--mount",
          `type=bind,source=${dirname(source)},target=/workspace/source,readonly`,
          "--mount",
          `type=bind,source=${stagingDir},target=/output`,
          "-w",
          "/workspace/source",
          texliveImage,
          "latexmk",
          "-pdf",
          "-interaction=nonstopmode",
          "-halt-on-error",
          "-outdir=/output",
          `/workspace/source/${basename(source)}`
        ],
        runOptions
      );
    } else {
      throw capabilityUnavailable(
        "No usable LaTeX engine found. Install latexmk/pdflatex or start Docker.",
        "auto"
      );
    }

    if (!(await isNonEmptyFile(stagedPdfPath))) {
      const error = new Error("PDF build completed without producing a non-empty PDF.");
      error.code = "ARTIFACT_MISSING";
      throw error;
    }

    await mkdir(outDir, { recursive: true });
    if (options.clean) await cleanJobArtifacts(outDir, jobName);
    await copyFile(stagedPdfPath, replacementPath);
    await rename(replacementPath, pdfPath);
  } finally {
    await rm(replacementPath, { force: true });
    await rm(stagingDir, { recursive: true, force: true });
  }

  return {
    engine,
    source,
    outDir,
    pdfPath
  };
}

async function isNonEmptyFile(path) {
  try {
    const artifact = await stat(path);
    return artifact.isFile() && artifact.size > 0;
  } catch {
    return false;
  }
}

async function cleanJobArtifacts(outDir, jobName) {
  const entries = await readdir(outDir, { withFileTypes: true });
  await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.startsWith(`${jobName}.`) &&
          compilerArtifactExtensions.has(entry.name.slice(jobName.length))
      )
      .map((entry) => rm(join(outDir, entry.name), { force: true }))
  );
}

function dockerUser() {
  const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
  const gid = typeof process.getgid === "function" ? process.getgid() : 1000;
  return `${uid}:${gid}`;
}

function capabilityUnavailable(message, engine) {
  const error = new Error(message);
  error.code = "CAPABILITY_UNAVAILABLE";
  error.metadata = { engine };
  return error;
}

function relativeForDocker(absPath, workspaceRoot) {
  const value = relative(workspaceRoot, absPath);
  if (isAbsolute(value) || value === ".." || value.startsWith(`..${sep}`)) {
    const error = new Error("Docker paths must stay inside the selected workspace.");
    error.code = "INVALID_USAGE";
    throw error;
  }
  return value.replaceAll("\\", "/") || ".";
}
