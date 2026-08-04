import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createPackageSbom, verifyPackageFileList } from "../src/corpus/package/index.ts";

const executioner = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(executioner, "..");
const output = resolve(repository, ".runtime", "c3-package");
await mkdir(output, { recursive: true });
const npmCli = process.env.npm_execpath;
if (npmCli === undefined) throw new Error("npm CLI path unavailable");
const result = spawnSync(process.execPath, [npmCli, "pack", "--json", "--pack-destination", output], {
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
const denied = verifyPackageFileList(pack.files.map((file) => file.path));
if (denied.length > 0) throw new Error(`package contains denied files: ${denied.join(", ")}`);
const artifact = resolve(output, pack.filename);
const checksum = createHash("sha256").update(await readFile(artifact)).digest("hex");
const lock = JSON.parse(await readFile(resolve(executioner, "package-lock.json"), "utf8"));
await writeFile(resolve(output, "sbom.cdx.json"), `${JSON.stringify(createPackageSbom(lock), null, 2)}\n`, "utf8");
await writeFile(resolve(output, "checksums.json"), `${JSON.stringify({ schemaVersion: 1, artifacts: [{ file: pack.filename, sha256: checksum }] }, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ status: "passed", artifact: pack.filename, sha256: checksum })}\n`);
