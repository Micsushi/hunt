import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { Script } from "node:vm";
import {
  createOutputService,
  createReportOperationService,
  createSourceFileService
} from "./ui-services.mjs";

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("UI source service loads and atomically saves approved LaTeX", async () => {
  const root = await fixtureRoot();
  const service = createSourceFileService({ repoRoot: root });
  const loaded = await service.load("resume/source/current.tex");
  assert.equal(loaded.name, "current.tex");
  assert.equal(loaded.text, "original");
  assert.match(loaded.revision, /^[a-f0-9]{64}$/);

  const saved = await service.save({
    source: loaded.source,
    text: "updated",
    revision: loaded.revision
  });
  assert.equal(saved.text, "updated");
  assert.notEqual(saved.revision, loaded.revision);
  assert.equal(await readFile(join(root, "resume", "source", "current.tex"), "utf8"), "updated");
});

test("UI source service rejects traversal, unsupported files, and stale writes", async () => {
  const root = await fixtureRoot();
  const service = createSourceFileService({ repoRoot: root });
  const loaded = await service.load("resume/source/current.tex");
  await writeFile(join(root, "resume", "source", "current.tex"), "external", "utf8");
  await assert.rejects(
    service.save({ source: loaded.source, text: "overwrite", revision: loaded.revision }),
    (error) => error.code === "CONFLICT"
  );
  await assert.rejects(service.load("../secret.txt"), (error) =>
    ["NOT_FOUND", "FORBIDDEN"].includes(error.code)
  );
  await writeFile(join(root, "resume", "source", "notes.txt"), "no", "utf8");
  await assert.rejects(
    service.load("resume/source/notes.txt"),
    (error) => error.code === "FORBIDDEN"
  );
});

test("UI source service rejects symlinks escaping approved roots when supported", async (t) => {
  const root = await fixtureRoot();
  const outsideDir = join(root, "outside");
  const outside = join(outsideDir, "secret.tex");
  const link = join(root, "resume", "source", "escape");
  await mkdir(outsideDir);
  await writeFile(outside, "private", "utf8");
  try {
    await symlink(outsideDir, link, process.platform === "win32" ? "junction" : "dir");
  } catch {
    t.skip("Symlink creation is unavailable on this Windows profile.");
    return;
  }
  const service = createSourceFileService({ repoRoot: root });
  await assert.rejects(
    service.load("resume/source/escape/secret.tex"),
    (error) => error.code === "FORBIDDEN"
  );
});

test("concurrent source saves with one revision allow exactly one writer", async () => {
  const root = await fixtureRoot();
  const service = createSourceFileService({ repoRoot: root });
  const loaded = await service.load("resume/source/current.tex");

  const results = await Promise.allSettled([
    service.save({ source: loaded.source, text: "first", revision: loaded.revision }),
    service.save({ source: loaded.source, text: "second", revision: loaded.revision })
  ]);
  const fulfilled = results.filter((result) => result.status === "fulfilled");
  const rejected = results.filter((result) => result.status === "rejected");

  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, "CONFLICT");
});

test("UI report projection preserves skipped evidence and privacy state", async () => {
  const root = await fixtureRoot();
  const service = createReportOperationService({
    repoRoot: root,
    idFactory: () => "check-1",
    runCheckImpl: async () => ({
      schema_version: 1,
      status: "pass_with_warnings",
      summary: "Optional tester skipped.",
      content_left_machine: false,
      checks: [
        {
          id: "tester_optional",
          category: "tester",
          severity: "medium",
          status: "warning",
          evidence: "Tester skipped.",
          suggested_fix: "",
          metadata: { optional_check_skipped: true }
        }
      ]
    })
  });
  const result = await service.run({ source: "resume/source/current.tex" });
  assert.equal(result.state, "complete");
  assert.equal(result.report.content_left_machine, false);
  assert.equal(result.report.checks[0].status, "warning");
  assert.equal(result.report.checks[0].metadata.optional_check_skipped, true);
});

