import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import {
  findPackageContentViolations,
  verifyPackageFileList,
  verifyPackageManifest,
  verifyReproduciblePackage,
} from "../src/corpus/package/index.ts";

const executioner = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npmCli = process.env.npm_execpath;
if (npmCli === undefined) throw new Error("npm CLI path unavailable");
const scratch = await mkdtemp(resolve(tmpdir(), "hunt-executioner-package-"));
try {
  const result = spawnSync(process.execPath, [npmCli, "pack", "--json", "--pack-destination", scratch], {
    cwd: executioner,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error("package build failed");
  const pack = (JSON.parse(result.stdout) as readonly {
    readonly filename: string;
    readonly files: readonly { readonly path: string }[];
  }[])[0];
  if (pack === undefined) throw new Error("package result unavailable");
  const files = pack.files.map((file) => file.path);
  const denied = verifyPackageFileList(files);
  if (denied.length > 0) throw new Error(`package contains denied files: ${denied.join(", ")}`);
  if (!files.includes("package.json") || !files.includes("README.md") || !files.includes("dist/control/mcp/facade.js")) {
    throw new Error("package required files missing");
  }
  const manifest = JSON.parse(await readFile(resolve(executioner, "package.json"), "utf8"));
  const manifestIssues = verifyPackageManifest(manifest);
  if (manifestIssues.length > 0) throw new Error(manifestIssues.join(", "));
  const contents = new Map<string, string>();
  for (const file of files) contents.set(file, await readFile(resolve(executioner, file), "utf8"));
  const contentViolations = findPackageContentViolations(contents);
  if (contentViolations.length > 0) throw new Error(`package content denied: ${contentViolations.join(", ")}`);

  const secondRoot = resolve(scratch, "second");
  await mkdir(secondRoot);
  const secondResult = spawnSync(process.execPath, [npmCli, "pack", "--json", "--pack-destination", secondRoot], {
    cwd: executioner,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (secondResult.error !== undefined || secondResult.status !== 0) {
    throw new Error("second package build failed");
  }
  const secondPack = (JSON.parse(secondResult.stdout) as readonly { readonly filename: string }[])[0];
  if (secondPack === undefined) throw new Error("second package result unavailable");
  const digest = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex");
  const reproducibilityIssues = verifyReproduciblePackage(
    await digest(resolve(scratch, pack.filename)),
    await digest(resolve(secondRoot, secondPack.filename)),
  );
  if (reproducibilityIssues.length > 0) throw new Error(reproducibilityIssues.join(", "));

  const installRoot = resolve(scratch, "install");
  await mkdir(installRoot);
  const install = spawnSync(process.execPath, [
    npmCli,
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--omit=dev",
    "--package-lock=false",
    resolve(scratch, pack.filename),
  ], {
    cwd: installRoot,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (install.error !== undefined || install.status !== 0) throw new Error("clean package install failed");
  const probe = spawnSync(process.execPath, [
    "--input-type=module",
    "--eval",
    "import('@hunt/executioner/mcp').then((module) => console.log(JSON.stringify(module.mcpMethods)))",
  ], {
    cwd: installRoot,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (probe.error !== undefined || probe.status !== 0) throw new Error("installed MCP surface failed to start");
  const methods = JSON.parse(probe.stdout.trim()) as string[];
  const expected = ["cancel_journey", "journey_result", "journey_status", "start_journey"];
  if (JSON.stringify([...methods].sort()) !== JSON.stringify(expected)) {
    throw new Error("installed MCP surface invalid");
  }
  process.stdout.write(`${JSON.stringify({ status: "passed", files: files.length, reproducible: true, cleanInstall: true, methods: expected })}\n`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
