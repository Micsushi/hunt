import type { Page, Frame } from 'playwright';
import { parseApplicationProfile } from '../profile/application-profile.ts';
import { fillVisibleFields } from '../../extension/generic-fill.js';

/** Same partial filler as the extension. Never advances or submits an application. */
export async function fillGenericIdentityFields(page: Page | Frame, profile: unknown, signal: AbortSignal) {
  signal.throwIfAborted();
  const url = new URL(page.url());
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new Error('Use an HTTPS application page.');
  const admitted = parseApplicationProfile(profile);
  const result = await page.evaluate(fillVisibleFields, { facts: admitted.facts, action: 'fill' as const });
  signal.throwIfAborted();
  return result;
}
