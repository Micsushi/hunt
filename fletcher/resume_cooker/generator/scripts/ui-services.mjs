import { createHash, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { existsSync, realpathSync } from "node:fs";
import { link, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { sanitizeReportValue } from "../../checker/scripts/report-lib.mjs";
import { buildPdf, getRepoRoot, runCommand } from "./build-lib.mjs";

const packageRoot = getRepoRoot();

export function createSourceFileService({ repoRoot, roots = ["resume/source"] }) {
  const approvedRoots = roots.map((root) => realpathSync(resolve(repoRoot, root)));
  let saveQueue = Promise.resolve();

  async function resolveSource(source) {
    if (typeof source !== "string" || source.length === 0 || source.length > 512) {
      throw typed("INVALID_SOURCE", "Source identifier is invalid.");
    }
    let canonical;
    try {
      canonical = realpathSync(resolve(repoRoot, source));
    } catch {
      throw typed("NOT_FOUND", "Source was not found.");
    }
    const approved = approvedRoots.some((root) => isInside(root, canonical));
    if (!approved || extname(canonical).toLowerCase() !== ".tex") {
      throw typed("FORBIDDEN", "Source is outside the approved LaTeX workspace.");
    }
    return canonical;
  }

  async function load(source) {
    const path = await resolveSource(source);
    const text = await readFile(path, "utf8");
    const info = await stat(path);
    return {
      source: relative(repoRoot, path).replaceAll("\\", "/"),
      name: basename(path),
      text,
      revision: revisionFor(text),
      bytes: info.size,
      modified_at: info.mtime.toISOString()
    };
  }

  async function saveNow({ source, text, revision }) {
    if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > 2_000_000) {
      throw typed("INVALID_SOURCE", "Source text is invalid or too large.");
    }
    const path = await resolveSource(source);
    const current = await readFile(path, "utf8");
    if (revisionFor(current) !== revision) {
      throw typed("CONFLICT", "Source changed on disk; reload before saving.");
    }
    const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, text, { encoding: "utf8", flag: "wx" });
      const latest = await readFile(path, "utf8");
      if (revisionFor(latest) !== revision) {
        throw typed("CONFLICT", "Source changed on disk; reload before saving.");
      }
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
    return load(relative(repoRoot, path));
  }

  function save(input) {
    const pending = saveQueue.then(
      () => saveNow(input),
      () => saveNow(input)
    );
    saveQueue = pending.catch(() => {});
    return pending;
  }

  return { load, save, resolveSource };
}

export function createReportOperationService({
  repoRoot,
  runCheckImpl,
  idFactory = randomUUID,
  nowImpl = () => new Date()
}) {
  const checkRunner =
    runCheckImpl || ((options, { signal }) => runCliCheck(repoRoot, options, { signal }));
  let current = {
    state: "idle",
    operation_id: null,
    status: null,
    report: null,
    message: "No check has run."
  };
  let controller = null;

  return {
    getState: () => clone(current),
    cancel() {
      if (!controller) return clone(current);
      controller.abort();
      current = {
        ...current,
        state: "cancelled",
        message: "Check cancelled.",
        completed_at: nowImpl().toISOString()
      };
      return clone(current);
    },
    async run({ source, pdf, jd, profile = "normal", suite = "local" }) {
      if (suite !== "local") {
        throw typed("API_CONFIRMATION_REQUIRED", "Only local checks are enabled in UI v1.");
      }
      const operationId = idFactory();
      controller?.abort();
      controller = new AbortController();
      current = {
        state: "running",
        operation_id: operationId,
        status: null,
        report: null,
        message: "Running local checks.",
        started_at: nowImpl().toISOString()
      };
      try {
        const report = await checkRunner(
          {
            suite,
            resume: resolve(repoRoot, source),
            pdf: pdf ? resolve(repoRoot, pdf) : undefined,
            jd: jd ? resolve(repoRoot, jd) : undefined,
            profile
          },
          { signal: controller.signal }
        );
        if (controller.signal.aborted || current.operation_id !== operationId) {
          return clone(current);
        }
        current = {
          state: "complete",
          operation_id: operationId,
          status: report.status,
          report: projectReport(report),
          message: report.summary,
          completed_at: nowImpl().toISOString()
        };
      } catch {
        if (current.operation_id !== operationId) return clone(current);
        current = {
          state: controller.signal.aborted ? "cancelled" : "failed",
          operation_id: operationId,
          status: null,
          report: null,
          message: controller.signal.aborted ? "Check cancelled." : "Local check failed.",
          completed_at: nowImpl().toISOString()
        };
      } finally {
        if (current.operation_id === operationId) controller = null;
      }
      return clone(current);
    }
  };
}

