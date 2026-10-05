import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { createPreviewService, startPreviewServer } from "./preview-server.mjs";

const tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

test("preview serves the PDF matching the selected ATS source and reports current state", async () => {
  const root = await createFixtureRoot();
  const ids = ["build-1"];
  const running = await startPreviewServer({
    repoRoot: root,
    source: "resume/source/ats.tex",
    port: 0,
    idFactory: () => ids.shift(),
    buildPdfImpl: async ({ outDir }) => {
      const pdfPath = join(outDir, "ats.pdf");
      await mkdir(outDir, { recursive: true });
      await writeFile(pdfPath, "ats-pdf");
      return { engine: "fixture", pdfPath };
    }
  });

  try {
    await running.initialCompile;
    const session = await openSession(running);
    assert.equal(running.server.address().address, "127.0.0.1");
    const statusResponse = await session.fetch("/api/status");
    const status = await statusResponse.json();
    const pdfResponse = await session.fetch("/preview.pdf");
    const documentResponse = await session.fetch("/");

    assert.equal(status.state, "current");
    assert.equal(status.ok, true);
    assert.equal(status.buildId, "build-1");
    assert.equal(status.lastGoodBuildId, "build-1");
    assert.equal(status.artifact, ".runtime/preview/ats.pdf");
    assert.equal(pdfResponse.status, 200);
    assert.match(pdfResponse.headers.get("content-type"), /^application\/pdf/);
    assert.equal(pdfResponse.headers.get("x-frame-options"), "SAMEORIGIN");
    assert.match(pdfResponse.headers.get("content-security-policy"), /frame-ancestors 'self'/u);
    assert.equal(documentResponse.headers.get("x-frame-options"), "DENY");
    assert.equal(await pdfResponse.text(), "ats-pdf");
  } finally {
    await running.close();
  }

  assert.equal(running.server.listening, false);
});

test("failed rebuild reports stale and preserves the last-good temporary PDF", async () => {
  const root = await createFixtureRoot();
  let shouldFail = false;
  const ids = ["build-good", "build-failed"];
  const running = await startPreviewServer({
    repoRoot: root,
    source: "resume/source/ats.tex",
    port: 0,
    idFactory: () => ids.shift(),
    buildPdfImpl: async ({ outDir }) => {
      if (shouldFail) throw new Error(`${root}\\resume\\source\\ats.tex\ncompiler private detail`);
      const pdfPath = join(outDir, "ats.pdf");
      await mkdir(outDir, { recursive: true });
      await writeFile(pdfPath, "last-good");
      return { engine: "fixture", pdfPath };
    }
  });

  try {
    await running.initialCompile;
    const session = await openSession(running);
    shouldFail = true;
    const csrf = await session
      .fetch("/api/bootstrap")
      .then((response) => response.json())
      .then((value) => value.csrf_token);
    const compileResponse = await session.fetch("/api/compile", {
      method: "POST",
      headers: { "x-resume-cooker-csrf": csrf }
    });
    const status = await compileResponse.json();
    const pdfResponse = await session.fetch("/preview.pdf");

    assert.equal(compileResponse.status, 200);
    assert.equal(status.state, "stale");
    assert.equal(status.ok, false);
    assert.equal(status.buildId, "build-failed");
    assert.equal(status.lastGoodBuildId, "build-good");
    assert.match(status.pdfUrl, /build-good/);
    assert.doesNotMatch(status.message, /compiler private detail|resume\\source/);
    assert.equal(await pdfResponse.text(), "last-good");
  } finally {
    await running.close();
  }
});

test("initial compile failure reports failed and does not serve a PDF", async () => {
  const root = await createFixtureRoot();
  const running = await startPreviewServer({
    repoRoot: root,
    source: "resume/source/ats.tex",
    port: 0,
    idFactory: () => "build-failed",
    buildPdfImpl: async () => {
      throw new Error("compile failed");
    }
  });

  try {
    await running.initialCompile;
    const session = await openSession(running);
    const status = await session.fetch("/api/status").then((response) => response.json());
    const pdfResponse = await session.fetch("/preview.pdf");

    assert.equal(status.state, "failed");
    assert.equal(status.pdfUrl, "");
    assert.equal(pdfResponse.status, 404);
  } finally {
    await running.close();
  }
});

