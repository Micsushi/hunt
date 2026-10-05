import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkAtsCheckerAgreement,
  compareParserExtractions,
  runAtsCheckerExtraction
} from "./ats-checker.mjs";

test("compareParserExtractions passes when extractions largely agree", () => {
  const check = compareParserExtractions(
    "Kubernetes Terraform PostgreSQL TypeScript backend engineer",
    "Kubernetes Terraform PostgreSQL TypeScript backend engineer"
  );

  assert.equal(check.status, "pass");
  assert.ok(check.metadata.agreement >= 0.6);
  assert.equal(check.metadata.threshold, 0.6);
  assert.equal(check.metadata.baseline_only_tokens, 0);
  assert.equal(check.metadata.ats_only_tokens, 0);
  assert.equal("only_in_baseline" in check.metadata, false);
  assert.equal("only_in_ats" in check.metadata, false);
});

test("compareParserExtractions warns when extractions disagree", () => {
  const check = compareParserExtractions(
    "Kubernetes Terraform PostgreSQL TypeScript backend engineer",
    "totally different words here nothing shared alpha beta gamma delta"
  );

  assert.equal(check.status, "warning");
});

test("compareParserExtractions fails when one side has no tokens", () => {
  const check = compareParserExtractions("Kubernetes Terraform", "");

  assert.equal(check.status, "fail");
  assert.equal(check.metadata.ats_tokens, 0);
});

test("checkAtsCheckerAgreement skips gracefully when python is absent", async () => {
  const checks = await checkAtsCheckerAgreement({
    pdf: "resume/output/current.pdf",
    baselineText: "Kubernetes",
    commandExistsImpl: async () => false
  });

  assert.equal(checks.length, 1);
  assert.equal(checks[0].id, "tester_ats_checker_skipped");
});

test("checkAtsCheckerAgreement fails when strict mode requires unavailable ATS-Checker", async () => {
  const checks = await checkAtsCheckerAgreement({
    pdf: "resume/output/current.pdf",
    baselineText: "Kubernetes",
    required: true,
    existsSyncImpl: () => false,
    commandExistsImpl: async () => false
  });

  assert.equal(checks[0].status, "fail");
  assert.equal(checks[0].severity, "blocker");
  assert.equal(checks[0].metadata.required_capability_unavailable, true);
});

test("checkAtsCheckerAgreement reports a ran check when the helper succeeds", async () => {
  const checks = await checkAtsCheckerAgreement({
    pdf: "resume/output/current.pdf",
    baselineText: "Kubernetes Terraform PostgreSQL",
    commandExistsImpl: async (cmd) => cmd === "python",
    runCommandImpl: async () => ({
      stdout: JSON.stringify({
        ok: true,
        library: "pypdf",
        text: "Kubernetes Terraform PostgreSQL"
      })
    })
  });

  assert.equal(checks[0].id, "tester_ats_checker_ran");
  assert.equal(checks[1].id, "parser_extraction_agreement");
  assert.equal(checks[1].status, "pass");
});

test("runAtsCheckerExtraction prefers the isolated environment and invokes the vendored parser", async () => {
  let invocation;
  const isolatedSuffix =
    process.platform === "win32"
      ? ".venv\\Scripts\\python.exe"
      : [".venv", "bin", "python"].join("/");
  const result = await runAtsCheckerExtraction({
    pdf: "resume/output/current.pdf",
    timeoutMs: 1234,
    existsSyncImpl: (path) =>
      path.replaceAll("\\", "/").endsWith(isolatedSuffix.replaceAll("\\", "/")),
    commandExistsImpl: async () => false,
    runCommandImpl: async (command, args, options) => {
      invocation = { command, args, options };
      return {
        stdout: JSON.stringify({
          ok: true,
          library: "PyPDF2",
          text: "Kubernetes Terraform"
        })
      };
    }
  });

  assert.equal(result.available, true);
  assert.ok(
    invocation.command.replaceAll("\\", "/").endsWith(isolatedSuffix.replaceAll("\\", "/"))
  );
  assert.match(invocation.args[1], /testers[\\/]ATS-Checker[\\/]ats\.py$/);
  assert.equal(invocation.options.timeoutMs, 1234);
});

test("runAtsCheckerExtraction classifies malformed helper output without exposing it", async () => {
  const result = await runAtsCheckerExtraction({
    pdf: "resume/output/current.pdf",
    existsSyncImpl: () => false,
    commandExistsImpl: async (command) => command === "python",
    runCommandImpl: async () => ({ stdout: "private resume output, not JSON" })
  });

  assert.deepEqual(result, {
    available: false,
    reason: "could not parse extractor output"
  });
});
