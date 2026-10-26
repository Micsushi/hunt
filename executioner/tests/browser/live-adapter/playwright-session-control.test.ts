import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { chromium } from "playwright";

import { PlaywrightSessionControlAdapter } from
  "../../../src/browser/playwright-live/private/playwright-session-control.ts";

test("classifies an exact Workday Sign In control as already signed out", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(
      '<button data-automation-id="utilityButtonSignIn">Sign In</button>',
    );

    assert.deepEqual(
      await new PlaywrightSessionControlAdapter({ settleTimeoutMs: 50 }).logout(page as never),
      { kind: "already_signed_out" },
    );
  } finally {
    await browser.close();
  }
});

test("opens the exact account menu, signs out once, and reclassifies", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(signedInMarkup());
    await page.locator('[aria-label="Sign Out"]').evaluate((element) => {
      element.addEventListener("click", () => {
        document.body.innerHTML =
          '<button data-automation-id="utilityButtonSignIn">Sign In</button>';
      });
    });

    assert.deepEqual(
      await new PlaywrightSessionControlAdapter().logout(page as never),
      { kind: "signed_out" },
    );
  } finally {
    await browser.close();
  }
});

test("reloads once when Workday clears auth but leaves stale signed-in UI", async (t) => {
  let signedOut = false;
  const server = createServer((request, response) => {
    if (request.url === "/logout") {
      signedOut = true;
      response.end("ok");
      return;
    }
    response.setHeader("content-type", "text/html");
    response.end(signedOut
      ? '<button data-automation-id="utilityButtonSignIn">Sign In</button>'
      : signedInMarkup().replace(
        'aria-label="Sign Out"',
        'aria-label="Sign Out" onclick="fetch(\'/logout\')"',
      ));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${(address as { port: number }).port}/`);

    assert.deepEqual(
      await new PlaywrightSessionControlAdapter({ settleTimeoutMs: 50 }).logout(page as never),
      { kind: "signed_out" },
    );
    assert.equal(signedOut, true);
  } finally {
    await browser.close();
  }
});

test("waits for a delayed logout request before the one reload fallback", async (t) => {
  let signedOut = false;
  const server = createServer((request, response) => {
    if (request.url === "/logout") {
      setTimeout(() => {
        signedOut = true;
        response.end("ok");
      }, 100);
      return;
    }
    response.setHeader("content-type", "text/html");
    response.end(signedOut
      ? '<button data-automation-id="utilityButtonSignIn">Sign In</button>'
      : signedInMarkup().replace(
        'aria-label="Sign Out"',
        'aria-label="Sign Out" onclick="fetch(\'/logout\')"',
      ));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${(address as { port: number }).port}/`);

    assert.deepEqual(
      await new PlaywrightSessionControlAdapter({ settleTimeoutMs: 50 }).logout(page as never),
      { kind: "signed_out" },
    );
    assert.equal(signedOut, true);
  } finally {
    await browser.close();
  }
});

test("fails closed when the account menu contains duplicate Sign Out controls", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(signedInMarkup().replace(
      '<button role="menuitem" aria-label="Sign Out">Sign Out</button>',
      '<button role="menuitem" aria-label="Sign Out">Sign Out</button>' +
        '<button role="menuitem" aria-label="Sign Out">Sign Out</button>',
    ));

    await assert.rejects(
      new PlaywrightSessionControlAdapter().logout(page as never),
      /sign out control is ambiguous/u,
    );
  } finally {
    await browser.close();
  }
});

function signedInMarkup(): string {
  return `
    <div data-automation-id="utilityButtonAccountTasksMenu">
      <button id="accountSettingsButton" data-automation-id="utilityMenuButton"
        aria-haspopup="true" onclick="document.querySelector('[role=menu]').hidden=false">
        account@example.invalid
      </button>
    </div>
    <div role="menu" aria-labelledby="accountSettingsButton" hidden>
      <button role="menuitem" aria-label="Sign Out">Sign Out</button>
    </div>
  `;
}
