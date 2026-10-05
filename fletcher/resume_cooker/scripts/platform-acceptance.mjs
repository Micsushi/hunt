#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { arch, platform, release } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sanitizeReportValue } from "../checker/scripts/report-lib.mjs";
import { runCommand } from "../generator/scripts/build-lib.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const claims = new Set(["core", "windows", "macos", "linux"]);
const platformForClaim = { windows: "win32", macos: "darwin", linux: "linux" };
const coreRows = [
  "root-ci",
  "production-audit",
  "package",
  "fresh-install",
  "public-pdf-check",
  "public-compare",
  "preview-lifecycle",
  "artifact-privacy"
];
const packageDocs = [
  "LICENSE",
  "README.md",
  "WINDOWS_COMPATIBILITY.md",
  "MACOS_COMPATIBILITY.md",
  "LINUX_COMPATIBILITY.md",
  "docs/container-boundary.md",
  "docs/platform-acceptance.md"
];

export function assessPlatformClaim({
  claim,
  platform: hostPlatform,
  inContainer,
  identities = {},
  checks
}) {
  if (!claims.has(claim)) {
    return rejected(claim, `Unknown platform claim: ${claim}.`);
  }
  const requiredIds = claim === "core" ? coreRows : [...coreRows, "browser-ui"];
  if (claim !== "core" && hostPlatform !== platformForClaim[claim]) {
    return rejected(claim, `${claim} certification requires ${platformForClaim[claim]}.`);
  }
  if (claim !== "core" && inContainer) {
    return rejected(claim, `A container cannot certify ${claim} desktop capability.`);
  }
  const nodeMajor = Number(/^v?(\d+)/.exec(identities.node || "")?.[1]);
  if (!Number.isSafeInteger(nodeMajor) || nodeMajor < 22) {
    return rejected(claim, "Certification requires a recorded Node 22 or newer identity.");
  }
  if (!identities.npm) return rejected(claim, "Certification requires an npm identity.");
  if (!identities.docker) return rejected(claim, "Certification requires a Docker identity.");
  if (claim !== "core" && !identities.browser) {
    return rejected(claim, "Desktop certification requires a browser identity.");
  }
  if (claim !== "core" && identities.desktop?.available !== true) {
    return rejected(claim, "Desktop certification requires real desktop/display evidence.");
  }
  for (const id of requiredIds) {
    const check = checks.find((item) => item.id === id);
    if (!check || check.status !== "pass") {
      return rejected(claim, `Required acceptance row ${id} did not pass.`);
    }
  }
  return {
    certified: true,
    claim,
    evidence_class: claim === "core" ? "T2-core" : `T2-capability:${claim}`,
    reason:
      claim === "core"
        ? "All required core acceptance rows passed."
        : `All required ${claim} desktop acceptance rows passed.`
  };
}

export function auditPackageFiles(files) {
  const normalized = files.map((path) => path.replaceAll("\\", "/")).sort();
  const forbidden = normalized
    .filter(
      (path) =>
        /(^|\/)(?:\.runtime|node_modules|\.git|\.codex|\.claude|\.gemini|\.agents)(?:\/|$)/i.test(
          path
        ) ||
        /(^|\/)\.env(?:\.|$)/i.test(path) ||
        /^(?:resume\/source\/(?:current|ats)\.tex|fixtures\/resume_extracted_text\.txt)$/i.test(
          path
        ) ||
        /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(path) ||
        (/\.(?:pdf|log|aux)$/i.test(path) && path !== "fixtures/compare/corrupt.pdf")
    )
    .sort();
  const missing = packageDocs.filter((path) => !normalized.includes(path));
  return {
    ok: forbidden.length === 0 && missing.length === 0,
    forbidden,
    missing
  };
}

