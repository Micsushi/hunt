#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { runCommand } from "../generator/scripts/build-lib.mjs";
import { auditPackageFiles } from "./platform-acceptance.mjs";

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("npm_execpath is unavailable; run this check through npm.");

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
if (packageJson.private !== true || packageJson.license !== "MIT") {
  throw new Error("Package must remain private and declare the MIT license.");
}

const packed = await runCommand(process.execPath, [npmCli, "pack", "--dry-run", "--json"], {
  quiet: true,
  timeoutMs: 60_000,
  maxOutputBytes: 2 * 1024 * 1024
});
const inventory = JSON.parse(packed.stdout);
const files = inventory?.[0]?.files?.map((entry) => entry.path);
if (!Array.isArray(files)) throw new Error("npm pack did not return a file inventory.");

const audit = auditPackageFiles(files);
if (!audit.ok) {
  throw new Error(
    `Unsafe package inventory: forbidden=${audit.forbidden.join(",") || "none"} missing=${audit.missing.join(",") || "none"}`
  );
}

console.log(`Package inventory passed (${files.length} files).`);
