#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  DEFAULT_OUTPUT_DIR,
  recordAuditIssues,
} = require("./lib/c3_issue_registry");

function parseArgs(argv) {
  const args = {
    audit: "",
    outputDir: DEFAULT_OUTPUT_DIR,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--audit" && next) {
      args.audit = next;
      index += 1;
    } else if (arg === "--output-dir" && next) {
      args.outputDir = next;
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function usage() {
  return [
    "Usage: node scripts/c3_issue_registry.js --audit <audit.json> [--output-dir docs/c3-issues]",
    "",
    "Extracts typed C3 issues from a live-smoke audit and appends them to a repo-visible JSONL ledger.",
  ].join("\n");
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.audit) {
    console.log(usage());
    return;
  }
  const auditPath = path.resolve(args.audit);
  const audit = JSON.parse(fs.readFileSync(auditPath, "utf8"));
  const result = recordAuditIssues({
    audit,
    auditPath: args.audit,
    outputDir: args.outputDir,
  });
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
}

main();
