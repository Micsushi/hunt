import type { Locator, Page } from "playwright";

type BackingStatus = "uncontrolled" | "committed" | "uncommitted";

const parts = [
  ["dateSectionMonth", "dateSectionMonth-input"],
  ["dateSectionDay", "dateSectionDay-input"],
  ["dateSectionYear", "dateSectionYear-input"],
] as const;

export async function compositeDateBackingCommitted(
  owner: Locator,
  isoDate: string,
  timeoutMs = 750,
): Promise<boolean> {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(isoDate)) return false;
  const deadline = Date.now() + timeoutMs;
  do {
    const observation = await owner.evaluate((element, expectedIso) => {
      const acceptedString = (value: string): boolean => {
        const normalized = value.replace(
          /[\s\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/gu,
          "",
        );
        if (normalized === expectedIso) return true;
        const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/u.exec(normalized);
        return match !== null &&
          `${match[3]}-${match[1]!.padStart(2, "0")}-${match[2]!.padStart(2, "0")}` ===
            expectedIso;
      };
      const acceptedValue = (value: unknown): boolean => {
        if (typeof value === "string") return acceptedString(value);
        if (value instanceof Date && !Number.isNaN(value.valueOf())) {
          return value.toISOString().slice(0, 10) === expectedIso;
        }
        if (typeof value !== "object" || value === null) return false;
        const record = value as Record<string, unknown>;
        for (const key of ["value", "displayValue", "formattedValue", "dateValue"] as const) {
          if (typeof record[key] === "string" && acceptedString(record[key])) return true;
        }
        const year = Number(record.year ?? record.yyyy);
        const month = Number(record.month ?? record.mm);
        const day = Number(record.day ?? record.dd);
        return Number.isSafeInteger(year) && Number.isSafeInteger(month) &&
          Number.isSafeInteger(day) &&
          `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${
            String(day).padStart(2, "0")}` === expectedIso;
      };
      const records: Record<string, unknown>[] = [];
      const seen = new Set<object>();
      const nodes = [element, ...element.querySelectorAll("input")];
      for (const node of nodes) {
        const nodeRecord = node as unknown as Record<string, unknown>;
        for (const key of Object.keys(node).filter((name) => name.startsWith("__reactProps$"))) {
          const value = nodeRecord[key];
          if (typeof value === "object" && value !== null && !seen.has(value)) {
            seen.add(value);
            records.push(value as Record<string, unknown>);
          }
        }
        const fiberKey = Object.keys(node).find((name) => name.startsWith("__reactFiber$"));
        let fiber = fiberKey === undefined
          ? undefined
          : nodeRecord[fiberKey] as Record<string, unknown> | undefined;
        for (let depth = 0; fiber !== undefined && depth < 24 && !seen.has(fiber); depth += 1) {
          seen.add(fiber);
          for (const key of ["memoizedProps", "pendingProps"] as const) {
            const value = fiber[key];
            if (typeof value === "object" && value !== null && !seen.has(value)) {
              seen.add(value);
              records.push(value as Record<string, unknown>);
            }
          }
          const parent = fiber.return;
          fiber = typeof parent === "object" && parent !== null
            ? parent as Record<string, unknown>
            : undefined;
        }
      }
      const controlled = records.filter((record) =>
        Object.hasOwn(record, "value") && typeof record.onDatePicked === "function"
      );
      const status: BackingStatus = controlled.length === 0 ? "uncontrolled"
        : controlled.some((record) => acceptedValue(record.value)) ? "committed" : "uncommitted";
      return status;
    }, isoDate).catch(() => "uncommitted" as const);
    if (observation === "uncontrolled" || observation === "committed") return true;
    if (Date.now() < deadline) await owner.page().waitForTimeout(50);
  } while (Date.now() < deadline);
  return false;
}

