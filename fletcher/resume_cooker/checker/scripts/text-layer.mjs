import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  defaultMaxOutputBytes,
  defaultOperationTimeoutMs,
  getRepoRoot,
  probeCommand,
  probeDockerDaemon,
  runCommand
} from "../../generator/scripts/build-lib.mjs";
import { createCheck } from "./report-lib.mjs";

export const defaultSections = ["Education", "Experience", "Projects", "Skills"];
export const popplerImage =
  "minidocks/poppler@sha256:f79a2bb81818dbade6388474915f9cd28f32a42a80d55fa50a1815aff255421f";

export async function extractPdfText({
  pdf,
  out,
  workspaceRoot = getRepoRoot(),
  probeCommandImpl = probeCommand,
  probeDockerDaemonImpl = probeDockerDaemon,
  runCommandImpl = runCommand,
  timeoutMs = defaultOperationTimeoutMs,
  maxOutputBytes = defaultMaxOutputBytes
}) {
  workspaceRoot = resolve(workspaceRoot);
  const pdfPath = resolve(workspaceRoot, pdf);
  const outPath = resolve(workspaceRoot, out || ".runtime/reports/extracted.txt");
  dockerPath(pdfPath, workspaceRoot);
  dockerPath(outPath, workspaceRoot);
  const runOptions = { quiet: true, timeoutMs, maxOutputBytes };

  const localCapability = await probeCommandImpl("pdftotext", {
    args: ["-v"],
    runCommandImpl
  });
  let localFailure;
  if (localCapability.usable) {
    try {
      await mkdir(dirname(outPath), { recursive: true });
      await rm(outPath, { force: true });
      await runCommandImpl("pdftotext", ["-layout", pdfPath, outPath], runOptions);
      const text = await readFile(outPath, "utf8");
      if (text.trim().length === 0) throw emptyExtraction("pdftotext");
      return {
        tool: "pdftotext",
        path: outPath,
        text,
        contentLeftMachine: false
      };
    } catch (error) {
      localFailure = error;
      // Fall through to Docker when a stale PATH entry or broken install is detected.
    }
  }

  const dockerCapability = await probeDockerDaemonImpl({ runCommandImpl });
  if (dockerCapability.usable) {
    const stagingRoot = join(workspaceRoot, ".runtime", "extracts");
    await mkdir(stagingRoot, { recursive: true });
    const stagingDir = await mkdtemp(join(stagingRoot, "pdftotext-"));
    const stagedOut = join(stagingDir, "extracted.txt");
    try {
      await mkdir(dirname(outPath), { recursive: true });
      await rm(outPath, { force: true });
      await runCommandImpl(
        "docker",
        [
          "run",
          "--rm",
          ...popplerSecurityArgs(),
          "--mount",
          `type=bind,source=${pdfPath},target=/input/resume.pdf,readonly`,
          "--mount",
          `type=bind,source=${stagingDir},target=/output`,
          "--workdir",
          "/input",
          popplerImage,
          "pdftotext",
          "-layout",
          "/input/resume.pdf",
          "/output/extracted.txt"
        ],
        runOptions
      );
      const text = await readFile(stagedOut, "utf8");
      if (text.trim().length === 0) throw emptyExtraction("Docker pdftotext");
      await copyFile(stagedOut, outPath);
      return {
        tool: "docker:pdftotext",
        path: outPath,
        text,
        contentLeftMachine: false
      };
    } catch (error) {
      if (error.code === "EMPTY_EXTRACTION") throw error;
      const failure = new Error("Docker PDF text extraction failed.");
      failure.code = "EXTRACTION_FAILED";
      throw failure;
    } finally {
      await rm(stagingDir, { recursive: true, force: true });
    }
  }

  if (localFailure?.code === "EMPTY_EXTRACTION") throw localFailure;
  if (localFailure) {
    const error = new Error(`Local pdftotext execution failed. ${dockerCapability.reason}`.trim());
    error.code = "EXTRACTION_FAILED";
    throw error;
  }
  const error = new Error(
    `No usable PDF text extractor. ${localCapability.reason} ${dockerCapability.reason}`.trim()
  );
  error.code = "CAPABILITY_UNAVAILABLE";
  throw error;
}

