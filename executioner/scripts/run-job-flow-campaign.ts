import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, globSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadJobFlowMatrix, matrixTestFiles, renderJobFlowRules, verifyReadOnlyLiveJob } from "./job-flow-campaign.ts";
import { acquireCampaignLock, baselineEvidencePresent, contentDigest, evidenceDigest, verifyCampaignCheckpoint, type CampaignGate } from "./campaign-checkpoint.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const matrix = loadJobFlowMatrix(join(root, "fixtures/job-flow-campaign/v1.json"), root);
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--write-rules") {
  writeFileSync(join(root, "docs/job-flow-rules.md"), renderJobFlowRules(matrix));
} else if (args.length === 1 && args[0] === "--check-rules") {
  if (readFileSync(join(root, "docs/job-flow-rules.md"), "utf8") !== renderJobFlowRules(matrix)) throw Error("generated rules are stale");
  console.log("Job-flow matrix and generated rules match.");
} else if (args[0] === "--live-read-only" && (args.length === 1 || args.length === 3 && args[1] === "--output" && args[2])) {
  const results = [];
  for (const job of matrix.baselineJobs) results.push(await verifyReadOnlyLiveJob(job, matrix.liveValidation));
  const report = JSON.stringify({ checkedAt: new Date().toISOString(), transport: "read_only_http", applicationAcceptance: false, results }, null, 2);
  if (args[2]) writeFileSync(resolve(args[2]), report, { flag: "wx" });
  console.log(report);
  if (results.some((result) => result.outcome !== "posting_present")) process.exitCode = 1;
} else {
  if (args[0] !== "--output" || !args[1] || args.length > 3 || (args[2] && args[2] !== "--resume")) {
    throw Error("Use --output <new-directory> [--resume], --check-rules, --write-rules, or --live-read-only");
  }
  const output = resolve(args[1]);
  const resume = args[2] === "--resume";
  if (readFileSync(join(root, "docs/job-flow-rules.md"), "utf8") !== renderJobFlowRules(matrix)) throw Error("generated rules are stale");
  const sourceDigest = () => contentDigest(root, ["package.json", "package-lock.json", "tsconfig.json", ...globSync("{src,tests,scripts,fixtures,docs}/**/*", { cwd: root, withFileTypes: true })
    .filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1))]);
  const sourceSha256 = sourceDigest();
  const definitions = [
    { id: "typecheck", command: ["node_modules/typescript/bin/tsc", "--noEmit", "--incremental", "false"] },
    { id: "rules", command: ["--experimental-test-module-mocks", "--test", "--test-concurrency=1", ...new Set(["tests/testing/job-flow-campaign.test.ts", "tests/testing/campaign-checkpoint.test.ts", ...matrixTestFiles(matrix).filter((file) => !file.includes("job-flow-browser"))])] },
    ...Array.from({ length: matrix.repeatRuns }, (_, index) => ({ id: `baseline-${index + 1}`, command: ["--experimental-test-module-mocks", "--test", "--test-concurrency=1", "tests/testing/job-flow-browser.test.ts"] })),
  ];
  const checkpointPath = join(output, "checkpoint.json");
  if (!resume) {
    if (existsSync(output)) throw Error("output exists; use --resume or choose a new directory");
    mkdirSync(dirname(output), { recursive: true });
    mkdirSync(output);
  }
  const release = acquireCampaignLock(output);
  try {
  let gates: CampaignGate[] = [];
  if (resume) {
    gates = [...verifyCampaignCheckpoint(JSON.parse(readFileSync(checkpointPath, "utf8")), sourceSha256, definitions.map(({ id }) => id)).gates];
    for (const gate of gates) {
      if (evidenceDigest(join(output, gate.directory)) !== gate.evidenceSha256) throw Error(`evidence changed for ${gate.id}`);
    }
  }
  const save = () => {
    const temporary = `${checkpointPath}.tmp-${randomUUID()}`;
    writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, sourceSha256, gates }, null, 2), { flag: "wx" });
    renameSync(temporary, checkpointPath);
  };
  save();
  for (const definition of definitions) {
    if (sourceDigest() !== sourceSha256) throw Error("source changed during campaign; use a new output directory");
    if (gates.some((gate) => gate.id === definition.id && gate.status === "passed")) {
      console.log(`${definition.id}: verified checkpoint reused`);
      continue;
    }
    const directory = `attempt-${randomUUID()}`;
    const attemptRoot = join(output, directory);
    mkdirSync(attemptRoot);
    console.log(`${definition.id}: running`);
    const result = spawnSync(process.execPath, definition.command, {
      cwd: root, encoding: "utf8", windowsHide: true, shell: false,
      timeout: 900_000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, HUNT_JOB_FLOW_EVIDENCE_DIR: join(attemptRoot, "browser") },
    });
    writeFileSync(join(attemptRoot, "stdout.log"), result.stdout ?? "");
    writeFileSync(join(attemptRoot, "stderr.log"), result.stderr ?? "");
    const sourceUnchanged = sourceDigest() === sourceSha256;
    const browserEvidenceComplete = !definition.id.startsWith("baseline-") || baselineEvidencePresent(join(attemptRoot, "browser"), matrix.baselineJobs.map(({ id }) => id));
    const status = result.status === 0 && !result.error && sourceUnchanged && browserEvidenceComplete ? "passed" : "failed";
    writeFileSync(join(attemptRoot, "execution.json"), JSON.stringify({ gate: definition.id, command: definition.command, exitCode: result.status, signal: result.signal, spawnError: result.error?.name ?? null, sourceSha256, sourceUnchanged, nodeVersion: process.version, platform: process.platform, status }, null, 2));
    gates = [...gates.filter((gate) => gate.id !== definition.id), { id: definition.id, status, directory, evidenceSha256: evidenceDigest(attemptRoot) }];
    save();
    console.log(`${definition.id}: ${status} (${directory})`);
    if (status === "failed") { process.exitCode = 1; break; }
  }
  const accepted = definitions.every(({ id }) => gates.some((gate) => gate.id === id && gate.status === "passed"));
  console.log(JSON.stringify({ status: accepted ? "fixture_campaign_passed" : "not_accepted", sourceSha256, liveAcceptance: false, checkpointPath }));
  } finally { release(); }
}
