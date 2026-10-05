import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import { createReadStream, realpathSync } from "node:fs";
import { copyFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizeReportValue } from "../../checker/scripts/report-lib.mjs";
import { buildPdf, getRepoRoot, parseArgs, probeCommand, probeDockerDaemon } from "./build-lib.mjs";
import {
  createOutputService,
  createReportOperationService,
  createSourceFileService
} from "./ui-services.mjs";

const sessionCookieName = "resume_cooker_session";

export function createPreviewService({
  repoRoot = getRepoRoot(),
  source = "resume/source/current.tex",
  engine = "auto",
  buildPdfImpl = buildPdf,
  runCheckImpl,
  idFactory = randomUUID,
  nowImpl = () => new Date()
} = {}) {
  const sourceFiles = createSourceFileService({ repoRoot });
  const sourcePath = validateInitialSource(repoRoot, source);
  const normalizedSource = relative(repoRoot, sourcePath).replaceAll("\\", "/");
  const previewDir = resolve(repoRoot, ".runtime", "preview");
  const previewPdf = join(previewDir, `${basename(sourcePath, extname(sourcePath))}.pdf`);
  const artifact = relative(repoRoot, previewPdf).replaceAll("\\", "/");
  const reports = createReportOperationService({ repoRoot, runCheckImpl, idFactory, nowImpl });
  const outputs = createOutputService({ repoRoot, buildPdfImpl });
  let active = null;
  let generation = 0;
  let transitionQueue = Promise.resolve();
  let status = {
    state: "failed",
    ok: false,
    stale: false,
    message: "Not built yet.",
    source: normalizedSource,
    source_revision: null,
    artifact,
    buildId: null,
    lastGoodBuildId: null,
    artifact_revision: null,
    pdfUrl: "",
    builtAt: null
  };

  const compile = async () => {
    const buildId = idFactory();
    const { operationGeneration, controller } = await withTransition(() => {
      const operationGeneration = ++generation;
      active?.controller.abort();
      const controller = new AbortController();
      active = { buildId, controller };
      return { operationGeneration, controller };
    });
    const operationDir = join(previewDir, "builds", String(operationGeneration));
    const operationPdf = join(operationDir, basename(previewPdf));
    const replacement = join(previewDir, `.${basename(previewPdf)}.${operationGeneration}.tmp`);
    let loaded;
    try {
      loaded = await sourceFiles.load(normalizedSource);
      if (controller.signal.aborted || operationGeneration !== generation)
        return withTransition(refreshStatus);
      status = {
        ...status,
        state: "running",
        ok: false,
        stale: Boolean(status.lastGoodBuildId),
        message: "Building preview.",
        buildId,
        source_revision: loaded.revision
      };
      const result = await buildPdfImpl({
        source: normalizedSource,
        outDir: operationDir,
        workspaceRoot: repoRoot,
        engine,
        clean: true,
        quiet: true,
        signal: controller.signal
      });
      const resultPath = resolve(result.pdfPath);
      if (resultPath !== resolve(operationPdf) || !(await isNonEmptyFile(resultPath))) {
        throw typed(
          "ARTIFACT_MISSING",
          "Preview build did not produce the expected non-empty PDF."
        );
      }
      await mkdir(previewDir, { recursive: true });
      await copyFile(resultPath, replacement);
      await withTransition(async () => {
        const currentSource = await sourceFiles.load(normalizedSource);
        if (currentSource.revision !== loaded.revision) {
          throw typed("SOURCE_CHANGED", "Source changed during preview build.");
        }
        if (controller.signal.aborted) throw typed("ABORT_ERR", "Preview build cancelled.");
        if (operationGeneration !== generation) return;
        await rename(replacement, previewPdf);
        status = {
          state: "current",
          ok: true,
          stale: false,
          message: `Built with ${result.engine}.`,
          source: normalizedSource,
          source_revision: loaded.revision,
          artifact,
          buildId,
          lastGoodBuildId: buildId,
          artifact_revision: loaded.revision,
          pdfUrl: `/preview.pdf?build=${encodeURIComponent(buildId)}`,
          builtAt: nowImpl().toISOString()
        };
      });
    } catch (error) {
      await withTransition(async () => {
        if (operationGeneration !== generation) return;
        const hasLastGood = Boolean(status.lastGoodBuildId) && (await isNonEmptyFile(previewPdf));
        const cancelled = controller.signal.aborted || error.code === "ABORT_ERR";
        status = {
          ...status,
          state: cancelled ? "cancelled" : hasLastGood ? "stale" : "failed",
          ok: false,
          stale: hasLastGood,
          message: cancelled
            ? "Preview build cancelled."
            : hasLastGood
              ? "Preview build failed; showing the last good PDF."
              : sanitizeBuildError(error),
          source_revision: loaded?.revision ?? status.source_revision,
          buildId,
          lastGoodBuildId: hasLastGood ? status.lastGoodBuildId : null,
          artifact_revision: hasLastGood ? status.artifact_revision : null,
          pdfUrl: hasLastGood
            ? `/preview.pdf?build=${encodeURIComponent(status.lastGoodBuildId)}`
            : "",
          builtAt: nowImpl().toISOString()
        };
      });
    } finally {
      await rm(replacement, { force: true });
      await rm(operationDir, { recursive: true, force: true });
      if (active?.buildId === buildId) active = null;
    }
    return withTransition(refreshStatus);
  };

  return {
    sourcePath,
    previewDir,
    previewPdf,
    reports,
    outputs,
    compile,
    cancelCompile() {
      if (active) active.controller.abort();
      return { ...status };
    },
    getStatus() {
      return withTransition(refreshStatus);
    },
    getSource() {
      return sourceFiles.load(normalizedSource);
    },
    async saveSource(input) {
      return withTransition(async () => {
        const saved = await sourceFiles.save({ source: normalizedSource, ...input });
        generation += 1;
        active?.controller.abort();
        const hasLastGood = Boolean(status.lastGoodBuildId) && (await isNonEmptyFile(previewPdf));
        status = {
          ...status,
          state: hasLastGood ? "stale" : "failed",
          ok: false,
          stale: hasLastGood,
          message: hasLastGood
            ? "Source changed; showing the last good PDF."
            : "Source changed; build the preview.",
          source_revision: saved.revision,
          lastGoodBuildId: hasLastGood ? status.lastGoodBuildId : null,
          artifact_revision: hasLastGood ? status.artifact_revision : null,
          pdfUrl: hasLastGood
            ? `/preview.pdf?build=${encodeURIComponent(status.lastGoodBuildId)}`
            : ""
        };
        return saved;
      });
    },
    async getPreviewPath() {
      return withTransition(async () =>
        (await refreshStatus()).lastGoodBuildId ? previewPdf : null
      );
    },
    async getTools() {
      return Promise.all(
        ["latexmk", "pdflatex", "pdftotext", "pdfinfo", "docker"].map(async (tool) => ({
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

  async function refreshStatus() {
    let revision = null;
    try {
      revision = (await sourceFiles.load(normalizedSource)).revision;
    } catch {
      // Do not retain a current claim when the approved source cannot be read.
    }
    const hasLastGood = Boolean(status.lastGoodBuildId) && (await isNonEmptyFile(previewPdf));
    const changed = revision === null || revision !== status.artifact_revision;
    if ((status.lastGoodBuildId && !hasLastGood) || (hasLastGood && changed)) {
      status = {
        ...status,
        state: status.state === "running" ? "running" : hasLastGood ? "stale" : "failed",
        ok: false,
        stale: hasLastGood,
        message: !hasLastGood
          ? "Preview unavailable; build the preview again."
          : revision === null
            ? "Source unavailable; showing the last good PDF. Restore the source and rebuild."
            : "Source changed; showing the last good PDF. Rebuild to update it.",
        lastGoodBuildId: hasLastGood ? status.lastGoodBuildId : null,
        artifact_revision: hasLastGood ? status.artifact_revision : null,
        pdfUrl: hasLastGood ? status.pdfUrl : ""
      };
    }
    status = { ...status, source_revision: revision };
    return { ...status };
  }

  function withTransition(operation) {
    const pending = transitionQueue.then(operation, operation);
    transitionQueue = pending.catch(() => {});
    return pending;
  }
}

export function createPreviewServer({
  service,
  indexPath,
  csrfToken = randomBytes(24).toString("base64url"),
  launchCapability = randomBytes(32).toString("base64url"),
  sessionToken = randomBytes(32).toString("base64url")
}) {
  const launchCapabilities = new Set([launchCapability]);
  return createServer(async (req, res) => {
    try {
      if (!validHostRequest(req)) {
        return sendJson(res, { error: "Request host is not allowed." }, 403);
      }
      const url = new URL(req.url || "/", "http://127.0.0.1");
      const route = `${req.method || "GET"} ${url.pathname}`;

      if (route === "GET /" && url.searchParams.has("launch")) {
        const presented = url.searchParams.get("launch") || "";
        const matched = [...launchCapabilities].find((candidate) =>
          safeEqual(presented, candidate)
        );
        if (!matched) {
          return sendJson(res, { error: "Launch authorization failed." }, 403);
        }
        launchCapabilities.delete(matched);
        res.writeHead(303, {
          ...securityHeaders("text/plain; charset=utf-8"),
          location: "/",
          "set-cookie": `${sessionCookieName}=${sessionToken}; Path=/; HttpOnly; SameSite=Strict`
        });
        return res.end("Session established.");
      }
      if (!validSessionRequest(req, sessionToken)) {
        return sendJson(res, { error: "Authentication required." }, 401);
      }

      if (route === "GET /") return sendFile(res, indexPath, "text/html; charset=utf-8");
      if (route === "GET /favicon.ico") {
        res.writeHead(204, securityHeaders("image/x-icon"));
        return res.end();
      }
      if (route === "GET /api/bootstrap") {
        return sendJson(res, {
          schema_version: 1,
          csrf_token: csrfToken,
          source: (await service.getSource()).source,
          api_review_enabled: false
        });
      }
      if (route === "GET /api/status") return sendJson(res, await service.getStatus());
      if (route === "GET /api/source") return sendJson(res, await service.getSource());
      if (route === "GET /api/check") return sendJson(res, service.reports.getState());
      if (route === "GET /api/tools") return sendJson(res, { tools: await service.getTools() });
      if (route === "GET /preview.pdf") {
        const path = await service.getPreviewPath();
        if (!path) return sendText(res, 404, "Preview unavailable");
        return sendFile(res, path, "application/pdf", { embeddable: true });
      }

      if (url.pathname.startsWith("/api/") && !["GET", "HEAD"].includes(req.method || "")) {
        if (!validMutationRequest(req, csrfToken)) {
          return sendJson(res, { error: "Mutation authorization failed." }, 403);
        }
      }
      if (route === "PUT /api/source") {
        const body = await readJsonBody(req);
        return sendJson(res, await service.saveSource(body));
      }
      if (route === "POST /api/compile") {
        const result = await service.compile();
        return sendJson(
          res,
          result,
          result.ok || result.stale || result.state === "cancelled" ? 200 : 500
        );
      }
      if (route === "POST /api/compile/cancel") {
        service.cancelCompile();
        return sendJson(res, await service.getStatus());
      }
      if (route === "POST /api/session/launch") {
        const capability = randomBytes(32).toString("base64url");
        launchCapabilities.add(capability);
        return sendJson(res, { path: `/?launch=${encodeURIComponent(capability)}` });
      }
      if (route === "POST /api/check") {
        const body = await readJsonBody(req);
        const loaded = await service.getSource();
        const previewStatus = await service.getStatus();
        return sendJson(
          res,
          await service.reports.run({
            source: loaded.source,
            pdf:
              previewStatus.lastGoodBuildId && previewStatus.artifact_revision === loaded.revision
                ? previewStatus.artifact
                : undefined,
            jd: body.jd,
            profile: body.profile,
            suite: body.suite
          })
        );
      }
      if (route === "POST /api/check/cancel") {
        return sendJson(res, service.reports.cancel());
      }
      if (route === "POST /api/output") {
        const body = await readJsonBody(req);
        return sendJson(
          res,
          await service.outputs.save({
            source: (await service.getSource()).source,
            name: body.name,
            overwrite: body.overwrite === true,
            engine: body.engine || "auto"
          })
        );
      }
      return sendText(res, 404, "Not found");
    } catch (error) {
      const status = httpStatus(error);
      return sendJson(res, { error: safeUiError(error) }, status);
    }
  });
}

export async function startPreviewServer({
  repoRoot = getRepoRoot(),
  source = "resume/source/current.tex",
  engine = "auto",
  port = 4177,
  host = "127.0.0.1",
  buildPdfImpl,
  runCheckImpl,
  idFactory,
  nowImpl
} = {}) {
  if (host !== "127.0.0.1") throw typed("INVALID_HOST", "Preview server must bind to 127.0.0.1.");
  const service = createPreviewService({
    repoRoot,
    source,
    engine,
    buildPdfImpl,
    runCheckImpl,
    idFactory,
    nowImpl
  });
  const launchCapability = randomBytes(32).toString("base64url");
  const sessionToken = randomBytes(32).toString("base64url");
  const server = createPreviewServer({
    service,
    indexPath: join(getRepoRoot(), "generator", "public", "index.html"),
    launchCapability,
    sessionToken
  });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolvePromise);
  });
  const address = server.address();
  const baseUrl = `http://${host}:${address.port}`;
  const url = `${baseUrl}/?launch=${encodeURIComponent(launchCapability)}`;
  const initialCompile = service.compile();
  return {
    service,
    server,
    url,
    baseUrl,
    initialCompile,
    close: () =>
      new Promise((resolvePromise, reject) => {
        service.cancelCompile();
        service.reports.cancel();
        const finish = async (error) => {
          await initialCompile.catch(() => {});
          if (error) reject(error);
          else resolvePromise();
        };
        if (!server.listening) return void finish();
        server.close((error) => void finish(error));
      })
  };
}

function validHostRequest(req) {
  const port = req.socket.localPort;
  const host = req.headers.host;
  if (!Number.isSafeInteger(port) || typeof host !== "string") return false;
  return host === `127.0.0.1:${port}` || (port === 80 && host === "127.0.0.1");
}

function validMutationRequest(req, csrfToken) {
  if (req.headers["x-resume-cooker-csrf"] !== csrfToken) return false;
  const host = req.headers.host;
  const origin = req.headers.origin;
  if (!origin) return true;
  return origin === `http://${host}`;
}

function validSessionRequest(req, sessionToken) {
  const cookieHeader = req.headers.cookie;
  if (typeof cookieHeader !== "string") return false;
  const token = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${sessionCookieName}=`))
    ?.slice(sessionCookieName.length + 1);
  return safeEqual(token || "", sessionToken);
}

function safeEqual(actual, expected) {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function validateInitialSource(repoRoot, source) {
  try {
    const root = realpathSync(resolve(repoRoot, "resume", "source"));
    const path = realpathSync(resolve(repoRoot, source));
    const fromRoot = relative(root, path);
    if (
      extname(path).toLowerCase() !== ".tex" ||
      isAbsolute(fromRoot) ||
      fromRoot === ".." ||
      fromRoot.startsWith(`..\\`) ||
      fromRoot.startsWith("../")
    ) {
      throw new Error("outside");
    }
    return path;
  } catch {
    throw typed("INVALID_SOURCE", "Preview source must be an approved existing .tex file.");
  }
}

async function readJsonBody(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 2_100_000) throw typed("BODY_TOO_LARGE", "Request body is too large.");
    chunks.push(chunk);
  }
  try {
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
  } catch {
    throw typed("INVALID_JSON", "Request body must be valid JSON.");
  }
}

async function isNonEmptyFile(path) {
  try {
    const info = await stat(path);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

function sanitizeBuildError(error) {
  if (["CAPABILITY_UNAVAILABLE", "ARTIFACT_MISSING", "INVALID_ENGINE"].includes(error.code)) {
    return safeUiError(error);
  }
  return "Preview build failed.";
}

function safeUiError(error) {
  const allowed = new Set([
    "API_CONFIRMATION_REQUIRED",
    "BODY_TOO_LARGE",
    "CONFLICT",
    "FORBIDDEN",
    "INVALID_JSON",
    "INVALID_OUTPUT",
    "INVALID_SOURCE",
    "NOT_FOUND",
    "OUTPUT_EXISTS"
  ]);
  if (!allowed.has(error.code)) return "Request failed.";
  return String(sanitizeReportValue(error.message)).replace(/\s+/g, " ").slice(0, 220);
}

function httpStatus(error) {
  if (error.code === "NOT_FOUND") return 404;
  if (error.code === "CONFLICT" || error.code === "OUTPUT_EXISTS") return 409;
  if (error.code === "FORBIDDEN") return 403;
  if (
    [
      "API_CONFIRMATION_REQUIRED",
      "BODY_TOO_LARGE",
      "INVALID_JSON",
      "INVALID_OUTPUT",
      "INVALID_SOURCE"
    ].includes(error.code)
  ) {
    return 400;
  }
  return 500;
}

function securityHeaders(contentType, { embeddable = false } = {}) {
  return {
    "content-type": contentType,
    "cache-control": "no-store",
    "content-security-policy": `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors ${embeddable ? "'self'" : "'none'"}`,
    "cross-origin-resource-policy": "same-origin",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": embeddable ? "SAMEORIGIN" : "DENY"
  };
}

function sendJson(res, body, status = 200) {
  res.writeHead(status, securityHeaders("application/json; charset=utf-8"));
  res.end(JSON.stringify(body));
}

function sendText(res, status, body) {
  res.writeHead(status, securityHeaders("text/plain; charset=utf-8"));
  res.end(body);
}

function sendFile(res, path, contentType, options) {
  const stream = createReadStream(path);
  stream.on("error", () => {
    if (res.headersSent) return res.destroy();
    sendText(res, 404, "Not found");
  });
  stream.once("open", () => {
    res.writeHead(200, securityHeaders(contentType, options));
    stream.pipe(res);
  });
}

function typed(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  try {
    const running = await startPreviewServer({
      source: args.source,
      engine: args.engine,
      port: Number(args.port || 4177)
    });
    console.log(`Resume Cooker editor: ${running.url}`);
    console.log(`Source: ${(await running.service.getStatus()).source}`);
    const stop = async () => {
      await running.close();
      process.exit(0);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  } catch (error) {
    console.error(safeUiError(error));
    process.exit(error.code?.startsWith("INVALID_") ? 64 : 70);
  }
}
