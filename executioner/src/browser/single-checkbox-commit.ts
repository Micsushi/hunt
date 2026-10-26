import type { Locator, Page } from "playwright";

const normalize = (value: string | null | undefined): string =>
  (value ?? "").normalize("NFC").replace(/\s+/gu, " ").trim();

interface SingleCheckboxTarget {
  readonly declaredToken: string;
  readonly name: string;
}

export async function commitSingleCheckbox(
  page: Page,
  target: SingleCheckboxTarget,
  checked: boolean,
  timeoutMs: number,
): Promise<"applied" | "ambiguous" | "invalid"> {
  const resolve = async (): Promise<Locator | "ambiguous" | undefined> => {
    const bound = page.locator(`[data-hunt-target-token="${target.declaredToken}"]`);
    const boundCount = await bound.count();
    if (boundCount === 1) return bound;
    if (boundCount > 1) return "ambiguous";

    const checkboxes = page.locator('input[type="checkbox"]');
    const matches = await checkboxes.evaluateAll((elements, expectedName) => {
      const visible = (element: Element): boolean => {
        if (!(element instanceof HTMLElement) || element.hidden ||
            element.getAttribute("aria-hidden") === "true") return false;
        const style = getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden" &&
          style.visibility !== "collapse" && element.getClientRects().length > 0;
      };
      const normalizedExpected = expectedName.normalize("NFC").replace(/\s+/gu, " ").trim();
      return elements.flatMap((element, index) => {
        if (!(element instanceof HTMLInputElement) || element.disabled) return [];
        const labels = [...(element.labels ?? [])];
        const exactVisibleLabel = labels.some((label) =>
          visible(label) &&
          (label.textContent ?? "").normalize("NFC").replace(/\s+/gu, " ").trim() ===
            normalizedExpected
        );
        return exactVisibleLabel ? [index] : [];
      });
    }, normalize(target.name));
    if (matches.length === 0) return undefined;
    if (matches.length > 1) return "ambiguous";
    return checkboxes.nth(matches[0]!);
  };

  const current = async (): Promise<boolean | "ambiguous" | undefined> => {
    const checkbox = await resolve();
    if (checkbox === undefined || checkbox === "ambiguous") return checkbox;
    try {
      return await checkbox.evaluate((element) => {
        if (element instanceof HTMLInputElement &&
            (element.type === "checkbox" || element.type === "radio")) return element.checked;
        if (element.getAttribute("role") === "checkbox") {
          const checked = element.getAttribute("aria-checked");
          return checked === "true" ? true : checked === "false" ? false : undefined;
        }
        return undefined;
      });
    } catch {
      return undefined;
    }
  };

  const waitForPersistentReadback = async (): Promise<boolean | "ambiguous"> => {
    const waitWindow = Math.max(100, Math.min(timeoutMs, 5_000));
    const stableWindow = Math.max(50, Math.min(waitWindow - 150, 4_300));
    const firstObserved = await current();
    if (firstObserved === "ambiguous") return "ambiguous";
    if (firstObserved !== checked) return false;
    const stableSince = performance.now();
    const deadline = stableSince + waitWindow;
    do {
      const observed = await current();
      if (observed === "ambiguous") return "ambiguous";
      if (observed !== checked) return false;
      if (performance.now() - stableSince >= stableWindow) return true;
      await page.waitForTimeout(Math.min(50, Math.max(1, deadline - performance.now())));
    } while (performance.now() < deadline);
    return await current() === checked && performance.now() - stableSince >= stableWindow;
  };

  const initial = await current();
  if (initial === "ambiguous") return "ambiguous";
  if (initial === checked) {
    const persistent = await waitForPersistentReadback();
    if (persistent === true) return "applied";
    if (persistent === "ambiguous") return "ambiguous";
  }

  const first = await resolve();
  if (first === "ambiguous") return "ambiguous";
  if (first === undefined) return "invalid";
  try {
    if (await first.evaluate((element) => element instanceof HTMLInputElement)) {
      await first.setChecked(checked, { timeout: Math.min(timeoutMs, 1_000) });
    } else {
      await first.click({ timeout: Math.min(timeoutMs, 1_000) });
    }
  } catch {
    // Reconcile the exact committed state before trying the native owner.
  }
  const trustedPersistent = await waitForPersistentReadback();
  if (trustedPersistent === true) return "applied";
  if (trustedPersistent === "ambiguous") return "ambiguous";

  const rebound = await resolve();
  if (rebound === "ambiguous") return "ambiguous";
  if (rebound === undefined) return "invalid";
  if (await current() === checked) {
    const reboundPersistent = await waitForPersistentReadback();
    if (reboundPersistent === true) return "applied";
    if (reboundPersistent === "ambiguous") return "ambiguous";
  }
  try {
    // Workday can visually cover the native input while React still delegates
    // its real change contract from that exact input. Native DOM click keeps
    // toggle-before-event ordering and remains idempotent after readback.
    await rebound.evaluate((element) => (element as HTMLInputElement).click());
  } catch {
    return "invalid";
  }
  const ownerPersistent = await waitForPersistentReadback();
  return ownerPersistent === true
    ? "applied"
    : ownerPersistent === "ambiguous" ? "ambiguous" : "invalid";
}
