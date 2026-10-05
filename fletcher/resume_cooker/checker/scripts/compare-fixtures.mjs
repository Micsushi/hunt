import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { getRepoRoot } from "../../generator/scripts/build-lib.mjs";
import { compareExitCode, runCompare } from "./compare.mjs";
import { sanitizeProcessMessage, writeReport } from "./report-lib.mjs";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const results = await runFixtureMatrix();
    console.log(JSON.stringify({ status: "pass", cases: results }, null, 2));
  } catch (error) {
    console.error(sanitizeProcessMessage(error?.message || "Fixture matrix failed."));
    process.exitCode = 1;
  }
}

export async function runFixtureMatrix({
  manifestPath = "fixtures/compare/manifest.json",
  pdf = "resume/output/ats.pdf"
} = {}) {
  const manifest = JSON.parse(await readFile(`${getRepoRoot()}/${manifestPath}`, "utf8"));
  validateManifest(manifest);
  const results = [];
  for (const fixture of manifest.cases) {
    const options = fixtureOptions(fixture, pdf);
    let report;
    let status;
    let exit;
    try {
      report = await runCompare(options);
      status = report.status;
      exit = compareExitCode(report);
    } catch (error) {
      status =
        error.code === "INVALID_USAGE"
          ? "invalid_usage"
          : error.code === "CAPABILITY_UNAVAILABLE"
            ? "capability_unavailable"
            : "internal_error";
      exit =
        error.code === "INVALID_USAGE" ? 64 : error.code === "CAPABILITY_UNAVAILABLE" ? 69 : 70;
    }
    if (status !== fixture.expected_status || exit !== fixture.expected_exit) {
      throw new Error(
        `Fixture ${fixture.id} expected ${fixture.expected_status}/${fixture.expected_exit} but received ${status}/${exit}.`
      );
    }
    if (report) {
      await writeReport(report, `.runtime/reports/compare-fixture-${fixture.id}.json`);
    }
    results.push({ id: fixture.id, status, exit });
  }
  return results;
}

function fixtureOptions(fixture, pdf) {
  const options = {
    before: `fixtures/compare/${fixture.before || "source.tex"}`,
    after: `fixtures/compare/${fixture.after || "tailored-valid.tex"}`
  };
  if (!fixture.source_only) {
    options["before-facts"] = `fixtures/compare/${fixture.before_facts || "source.facts.json"}`;
    options["after-facts"] = `fixtures/compare/${fixture.after_facts}`;
  }
  if (fixture.profile_facts) {
    options["profile-facts"] = `fixtures/compare/${fixture.profile_facts}`;
  }
  if (fixture.policy) options.policy = `fixtures/compare/${fixture.policy}`;
  if (fixture.jd) options.jd = `fixtures/compare/${fixture.jd}`;
  if (fixture.pdf === "public") options.pdf = pdf;
  if (fixture.pdf && fixture.pdf !== "public") {
    options.pdf = `fixtures/compare/${fixture.pdf}`;
  }
  return options;
}

function validateManifest(manifest) {
  if (
    manifest?.schema_version !== 1 ||
    manifest.synthetic_only !== true ||
    manifest.privacy_reviewed !== true ||
    !Array.isArray(manifest.cases) ||
    manifest.cases.length === 0
  ) {
    throw new Error("Comparison fixture manifest is malformed or not privacy reviewed.");
  }
  const ids = new Set();
  for (const fixture of manifest.cases) {
    if (
      typeof fixture?.id !== "string" ||
      !fixture.id ||
      ids.has(fixture.id) ||
      typeof fixture.expected_status !== "string" ||
      !Number.isSafeInteger(fixture.expected_exit) ||
      (!fixture.source_only && typeof fixture.after_facts !== "string")
    ) {
      throw new Error("Comparison fixture manifest contains an invalid case.");
    }
    ids.add(fixture.id);
  }
}