test("preview cancellation aborts the active build and records cancelled state", async () => {
  const root = await createFixtureRoot();
  let started;
  const buildStarted = new Promise((resolvePromise) => {
    started = resolvePromise;
  });
  const service = createPreviewService({
    repoRoot: root,
    source: "resume/source/ats.tex",
    idFactory: () => "build-cancelled",
    buildPdfImpl: async ({ signal }) => {
      started();
      await new Promise((resolvePromise) => {
        signal.addEventListener("abort", resolvePromise, { once: true });
      });
      throw Object.assign(new Error("cancelled"), { code: "ABORT_ERR" });
    }
  });

  const running = service.compile();
  await buildStarted;
  service.cancelCompile();
  const status = await running;

  assert.equal(status.state, "cancelled");
  assert.equal(status.ok, false);
  assert.equal(status.stale, false);
  assert.equal(status.lastGoodBuildId, null);
});

test("preview source must stay under resume/source and use a tex extension", async () => {
  const root = await createFixtureRoot();

  assert.throws(
    () => createPreviewService({ repoRoot: root, source: "../secret.txt" }),
    (error) => error.code === "INVALID_SOURCE"
  );
  assert.throws(
    () => createPreviewService({ repoRoot: root, source: "resume/source/ats.pdf" }),
    (error) => error.code === "INVALID_SOURCE"
  );
});

test("preview compilation never changes an intentional saved PDF", async () => {
  const root = await createFixtureRoot();
  const savedPath = join(root, "resume", "output", "ats.pdf");
  await mkdir(join(root, "resume", "output"), { recursive: true });
  await writeFile(savedPath, "saved-output");
  const service = createPreviewService({
    repoRoot: root,
    source: "resume/source/ats.tex",
    idFactory: () => "build-1",
    buildPdfImpl: async ({ outDir }) => {
      const pdfPath = join(outDir, "ats.pdf");
      await mkdir(outDir, { recursive: true });
      await writeFile(pdfPath, "temporary-preview");
      return { engine: "fixture", pdfPath };
    }
  });

  await service.compile();

  assert.equal(await readFile(savedPath, "utf8"), "saved-output");
  assert.equal(await readFile(service.previewPdf, "utf8"), "temporary-preview");
});

test("mutating preview endpoints require CSRF and source saves detect conflicts", async () => {
  const root = await createFixtureRoot();
  const running = await startPreviewServer({
    repoRoot: root,
    source: "resume/source/ats.tex",
    port: 0,
    buildPdfImpl: async ({ outDir }) => {
      const pdfPath = join(outDir, "ats.pdf");
      await mkdir(outDir, { recursive: true });
      await writeFile(pdfPath, "fixture");
      return { engine: "fixture", pdfPath };
    }
  });
  try {
    await running.initialCompile;
    const session = await openSession(running);
    const denied = await session.fetch("/api/source", {
      method: "PUT",
      body: JSON.stringify({ text: "blocked", revision: "wrong" })
    });
    assert.equal(denied.status, 403);

    const bootstrap = await session.fetch("/api/bootstrap").then((response) => response.json());
    const source = await session.fetch("/api/source").then((response) => response.json());
    const saved = await session.fetch("/api/source", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-resume-cooker-csrf": bootstrap.csrf_token
      },
      body: JSON.stringify({
        text: "\\documentclass{article}\\nupdated",
        revision: source.revision
      })
    });
    assert.equal(saved.status, 200);
    assert.match((await saved.json()).revision, /^[a-f0-9]{64}$/);

    const conflict = await session.fetch("/api/source", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-resume-cooker-csrf": bootstrap.csrf_token
      },
      body: JSON.stringify({ text: "stale overwrite", revision: source.revision })
    });
    assert.equal(conflict.status, 409);
  } finally {
    await running.close();
  }
});

test("preview rejects hostile Host headers before exposing local data", async () => {
  const root = await createFixtureRoot();
  const running = await startPreviewServer({
    repoRoot: root,
    source: "resume/source/ats.tex",
    port: 0,
    buildPdfImpl: fixtureBuild
  });
  try {
    const response = await rawRequest(running.baseUrl, "/api/bootstrap", {
      Host: "attacker.example"
    });

    assert.equal(response.status, 403);
    assert.doesNotMatch(response.body, /csrf|documentclass|ats\.tex/i);
    assert.equal((await globalThis.fetch(`${running.baseUrl}/api/bootstrap`)).status, 401);
  } finally {
    await running.close();
  }
});