export async function checkPdfPageLimit({
  pdf,
  maxPages = 1,
  required = false,
  workspaceRoot = getRepoRoot(),
  probeCommandImpl = probeCommand,
  probeDockerDaemonImpl = probeDockerDaemon,
  runCommandImpl = runCommand,
  timeoutMs = defaultOperationTimeoutMs,
  maxOutputBytes = defaultMaxOutputBytes
}) {
  const result = await countPdfPages({
    pdf,
    workspaceRoot,
    probeCommandImpl,
    probeDockerDaemonImpl,
    runCommandImpl,
    timeoutMs,
    maxOutputBytes
  });
  if (!result.available) {
    return createCheck({
      id: "pdf_page_count_unavailable",
      category: "pdf_text_layer",
      severity: required ? "blocker" : "medium",
      status: required ? "fail" : "warning",
      evidence: `Could not count PDF pages: ${result.reason}.`,
      suggestedFix:
        "Install pdfinfo/poppler or start Docker before treating page-limit checks as complete.",
      metadata: { required_capability_unavailable: required }
    });
  }

  return createCheck({
    id: "pdf_page_limit",
    category: "pdf_text_layer",
    severity: "blocker",
    status: result.pages <= maxPages ? "pass" : "fail",
    evidence:
      result.pages <= maxPages
        ? `PDF is ${result.pages} page(s), within the ${maxPages}-page limit.`
        : `PDF is ${result.pages} page(s), exceeding the ${maxPages}-page limit.`,
    suggestedFix:
      result.pages <= maxPages
        ? ""
        : "Tighten content or layout until the resume fits on one page.",
    metadata: { pages: result.pages, max_pages: maxPages, tool: result.tool }
  });
}

export async function countPdfPages({
  pdf,
  workspaceRoot = getRepoRoot(),
  probeCommandImpl = probeCommand,
  probeDockerDaemonImpl = probeDockerDaemon,
  runCommandImpl = runCommand,
  timeoutMs = defaultOperationTimeoutMs,
  maxOutputBytes = defaultMaxOutputBytes
}) {
  workspaceRoot = resolve(workspaceRoot);
  const pdfPath = resolve(workspaceRoot, pdf);
  dockerPath(pdfPath, workspaceRoot);
  const failures = [];
  const runOptions = { quiet: true, timeoutMs, maxOutputBytes };

  const localCapability = await probeCommandImpl("pdfinfo", {
    args: ["-v"],
    runCommandImpl
  });
  if (localCapability.usable) {
    try {
      const result = await runCommandImpl("pdfinfo", [pdfPath], runOptions);
      const parsed = parsePdfInfo(result.stdout, "pdfinfo");
      if (parsed.available) return parsed;
      failures.push(parsed.reason);
    } catch {
      failures.push("pdfinfo execution failed");
      // Fall through to Docker when a stale PATH entry or broken install is detected.
    }
  } else {
    failures.push(localCapability.reason);
  }

  const dockerCapability = await probeDockerDaemonImpl({ runCommandImpl });
  if (dockerCapability.usable) {
    try {
      const result = await runCommandImpl(
        "docker",
        [
          "run",
          "--rm",
          ...popplerSecurityArgs(),
          "--mount",
          `type=bind,source=${pdfPath},target=/input/resume.pdf,readonly`,
          "--workdir",
          "/input",
          popplerImage,
          "pdfinfo",
          "/input/resume.pdf"
        ],
        runOptions
      );
      const parsed = parsePdfInfo(result.stdout, "docker:pdfinfo");
      if (parsed.available) return parsed;
      failures.push(parsed.reason);
    } catch {
      failures.push("Docker pdfinfo execution failed");
    }
  } else {
    failures.push(dockerCapability.reason);
  }

  return {
    available: false,
    usable: false,
    reason: failures.filter(Boolean).join("; ") || "No usable PDF page counter."
  };
}

export function analyzeExtractedText(text, options = {}) {
  const checks = [];
  const normalized = normalizeText(text);
  const sections = options.sections || defaultSections;
  const criticalTerms = options.criticalTerms || [];

  checks.push(checkNonEmptyText(normalized));
  checks.push(...checkSectionPresenceAndOrder(normalized, sections));
  checks.push(...checkCriticalTerms(normalized, criticalTerms));
  checks.push(checkEncodingNoise(normalized));

  return checks;
}

