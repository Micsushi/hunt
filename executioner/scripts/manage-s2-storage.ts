import { runStage2StorageCli } from "../src/composition/s2-storage-cli.ts";

try {
  const result = await runStage2StorageCli(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = 0;
} catch {
  process.stdout.write('{"status":"failed","code":"storage_operation_denied"}\n');
  process.exitCode = 1;
}
