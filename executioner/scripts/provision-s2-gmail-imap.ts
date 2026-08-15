import { resolve } from "node:path";

import { bootstrapS2GmailAuthorization } from "../src/composition/s2-gmail-bootstrap.ts";
import { runS2GmailBootstrapCli } from "../src/composition/s2-gmail-bootstrap-cli.ts";
import { WindowsPinnedEnvGmailImapSealer } from "../src/secrets/windows-dpapi/private/pinned-env-gmail-imap-sealer.ts";

const arguments_ = process.argv.slice(2);
const sourceIndex = arguments_.indexOf("--env-source");
const digestIndex = arguments_.indexOf("--sha256");
if (
  arguments_.length !== 8 ||
  sourceIndex !== 4 ||
  digestIndex !== 6 ||
  typeof arguments_[5] !== "string" ||
  typeof arguments_[7] !== "string"
) {
  process.stdout.write('{"ok":false,"error":{"code":"gmail_bootstrap_input_invalid"}}\n');
  process.exitCode = 1;
} else {
  let sealer: WindowsPinnedEnvGmailImapSealer;
  try {
    sealer = new WindowsPinnedEnvGmailImapSealer({
      sourcePath: arguments_[5]!,
      expectedSha256: arguments_[7]!,
    });
  } catch {
    process.stdout.write('{"ok":false,"error":{"code":"gmail_bootstrap_input_invalid"}}\n');
    process.exitCode = 1;
    process.exit();
  }
  const result = await runS2GmailBootstrapCli(
    arguments_.slice(0, 4),
    process.env,
    {
      forbiddenRoots: [resolve(import.meta.dirname, "..", "..")],
      operation(owner, bootstrap, context, signal) {
        return bootstrapS2GmailAuthorization(
          owner,
          bootstrap,
          { ...context, sealer },
          signal,
        );
      },
    },
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.ok ? 0 : 1;
}
