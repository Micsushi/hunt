import { verifyStage2RuntimeReadiness } from "../src/live/preflight/runtime-readiness.ts";

const profileIndex = process.argv.indexOf("--profile-path");
const profilePath = profileIndex === -1 ? undefined : process.argv[profileIndex + 1];
const report = await verifyStage2RuntimeReadiness({ profilePath });
process.stdout.write(`${JSON.stringify(report)}\n`);
process.exitCode = report.status === "ready" ? 0 : 1;
