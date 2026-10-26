import { runStage2RunPreparationCli } from "../src/composition/s2-run-preparation-cli.ts";

try {
  const result = await runStage2RunPreparationCli(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = 0;
} catch {
  process.stdout.write('{"status":"failed","code":"run_preparation_denied"}\n');
  process.exitCode = 1;
}