async function runCliCheck(repoRoot, options, { signal }) {
  const args = [
    resolve(packageRoot, "cli", "resume-cooker.mjs"),
    "check",
    "--suite",
    options.suite,
    "--resume",
    options.resume,
    "--profile",
    options.profile,
    "--json"
  ];
  if (options.pdf) args.push("--pdf", options.pdf);
  if (options.jd) args.push("--jd", options.jd);
  let stdout;
  try {
    ({ stdout } = await runCommand(process.execPath, args, {
      cwd: repoRoot,
      quiet: true,
      signal
    }));
  } catch (error) {
    if (error.code === "ABORT_ERR") throw error;
    if (![2, 69].includes(error.code) || !error.stdout) throw error;
    stdout = error.stdout;
  }
  try {
    return JSON.parse(stdout);
  } catch {
    throw typed("MALFORMED_REPORT", "Local check returned an invalid report.");
  }
}

export function createOutputService({ repoRoot, buildPdfImpl = buildPdf }) {
  const outputRoot = resolve(repoRoot, "resume", "output");
  return {
    async save({ source, name, overwrite = false, engine = "auto" }) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.pdf$/u.test(name || "")) {
        throw typed("INVALID_OUTPUT", "Output name must be a safe .pdf filename.");
      }
      const target = resolve(outputRoot, name);
      if (!isInside(outputRoot, target)) throw typed("FORBIDDEN", "Output path is not approved.");
      if (existsSync(target) && !overwrite) {
        throw typed("OUTPUT_EXISTS", "Output exists; confirm overwrite.");
      }
      const staging = resolve(repoRoot, ".runtime", "output-save", randomUUID());
      try {
        const result = await buildPdfImpl({
          source,
          outDir: staging,
          workspaceRoot: repoRoot,
          engine,
          clean: false,
          quiet: true
        });
        const built = resolve(result.pdfPath);
        const generated = await readFile(built);
        if (generated.length === 0) throw typed("ARTIFACT_MISSING", "Saved PDF is empty.");
        const temporary = join(outputRoot, `.${name}.${randomUUID()}.tmp`);
        try {
          await mkdir(outputRoot, { recursive: true });
          await writeFile(temporary, generated, { flag: "wx" });
          if (overwrite) {
            await rename(temporary, target);
          } else {
            try {
              await link(temporary, target);
            } catch (error) {
              if (error.code === "EEXIST") {
                throw typed("OUTPUT_EXISTS", "Output exists; confirm overwrite.");
              }
              throw error;
            }
          }
        } finally {
          await rm(temporary, { force: true });
        }
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
      const info = await stat(target);
      if (!info.isFile() || info.size === 0) throw typed("ARTIFACT_MISSING", "Saved PDF is empty.");
      return { name, bytes: info.size, saved: true };
    }
  };
}

export function revisionFor(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function projectReport(report) {
  return sanitizeReportValue({
    schema_version: report.schema_version,
    status: report.status,
    summary: report.summary,
    content_left_machine: report.content_left_machine === true,
    checks: (report.checks || []).map((check) => ({
      id: check.id,
      category: check.category,
      severity: check.severity,
      status: check.status,
      evidence: check.evidence,
      suggested_fix: check.suggested_fix,
      metadata: check.metadata
    }))
  });
}

function isInside(root, candidate) {
  const value = relative(root, candidate);
  return (
    value === "" ||
    (!isAbsolute(value) && value !== ".." && !value.startsWith(`..\\`) && !value.startsWith("../"))
  );
}

function typed(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
