import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runCorpusAudit } from "../src/corpus/audit/index.ts";

const executioner = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const report = await runCorpusAudit(executioner);
process.stdout.write(`${JSON.stringify(report)}\n`);
if (report.status !== "passed") process.exitCode = 1;
