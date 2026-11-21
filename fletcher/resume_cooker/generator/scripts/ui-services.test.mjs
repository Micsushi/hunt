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

async function fixtureRoot() {
  const root = await mkdtemp(join(os.tmpdir(), "resume-cooker-ui-"));
  roots.push(root);
  await mkdir(join(root, "resume", "source"), { recursive: true });
  await writeFile(join(root, "resume", "source", "current.tex"), "original", "utf8");
  return root;
}
