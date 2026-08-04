import { globSync, statSync } from "node:fs";
import { join } from "node:path";

export function testRunnerArgs(inputs: readonly string[]): string[] {
  return ["--test", "--test-concurrency=4", ...testTargets(inputs)];
}

export function testTargets(inputs: readonly string[]): string[] {
  return (inputs.length === 0 ? ["tests"] : inputs).flatMap((input) => {
    if (!statSync(input).isDirectory()) {
      if (!input.endsWith(".test.ts")) {
        throw new Error(`Test file must match *.test.ts: ${input}`);
      }
      return input;
    }

    const targets = globSync("**/*.test.ts", { cwd: input }).map((file) =>
      join(input, file),
    );
    if (targets.length === 0) {
      throw new Error(`No test files found in ${input}`);
    }
    return targets;
  });
}
