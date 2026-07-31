import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("Playwright is the sole Stage 1 runtime dependency", () => {
  const manifest = JSON.parse(readFileSync("package.json", "utf8")) as {
    readonly dependencies?: Readonly<Record<string, string>>;
  };
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8")) as {
    readonly packages: {
      readonly "": {
        readonly dependencies?: Readonly<Record<string, string>>;
      };
    };
  };

  assert.deepEqual(Object.keys(manifest.dependencies ?? {}), ["playwright"]);
  assert.equal(
    lock.packages[""].dependencies?.playwright,
    manifest.dependencies?.playwright,
  );
});
