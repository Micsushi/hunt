import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

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

const sourcePath = resolve(option("csv", "../wd_test_jobs.csv"));
const outputRoot = resolve(option("output-root", ".runtime/public-catalog-refresh"));
const concurrency = Number.parseInt(option("concurrency", "5"), 10);
const verify = process.argv.includes("--verify");
if (process.argv.includes("--out") || process.argv.includes("--verify-out")) {
  throw new TypeError("use --output-root; refresh artifacts are always run-scoped");
}

const sourceBytes = readFileSync(sourcePath);
const sourceRows = parsePublicCatalog(sourceBytes.toString("utf8"));
const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
const run = createPublicCatalogRun(outputRoot);
let runIsStaging = true;
try {
  const candidates = await discoverCandidateRows(
    sourceRows.map((row) => ({ company: row.company, link: row.link })),
    requestWorkdayFeed,
    concurrency,
  );
  const csv = buildCandidateCatalogCsv(candidates);
  parsePublicCatalog(csv);
  writeFileSync(run.candidatePath, csv, { encoding: "utf8", flag: "wx" });

  let verified = false;
  if (verify) {
    const verifier = resolve(import.meta.dirname, "verify-public-catalog-titles.ts");
    const result = spawnSync(process.execPath, [
      verifier,
      "--csv",
      run.candidatePath,
      "--out",
      run.evidencePath,
      "--expected-rows",
      String(candidates.length),
    ], {
      cwd: process.cwd(),
      stdio: "inherit",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      const failedDirectory = tryFailPublicCatalogRun(run);
      runIsStaging = false;
      process.exitCode = result.status ?? 1;
      process.stdout.write(JSON.stringify({
        kind: "public_catalog_verification_failed",
        rows: candidates.length,
        failedDirectory,
      }) + "\n");
    } else verified = true;
  }

  if (runIsStaging) {
    const published = finalizePublicCatalogRun(run, {
      sourceSha256,
      rows: candidates.length,
      verified,
    });
    runIsStaging = false;
    process.stdout.write(JSON.stringify({
      kind: verified ? "public_catalog_candidates_verified" : "public_catalog_candidates_written",
      rows: candidates.length,
      directory: published.directory,
      candidatePath: published.candidatePath,
      evidencePath: published.evidencePath,
      manifestPath: published.manifestPath,
    }) + "\n");
  }
} catch (error) {
  if (runIsStaging) preservePublicCatalogFailure(run, error);
  throw error;
}