export async function hashPackageContents(files, { workspaceRoot = repoRoot } = {}) {
  const root = await realpath(resolve(workspaceRoot));
  const hash = createHash("sha256");
  for (const path of files.map((value) => value.replaceAll("\\", "/")).sort()) {
    const fullPath = await realpath(resolve(root, path));
    const fromRoot = relative(root, fullPath);
    if (isAbsolute(fromRoot) || fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) {
      throw new Error(`Package file is outside the workspace: ${path}.`);
    }
    const content = await readFile(fullPath);
    hash.update(`${path}\0${content.length}\0`);
    hash.update(content);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function assertGitStatusUnchanged(before, after) {
  if (before !== after) throw new Error("Git status changed during platform acceptance.");
}

export function validateCliReport(
  report,
  { command, statuses = ["pass", "pass_with_warnings"], requireTools = false } = {}
) {
  const valid =
    report &&
    typeof report === "object" &&
    !Array.isArray(report) &&
    report.schema_version === 1 &&
    report.command === command &&
    report.content_left_machine === false &&
    statuses.includes(report.status);
  if (!valid) throw new Error(`Invalid packaged ${command || "CLI"} schema/privacy report.`);
  if (
    requireTools &&
    (!Array.isArray(report.tools) ||
      report.tools.some(
        (tool) =>
          !tool ||
          typeof tool.tool !== "string" ||
          typeof tool.available !== "boolean" ||
          typeof tool.usable !== "boolean"
      ))
  ) {
    throw new Error("Invalid packaged tools report.");
  }
  return report;
}

export function resolveAcceptanceOutput({
  workspaceRoot = repoRoot,
  output = null,
  claim = "core",
  hostPlatform = platform()
} = {}) {
  const root = resolve(workspaceRoot);
  const evidenceRoot = join(root, ".runtime", "platform-acceptance");
  const outputPath = resolve(root, output || join(evidenceRoot, `${claim}-${hostPlatform}.json`));
  const value = relative(evidenceRoot, outputPath);
  if (!value || isAbsolute(value) || value === ".." || value.startsWith(`..${sep}`)) {
    throw new Error("Acceptance output must stay under ignored .runtime/platform-acceptance.");
  }
  return outputPath;
}

export function sanitizePlatformEvidence(value, { workspaceRoot = repoRoot } = {}) {
  const roots = [
    workspaceRoot,
    workspaceRoot.replaceAll("\\", "/"),
    workspaceRoot.replaceAll("/", "\\")
  ].filter(Boolean);
  const visit = (item) => {
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === "object") {
      return Object.fromEntries(
        Object.entries(item)
          .filter(([key]) => !["stdout", "stderr"].includes(key))
          .map(([key, child]) => [key, visit(child)])
      );
    }
    if (typeof item !== "string") return item;
    let result = item;
    for (const root of roots) result = result.replaceAll(root, "[workspace]");
    return sanitizeReportValue(result);
  };
  return visit(value);
}

export async function runPlatformAcceptance({
  claim = "core",
  browser = null,
  output = null,
  workspaceRoot = repoRoot
} = {}) {
  if (!claims.has(claim)) throw new Error(`--claim must be one of: ${[...claims].join(", ")}.`);
  workspaceRoot = resolve(workspaceRoot);
  const initialGitStatus = await capture(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { cwd: workspaceRoot, timeoutMs: 10_000 }
  );
  if (!initialGitStatus.ok) throw stepError(initialGitStatus);
  const outputPath = resolveAcceptanceOutput({ workspaceRoot, output, claim });
  const runId = randomUUID();
  const runRoot = join(workspaceRoot, ".runtime", "platform-acceptance", runId);
  const packageRoot = join(runRoot, "package");
  const callerRoot = join(runRoot, "caller workspace");
  await mkdir(packageRoot, { recursive: true });
  await mkdir(join(callerRoot, "resume", "source"), { recursive: true });
  await mkdir(join(callerRoot, "fixtures"), { recursive: true });
  await copyFile(
    join(workspaceRoot, "resume", "source", "ats.tex"),
    join(callerRoot, "resume", "source", "ats.tex")
  );
  await copyFile(
    join(workspaceRoot, "fixtures", "software_engineering_intern_jd.txt"),
    join(callerRoot, "fixtures", "software_engineering_intern_jd.txt")
  );
  await writeFile(join(callerRoot, "package.json"), '{"private":true,"type":"module"}\n', "utf8");

  const checks = [];
  const identities = {
    platform: platform(),
    architecture: arch(),
    os_release: release(),
    node: process.version,
    npm: null,
    docker: null,
    browser: null,
    desktop: await detectDesktopSession(),
    in_container: await detectContainer()
  };

  const npmVersion = await captureNpm(["--version"], { cwd: workspaceRoot });
  identities.npm = firstLine(npmVersion.stdout);
  const dockerVersion = await capture("docker", ["info", "--format", "{{json .ServerVersion}}"], {
    cwd: workspaceRoot,
    timeoutMs: 10_000
  });
  identities.docker = dockerVersion.ok ? parseJsonString(dockerVersion.stdout) : null;

  checks.push(
    await commandCheck("root-ci", () => captureNpm(["run", "ci"], { cwd: workspaceRoot }))
  );
  checks.push(
    await commandCheck("production-audit", () =>
      captureNpm(["audit", "--omit=dev", "--audit-level=high"], { cwd: workspaceRoot })
    )
  );

  let tarballPath;
  checks.push(
    await operationCheck("package", async () => {
      const dryRun = await captureNpm(["pack", "--dry-run", "--json"], { cwd: workspaceRoot });
      if (!dryRun.ok) throw stepError(dryRun);
      const manifest = JSON.parse(dryRun.stdout)[0];
      const packageFiles = manifest.files.map((file) => file.path);
      const audit = auditPackageFiles(packageFiles);
      if (!audit.ok) throw new Error(`Package audit failed: ${JSON.stringify(audit)}.`);
      const inventorySha256 = await hashPackageContents(packageFiles, { workspaceRoot });
      const packed = await captureNpm(["pack", "--json", "--pack-destination", packageRoot], {
        cwd: workspaceRoot
      });
      if (!packed.ok) throw stepError(packed);
      const filename = JSON.parse(packed.stdout)[0].filename;
      tarballPath = join(packageRoot, filename);
      if (!(await nonEmptyFile(tarballPath))) throw new Error("npm pack produced no tarball.");
      return {
        entries: manifest.entryCount,
        bytes: manifest.size,
        inventory_sha256: inventorySha256
      };
    })
  );

  let cliPath;
  checks.push(
    await operationCheck("fresh-install", async () => {
      if (!tarballPath) throw new Error("Package tarball is unavailable.");
      const install = await captureNpm(
        ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarballPath],
        { cwd: callerRoot, timeoutMs: 60_000 }
      );
      if (!install.ok) throw stepError(install);
      cliPath = join(callerRoot, "node_modules", "resume-cooker", "cli", "resume-cooker.mjs");
      if (!existsSync(cliPath)) throw new Error("Installed CLI entry is missing.");
      const version = await captureNpx(["--no-install", "resume-cooker", "--version"], {
        cwd: callerRoot
      });
      if (!version.ok || !/^\d+\.\d+\.\d+/.test(firstLine(version.stdout))) {
        throw new Error("Installed package binary did not run.");
      }
      const tools = await capture(process.execPath, [cliPath, "tools", "--json"], {
        cwd: callerRoot
      });
      parseSuccessfulCliReport(tools, { command: "tools", requireTools: true });
      return { installed: true, version: firstLine(version.stdout) };
    })
  );

  checks.push(
    await operationCheck("public-compare", async () => {
      if (!cliPath) throw new Error("Installed CLI is unavailable.");
      const compared = await capture(
        process.execPath,
        [
          cliPath,
          "compare",
          "--before",
          "resume/source/ats.tex",
          "--after",
          "resume/source/ats.tex",
          "--jd",
          "fixtures/software_engineering_intern_jd.txt",
          "--json"
        ],
        { cwd: callerRoot, timeoutMs: 30_000 }
      );
      const report = parseSuccessfulCliReport(compared, { command: "compare" });
      return {
        report_status: report.status,
        content_left_machine: false
      };
    })
  );

  checks.push(
    await operationCheck("public-pdf-check", async () => {
      if (!cliPath) throw new Error("Installed CLI is unavailable.");
      const source = "resume/source/ats.tex";
      const jd = "fixtures/software_engineering_intern_jd.txt";
      const build = await capture(
        process.execPath,
        [cliPath, "build", "--resume", source, "--engine", "docker", "--json"],
        { cwd: callerRoot, timeoutMs: 180_000 }
      );
      const buildReport = parseSuccessfulCliReport(build, {
        command: "build",
        statuses: ["pass"]
      });
      const check = await capture(
        process.execPath,
        [
          cliPath,
          "check",
          "--suite",
          "local",
          "--resume",
          source,
          "--build",
          "--engine",
          "docker",
          "--jd",
          jd,
          "--json"
        ],
        { cwd: callerRoot, timeoutMs: 180_000 }
      );
      const checkReport = parseSuccessfulCliReport(check, { command: "check" });
      const pdf = join(callerRoot, "resume", "output", "ats.pdf");
      return {
        build_status: buildReport.status,
        check_status: checkReport.status,
        pdf_bytes: (await stat(pdf)).size,
        content_left_machine: false
      };
    })
  );

  let previewUrl = null;
  let previewBaseUrl = null;
  let browserLaunchUrl = null;
  let previewController = null;
  let previewRunning = null;
  checks.push(
    await operationCheck("preview-lifecycle", async () => {
      if (!cliPath) throw new Error("Installed CLI is unavailable.");
      previewController = new AbortController();
      let readyResolve;
      let readyReject;
      const ready = new Promise((resolvePromise, reject) => {
        readyResolve = resolvePromise;
        readyReject = reject;
      });
      let stdout = "";
      let stderr = "";
      let previewReport = null;
      const maybeReady = () => {
        if (previewReport && previewUrl) readyResolve(previewReport);
      };
      previewRunning = runCommand(
        process.execPath,
        [
          cliPath,
          "preview",
          "--resume",
          "resume/source/ats.tex",
          "--engine",
          "docker",
          "--port",
          "0",
          "--json"
        ],
        {
          cwd: callerRoot,
          quiet: true,
          signal: previewController.signal,
          timeoutMs: 180_000,
          onSpawn: (child) => {
            child.stdout.on("data", (chunk) => {
              stdout += chunk.toString();
              const line = stdout.split(/\r?\n/).find(Boolean);
              if (!line) return;
              try {
                previewReport = validateCliReport(JSON.parse(line), { command: "preview" });
                previewBaseUrl = `http://${previewReport.host}:${previewReport.port}`;
                maybeReady();
              } catch (error) {
                readyReject(error);
              }
            });
            child.stderr.on("data", (chunk) => {
              stderr += chunk.toString();
              const match = stderr.match(
                /Resume Cooker editor:\s+(http:\/\/127\.0\.0\.1:\d+\/\?launch=[A-Za-z0-9_%._-]+)/
              );
              if (!match) return;
              previewUrl = match[1];
              maybeReady();
            });
          }
        }
      );
      previewRunning.catch((error) => {
        if (error.code !== "ABORT_ERR") readyReject(error);
      });
      const report = await withTimeout(ready, 180_000, "Preview did not become ready.");
      if (!previewUrl?.startsWith("http://127.0.0.1:"))
        throw new Error("Preview was not loopback.");
      const launchResponse = await globalThis.fetch(previewUrl, { redirect: "manual" });
      const setCookie = launchResponse.headers.get("set-cookie");
      if (launchResponse.status !== 303 || !setCookie) {
        throw new Error("Preview launch exchange failed.");
      }
      const cookie = setCookie.split(";", 1)[0];
      const authenticatedFetch = (path, options = {}) =>
        globalThis.fetch(`${previewBaseUrl}${path}`, {
          ...options,
          headers: { ...(options.headers || {}), cookie }
        });
      const pageResponse = await authenticatedFetch("/");
      if (!pageResponse.ok) throw new Error("Preview HTTP smoke failed.");
      const pdfBytes = await waitForPreviewPdf(authenticatedFetch);
      const page = await pageResponse.text();
      if (!page.includes("<title>Resume Cooker</title>")) throw new Error("Preview UI is missing.");
      const bootstrap = await authenticatedFetch("/api/bootstrap").then((response) =>
        response.json()
      );
      const browserLaunch = await authenticatedFetch("/api/session/launch", {
        method: "POST",
        headers: { "x-resume-cooker-csrf": bootstrap.csrf_token }
      }).then((response) => response.json());
      browserLaunchUrl = `${previewBaseUrl}${browserLaunch.path}`;
      if (report.content_left_machine !== false)
        throw new Error("Preview privacy state is invalid.");
      return {
        host: "127.0.0.1",
        http: "pass",
        pdf_bytes: pdfBytes.byteLength
      };
    })
  );

  const browserPath = browser || findBrowser();
  checks.push(
    await operationCheck(
      "browser-ui",
      async () => {
        if (!browserLaunchUrl) throw new Error("Preview browser launch URL is unavailable.");
        if (!browserPath) throw new Error("No supported browser executable was found.");
        identities.browser = await browserIdentity(browserPath);
        const profileRoot = join(runRoot, "browser-profile");
        const rendered = await capture(
          browserPath,
          [
            "--headless=new",
            "--disable-gpu",
            "--no-first-run",
            "--no-default-browser-check",
            `--user-data-dir=${profileRoot}`,
            "--dump-dom",
            browserLaunchUrl
          ],
          { timeoutMs: 30_000 }
        );
        if (!rendered.ok || !rendered.stdout.includes("<h1>Resume Cooker</h1>")) {
          throw new Error("Real browser did not render the Resume Cooker UI.");
        }
        return { rendered: true, browser: identities.browser };
      },
      { required: claim !== "core" }
    )
  );

  previewController?.abort();
  if (previewRunning) {
    await previewRunning.catch((error) => {
      if (error.code !== "ABORT_ERR") throw error;
    });
  }
  if (previewBaseUrl) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
    try {
      await globalThis.fetch(previewBaseUrl);
      const row = checks.find((check) => check.id === "preview-lifecycle");
      row.status = "fail";
      row.reason = "Preview port remained reachable after cancellation.";
    } catch {
      // Expected: the loopback server is gone.
    }
  }

  checks.push(
    await operationCheck("artifact-privacy", async () => {
      if (checks.some((check) => check.content_left_machine === true)) {
        throw new Error("An acceptance row reported that content left the machine.");
      }
      for (const path of [
        relative(workspaceRoot, outputPath).replaceAll("\\", "/"),
        relative(workspaceRoot, runRoot).replaceAll("\\", "/")
      ]) {
        const ignored = await capture("git", ["check-ignore", "--no-index", "--quiet", path], {
          cwd: workspaceRoot,
          timeoutMs: 10_000
        });
        if (!ignored.ok) throw new Error(`Generated acceptance path is not ignored: ${path}.`);
      }
      if (existsSync(join(workspaceRoot, "resume-cooker-0.1.0.tgz"))) {
        throw new Error("A package tarball escaped ignored runtime storage.");
      }
      const finalGitStatus = await capture(
        "git",
        ["status", "--porcelain=v1", "--untracked-files=all"],
        { cwd: workspaceRoot, timeoutMs: 10_000 }
      );
      if (!finalGitStatus.ok) throw stepError(finalGitStatus);
      assertGitStatusUnchanged(initialGitStatus.stdout, finalGitStatus.stdout);
      return {
        generated_paths_ignored: true,
        git_status_unchanged: true,
        content_left_machine: false
      };
    })
  );

  const claimResult = assessPlatformClaim({
    claim,
    platform: identities.platform,
    inContainer: identities.in_container,
    identities,
    checks
  });
  const evidence = sanitizePlatformEvidence(
    {
      schema_version: 1,
      run_id: runId,
      generated_at: new Date().toISOString(),
      content_left_machine: false,
      identities,
      checks,
      claim: claimResult
    },
    { workspaceRoot }
  );
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  await rm(runRoot, { recursive: true, force: true });
  return { evidence, outputPath, exitCode: claimResult.certified ? 0 : 1 };
}

