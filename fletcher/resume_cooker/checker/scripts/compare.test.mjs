import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { test } from "node:test";
import {
  checkProtectedPdfFacts,
  compareExitCode,
  createPostflightTextPath,
  inspectPdfArtifact,
  runCompare
} from "./compare.mjs";
import { createCheck } from "./report-lib.mjs";

test("runCompare includes actual supplied PDF inspection checks", async () => {
  let inspected;
  const report = await runCompare(
    {
      before: "fixtures/compare/source.tex",
      after: "fixtures/compare/tailored-valid.tex",
      "before-facts": "fixtures/compare/source.facts.json",
      "after-facts": "fixtures/compare/tailored-valid.facts.json",
      pdf: "fixtures/compare/tailored-valid.pdf"
    },
    {
      inspectPdfArtifactImpl: async (options) => {
        inspected = options;
        return [
          createCheck({
            id: "pdf_artifact_non_empty",
            category: "pdf_text_layer",
            status: "pass"
          })
        ];
      }
    }
  );

  assert.equal(inspected.pdf, "fixtures/compare/tailored-valid.pdf");
  assert.deepEqual(inspected.protectedFacts, []);
  assert.ok(report.checks.some((check) => check.id === "pdf_artifact_non_empty"));
  assert.equal(report.inputs_checked.pdf, true);
});

test("runCompare makes a missing optional PDF visible", async () => {
  const report = await runCompare({
    before: "fixtures/compare/source.tex",
    after: "fixtures/compare/tailored-valid.tex",
    "before-facts": "fixtures/compare/source.facts.json",
    "after-facts": "fixtures/compare/tailored-valid.facts.json"
  });

  const check = report.checks.find((item) => item.id === "pdf_artifact_not_supplied");
  assert.equal(check.status, "warning");
  assert.equal(report.status, "pass_with_warnings");
});

test("runCompare maps a missing strict PDF to required capability exit 69", async () => {
  const report = await runCompare({
    before: "fixtures/compare/source.tex",
    after: "fixtures/compare/tailored-valid.tex",
    "before-facts": "fixtures/compare/source.facts.json",
    "after-facts": "fixtures/compare/tailored-valid.facts.json",
    profile: "strict"
  });

  const check = report.checks.find((item) => item.id === "pdf_artifact_required");
  assert.equal(check.status, "fail");
  assert.equal(check.metadata.required_capability_unavailable, true);
  assert.equal(compareExitCode(report), 69);
});

test("runCompare treats a missing explicit structured fact file as invalid input", async () => {
  await assert.rejects(
    runCompare({
      before: "fixtures/compare/source.tex",
      after: "fixtures/compare/tailored-valid.tex",
      "before-facts": "fixtures/compare/missing.json",
      "after-facts": "fixtures/compare/tailored-valid.facts.json"
    }),
    (error) => error.code === "INVALID_USAGE"
  );
});

test("runCompare treats missing explicit policy and JD files as invalid input", async () => {
  const base = {
    before: "fixtures/compare/source.tex",
    after: "fixtures/compare/tailored-valid.tex",
    "before-facts": "fixtures/compare/source.facts.json",
    "after-facts": "fixtures/compare/tailored-valid.facts.json"
  };
  await assert.rejects(
    runCompare({ ...base, policy: "fixtures/compare/missing-policy.json" }),
    (error) => error.code === "INVALID_USAGE"
  );
  await assert.rejects(
    runCompare({ ...base, jd: "fixtures/compare/missing-jd.txt" }),
    (error) => error.code === "INVALID_USAGE"
  );
});

test("runCompare rejects malformed comparison controls as invalid usage", async () => {
  const base = {
    before: "fixtures/compare/source.tex",
    after: "fixtures/compare/tailored-valid.tex",
    "before-facts": "fixtures/compare/source.facts.json",
    "after-facts": "fixtures/compare/tailored-valid.facts.json"
  };
  await assert.rejects(
    runCompare({ ...base, "max-pages": "nope" }),
    (error) => error.code === "INVALID_USAGE"
  );
  await assert.rejects(
    runCompare({ ...base, profile: "strcit" }),
    (error) => error.code === "INVALID_USAGE"
  );
});

test("runCompare passes protected facts into PDF artifact retention", async () => {
  let inspected;
  await runCompare(
    {
      before: "fixtures/compare/source.tex",
      after: "fixtures/compare/tailored-valid.tex",
      "before-facts": "fixtures/compare/source.facts.json",
      "after-facts": "fixtures/compare/tailored-valid.facts.json",
      policy: "fixtures/compare/protected-policy.json",
      pdf: "fixtures/compare/tailored-valid.pdf"
    },
    {
      inspectPdfArtifactImpl: async (options) => {
        inspected = options;
        return [];
      }
    }
  );

  assert.deepEqual(inspected.protectedFacts, [
    { id: "skill.typescript", normalized: "typescript" }
  ]);
});

test("protected PDF retention reports IDs and counts without raw values", () => {
  const check = checkProtectedPdfFacts(
    "Rendered resume without the configured skill",
    [{ id: "skill.private", normalized: "Private Candidate Term" }],
    "blocker"
  );

  assert.equal(check.status, "fail");
  assert.deepEqual(check.metadata.missing_ids, ["skill.private"]);
  assert.doesNotMatch(JSON.stringify(check), /Private Candidate Term/i);

  const tokenBoundary = checkProtectedPdfFacts("MongoDB systems", [
    { id: "skill.go", normalized: "Go" }
  ]);
  assert.equal(tokenBoundary.status, "warning");
  assert.deepEqual(tokenBoundary.metadata.missing_ids, ["skill.go"]);
});

test("postflight extraction paths are unique per run", () => {
  const left = createPostflightTextPath();
  const right = createPostflightTextPath();

  assert.notEqual(left, right);
  assert.match(left, /^\.runtime\/reports\/postflight-[0-9a-f-]+\.txt$/);
});

test("compareExitCode implements D7 status and capability mapping", () => {
  assert.equal(compareExitCode({ status: "pass", checks: [] }), 0);
  assert.equal(compareExitCode({ status: "pass_with_warnings", checks: [] }), 0);
  assert.equal(compareExitCode({ status: "fail", checks: [] }), 2);
  assert.equal(
    compareExitCode({
      status: "fail",
      checks: [{ metadata: { required_capability_unavailable: true } }]
    }),
    69
  );
});

test("inspectPdfArtifact fails missing and empty supplied PDFs", async (t) => {
  const dir = ".runtime/tests/postflight-artifacts";
  await mkdir(dir, { recursive: true });
  await writeFile(`${dir}/empty.pdf`, "");
  t.after(() => rm(dir, { recursive: true, force: true }));

  const missing = await inspectPdfArtifact({ pdf: `${dir}/missing.pdf` });
  const empty = await inspectPdfArtifact({ pdf: `${dir}/empty.pdf` });

  assert.equal(missing[0].id, "pdf_artifact_non_empty");
  assert.equal(missing[0].status, "fail");
  assert.equal(empty[0].id, "pdf_artifact_non_empty");
  assert.equal(empty[0].status, "fail");
});
