import { resolve } from "node:path";

import { runS2AccountBootstrapCli } from "../src/composition/s2-account-bootstrap-cli.ts";

const result = await runS2AccountBootstrapCli(
  process.argv.slice(2),
  process.env,
  { forbiddenRoots: [resolve(import.meta.dirname, "..", "..")] },
);
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exitCode = result.ok ? 0 : 1;
