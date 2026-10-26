import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("runbook requires external config and secure UI without secret CLI values", async () => {
  const readme = (await readFile("README.md", "utf8")).replace(/\s+/gu, " ");
  for (const statement of [
    "npm run provision:s2-account -- --config",
    "outside every repository and worktree",
    "secure Windows credential dialog",
    "Never pass the email or password through arguments or environment variables",
    "does not contact Workday or Gmail",
  ]) {
    assert.equal(readme.includes(statement), true, statement);
  }
});