test("preview requires a session for every route and exchanges the launch capability once", async () => {
  const root = await createFixtureRoot();
  const running = await startPreviewServer({
    repoRoot: root,
    source: "resume/source/ats.tex",
    port: 0,
    buildPdfImpl: fixtureBuild
  });
  try {
    for (const path of ["/", "/favicon.ico", "/api/bootstrap", "/api/source", "/preview.pdf"]) {
      const response = await globalThis.fetch(`${running.baseUrl}${path}`);
      assert.equal(response.status, 401, path);
      assert.doesNotMatch(await response.text(), /csrf|documentclass|fixture-pdf/i);
    }
    assert.equal(
      (await globalThis.fetch(`${running.baseUrl}/?launch=wrong`, { redirect: "manual" })).status,
      403
    );

    const session = await openSession(running);
    assert.equal((await session.fetch("/api/bootstrap")).status, 200);
    assert.equal((await globalThis.fetch(running.url, { redirect: "manual" })).status, 403);
  } finally {
    await running.close();
  }
});

test("preview can cancel the initial compile after the HTTP server starts listening", async () => {
  const root = await createFixtureRoot();
  let markStarted;
  const started = new Promise((resolvePromise) => {
    markStarted = resolvePromise;
  });
  const running = await startPreviewServer({
    repoRoot: root,
    source: "resume/source/ats.tex",
    port: 0,
    buildPdfImpl: async ({ signal }) => {
      markStarted();
      await new Promise((resolvePromise) =>
        signal.addEventListener("abort", resolvePromise, { once: true })
      );
      throw Object.assign(new Error("cancelled"), { code: "ABORT_ERR" });
    }
  });
  try {
    await started;
    const session = await openSession(running);
    const bootstrap = await session.fetch("/api/bootstrap").then((response) => response.json());
    const cancelled = await session.fetch("/api/compile/cancel", {
      method: "POST",
      headers: { "x-resume-cooker-csrf": bootstrap.csrf_token }
    });
    assert.equal(cancelled.status, 200);
    assert.equal((await running.initialCompile).state, "cancelled");
  } finally {
    await running.close();
  }
});

test("saving source marks the preview stale and checks omit its stale PDF", async () => {
  const root = await createFixtureRoot();
  let checkOptions;
  const ids = ["build-1", "check-1"];
  const running = await startPreviewServer({
    repoRoot: root,
    source: "resume/source/ats.tex",
    port: 0,
    idFactory: () => ids.shift(),
    buildPdfImpl: fixtureBuild,
    runCheckImpl: async (options) => {
      checkOptions = options;
      return {
        schema_version: 1,
        status: "pass",
        summary: "Checked source only.",
        content_left_machine: false,
        checks: []
      };
    }
  });
  try {
    await running.initialCompile;
    const session = await openSession(running);
    const bootstrap = await session.fetch("/api/bootstrap").then((response) => response.json());
    const source = await session.fetch("/api/source").then((response) => response.json());
    await session.fetch("/api/source", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-resume-cooker-csrf": bootstrap.csrf_token
      },
      body: JSON.stringify({ text: `${source.text}\nupdated`, revision: source.revision })
    });

    const status = await session.fetch("/api/status").then((response) => response.json());
    assert.equal(status.state, "stale");
    assert.equal(status.stale, true);
    assert.notEqual(status.source_revision, status.artifact_revision);

    const checked = await session.fetch("/api/check", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-resume-cooker-csrf": bootstrap.csrf_token
      },
      body: "{}"
    });
    assert.equal(checked.status, 200);
    assert.equal(checkOptions.pdf, undefined);
  } finally {
    await running.close();
  }
});

test("a superseded build cannot overwrite the newer preview artifact", async () => {
  const root = await createFixtureRoot();
  let releaseFirst;
  let markFirstStarted;
  let call = 0;
  const firstStarted = new Promise((resolvePromise) => {
    markFirstStarted = resolvePromise;
  });
  const firstGate = new Promise((resolvePromise) => {
    releaseFirst = resolvePromise;
  });
  const ids = ["build-old", "build-new"];
  const service = createPreviewService({
    repoRoot: root,
    source: "resume/source/ats.tex",
    idFactory: () => ids.shift(),
    buildPdfImpl: async ({ outDir }) => {
      const currentCall = ++call;
      if (currentCall === 1) {
        markFirstStarted();
        await firstGate;
      }
      await mkdir(outDir, { recursive: true });
      const pdfPath = join(outDir, "ats.pdf");
      await writeFile(pdfPath, currentCall === 1 ? "older-artifact" : "newer-artifact");
      return { engine: "fixture", pdfPath };
    }
  });

  const older = service.compile();
  await firstStarted;
  const newer = await service.compile();
  releaseFirst();
  await older;

  assert.equal(newer.buildId, "build-new");
  assert.equal((await service.getStatus()).buildId, "build-new");
  assert.equal(await readFile(service.previewPdf, "utf8"), "newer-artifact");
});