export async function applyCompositeDateMutation(
  page: Page,
  owner: Locator,
  isoDate: string,
  timeoutMs: number,
): Promise<boolean> {
  const locators = parts.map(([legacyId, currentId]) => owner.locator(
    `[data-automation-id="${legacyId}"], [data-automation-id="${currentId}"]`,
  ));
  const editable = await Promise.all(locators.map(async (part) =>
    await part.count() === 1 && await part.isEditable()
  ));
  if (editable.some((value) => !value)) return false;
  const existing = await Promise.all(locators.map(part => part.inputValue()));
  const existingIso = `${existing[2]?.trim()}-${existing[0]?.trim().padStart(2, "0")}-${existing[1]?.trim().padStart(2, "0")}`;
  const boxes = await Promise.all(locators.map(part => part.boundingBox()));
  const directlyEditable = boxes.every(box => box !== null && box.width >= 1 && box.height >= 1);
  if (directlyEditable && existingIso === isoDate && await compositeDateBackingCommitted(owner, isoDate)) return true;
  // Some Workday tenants keep zero-sized segments behind a visible date picker.
  // Use that owned UI instead of trying to fill hidden inputs.
  if (directlyEditable) {
    const values = [isoDate.slice(5, 7), isoDate.slice(8, 10), isoDate.slice(0, 4)];
    try {
      for (const [index, part] of locators.entries()) {
        await part.fill(values[index]!, { timeout: timeoutMs });
      }
      await locators[2]!.blur({ timeout: timeoutMs });
    } catch {
      return false;
    }
    if (await compositeDateBackingCommitted(owner, isoDate)) return true;
  }
  if (!await openOwnedCalendar(owner, timeoutMs)) return false;
  // A tiny-input widget can display a local default that its form has not saved.
  // Changing the calendar selection first makes its change handler commit again.
  if (!directlyEditable && existingIso === isoDate) {
    const alternate = new Date(`${isoDate}T12:00:00.000Z`);
    alternate.setUTCDate(alternate.getUTCDate() === 1 ? 2 : alternate.getUTCDate() - 1);
    if (!await chooseCalendarDate(page, alternate.toISOString().slice(0, 10), timeoutMs)) return false;
    if (!await openOwnedCalendar(owner, timeoutMs)) return false;
  }
  if (!await chooseCalendarDate(page, isoDate, timeoutMs)) return false;
  return await compositeDateBackingCommitted(owner, isoDate);
}

async function openOwnedCalendar(owner: Locator, timeoutMs: number): Promise<boolean> {
  const field = owner.locator(
    "xpath=ancestor::*[@data-automation-id='formField' or " +
      "starts-with(@data-automation-id, 'formField-')][1]",
  );
  if (await field.count() !== 1) return false;
  const candidates = field.locator("button:visible, [role='button']:visible, [data-automation-id]:visible");
  const matches = await candidates.evaluateAll((elements) => elements.flatMap((element, index) => {
    const evidence = [
      element.getAttribute("aria-label") ?? "",
      element.getAttribute("data-automation-id") ?? "",
      ...[...element.querySelectorAll("[data-automation-id]")]
        .map((child) => child.getAttribute("data-automation-id") ?? ""),
    ].join(" ");
    return /(?:calendar|date[\s_-]*(?:picker|button|icon))/iu.test(evidence)
      ? [{ index, actionable: element.matches('button, [role="button"]') }] : [];
  }));
  const buttons = matches.filter(({ actionable }) => actionable);
  const preferred = buttons.length > 0 ? buttons : matches;
  if (preferred.length === 1) {
    const target = candidates.nth(preferred[0]!.index);
    await target.evaluate(element => element.scrollIntoView({
      block: "center", inline: "nearest", behavior: "instant",
    }));
    await target.click({ timeout: timeoutMs });
    return true;
  }
  if (buttons.length > 1) return false;
  const icons = field.locator("svg:visible");
  if (await icons.count() !== 1) return false;
  await icons.click({ timeout: timeoutMs });
  return true;
}

