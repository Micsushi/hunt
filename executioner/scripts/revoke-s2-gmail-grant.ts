import { resolve } from "node:path";

import { runS2GmailGrantRevokeCli } from "../src/composition/s2-gmail-bootstrap-cli.ts";

const result = await runS2GmailGrantRevokeCli(
  process.argv.slice(2),
  process.env,
  { forbiddenRoots: [resolve(import.meta.dirname, "..", "..")] },
);
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exitCode = result.ok ? 0 : 1;
