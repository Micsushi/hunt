import type { Locator, Page } from "playwright";

import {
  profileRepeatableCatalog,
  profileScalarControlCatalog,
  type ProfileControlCatalogEntry,
  type ProfileRepeatableCatalogEntry,
} from "./catalog.ts";
import type {
  ProfileCommitRequest,
  ProfileControlSnapshot,
  ProfilePageSnapshot,
  ProfilePageType,
  ProfileRepeatableSection,
  ProfileRowSnapshot,
  WorkdayProfilePagePort,
} from "./types.ts";

interface ResolvedControl {
  readonly locator: Locator;
  readonly uiBehavior: ProfileControlSnapshot["uiBehavior"];
}

export interface PlaywrightWorkdayProfilePageOptions {
  readonly pageType: ProfilePageType;
  readonly timeoutMs?: number;
}

export class PlaywrightWorkdayProfilePage implements WorkdayProfilePagePort {
  readonly #page: Page;
  readonly #pageType: ProfilePageType;
  readonly #timeoutMs: number;
  readonly #controls = new Map<string, ResolvedControl>();

  constructor(page: Page, options: PlaywrightWorkdayProfilePageOptions) {
    this.#page = page;
    this.#pageType = options.pageType;
    this.#timeoutMs = options.timeoutMs ?? 5_000;
  }