async function chooseCalendarDate(
  page: Page,
  isoDate: string,
  timeoutMs: number,
): Promise<boolean> {
  await page.waitForTimeout(50);
  const date = new Date(`${isoDate}T12:00:00`);
  const labels = [
    new Intl.DateTimeFormat("en-US", {
      weekday: "long", year: "numeric", month: "long", day: "numeric",
    }).format(date),
    new Intl.DateTimeFormat("en-US", {
      year: "numeric", month: "long", day: "numeric",
    }).format(date),
    new Intl.DateTimeFormat("en-GB", {
      weekday: "long", year: "numeric", month: "long", day: "numeric",
    }).format(date).replaceAll(",", ""),
    `${isoDate.slice(5, 7)}/${isoDate.slice(8, 10)}/${isoDate.slice(0, 4)}`,
    `${Number(isoDate.slice(5, 7))}/${Number(isoDate.slice(8, 10))}/${isoDate.slice(0, 4)}`,
  ];
  const picker = page.locator('[data-automation-id="datePicker"][role="application"]:visible');
  const pickerCount = await picker.count();
  if (pickerCount > 1 || pickerCount === 1 && !await navigateCalendarMonth(picker, date, timeoutMs)) return false;
  const surfaces = (pickerCount === 1 ? picker : page).locator(
    'button[aria-label]:visible, [role="button"][aria-label]:visible, ' +
      '[role="gridcell"][aria-label]:visible',
  );
  const matches = await surfaces.evaluateAll((elements, admitted) => elements.flatMap(
    (element, index) => admitted.includes((element.getAttribute("aria-label") ?? "")
      .replace(/\s+/gu, " ").trim().replace(/^(?:(?:Selected|Today)\s+)+/u, "")) ? [index] : [],
  ), labels);
  if (matches.length === 1) {
    await surfaces.nth(matches[0]!).click({ timeout: timeoutMs });
    return true;
  }
  const dialog = page.locator('[role="dialog"]:visible');
  if (await dialog.count() !== 1) return false;
  const monthYear = new Intl.DateTimeFormat("en-US", {
    month: "long", year: "numeric",
  }).format(date);
  if (!(await dialog.textContent() ?? "").replace(/\s+/gu, " ").includes(monthYear)) return false;
  const day = dialog.getByRole("button", {
    name: String(Number(isoDate.slice(8, 10))), exact: true,
  });
  if (await day.count() !== 1) return false;
  await day.click({ timeout: timeoutMs });
  return true;
}

async function navigateCalendarMonth(picker: Locator, date: Date, timeoutMs: number): Promise<boolean> {
  const header = picker.locator('[data-automation-id="monthPickerHeader"]');
  if (await header.count() !== 1) return false;
  const months = Array.from({ length: 12 }, (_, month) =>
    new Intl.DateTimeFormat("en-US", { month: "long" }).format(new Date(2000, month, 1))
  );
  const target = date.getFullYear() * 12 + date.getMonth();
  for (let step = 0; step <= 24; step += 1) {
    const label = (await header.innerText()).replace(/\s+/gu, " ").trim();
    const match = /^(\w+) (\d{4})$/u.exec(label);
    const month = match === null ? -1 : months.indexOf(match[1]!);
    if (match === null || month < 0) return false;
    const current = Number(match[2]) * 12 + month;
    if (current === target) return true;
    if (step === 24 || Math.abs(target - current) > 24 - step) return false;
    const delta = target > current ? 1 : -1;
    const next = current + delta;
    const button = header.getByRole("button", { name: delta > 0 ? "Next month" : "Previous month", exact: true });
    if (await button.count() !== 1 || !await button.isEnabled()) return false;
    await button.click({ timeout: timeoutMs });
    const expected = `${months[next % 12]} ${Math.floor(next / 12)}`;
    try {
      await header.filter({ hasText: new RegExp(`^\\s*${expected}\\s*$`, "u") })
        .waitFor({ state: "visible", timeout: Math.min(timeoutMs, 1500) });
    } catch { return false; }
  }
  return false;
}
