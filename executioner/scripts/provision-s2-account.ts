import { isAbsolute, normalize, resolve } from "node:path";

import { bootstrapS2AccountSecret } from "../src/composition/s2-account-bootstrap.ts";
import { runS2AccountBootstrapCli } from "../src/composition/s2-account-bootstrap-cli.ts";
import { WindowsPinnedEnvAccountSealer } from "../src/secrets/windows-dpapi/private/pinned-env-account-sealer.ts";

const arguments_ = process.argv.slice(2);
const pinned = parsePinnedSource(arguments_);
const result = await runS2AccountBootstrapCli(
  pinned === null ? arguments_ : ["--config", pinned.config],
  process.env,
  {
    forbiddenRoots: [resolve(import.meta.dirname, "..", "..")],
    ...(pinned === null ? {} : {
      operation: (value, context, signal) => bootstrapS2AccountSecret(value, {
        ...context,
        sealer: new WindowsPinnedEnvAccountSealer({
          sourcePath: pinned.source,
          expectedSha256: pinned.sha256,
        }),
      }, signal),
    }),
  },
);
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exitCode = result.ok ? 0 : 1;

function parsePinnedSource(arguments_: readonly string[]): {
  readonly config: string;
  readonly source: string;
  readonly sha256: string;
} | null {
  if (
    arguments_.length !== 6 ||
    arguments_[0] !== "--config" ||
    arguments_[2] !== "--env-source" ||
    arguments_[4] !== "--sha256"
  ) return null;
  const config = exactAbsolute(arguments_[1]);
  const source = exactAbsolute(arguments_[3]);
  const sha256 = arguments_[5];
  return config !== null && source !== null && /^[0-9a-f]{64}$/u.test(sha256 ?? "")
    ? { config, source, sha256: sha256! }
    : null;
}

function exactAbsolute(value: string | undefined): string | null {
  return typeof value === "string" && isAbsolute(value) && normalize(value) === value
    ? value
    : null;
}