function checkNonEmptyText(text) {
  const ok = text.trim().length > 0;
  return createCheck({
    id: "pdf_text_non_empty",
    category: "pdf_text_layer",
    severity: "blocker",
    status: ok ? "pass" : "fail",
    evidence: ok ? "Extracted text is non-empty." : "Extracted text is empty.",
    suggestedFix: ok ? "" : "Rebuild the PDF and inspect whether the PDF text layer is selectable."
  });
}

function checkSectionPresenceAndOrder(text, sections) {
  const positions = sections.map((section) => ({
    section,
    index: text.search(new RegExp(`\\b${escapeRegExp(section)}\\b`, "i"))
  }));

  const missing = positions.filter((position) => position.index === -1);
  const present = positions.filter((position) => position.index !== -1);
  const ordered = present.every((position, index) => {
    if (index === 0) return true;
    return position.index >= present[index - 1].index;
  });

  return [
    createCheck({
      id: "section_headings_present",
      category: "pdf_text_layer",
      severity: "high",
      status: missing.length === 0 ? "pass" : "warning",
      evidence:
        missing.length === 0
          ? `Found expected sections: ${sections.join(", ")}.`
          : `Missing expected section heading(s): ${missing.map((item) => item.section).join(", ")}.`,
      suggestedFix:
        missing.length === 0 ? "" : "Confirm whether the resume uses standard section headings."
    }),
    createCheck({
      id: "section_order_readable",
      category: "pdf_text_layer",
      severity: "medium",
      status: ordered ? "pass" : "warning",
      evidence: ordered
        ? "Detected sections appear in expected order."
        : "Detected sections appear out of expected order.",
      suggestedFix: ordered
        ? ""
        : "Inspect extracted text order before adding stricter ATS or postflight gates."
    })
  ];
}

function checkCriticalTerms(text, terms) {
  return terms.map((term) => {
    const found = text.toLowerCase().includes(term.toLowerCase());
    return createCheck({
      id: "critical_term_present",
      category: "pdf_text_layer",
      severity: "medium",
      status: found ? "pass" : "warning",
      evidence: found
        ? `Configured term "${term}" appears in extracted text.`
        : `Configured term "${term}" was not found exactly in extracted text.`,
      suggestedFix: found
        ? ""
        : "Check whether the term is absent intentionally or split/corrupted in the PDF text layer.",
      metadata: { term }
    });
  });
}

function checkEncodingNoise(text) {
  const replacementCount = (text.match(/\uFFFD/g) || []).length;
  return createCheck({
    id: "encoding_noise_low",
    category: "pdf_text_layer",
    severity: "high",
    status: replacementCount === 0 ? "pass" : "warning",
    evidence:
      replacementCount === 0
        ? "No Unicode replacement characters found."
        : `Found ${replacementCount} Unicode replacement character(s).`,
    suggestedFix:
      replacementCount === 0
        ? ""
        : "Inspect LaTeX font encoding, glyph commands, or the extraction tool output."
  });
}

function normalizeText(text) {
  return text.replace(/\r\n/g, "\n");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parsePdfInfo(stdout, tool) {
  const match = stdout.match(/^Pages:\s*(\d+)\s*$/im);
  const pages = match ? Number(match[1]) : null;
  if (!Number.isSafeInteger(pages) || pages < 1) {
    return {
      available: false,
      usable: false,
      reason: `${tool} output did not include a valid page count`
    };
  }
  return { available: true, usable: true, tool, pages };
}

function emptyExtraction(tool) {
  const error = new Error(`${tool} produced empty output.`);
  error.code = "EMPTY_EXTRACTION";
  return error;
}

function dockerPath(path, workspaceRoot) {
  const value = relative(workspaceRoot, path);
  if (isAbsolute(value) || value === ".." || value.startsWith(`..${sep}`)) {
    const error = new Error("Docker paths must stay inside the selected workspace.");
    error.code = "INVALID_USAGE";
    throw error;
  }
  return value.replaceAll("\\", "/") || ".";
}

function popplerSecurityArgs() {
  const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
  const gid = typeof process.getgid === "function" ? process.getgid() : 1000;
  return [
    "--network=none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit=64",
    "--memory=256m",
    "--cpus=1",
    "--user",
    `${uid}:${gid}`,
    "--env",
    "HOME=/tmp",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,nodev,size=64m"
  ];
}
