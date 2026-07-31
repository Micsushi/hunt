import { globSync, statSync } from "node:fs";
import { join } from "node:path";

export function testTargets(inputs: readonly string[]): string[] {
  return (inputs.length === 0 ? ["tests"] : inputs).flatMap((input) => {
    if (!statSync(input).isDirectory()) {
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
