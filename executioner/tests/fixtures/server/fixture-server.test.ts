import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { Server } from "node:http";
import { chromium } from "playwright";

import { fixtureRunId, providerError } from "../../../src/contracts/index.ts";
import { requiredFieldFlowCases } from "../../../src/testing/contracts/field-flow-cases.ts";
import {
  FixtureServer,
  FixtureValidationError,
  loadFixtureManifest,
} from "../../../src/testing/fixture-server.ts";

const fixtureRoot = fileURLToPath(
  new URL("../../../fixtures/workday/s1/", import.meta.url),
);
const countryListboxScript = `document.addEventListener("click",({target})=>{if(!(target instanceof Element)||target.getAttribute("role")!=="option")return;const listbox=target.parentElement;if(listbox?.getAttribute("data-field-id")!=="s1-field-country")return;for(const option of listbox.querySelectorAll(':scope > [role="option"]'))option.setAttribute("aria-selected",option===target?"true":"false")})`;
const countryListboxScriptSource = `sha256-${createHash("sha256")
  .update(countryListboxScript)
  .digest("base64")}`;
const expectedCsp = `default-src 'none'; style-src 'unsafe-inline'; script-src '${countryListboxScriptSource}'; form-action 'self'; base-uri 'none'`;

function fixtureCopy(): string {
  const root = mkdtempSync(join(tmpdir(), "hunt-f2-server-"));
  cpSync(fixtureRoot, root, { recursive: true });
  return root;
}

test("the v2 manifest admits exactly four frozen fixture assets", () => {
  const manifest = loadFixtureManifest(fixtureRoot);
  assert.equal(manifest.schemaVersion, 2);
  assert.deepEqual(
    manifest.pages.map(({ id, path }) => ({ id, path })),
    [
      { id: "fixture-account", path: "/account" },
      { id: "fixture-profile", path: "/profile" },
      { id: "fixture-questionnaire", path: "/questionnaire" },
      { id: "fixture-review", path: "/review" },
    ],
  );
  for (const page of manifest.pages) {
    assert.match(page.semanticHash, /^sha256\.[a-f0-9]{64}$/u);
  }
});

