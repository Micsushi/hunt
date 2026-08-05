import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("S2 runbook preserves slices and documents the same-revision Review gate and failure stops", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
    readonly scripts: Readonly<Record<string, string>>;
  };
  const readme = await readFile("README.md", "utf8");
  assert.equal(packageJson.scripts["live:s2"], "node scripts/run-s2-acceptance.ts");
  assert.equal(packageJson.scripts["live:s2:slice"], "node scripts/run-s2-isolated.ts");
  assert.match(readme, /npm run live:s2 -- --config .* --stop-after review --evidence-root/u);
  assert.match(readme, /npm run live:s2:slice -- --config .* --stop-after account_access/u);
  assert.match(readme, /quality_failed/u);
  assert.match(readme, /source_changed/u);
  assert.match(readme, /config_changed/u);
  assert.match(readme, /result_reconciliation_failed/u);
  assert.match(readme, /runtime_binding_failed/u);
  assert.match(readme, /bounded recovery.*verified pre-Review.*independent\s+Review proof/us);
  assert.match(readme, /real-evidence\/manifest\.json.*before\s+browser cleanup/us);
  assert.match(readme, /immutable owner-source resolver.*concrete/us);
  assert.match(readme, /live-only.*browser runtime adapter.*not yet available/us);
  assert.match(readme, /never automatically discards/u);
  assert.match(readme, /new prepared run/u);
  assert.match(readme, /Final job\s+Submit remains\s+forbidden/u);
});