test("a source save during build keeps the previous preview stale", async () => {
  const root = await createFixtureRoot();
  let markRebuildStarted;
  let releaseRebuild;
  let call = 0;
  const rebuildStarted = new Promise((resolvePromise) => {
    markRebuildStarted = resolvePromise;
  });
  const rebuildGate = new Promise((resolvePromise) => {
    releaseRebuild = resolvePromise;
  });
  const ids = ["build-good", "build-obsolete"];
  const service = createPreviewService({
    repoRoot: root,
    source: "resume/source/ats.tex",
    idFactory: () => ids.shift(),
    buildPdfImpl: async ({ outDir }) => {
      const currentCall = ++call;
      if (currentCall === 2) {
        markRebuildStarted();
        await rebuildGate;
      }
      await mkdir(outDir, { recursive: true });
      const pdfPath = join(outDir, "ats.pdf");
      await writeFile(pdfPath, currentCall === 1 ? "last-good" : "obsolete");
      return { engine: "fixture", pdfPath };
    }
  });
  await service.compile();

  const rebuilding = service.compile();
  await rebuildStarted;
  const loaded = await service.getSource();
  await service.saveSource({
    text: `${loaded.text}\nchanged`,
    revision: loaded.revision
  });
  releaseRebuild();
  await rebuilding;

  const status = await service.getStatus();
  assert.equal(status.state, "stale");
  assert.notEqual(status.source_revision, status.artifact_revision);
  assert.equal(await readFile(service.previewPdf, "utf8"), "last-good");
});

test("cancellation wins even when a build implementation ignores AbortSignal", async () => {
  const root = await createFixtureRoot();
  let markStarted;
  let releaseBuild;
  const started = new Promise((resolvePromise) => {
    markStarted = resolvePromise;
  });
  const buildGate = new Promise((resolvePromise) => {
    releaseBuild = resolvePromise;
  });
  const service = createPreviewService({
    repoRoot: root,
    source: "resume/source/ats.tex",
    idFactory: () => "build-cancelled",
    buildPdfImpl: async ({ outDir }) => {
      markStarted();
      await buildGate;
      await mkdir(outDir, { recursive: true });
      const pdfPath = join(outDir, "ats.pdf");
      await writeFile(pdfPath, "must-not-publish");
      return { engine: "fixture", pdfPath };
    }
  });

  const building = service.compile();
  await started;
  service.cancelCompile();
  releaseBuild();
  const status = await building;

  assert.equal(status.state, "cancelled");
  assert.equal(status.lastGoodBuildId, null);
  assert.equal(await service.getPreviewPath(), null);
});

async function createFixtureRoot() {
  const root = await mkdtemp(join(tmpdir(), "resume-cooker-preview-"));
  tempDirs.push(root);
  await mkdir(join(root, "resume", "source"), { recursive: true });
  await mkdir(join(root, "generator", "public"), { recursive: true });
  await writeFile(join(root, "resume", "source", "ats.tex"), "\\documentclass{article}");
  await writeFile(
    join(root, "generator", "public", "index.html"),
    "<!doctype html><title>Test</title>"
  );
  return root;
}

test("external source edits invalidate status but preserve the last-good PDF", async () => {
  const root = await createFixtureRoot();
  const service = createPreviewService({
    repoRoot: root,
    source: "resume/source/ats.tex",
    buildPdfImpl: fixtureBuild
  });
  const built = await service.compile();
  await writeFile(service.sourcePath, "external synthetic edit");
  const status = await service.getStatus();
  assert.equal(status.state, "stale");
  assert.equal(status.ok, false);
  assert.equal(status.stale, true);
  assert.equal(status.artifact_revision, built.artifact_revision);
  assert.equal(status.source_revision, (await service.getSource()).revision);
  assert.notEqual(status.source_revision, status.artifact_revision);
  assert.equal(await readFile(await service.getPreviewPath(), "utf8"), "fixture-pdf");
});