async function operationCheck(id, operation, { required = true } = {}) {
  const started = Date.now();
  try {
    const detail = await operation();
    return {
      id,
      required,
      status: "pass",
      duration_ms: Date.now() - started,
      ...detail
    };
  } catch (error) {
    return {
      id,
      required,
      status: required ? "fail" : "skipped",
      duration_ms: Date.now() - started,
      reason: String(sanitizeReportValue(error.message || "Operation failed.")).slice(0, 220)
    };
  }
}

async function commandCheck(id, command) {
  return operationCheck(id, async () => {
    const result = await command();
    if (!result.ok) throw stepError(result);
    return { exit_code: 0 };
  });
}

async function capture(command, args, { cwd = repoRoot, timeoutMs = 120_000 } = {}) {
  try {
    const result = await runCommand(command, args, { cwd, quiet: true, timeoutMs });
    return { ok: true, ...result };
  } catch (error) {
    return {
      ok: false,
      code: Number.isInteger(error.code) ? error.code : null,
      stdout: error.stdout || "",
      stderr: error.stderr || "",
      message: error.message
    };
  }
}

function captureNpm(args, options) {
  if (platform() !== "win32") return capture("npm", args, options);
  return capture(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npm.cmd", ...args], options);
}

function captureNpx(args, options) {
  if (platform() !== "win32") return capture("npx", args, options);
  return capture(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npx.cmd", ...args], options);
}

async function browserIdentity(browserPath) {
  if (platform() === "win32") {
    const escapedPath = browserPath.replaceAll("'", "''");
    const result = await capture(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-Item -LiteralPath '${escapedPath}').VersionInfo.ProductVersion`
      ],
      { timeoutMs: 10_000 }
    );
    if (!result.ok || !firstLine(result.stdout)) throw stepError(result);
    return `${basename(browserPath)} ${firstLine(result.stdout)}`.slice(0, 120);
  }
  const result = await capture(browserPath, ["--version"], { timeoutMs: 10_000 });
  if (!result.ok || !firstLine(result.stdout || result.stderr)) throw stepError(result);
  return firstLine(result.stdout || result.stderr).slice(0, 120);
}

async function detectDesktopSession() {
  if (platform() === "win32") {
    const result = await capture(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "(Get-Process explorer -ErrorAction SilentlyContinue | Select-Object -First 1).Id"
      ],
      { timeoutMs: 10_000 }
    );
    return {
      available: result.ok && /^\d+$/u.test(firstLine(result.stdout) || ""),
      kind: "windows-shell"
    };
  }
  if (platform() === "darwin") {
    const result = await capture("/usr/bin/pgrep", ["-x", "Finder"], { timeoutMs: 10_000 });
    return { available: result.ok, kind: "macos-gui-session" };
  }
  const display = process.env.WAYLAND_DISPLAY ? "wayland" : process.env.DISPLAY ? "x11" : null;
  const sessionType = (process.env.XDG_SESSION_TYPE || "").toLowerCase();
  const remoteShell = Boolean(process.env.SSH_CONNECTION || process.env.SSH_TTY);
  return {
    available: Boolean(display) && ["wayland", "x11"].includes(sessionType) && !remoteShell,
    kind: display || "none"
  };
}

function findBrowser() {
  const candidates =
    platform() === "win32"
      ? [
          join(process.env.PROGRAMFILES || "", "Google", "Chrome", "Application", "chrome.exe"),
          join(
            process.env["PROGRAMFILES(X86)"] || "",
            "Microsoft",
            "Edge",
            "Application",
            "msedge.exe"
          ),
          join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe")
        ]
      : platform() === "darwin"
        ? [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
          ]
        : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  return candidates.find((candidate) => candidate && existsSync(candidate)) || null;
}

async function detectContainer() {
  if (platform() !== "linux") return false;
  if (existsSync("/.dockerenv")) return true;
  try {
    return /(?:docker|containerd|kubepods|podman)/i.test(await readFile("/proc/1/cgroup", "utf8"));
  } catch {
    return false;
  }
}

function rejected(claim, reason) {
  return { certified: false, claim, evidence_class: null, reason };
}

function stepError(result) {
  const error = new Error(
    result.message || `Command exited with code ${result.code ?? "unknown"}.`
  );
  error.code = result.code;
  return error;
}

function parseSuccessfulCliReport(result, options) {
  if (!result.ok) throw stepError(result);
  if (result.stderr.trim()) {
    throw new Error(`Invalid packaged ${options.command} stream ownership.`);
  }
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    throw new Error(`Invalid packaged ${options.command} JSON report.`);
  }
  return validateCliReport(report, options);
}

function firstLine(value = "") {
  return value.trim().split(/\r?\n/, 1)[0] || null;
}

function parseJsonString(value) {
  try {
    const result = JSON.parse(value.trim());
    return typeof result === "string" ? result : null;
  } catch {
    return null;
  }
}

async function nonEmptyFile(path) {
  try {
    const info = await stat(path);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

async function withTimeout(promise, timeoutMs, message) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

export async function waitForPreviewPdf(
  authenticatedFetch,
  {
    timeoutMs = 180_000,
    pollMs = 100,
    sleepImpl = (delay) => new Promise((resolvePromise) => setTimeout(resolvePromise, delay))
  } = {}
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const statusResponse = await authenticatedFetch("/api/status");
    if (!statusResponse.ok) throw new Error("Preview status request failed.");
    const status = await statusResponse.json();
    if (status?.state === "current") {
      const pdfResponse = await authenticatedFetch("/preview.pdf");
      if (!pdfResponse.ok) throw new Error("Preview PDF request failed.");
      const bytes = await pdfResponse.arrayBuffer();
      if (bytes.byteLength === 0) throw new Error("Preview PDF was empty.");
      return bytes;
    }
    if (status?.builtAt && ["failed", "cancelled", "stale"].includes(status.state)) {
      throw new Error("Initial preview compilation did not produce a current PDF.");
    }
    await sleepImpl(pollMs);
  }
  throw new Error("Preview compilation did not finish before the acceptance timeout.");
}

function parseCliArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!name.startsWith("--")) throw new Error(`Unexpected argument: ${name}.`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
    result[name.slice(2)] = value;
  }
  return result;
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const result = await runPlatformAcceptance({
    claim: args.claim || "core",
    browser: args.browser || null,
    output: args.output ? resolve(args.output) : null
  });
  process.stdout.write(
    `${JSON.stringify({
      status: result.evidence.claim.certified ? "pass" : "fail",
      claim: result.evidence.claim,
      output: basename(result.outputPath)
    })}\n`
  );
  process.exitCode = result.exitCode;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  await main().catch((error) => {
    process.stderr.write(`${String(sanitizeReportValue(error.message || "Acceptance failed."))}\n`);
    process.exitCode = 1;
  });
}
