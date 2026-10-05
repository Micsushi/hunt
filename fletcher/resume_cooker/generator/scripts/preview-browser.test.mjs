/* global document, window, Event */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startPreviewServer } from "./preview-server.mjs";

test(
  "visible preview freshness follows external edits without erasing unsaved text",
  {
    skip: !process.env.RESUME_COOKER_PLAYWRIGHT_MODULE,
    timeout: 30000
  },
  async () => {
    const { chromium } = await import(process.env.RESUME_COOKER_PLAYWRIGHT_MODULE);
    const root = await mkdtemp(join(tmpdir(), "resume-cooker-freshness-browser-"));
    let running;
    let browser;
    try {
      await mkdir(join(root, "resume/source"), { recursive: true });
      const sourcePath = join(root, "resume/source/ats.tex");
      await writeFile(sourcePath, "synthetic original");
      running = await startPreviewServer({
        repoRoot: root,
        source: "resume/source/ats.tex",
        port: 0,
        buildPdfImpl: async ({ outDir }) => {
          await mkdir(outDir, { recursive: true });
          const pdfPath = join(outDir, "ats.pdf");
          await writeFile(pdfPath, "%PDF-1.4 synthetic fixture");
          return { pdfPath, engine: "fixture" };
        }
      });
      running.service.getTools = async () => [];
      await running.initialCompile;
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(running.url);
      await page.waitForFunction(() =>
        document.getElementById("build-status").textContent.includes("Built with")
      );
      const pdfUrl = await page.locator("#pdf").getAttribute("src");
      await page.locator("#editor").fill("synthetic unsaved text");
      await writeFile(sourcePath, "synthetic external edit");
      await page.waitForFunction(() =>
        document.getElementById("build-status").textContent.includes("last good PDF is stale")
      );
      assert.equal(await page.locator("#editor").inputValue(), "synthetic unsaved text");
      assert.equal(await page.locator("#pdf").getAttribute("src"), pdfUrl);
      assert.equal(
        await readFile(running.service.previewPdf, "utf8"),
        "%PDF-1.4 synthetic fixture"
      );
      await page.route("**/api/status", (route) => route.abort());
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await page.waitForFunction(() =>
        document.getElementById("build-status").textContent.includes("freshness unavailable")
      );
      assert.equal(await page.locator("#pdf").getAttribute("src"), pdfUrl);
      await page.unroute("**/api/status");
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await page.waitForFunction(() =>
        document.getElementById("build-status").textContent.includes("last good PDF is stale")
      );
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 800 });
        assert.equal(await page.locator("#build-status").isVisible(), true);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
          true
        );
      }
      assert.deepEqual(errors, []);
    } finally {
      await browser?.close();
      await running?.close();
      await rm(root, { recursive: true, force: true });
    }
  }
);