test("HTTP status detects external edits and checks exclude stale artifacts", async () => {
  const root = await createFixtureRoot();
  let checked;
  const running = await startPreviewServer({
    repoRoot: root,
    source: "resume/source/ats.tex",
    port: 0,
    buildPdfImpl: fixtureBuild,
    runCheckImpl: async (options) => {
      checked = options;
      return { status: "pass", checks: [], content_left_machine: false };
    }
  });
  try {
    await running.initialCompile;
    const session = await openSession(running);
    const bootstrap = await session.fetch("/api/bootstrap").then((r) => r.json());
    await writeFile(running.service.sourcePath, "external edit after build");
    assert.equal((await session.fetch("/preview.pdf")).status, 200);
    const status = await session.fetch("/api/status").then((r) => r.json());
    assert.equal(status.state, "stale");
    assert.equal(status.ok, false);
    await session.fetch("/api/check", {
      method: "POST",
      headers: { "x-resume-cooker-csrf": bootstrap.csrf_token },
      body: "{}"
    });
    assert.equal(checked.pdf, undefined);
  } finally {
    await running.close();
  }
});

test("missing source or artifact cannot retain a current claim", async () => {
  const root = await createFixtureRoot();
  const service = createPreviewService({
    repoRoot: root,
    source: "resume/source/ats.tex",
    buildPdfImpl: fixtureBuild
  });
  await service.compile();
  await rm(service.sourcePath);
  assert.equal((await service.getStatus()).state, "stale");
  assert.equal((await service.getStatus()).source_revision, null);
  assert.equal(await service.getPreviewPath(), service.previewPdf);
  await rm(service.previewPdf);
  assert.equal((await service.getStatus()).state, "failed");
  assert.equal(await service.getPreviewPath(), null);
});

test("overlapping service saves and builds preserve the winning source and artifact", async () => {
  const root = await createFixtureRoot();
  let call = 0;
  let release;
  let started;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const service = createPreviewService({
    repoRoot: root,
    source: "resume/source/ats.tex",
    buildPdfImpl: async (options) => {
      const sourceText = await readFile(join(root, options.source), "utf8");
      if (++call === 2) {
        started();
        await gate;
      }
      const result = await fixtureBuild(options);
      await writeFile(result.pdfPath, sourceText);
      return result;
    }
  });
  await service.compile();
  const old = service.compile();
  await ready;
  const loaded = await service.getSource();
  const saves = await Promise.allSettled([
    service.saveSource({ revision: loaded.revision, text: "winner" }),
    service.saveSource({ revision: loaded.revision, text: "loser" })
  ]);
  assert.equal(saves[0].status, "fulfilled");
  assert.equal(saves[1].reason.code, "CONFLICT");
  const current = await service.compile();
  release();
  await old;
  const status = await service.getStatus();
  assert.equal(status.state, "current");
  assert.equal(status.lastGoodBuildId, current.lastGoodBuildId);
  assert.equal(status.source_revision, saves[0].value.revision);
  assert.equal(status.artifact_revision, status.source_revision);
  assert.equal(await readFile(service.previewPdf, "utf8"), "winner");
});

async function fixtureBuild({ outDir }) {
  const pdfPath = join(outDir, "ats.pdf");
  await mkdir(outDir, { recursive: true });
  await writeFile(pdfPath, "fixture-pdf");
  return { engine: "fixture", pdfPath };
}

function rawRequest(baseUrl, path, headers) {
  const url = new URL(baseUrl);
  return new Promise((resolvePromise, reject) => {
    const req = request(
      {
        host: url.hostname,
        port: url.port,
        path,
        headers
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolvePromise({
            status: res.statusCode,
            body: Buffer.concat(chunks).toString("utf8")
          })
        );
      }
    );
    req.once("error", reject);
    req.end();
  });
}

async function openSession(running) {
  const exchanged = await globalThis.fetch(running.url, { redirect: "manual" });
  assert.equal(exchanged.status, 303);
  assert.equal(exchanged.headers.get("location"), "/");
  const setCookie = exchanged.headers.get("set-cookie");
  assert.match(
    setCookie,
    /^resume_cooker_session=[A-Za-z0-9_-]+; Path=\/; HttpOnly; SameSite=Strict$/
  );
  const cookie = setCookie.split(";", 1)[0];
  const fetchWithSession = (path, options = {}) =>
    globalThis.fetch(`${running.baseUrl}${path}`, {
      ...options,
      headers: { ...(options.headers || {}), cookie }
    });
  assert.equal((await fetchWithSession("/")).status, 200);
  return { cookie, fetch: fetchWithSession };
}
