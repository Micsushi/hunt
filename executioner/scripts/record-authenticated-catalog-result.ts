import { recordAuthenticatedCatalogResultFromArgs } from "../src/live/runner/catalog/authenticated-catalog-cli.ts";

try {
  const result = recordAuthenticatedCatalogResultFromArgs(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch {
  process.stdout.write('{"status":"failed","code":"catalog_result_denied"}\n');
  process.exitCode = 1;
}
