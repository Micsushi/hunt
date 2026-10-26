import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { protectStage2StoragePaths } from "../src/composition/private/s2-run-storage.ts";
import { applicationProfileFactIds, type ApplicationProfileFactId } from
  "../src/profile/application-profile.ts";
import { importJobFillBackup } from "../src/profile/job-fill-import.ts";

const args = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (key === undefined || value === undefined || !key.startsWith("--")) throw new TypeError("invalid arguments");
  args.set(key, value);
}
const input = args.get("--input");
const output = args.get("--output");
if (!input || !output || !isAbsolute(input) || !isAbsolute(output)) throw new TypeError("absolute input and output paths required");

// Require a new leaf in an existing physical parent: no overwrite or junction traversal.
const destination = join(await realpath(dirname(resolve(output))), basename(resolve(output)));
for (let ancestor = dirname(destination); ; ancestor = dirname(ancestor)) {
  const marker = await lstat(join(ancestor, ".git")).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (marker !== null) throw new TypeError("output must be outside every repository");
  if (dirname(ancestor) === ancestor) break;
}

const confirmations = (args.get("--confirm-defaults") ?? "").split(",").filter(Boolean);
if (confirmations.some((factId) => !(applicationProfileFactIds as readonly string[]).includes(factId))) {
  throw new TypeError("unknown default confirmation");
}
const result = importJobFillBackup(JSON.parse(await readFile(input, "utf8")), {
  profileId: args.get("--profile-id") ?? "job-fill-import",
  revision: Number(args.get("--revision") ?? "1"),
  confirmedDefaultFactIds: confirmations as ApplicationProfileFactId[],
});

await mkdir(destination, { mode: 0o700 });
// Establish the inherited Windows ACL boundary before any applicant bytes exist.
await protectStage2StoragePaths([{ path: destination, directory: true }]);
const written = [join(destination, "application-profile.json")];
await writeFile(written[0]!, `${JSON.stringify(result.profile, null, 2)}\n`, { mode: 0o600, flag: "wx" });
for (const document of result.documents) {
  const path = join(destination, `${document.kind}-${basename(document.name)}`);
  await writeFile(path, document.bytes, { mode: 0o600, flag: "wx" });
  written.push(path);
}
const report = {
  unresolved: result.unresolved,
  defaultsAwaitingConfirmation: result.defaultsAwaitingConfirmation,
  replacementLedger: result.replacementLedger,
  documents: result.documents.map(({ kind, name, mimeType, bytes }) => ({ kind, name, mimeType, size: bytes.length })),
};
written.push(join(destination, "job-fill-import-report.json"));
await writeFile(written.at(-1)!, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: "wx" });
await protectStage2StoragePaths([
  { path: destination, directory: true },
  ...written.map((path) => ({ path, directory: false })),
]);
process.stdout.write(`${JSON.stringify({ status: "imported", output: destination, report: join(destination, "job-fill-import-report.json") })}\n`);
