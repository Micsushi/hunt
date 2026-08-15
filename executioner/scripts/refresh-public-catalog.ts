import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";

import {
  buildHostedCatalogCsv,
  type HostedCandidateRow,
  parseHostedCatalog,
  refreshHostedCatalog,
  verifyHostedCatalog,
} from "./hosted-public-feed.ts";
import { parsePublicCatalog } from "./public-catalog-title.ts";
import {
  createPublicCatalogRun,
  finalizePublicCatalogRun,
  preservePublicCatalogFailure,
  tryFailPublicCatalogRun,
} from "./public-catalog-run.ts";
import {
  buildCandidateCatalogCsv,
  discoverCandidateRows,
  requestWorkdayFeed,
} from "./workday-public-feed.ts";

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

function options(name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === `--${name}` && process.argv[index + 1]) values.push(process.argv[index + 1]!);
  }
  return values;
}

const explicitCatalogs = options("csv");
const sourcePaths = (explicitCatalogs.length > 0 ? explicitCatalogs : [
  "../wd_test_jobs.csv",
  "../greenhouse_test_jobs.csv",
  "../lever_test_jobs.csv",
  "../ashby_test_jobs.csv",
]).map((path) => resolve(path));
if (new Set(sourcePaths.map((path) => path.toLocaleLowerCase("en-US"))).size !== sourcePaths.length) {
  throw new TypeError("catalog paths must be unique");
}

const outputRoot = resolve(option("output-root", ".runtime/public-catalog-refresh"));
const concurrency = Number.parseInt(option("concurrency", "5"), 10);
const verify = process.argv.includes("--verify");
if (process.argv.includes("--out") || process.argv.includes("--verify-out")) {
  throw new TypeError("use --output-root; refresh artifacts are always run-scoped");
}

for (const sourcePath of sourcePaths) {
  const catalogOutputRoot = sourcePaths.length === 1
    ? outputRoot
    : join(outputRoot, basename(sourcePath, extname(sourcePath)));
  await refreshCatalog(sourcePath, catalogOutputRoot);
}

async function refreshCatalog(sourcePath: string, catalogOutputRoot: string): Promise<void> {
  const sourceBytes = readFileSync(sourcePath);
  const sourceText = sourceBytes.toString("utf8");
  const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
  const workday = sourceText.includes(".myworkdayjobs.com");
  const run = createPublicCatalogRun(catalogOutputRoot);
  let runIsStaging = true;
  try {
    let csv: string;
    let rows: number;
    let hostedCandidates: HostedCandidateRow[] | undefined;
    if (workday) {
      const sourceRows = parsePublicCatalog(sourceText);
      const candidates = await discoverCandidateRows(
        sourceRows.map((row) => ({ company: row.company, link: row.link })),
        requestWorkdayFeed,
        concurrency,
      );
      csv = buildCandidateCatalogCsv(candidates);
      rows = candidates.length;
      parsePublicCatalog(csv, rows);
    } else {
      const sourceRows = parseHostedCatalog(sourceText);
      const candidates = await refreshHostedCatalog(sourceRows);
      hostedCandidates = candidates;
      csv = buildHostedCatalogCsv(candidates);
      rows = candidates.length;
      parseHostedCatalog(csv, rows);
    }

    writeFileSync(run.candidatePath, csv, { encoding: "utf8", flag: "wx" });
    if (verify && hostedCandidates) {
      const evidence = await verifyHostedCatalog(hostedCandidates, concurrency);
      writeFileSync(run.evidencePath, `${evidence.map((result) => JSON.stringify(result)).join("\n")}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
      const failures = evidence.filter((result) => !result.matched).length;
      process.stdout.write(`${basename(sourcePath)}: ${rows - failures}/${rows} hosted URLs matched\n`);
      if (failures > 0) {
        const failedDirectory = tryFailPublicCatalogRun(run);
        runIsStaging = false;
        process.exitCode = 1;
        process.stdout.write(`${JSON.stringify({
          kind: "public_catalog_verification_failed",
          catalog: sourcePath,
          rows,
          failures,
          failedDirectory,
        })}\n`);
        return;
      }
    } else if (verify && workday) {
      const verifier = resolve(import.meta.dirname, "verify-public-catalog-titles.ts");
      const result = spawnSync(process.execPath, [
        verifier,
        "--csv",
        run.candidatePath,
        "--out",
        run.evidencePath,
        "--expected-rows",
        String(rows),
      ], { cwd: process.cwd(), stdio: "inherit" });
      if (result.error) throw result.error;
      if (result.status !== 0) {
        const failedDirectory = tryFailPublicCatalogRun(run);
        runIsStaging = false;
        process.exitCode = result.status ?? 1;
        process.stdout.write(`${JSON.stringify({
          kind: "public_catalog_verification_failed",
          catalog: sourcePath,
          rows,
          failedDirectory,
        })}\n`);
        return;
      }
    }

    const published = finalizePublicCatalogRun(run, { sourceSha256, rows, verified: verify });
    runIsStaging = false;
    process.stdout.write(`${JSON.stringify({
      kind: verify ? "public_catalog_candidates_verified" : "public_catalog_candidates_written",
      catalog: sourcePath,
      rows,
      ...published,
    })}\n`);
  } catch (error) {
    if (runIsStaging) preservePublicCatalogFailure(run, error);
    throw error;
  }
}