test("UI report cancellation keeps cancelled state after the runner stops", async () => {
  const root = await fixtureRoot();
  const service = createReportOperationService({
    repoRoot: root,
    idFactory: () => "check-cancel",
    runCheckImpl: (_options, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(Object.assign(new Error("cancelled"), { code: "ABORT_ERR" })),
          { once: true }
        );
      })
  });
  const running = service.run({ source: "resume/source/current.tex" });
  assert.equal(service.getState().state, "running");
  assert.equal(service.cancel().state, "cancelled");
  assert.equal((await running).state, "cancelled");
  assert.equal(service.getState().state, "cancelled");
});

test("UI saved output requires explicit overwrite and leaves preview staging temporary", async () => {
  const root = await fixtureRoot();
  const output = createOutputService({
    repoRoot: root,
    buildPdfImpl: async ({ outDir }) => {
      await mkdir(outDir, { recursive: true });
      const pdfPath = join(outDir, "current.pdf");
      await writeFile(pdfPath, "verified-pdf", "utf8");
      return { pdfPath, engine: "fixture" };
    }
  });
  const first = await output.save({
    source: "resume/source/current.tex",
    name: "selected.pdf"
  });
  assert.deepEqual(first, { name: "selected.pdf", bytes: 12, saved: true });
  assert.equal(
    await readFile(join(root, "resume", "output", "selected.pdf"), "utf8"),
    "verified-pdf"
  );
  await assert.rejects(
    output.save({ source: "resume/source/current.tex", name: "selected.pdf" }),
    (error) => error.code === "OUTPUT_EXISTS"
  );
  await output.save({
    source: "resume/source/current.tex",
    name: "selected.pdf",
    overwrite: true
  });
  await assert.rejects(
    output.save({ source: "resume/source/current.tex", name: "../escape.pdf" }),
    (error) => error.code === "INVALID_OUTPUT"
  );
});

test("UI output no-overwrite remains atomic when a target appears during the build", async () => {
  const root = await fixtureRoot();
  let markStarted;
  let releaseBuild;
  const started = new Promise((resolvePromise) => {
    markStarted = resolvePromise;
  });
  const buildGate = new Promise((resolvePromise) => {
    releaseBuild = resolvePromise;
  });
  const output = createOutputService({
    repoRoot: root,
    buildPdfImpl: async ({ outDir }) => {
      markStarted();
      await buildGate;
      await mkdir(outDir, { recursive: true });
      const pdfPath = join(outDir, "current.pdf");
      await writeFile(pdfPath, "generated", "utf8");
      return { pdfPath, engine: "fixture" };
    }
  });

  const saving = output.save({
    source: "resume/source/current.tex",
    name: "selected.pdf"
  });
  await started;
  const target = join(root, "resume", "output", "selected.pdf");
  await mkdir(join(root, "resume", "output"), { recursive: true });
  await writeFile(target, "external", "utf8");
  releaseBuild();

  await assert.rejects(saving, (error) => error.code === "OUTPUT_EXISTS");
  assert.equal(await readFile(target, "utf8"), "external");
});

test("UI document has labeled keyboard actions and no persistent/browser HTML injection sink", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  for (const marker of [
    'id="editor"',
    'id="save"',
    'id="build"',
    'id="check"',
    'id="findings"',
    'role="status"',
    "Ctrl+S",
    "Ctrl+B",
    "Ctrl+Enter"
  ]) {
    assert.match(html, new RegExp(marker.replace(/[+]/g, "\\+")));
  }
  assert.doesNotMatch(html, /localStorage|sessionStorage|\.innerHTML\s*=/);
  assert.match(html, /\.textContent\s*=/);
  const script = html.match(/<script>([\s\S]+)<\/script>/u);
  assert.ok(script, "UI document should contain its bootstrap script");
  assert.doesNotThrow(() => new Script(script[1]), "UI bootstrap must parse as a classic script");
});

async function fixtureRoot() {
  const root = await mkdtemp(join(os.tmpdir(), "resume-cooker-ui-"));
  roots.push(root);
  await mkdir(join(root, "resume", "source"), { recursive: true });
  await writeFile(join(root, "resume", "source", "current.tex"), "original", "utf8");
  return root;
}