test("manifest validation rejects malformed, missing, extra, and changed assets", () => {
  const malformed = fixtureCopy();
  const missing = fixtureCopy();
  const extra = fixtureCopy();
  const changed = fixtureCopy();
  try {
    writeFileSync(join(malformed, "manifest.json"), "{}", "utf8");
    unlinkSync(join(missing, "profile"));
    writeFileSync(join(extra, "unexpected.js"), "", "utf8");
    writeFileSync(join(changed, "account"), "changed", "utf8");

    for (const [root, code] of [
      [malformed, "fixture_manifest_invalid"],
      [missing, "fixture_asset_missing"],
      [extra, "fixture_asset_extra"],
      [changed, "fixture_manifest_invalid"],
    ] as const) {
      assert.throws(
        () => loadFixtureManifest(root),
        (error: unknown) =>
          error instanceof FixtureValidationError && error.code === code,
      );
    }
  } finally {
    for (const root of [malformed, missing, extra, changed]) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("manifest hashes are stable across platform line endings", () => {
  const root = fixtureCopy();
  try {
    const account = join(root, "account");
    const normalized = readFileSync(account, "utf8").replaceAll("\r\n", "\n");
    writeFileSync(account, normalized.replaceAll("\n", "\r\n"), "utf8");
    assert.doesNotThrow(() => loadFixtureManifest(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("all ten canonical fields declare one exact browser target coordinate", () => {
  const manifest = loadFixtureManifest(fixtureRoot);
  const html = manifest.pages
    .map(({ path }) => readFileSync(join(fixtureRoot, path.slice(1)), "utf8"))
    .join("\n");
  const coordinates = [...html.matchAll(
    /\bdata-field-id="([^"]+)"[^>]*\bdata-hunt-target-token="([^"]+)"/gu,
  )].map((match) => ({ fieldId: match[1], token: match[2] }));

  assert.deepEqual(
    coordinates.map(({ fieldId }) => fieldId).sort(),
    requiredFieldFlowCases.map(({ fieldId }) => fieldId).sort(),
  );
  assert.deepEqual(
    coordinates.map(({ token }) => token).sort(),
    requiredFieldFlowCases.map(({ fieldId }) => `target-${fieldId}`).sort(),
  );
  assert.equal(new Set(coordinates.map(({ token }) => token)).size, 10);
});

test("all ten canonical controls and their exact options are browser-visible", () => {
  const manifest = loadFixtureManifest(fixtureRoot);
  const html = manifest.pages
    .map(({ path }) => readFileSync(join(fixtureRoot, path.slice(1)), "utf8"))
    .join("\n");
  assert.equal([...html.matchAll(/\bdata-field-id=/gu)].length, 10);

  for (const field of requiredFieldFlowCases) {
    assert.ok(html.includes(`data-field-id="${field.fieldId}"`), field.fieldId);
    assert.ok(html.includes(`data-question-id="${field.questionId}"`), field.questionId);
    assert.ok(html.includes(`data-question-label="${field.questionLabel}"`), field.questionLabel);
    assert.ok(html.includes(field.fieldLabel), field.fieldLabel);
    for (const option of field.options) {
      assert.ok(html.includes(`data-option-id="${option.id}"`), option.id);
      assert.ok(html.includes(`value="${option.value}"`), option.value);
      assert.ok(html.includes(option.label), option.label);
    }
  }
});

test("profile admits exactly one hashed country-listbox script", () => {
  const profile = readFileSync(join(fixtureRoot, "profile"), "utf8");
  assert.equal([...profile.matchAll(/<script\b/gu)].length, 1);
  assert.deepEqual(
    [...profile.matchAll(/<script>([\s\S]*?)<\/script>/gu)].map((match) => match[1]),
    [countryListboxScript],
  );
  assert.doesNotMatch(profile, /\b(?:localStorage|sessionStorage|fetch|XMLHttpRequest|eval|Function)\b/u);
});

test("canonical fields use their exact HTML behavior and no extra options", () => {
  const html = ["profile", "questionnaire"]
    .map((page) => readFileSync(join(fixtureRoot, page), "utf8"))
    .join("\n");
  const markup = (fieldId: string): string => {
    const line = html.split(/\r?\n/u).find((candidate) =>
      candidate.includes(`data-field-id="${fieldId}"`)
    );
    assert.ok(line, fieldId);
    return line;
  };

  for (const field of requiredFieldFlowCases) {
    const line = markup(field.fieldId);
    const shape = {
      text: /<input\b[^>]*type="(?:text|tel)"/u,
      textarea: /<textarea\b/u,
      radio: /<fieldset\b[^>]*data-field-id=/u,
      checkbox: /<input\b[^>]*data-field-id=[^>]*type="checkbox"/u,
      select: /<select\b[^>]*data-field-id=/u,
      listbox: /<div\b[^>]*role="listbox"[^>]*data-field-id=/u,
      date: /<input\b[^>]*data-field-id=[^>]*type="date"/u,
      file_upload: /<input\b[^>]*data-field-id=[^>]*type="file"/u,
    } as const;
    assert.match(line, shape[field.behavior], field.fieldId);
    assert.deepEqual(
      [...line.matchAll(/\bdata-option-id="([^"]+)"/gu)].map((match) => match[1]),
      field.options.map(({ id }) => id),
      field.fieldId,
    );
    assert.doesNotMatch(line, /Choose an option/iu, field.fieldId);
  }
});

test("the age checkbox has one native semantic group and one input target", () => {
  const questionnaire = readFileSync(join(fixtureRoot, "questionnaire"), "utf8");
  const group = questionnaire.match(
    /<fieldset>\s*<legend>Are you at least 18 years of age\?<\/legend>\s*<label><input([^>]*)>I am at least 18 years of age\.<\/label>\s*<\/fieldset>/u,
  );
  assert.ok(group);
  const inputAttributes = group[1] ?? "";
  assert.match(inputAttributes, /\bdata-field-id="s1-field-age-requirement"/u);
  assert.match(
    inputAttributes,
    /\bdata-hunt-target-token="target-s1-field-age-requirement"/u,
  );
  assert.equal(
    [...questionnaire.matchAll(
      /\bdata-hunt-target-token="target-s1-field-age-requirement"/gu,
    )].length,
    1,
  );
});

test("the loopback server preserves exact fixture and browser page coordinates across reset", async (t) => {
  const server = new FixtureServer(fixtureRoot);
  t.after(() => server.close());
  const started = await server.start(
    { fixtureRunId: fixtureRunId("fixture-run-server") },
    new AbortController().signal,
  );
  assert.equal(started.ok, true);
  if (!started.ok) return;

  const expectedBrowserPageIds = new Map([
    ["fixture-account", "page-account"],
    ["fixture-profile", "page-profile"],
    ["fixture-questionnaire", "page-questionnaire"],
    ["fixture-review", "page-review"],
  ]);
  for (const phase of ["start", "reset"] as const) {
    if (phase === "reset") {
      assert.equal((await server.reset(
        { fixtureRunId: started.value.fixtureRunId },
        new AbortController().signal,
      )).ok, true);
    }
    for (const page of loadFixtureManifest(fixtureRoot).pages) {
      const response: Response = await fetch(`${started.value.origin}${page.path}`);
      assert.equal(response.status, 200);
      assert.equal(
        response.headers.get("content-security-policy"),
        expectedCsp,
      );
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      const html = await response.text();
      const openingTag = html.match(/<html\b[^>]*>/u)?.[0];
      assert.ok(openingTag, page.id);
      assert.deepEqual(
        [...openingTag.matchAll(/\bdata-fixture-page-id="([^"]+)"/gu)]
          .map((match) => match[1]),
        [page.id],
      );
      assert.deepEqual(
        [...openingTag.matchAll(/\bdata-hunt-page-id="([^"]+)"/gu)]
          .map((match) => match[1]),
        [expectedBrowserPageIds.get(page.id)],
      );
    }
  }
  assert.equal((await fetch(`${started.value.origin}/missing`)).status, 404);
  assert.equal((await fetch(`${started.value.origin}/account`, { method: "POST" })).status, 405);
});

test("country selection is exclusive and clears on reload, fresh session, and reset", async (t) => {
  const server = new FixtureServer(fixtureRoot);
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    await server.close();
  });
  const started = await server.start(
    { fixtureRunId: fixtureRunId("fixture-run-listbox") },
    new AbortController().signal,
  );
  assert.equal(started.ok, true);
  if (!started.ok) return;

  const page = await browser.newPage();
  await page.goto(`${started.value.origin}/profile`);
  const selection = () => page.locator('[role="listbox"] > [role="option"]')
    .evaluateAll((options) => options.map((option) => option.getAttribute("aria-selected")));
  assert.deepEqual(await selection(), ["false", "false"]);
  await page.locator('[data-option-id="s1-option-country-us"]').click();
  assert.deepEqual(await selection(), ["true", "false"]);
  await page.locator('[data-option-id="s1-option-country-ca"]').click();
  assert.deepEqual(await selection(), ["false", "true"]);

  await page.reload();
  assert.deepEqual(await selection(), ["false", "false"]);
  const freshPage = await browser.newPage();
  await freshPage.goto(`${started.value.origin}/profile`);
  assert.deepEqual(
    await freshPage.locator('[role="listbox"] > [role="option"]')
      .evaluateAll((options) => options.map((option) => option.getAttribute("aria-selected"))),
    ["false", "false"],
  );
  await freshPage.close();

  await page.locator('[data-option-id="s1-option-country-us"]').click();
  assert.equal((await server.reset(
    { fixtureRunId: started.value.fixtureRunId },
    new AbortController().signal,
  )).ok, true);
  await page.reload();
  assert.deepEqual(await selection(), ["false", "false"]);
});

test("required sponsorship starts semantically unselected with only Yes and No options", async (t) => {
  const server = new FixtureServer(fixtureRoot);
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    await server.close();
  });
  const started = await server.start(
    { fixtureRunId: fixtureRunId("fixture-run-sponsorship") },
    new AbortController().signal,
  );
  assert.equal(started.ok, true);
  if (!started.ok) return;

  const page = await browser.newPage();
  await page.goto(`${started.value.origin}/questionnaire`);
  const sponsorship = page.locator('[data-field-id="s1-field-sponsorship"]');
  const selection = () => sponsorship.evaluate((element) => {
    const select = element as HTMLSelectElement;
    const options = [...select.options];
    return {
      required: select.required,
      valid: select.checkValidity(),
      value: select.value,
      selectedCatalogOptionId:
        options.find((option) => option.selected)?.dataset.optionId ?? null,
      visibleLabels: options
        .filter((option) => !option.hidden)
        .map((option) => option.textContent?.trim()),
      catalogLabels: options
        .filter((option) => option.dataset.optionId !== undefined)
        .map((option) => option.textContent?.trim()),
    };
  });
  const empty = {
    required: true,
    valid: false,
    value: "",
    selectedCatalogOptionId: null,
    visibleLabels: ["Yes", "No"],
    catalogLabels: ["Yes", "No"],
  };
  assert.deepEqual(await selection(), empty);

  await sponsorship.selectOption("yes");
  assert.deepEqual(await selection(), {
    ...empty,
    valid: true,
    value: "yes",
    selectedCatalogOptionId: "s1-option-sponsorship-yes",
  });
  await sponsorship.selectOption("no");
  assert.deepEqual(await selection(), {
    ...empty,
    valid: true,
    value: "no",
    selectedCatalogOptionId: "s1-option-sponsorship-no",
  });

  await page.reload();
  assert.deepEqual(await selection(), empty);
});

test("the server retains the exact validated asset bytes across disk changes and reset", async () => {
  const root = fixtureCopy();
  const expected = readFileSync(join(root, "account"), "utf8");
  const server = new FixtureServer(root);
  try {
    writeFileSync(join(root, "account"), "changed after validation", "utf8");
    const started = await server.start(
      { fixtureRunId: fixtureRunId("fixture-run-immutable-assets") },
      new AbortController().signal,
    );
    assert.equal(started.ok, true);
    if (!started.ok) return;
    const account = `${started.value.origin}/account`;
    assert.equal(await (await fetch(account)).text(), expected);
    assert.equal((await server.reset(
      { fixtureRunId: started.value.fixtureRunId },
      new AbortController().signal,
    )).ok, true);
    assert.equal(await (await fetch(account)).text(), expected);
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("listener failure and timeout return fixture_timeout and clean partial servers", async () => {
  const expected = { ok: false, error: providerError("fixture_timeout") } as const;
  let failedServer: Server | undefined;
  const failed = new FixtureServer(fixtureRoot, {
    bind(server: Server) {
      failedServer = server;
      queueMicrotask(() => server.emit("error", new Error("synthetic bind failure")));
    },
    listenTimeoutMs: 50,
  });
  try {
    assert.deepEqual(await failed.start(
      { fixtureRunId: fixtureRunId("fixture-run-bind-failure") },
      new AbortController().signal,
    ), expected);
    assert.equal(failedServer?.listening, false);
  } finally {
    await failed.close();
  }

  let timedOutServer: Server | undefined;
  const timedOut = new FixtureServer(fixtureRoot, {
    bind(server: Server) {
      timedOutServer = server;
    },
    listenTimeoutMs: 10,
  });
  try {
    assert.deepEqual(await timedOut.start(
      { fixtureRunId: fixtureRunId("fixture-run-bind-timeout") },
      new AbortController().signal,
    ), expected);
    assert.equal(timedOutServer?.listening, false);
  } finally {
    await timedOut.close();
  }
});

test("only exact F3-compatible browser navigation exists and Submit is inert", () => {
  const expected = [
    ["account", "/profile", "target-next-account"],
    ["profile", "/questionnaire", "target-next-profile"],
    ["questionnaire", "/review", "target-next-questionnaire"],
  ] as const;
  for (const [page, next, token] of expected) {
    const html = readFileSync(join(fixtureRoot, page), "utf8");
    assert.match(html, new RegExp(`<form[^>]+action="${next}"[^>]+method="get"`, "u"));
    assert.match(html, new RegExp(
      `<button[^>]+data-action="next"[^>]+data-hunt-target-token="${token}"[^>]*>Continue</button>`,
      "u",
    ));
  }
  const review = readFileSync(join(fixtureRoot, "review"), "utf8");
  assert.match(review, /<button[^>]*\bdisabled\b[^>]*>Submit application<\/button>/u);
  assert.doesNotMatch(review, /<form\b|type="submit"|\b(?:href|action)=/iu);
});
