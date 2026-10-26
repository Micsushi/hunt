import { compileAuthenticatedCatalogFromArgs } from "../src/live/runner/catalog/authenticated-catalog-cli.ts";

try {
  const result = compileAuthenticatedCatalogFromArgs(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify({
    status: "compiled",
    runId: result.summary.runId,
    completed: result.summary.completed,
    resultsPath: result.resultsPath,
    summaryPath: result.summaryPath,
  })}\n`);
} catch {
  process.stdout.write('{"status":"failed","code":"catalog_compile_denied"}\n');
  process.exitCode = 1;
}
