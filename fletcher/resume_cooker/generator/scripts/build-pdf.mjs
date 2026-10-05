import { buildPdf, parseArgs } from "./build-lib.mjs";

const args = parseArgs(process.argv.slice(2));

try {
  const result = await buildPdf({
    source: args.source,
    outDir: args["out-dir"],
    engine: args.engine,
    clean: args.clean === "true"
  });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
