import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { verifyPackageFileList } from "../src/corpus/package/index.ts";

const executioner = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npmCli = process.env.npm_execpath;
if (npmCli === undefined) throw new Error("npm CLI path unavailable");
const result = spawnSync(process.execPath, [npmCli, "pack", "--json", "--dry-run"], {
  cwd: executioner,
  encoding: "utf8",
  shell: false,
  windowsHide: true,
  stdio: ["ignore", "pipe", "inherit"],
});
if (result.error !== undefined) throw result.error;
if (result.status !== 0) throw new Error("package dry run failed");
const packs = JSON.parse(result.stdout) as readonly { readonly files: readonly { readonly path: string }[] }[];
const files = packs[0]?.files.map((file) => file.path) ?? [];
const denied = verifyPackageFileList(files);
if (denied.length > 0) throw new Error(`package contains denied files: ${denied.join(", ")}`);
if (!files.includes("package.json") || !files.includes("README.md") || !files.includes("src/control/mcp/facade.ts")) {
  throw new Error("package required files missing");
}
process.stdout.write(`${JSON.stringify({ status: "passed", files: files.length })}\n`);
