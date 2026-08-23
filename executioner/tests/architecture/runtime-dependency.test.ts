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

test("Stage 2 setup pins one verified Node and Playwright pairing", () => {
  const manifest = JSON.parse(readFileSync("package.json", "utf8")) as {
    readonly scripts: Readonly<Record<string, string>>;
  };
  const setup = readFileSync("scripts/prepare-s2-runtime.ps1", "utf8");
  const wrapper = readFileSync("scripts/run-with-s2-runtime.ps1", "utf8");

  assert.match(setup, /\$nodeVersion = '22\.23\.2'/u);
  assert.match(setup, /\$npmVersion = '10\.9\.8'/u);
  assert.match(setup, /\$nodeArchiveSha256 = '[0-9a-f]{64}'/u);
  assert.match(setup, /npm-cli\.js/u);
  assert.match(setup, /npmCli ci/u);
  assert.match(setup, /playwright\\cli\.js'\) install chromium/u);
  assert.match(setup, /Get-Counter '\\Memory\\Available Bytes','\\Memory\\Commit Limit','\\Memory\\Committed Bytes'/u);
  assert.match(setup, /Get-HuntToolingIdentity/u);
  assert.doesNotMatch(setup, /taskkill|Stop-Process\s+-Name/u);
  for (const script of ["prepare:s2-run", "live:s2", "live:s2:slice", "mcp:s2"] as const) {
    assert.match(manifest.scripts[script] ?? "", /run-with-s2-runtime\.ps1/u);
  }
  assert.match(wrapper, /prepare-s2-runtime\.ps1/u);
  assert.match(wrapper, /npm_execpath/u);
});
