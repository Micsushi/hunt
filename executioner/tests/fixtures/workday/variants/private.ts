import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { chromium } from "playwright";

import { PlaywrightBrowserSession } from "../../../../src/browser/session.ts";
import type { BrowserObservation, BrowserPageId, BrowserSessionId } from "../../../../src/contracts/index.ts";
import { dataPage, testIds, testJourneyId } from "../../../browser/playwright-fixture.ts";

export interface FrozenVariantFixture {
  readonly fixtureId: string;
  readonly provingSlots: readonly string[];
  readonly semanticHash: string;
  readonly variantIds: readonly string[];
}

export function frozenVariantFixture(id: string): FrozenVariantFixture {
  const path = resolve(import.meta.dirname, `../../../../fixtures/workday/corpus/${id}.json`);
  return JSON.parse(readFileSync(path, "utf8")) as FrozenVariantFixture;
}

export async function openVariantPage(body: string, seed: string) {
  const engine = await chromium.launch();
  const context = await engine.newContext();
  const browser = new PlaywrightBrowserSession({ context, ids: testIds(seed) });
  const signal = new AbortController().signal;
  const started = await browser.start({ journeyId: testJourneyId, target: dataPage(body) }, signal);
  assert.equal(started.ok, true, JSON.stringify(started));
  if (!started.ok) throw new Error("variant page failed to start");
  const page = context.pages()[0];
  assert.ok(page !== undefined);
  return {
    browser,
    page,
    signal,
    sessionId: started.value.sessionId as BrowserSessionId,
    pageId: started.value.pageId as BrowserPageId,
    observe: async (): Promise<BrowserObservation> => {
      const result = await browser.observe(started.value, signal);
      assert.equal(result.ok, true, JSON.stringify(result));
      if (!result.ok) throw new Error("variant observation failed");
      return result.value;
    },
    close: async () => {
      await browser.close({ sessionId: started.value.sessionId }, signal);
      await context.close();
      await engine.close();
    },
  };
}
