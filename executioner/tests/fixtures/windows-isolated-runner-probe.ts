import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";

import { assertCurrentProcessIsOnIsolatedDesktop } from "../../src/browser/playwright-live/private/windows-isolated-desktop-attestation.ts";

const [mode, outputPath, ...values] = process.argv.slice(2);
if (typeof outputPath !== "string") throw new TypeError("probe output missing");

if (mode === "argv") {
  await writeFile(outputPath, JSON.stringify(values), "utf8");
} else if (mode === "attest") {
  await assertCurrentProcessIsOnIsolatedDesktop();
  await writeFile(outputPath, "ok", "utf8");
} else if (mode === "linger") {
  const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    windowsHide: true,
  });
  await writeFile(outputPath, JSON.stringify({
    runnerPid: process.pid,
    descendantPid: descendant.pid,
  }), "utf8");
  await new Promise(() => undefined);
} else {
  throw new TypeError("probe mode invalid");
}
