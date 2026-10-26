import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { chromium, type Browser } from "playwright";

import {
  parsePublicCatalog,
  verifiedPublicCatalogPosting,
} from "./public-catalog-title.ts";

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

const csvPath = resolve(option("csv", "../wd_test_jobs.csv"));
const expectedRows = Number.parseInt(option("expected-rows", "100"), 10);
const worker = Number.parseInt(option("worker", "0"), 10);
const workers = Number.parseInt(option("workers", "1"), 10);
if (!Number.isInteger(worker) || !Number.isInteger(workers) || worker < 0 || worker >= workers) {
  throw new TypeError("worker assignment is invalid");
}
const defaultOutput = workers === 1
  ? `.runtime/public-catalog-title-results.${randomUUID()}.jsonl`
  : `.runtime/public-catalog-title-results.worker-${worker}-of-${workers}.jsonl`;
const outputPath = resolve(option("out", defaultOutput));

const rows = parsePublicCatalog(readFileSync(csvPath, "utf8"), expectedRows);
const hosts = [...new Set(rows.map((row) => new URL(row.link).host))].sort();
const assignedHosts = new Set(hosts.filter((_, index) => index % workers === worker));
const assignedRows = rows.filter((row) => assignedHosts.has(new URL(row.link).host));
mkdirSync(dirname(outputPath), { recursive: true });
const outputFile = openSync(outputPath, "wx");

let browser: Browser | undefined;
let failures = 0;
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  for (const row of assignedRows) {
    const result: {
      sourceRow: number;
      company: string;
      expectedTitle: string;
      observedTitle: string | null;
      matched: boolean;
      httpStatus: number | null;
      finalUrl: string | null;
      error: string | null;
    } = {
      sourceRow: row.sourceRow,
      company: row.company,
      expectedTitle: row.expectedTitle,
      observedTitle: null,
      matched: false,
      httpStatus: null,
      finalUrl: null,
      error: null,
    };
    const context = await browser.newContext({ serviceWorkers: "block" });
    try {
      const page = await context.newPage();
      const response = await page.goto(row.link, {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      });
      result.httpStatus = response?.status() ?? null;
      result.finalUrl = page.url();
      const title = page.locator('[data-automation-id="jobPostingHeader"]').first();
      await title.waitFor({ state: "visible", timeout: 20_000 });
      result.observedTitle = (await title.innerText()).replace(/\s+/gu, " ").trim();
      result.matched = verifiedPublicCatalogPosting(
        row.link,
        result.finalUrl,
        result.httpStatus,
        row.expectedTitle,
        result.observedTitle,
      );
    } catch (error) {
      result.error = String(error instanceof Error ? error.message : error).slice(0, 500);
    } finally {
      await context.close();
    }
    if (!result.matched) failures += 1;
    appendFileSync(outputFile, `${JSON.stringify(result)}\n`, "utf8");
    process.stdout.write(`${row.sourceRow} ${row.company}: ${result.matched ? "matched" : "mismatch"}\n`);
  }
} finally {
  await browser?.close();
  closeSync(outputFile);
}
process.stdout.write(JSON.stringify({ worker, workers, assignedRows: assignedRows.length, failures, outputPath }) + "\n");
process.exitCode = failures === 0 ? 0 : 1;
