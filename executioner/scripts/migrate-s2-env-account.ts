import { isAbsolute, normalize, resolve } from "node:path";

import { bootstrapS2AccountSecret } from "../src/composition/s2-account-bootstrap.ts";
import { runS2AccountBootstrapCli } from "../src/composition/s2-account-bootstrap-cli.ts";
import { WindowsPinnedEnvAccountSealer } from "../src/secrets/windows-dpapi/private/pinned-env-account-sealer.ts";

const parsed = parseArguments(process.argv.slice(2));
if (parsed === null) {
  process.stdout.write('{"ok":false,"error":{"code":"bootstrap_input_invalid"}}\n');
  process.exitCode = 1;
} else {
  const sealer = new WindowsPinnedEnvAccountSealer({
    sourcePath: parsed.envSource,
    expectedSha256: parsed.sha256,
  });
  const result = await runS2AccountBootstrapCli(
    ["--config", parsed.config],
    process.env,
    {
      forbiddenRoots: [resolve(import.meta.dirname, "..", "..")],
      operation: (value, context, signal) => bootstrapS2AccountSecret(
        value,
        { ...context, sealer },
        signal,
      ),
    },
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.ok ? 0 : 1;
}

function parseArguments(arguments_: readonly string[]): {
  readonly config: string;
  readonly envSource: string;
  readonly sha256: string;
} | null {
  if (
    arguments_.length !== 6 ||
    arguments_[0] !== "--config" ||
    arguments_[2] !== "--env-source" ||
    arguments_[4] !== "--sha256"
  ) return null;
  const config = exactAbsolute(arguments_[1]);
  const envSource = exactAbsolute(arguments_[3]);
  const sha256 = arguments_[5];
  if (config === null || envSource === null || !/^[0-9a-f]{64}$/u.test(sha256 ?? "")) {
    return null;
  }
  return { config, envSource, sha256: sha256! };
}

function exactAbsolute(value: string | undefined): string | null {
  return typeof value === "string" && isAbsolute(value) && normalize(value) === value
    ? value
    : null;
}