  async inspect(signal: AbortSignal): Promise<ProfilePageSnapshot> {
    abort(signal);
    await this.#assertPageType();
    this.#controls.clear();
    const controls: ProfileControlSnapshot[] = [];
    for (const entry of profileScalarControlCatalog) {
      controls.push(...await this.#inspectControls(entry, this.#page.locator(entry.selector)));
    }
    const rows: ProfileRowSnapshot[] = [];
    for (const entry of profileRepeatableCatalog) {
      const section = this.#page.locator(entry.sectionSelector);
      const sections = await visibleLocators(section);
      if (sections.length > 1) throw new TypeError("ambiguous Workday repeatable section");
      if (sections.length === 0) continue;
      const candidates = await visibleLocators(sections[0]!.locator(entry.rowSelector));
      for (const row of candidates) rows.push(await this.#inspectRow(entry, row));
    }
    abort(signal);
    return { pageType: this.#pageType, controls, rows };
  }

  async commit(request: ProfileCommitRequest, signal: AbortSignal): Promise<void> {
    abort(signal);
    const resolved = this.#controls.get(request.controlId);
    if (resolved === undefined || resolved.uiBehavior !== request.uiBehavior) {
      throw new TypeError("profile control binding is stale or incompatible");
    }
    if (request.uiBehavior === "search_select") {
      await this.#selectSearchOption(resolved.locator, request.value);
    } else {
      await resolved.locator.fill(request.value, { timeout: this.#timeoutMs });
    }
    abort(signal);
  }

  async addOwnedRow(
    section: ProfileRepeatableSection,
    signal: AbortSignal,
  ): Promise<string> {
    abort(signal);
    const entry = repeatableEntry(section);
    const container = await exactVisible(this.#page.locator(entry.sectionSelector));
    const before = new Set(await this.#rowIds(entry, container));
    const add = await exactVisible(container.locator(entry.addSelector));
    await add.click({ timeout: this.#timeoutMs });
    const added = await this.#waitForAddedRow(entry, container, before);
    await added.evaluate((element) => {
      element.setAttribute("data-hunt-c3-owned", "true");
    });
    abort(signal);
    return await rowId(added);
  }

  async removeOwnedRow(
    section: ProfileRepeatableSection,
    rowIdentifier: string,
    signal: AbortSignal,
  ): Promise<void> {
    abort(signal);
    const entry = repeatableEntry(section);
    const container = await exactVisible(this.#page.locator(entry.sectionSelector));
    const row = await this.#findRow(entry, container, rowIdentifier);
    if (await row.getAttribute("data-hunt-c3-owned") !== "true") {
      throw new TypeError("foreign Workday row removal is forbidden");
    }
    const remove = await exactVisible(row.locator('[data-automation-id="delete"]'));
    await remove.click({ timeout: this.#timeoutMs });
    await row.waitFor({ state: "detached", timeout: this.#timeoutMs });
    abort(signal);
  }

  async #assertPageType(): Promise<void> {
    await exactVisible(this.#page.locator('[data-automation-id="applyFlowMyInfoPage"]'));
    const declared = await this.#page.locator("body").getAttribute(
      "data-hunt-profile-page-type",
    );
    if (declared !== null && declared !== this.#pageType) {
      throw new TypeError("Workday profile page type does not match the admitted handler");
    }
  }

  async #inspectControls(
    entry: ProfileControlCatalogEntry,
    locator: Locator,
    rowIdValue?: string,
  ): Promise<ProfileControlSnapshot[]> {
    const matches = await visibleLocators(locator);
    const snapshots: ProfileControlSnapshot[] = [];
    for (const [index, match] of matches.entries()) {
      const controlId = [rowIdValue ?? "scalar", entry.fieldId, index].join(":");
      this.#controls.set(controlId, { locator: match, uiBehavior: entry.uiBehavior });
      snapshots.push({
        controlId,
        fieldId: entry.fieldId,
        required: await required(match),
        uiBehavior: entry.uiBehavior,
        uiVariant: entry.uiVariant,
        readback: await readback(match, entry.uiBehavior),
      });
    }
    return snapshots;
  }

  async #inspectRow(
    entry: ProfileRepeatableCatalogEntry,
    row: Locator,
  ): Promise<ProfileRowSnapshot> {
    const identifier = await rowId(row);
    const controls: ProfileControlSnapshot[] = [];
    for (const field of entry.fields) {
      const locator = row.locator(`[data-automation-id$="--${field.suffix}"]`);
      controls.push(...await this.#inspectControls({
        fieldId: field.fieldId,
        selector: "",
        uiBehavior: field.uiBehavior,
        uiVariant: field.uiVariant,
      }, locator, identifier));
    }
    return {
      section: entry.section,
      rowId: identifier,
      ownedByC3: await row.getAttribute("data-hunt-c3-owned") === "true",
      controls,
    };
  }

  async #selectSearchOption(control: Locator, value: string): Promise<void> {
    await control.click({ timeout: this.#timeoutMs });
    await control.fill(value, { timeout: this.#timeoutMs });
    const relationship = await control.getAttribute("aria-controls") ??
      await control.getAttribute("aria-owns");
    if (relationship === null || relationship.trim().split(/\s+/u).length !== 1) {
      throw new TypeError("Workday listbox ownership is unavailable or ambiguous");
    }
    const listboxes = this.#page.locator(`#${cssIdentifier(relationship.trim())}`);
    const listbox = await exactVisible(listboxes);
    const option = await exactVisible(
      listbox.getByRole("option", { name: value, exact: true }),
    );
    await option.click({ timeout: this.#timeoutMs });
  }

  async #rowIds(
    entry: ProfileRepeatableCatalogEntry,
    container: Locator,
  ): Promise<string[]> {
    const rows = await visibleLocators(container.locator(entry.rowSelector));
    return await Promise.all(rows.map(rowId));
  }

  async #waitForAddedRow(
    entry: ProfileRepeatableCatalogEntry,
    container: Locator,
    before: ReadonlySet<string>,
  ): Promise<Locator> {
    const deadline = Date.now() + this.#timeoutMs;
    while (Date.now() < deadline) {
      const rows = await visibleLocators(container.locator(entry.rowSelector));
      const added: Locator[] = [];
      for (const row of rows) {
        if (!before.has(await rowId(row))) added.push(row);
      }
      if (added.length === 1) return added[0]!;
      if (added.length > 1) throw new TypeError("ambiguous added Workday row");
      await this.#page.waitForTimeout(25);
    }
    throw new TypeError("added Workday row did not become visible");
  }

  async #findRow(
    entry: ProfileRepeatableCatalogEntry,
    container: Locator,
    identifier: string,
  ): Promise<Locator> {
    const rows = await visibleLocators(container.locator(entry.rowSelector));
    const matches: Locator[] = [];
    for (const row of rows) {
      if (await rowId(row) === identifier) matches.push(row);
    }
    if (matches.length !== 1) throw new TypeError("Workday row binding is stale or ambiguous");
    return matches[0]!;
  }
}

async function readback(
  locator: Locator,
  behavior: ProfileControlSnapshot["uiBehavior"],
): Promise<string | null> {
  if (behavior !== "search_select") {
    const value = await locator.inputValue();
    return value === "" ? null : value;
  }
  const selected = (await locator.getAttribute("data-selected-label"))?.trim() ?? "";
  if (selected !== "") return selected;
  const field = locator.locator('xpath=ancestor::*[@data-automation-id][1]');
  const pills = await visibleLocators(field.locator('[data-automation-id="selectedItem"]'));
  if (pills.length !== 1) return null;
  const label = (await pills[0]!.innerText()).replace(/\s+/gu, " ").trim();
  return label === "" ? null : label;
}

async function required(locator: Locator): Promise<boolean> {
  return await locator.getAttribute("required") !== null ||
    await locator.getAttribute("aria-required") === "true";
}

async function visibleLocators(locator: Locator): Promise<Locator[]> {
  const matches: Locator[] = [];
  for (let index = 0; index < await locator.count(); index += 1) {
    const item = locator.nth(index);
    if (await item.isVisible()) matches.push(item);
  }
  return matches;
}

async function exactVisible(locator: Locator): Promise<Locator> {
  const matches = await visibleLocators(locator);
  if (matches.length !== 1) throw new TypeError("Workday control is missing or ambiguous");
  return matches[0]!;
}

async function rowId(row: Locator): Promise<string> {
  const value = await row.getAttribute("data-row-id") ??
    await row.getAttribute("data-automation-id") ?? "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) {
    throw new TypeError("Workday row identifier is unavailable");
  }
  return value;
}

function repeatableEntry(section: ProfileRepeatableSection): ProfileRepeatableCatalogEntry {
  const entry = profileRepeatableCatalog.find((item) => item.section === section);
  if (entry === undefined) throw new TypeError("unsupported Workday repeatable section");
  return entry;
}

function cssIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_-]{0,127}$/u.test(value)) {
    throw new TypeError("invalid Workday listbox identifier");
  }
  return value;
}

function abort(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Operation cancelled", "AbortError");
}
