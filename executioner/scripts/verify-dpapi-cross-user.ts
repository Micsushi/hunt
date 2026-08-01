import { runCrossWindowsUserDpapiGate } from "../src/secrets/windows-dpapi/cross-user-gate.ts";

const result = await runCrossWindowsUserDpapiGate(
  {},
  new AbortController().signal,
);
process.stdout.write(JSON.stringify(result));
process.exitCode = result.kind === "passed" ? 0 : result.kind === "environment_prerequisite" ? 2 : 1;
