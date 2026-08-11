import type { Locator, Page } from "playwright";

import {
  profileInteractiveControlSelector,
  profileRequiredControlSelector,
  profileRepeatableCatalog,
  profileScalarControlCatalog,
  type ProfileControlCatalogEntry,
  type ProfileRepeatableCatalogEntry,
} from "./catalog.ts";
import type {
  ProfileCommitRequest,
  ProfileControlSnapshot,
  ProfileInteractionSnapshot,
  ProfilePageSnapshot,
  ProfilePageType,
  ProfileRepeatableSection,
  ProfileRowSnapshot,
  WorkdayProfilePagePort,
} from "./types.ts";

interface ResolvedControl {
  readonly locator: Locator;
  readonly uiBehavior: ProfileControlSnapshot["uiBehavior"];
  readonly uiVariant: string;
}

interface MutableInteraction {
  popupBound: boolean | null;
  optionFocused: boolean | null;
  optionActivated: boolean | null;
  popupClosed: boolean | null;
  backingValueCommitted: boolean;
  validationCleared: boolean;
  visibleOptionCount: number | null;
  selectedOptionOrdinal: number | null;
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
  readonly #interactions = new Map<string, MutableInteraction>();
  readonly #unknownControlOrdinals = new Map<string, number>();
  #nextUnknownControlOrdinal = 1;

  constructor(page: Page, options: PlaywrightWorkdayProfilePageOptions) {
    this.#page = page;
    this.#pageType = options.pageType;
    this.#timeoutMs = options.timeoutMs ?? 5_000;
  }

  async inspect(signal: AbortSignal): Promise<ProfilePageSnapshot> {
    abort(signal);
    const profile = await this.#assertPageType();
    this.#controls.clear();
    const controls: ProfileControlSnapshot[] = [];
    for (const entry of profileScalarControlCatalog) {
      controls.push(...await this.#inspectControls(entry, profile.locator(entry.selector)));
    }
    const rows: ProfileRowSnapshot[] = [];
    for (const entry of profileRepeatableCatalog) {
      const section = profile.locator(entry.sectionSelector);
      const sections = await visibleLocators(section);
      if (sections.length > 1) throw new TypeError("ambiguous Workday repeatable section");
      if (sections.length === 0) continue;
      const candidates = await visibleLocators(sections[0]!.locator(entry.rowSelector));
      for (const row of candidates) rows.push(await this.#inspectRow(entry, row));
    }
    controls.push(...await this.#inspectUnknownControls(profile));
    abort(signal);
    return { pageType: this.#pageType, controls, rows };
  }

  async commit(request: ProfileCommitRequest, signal: AbortSignal): Promise<void> {
    abort(signal);
    const resolved = this.#controls.get(request.controlId);
    if (resolved === undefined || resolved.uiBehavior !== request.uiBehavior) {
      throw new TypeError("profile control binding is stale or incompatible");
    }
    const interaction = emptyInteraction(request.uiBehavior);
    this.#interactions.set(request.controlId, interaction);
    if (request.uiBehavior === "search_select") {
      await this.#selectSearchOption(
        resolved.locator,
        request.value,
        resolved.uiVariant,
        interaction,
      );
    } else if (request.uiBehavior === "radio_group") {
      await this.#selectRadioOption(resolved.locator, request.value, interaction);
    } else {
      await resolved.locator.fill(request.value, { timeout: this.#timeoutMs });
      await resolved.locator.blur({ timeout: this.#timeoutMs });
      await this.#page.waitForTimeout(25);
      interaction.backingValueCommitted = normalize(
        await readback(resolved.locator, request.uiBehavior) ?? "",
      ) === normalize(request.value);
      interaction.validationCleared = await validationCleared(resolved.locator);
      if (!interaction.backingValueCommitted || !interaction.validationCleared) {
        throw new TypeError("Workday profile value did not commit");
      }
    }
    abort(signal);
  }

  interaction(controlId: string): ProfileInteractionSnapshot | undefined {
    const interaction = this.#interactions.get(controlId);
    return interaction === undefined
      ? undefined
      : Object.freeze({ ...interaction });
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

  async #assertPageType(): Promise<Locator> {
    const profile = await exactVisible(
      this.#page.locator('[data-automation-id="applyFlowMyInfoPage"]'),
    );
    const declared = await this.#page.locator("body").getAttribute(
      "data-hunt-profile-page-type",
    );
    if (declared !== null && declared !== this.#pageType) {
      throw new TypeError("Workday profile page type does not match the admitted handler");
    }
    return profile;
  }

  async #inspectControls(
    entry: ProfileControlCatalogEntry,
    locator: Locator,
    rowIdValue?: string,
  ): Promise<ProfileControlSnapshot[]> {
    const matches = await visibleLocators(locator);
    if (entry.uiBehavior === "radio_group") {
      if (matches.length === 0) return [];
      const controlId = [rowIdValue ?? "scalar", entry.fieldId, 0].join(":");
      this.#controls.set(controlId, {
        locator,
        uiBehavior: entry.uiBehavior,
        uiVariant: entry.uiVariant,
      });
      return [{
        controlId,
        fieldId: entry.fieldId,
        required: (await Promise.all(matches.map(required))).some(Boolean),
        uiBehavior: entry.uiBehavior,
        uiVariant: entry.uiVariant,
        readback: await radioReadback(matches),
      }];
    }
    const snapshots: ProfileControlSnapshot[] = [];
    for (const [index, match] of matches.entries()) {
      const controlId = [rowIdValue ?? "scalar", entry.fieldId, index].join(":");
      this.#controls.set(controlId, {
        locator: match,
        uiBehavior: entry.uiBehavior,
        uiVariant: entry.uiVariant,
      });
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

  async #inspectUnknownControls(
    profile: Locator,
  ): Promise<ProfileControlSnapshot[]> {
    const candidates = await visibleLocators(
      profile.locator(`${profileInteractiveControlSelector}, ${profileRequiredControlSelector}`),
    );
    const catalog = {
      scalarSelectors: profileScalarControlCatalog.map(({ selector }) => selector),
      repeatables: profileRepeatableCatalog.map((entry) => ({
        sectionSelector: entry.sectionSelector,
        rowSelector: entry.rowSelector,
        suffixes: entry.fields.map(({ suffix }) => suffix),
      })),
    };
    const unreviewed: { readonly candidate: Locator; readonly machineKey: string | null }[] = [];
    for (const candidate of candidates) {
      if (await candidate.isDisabled()) continue;
      if (await candidate.evaluate((element) => element.matches(
        'input[type="file"][data-automation-id="file-upload-input-ref"]',
      ))) continue;
      const admitted = await candidate.evaluate((element, reviewed) => {
        if (reviewed.scalarSelectors.some((selector) => element.matches(selector))) {
          return true;
        }
        return reviewed.repeatables.some((entry) => {
          const section = element.closest(entry.sectionSelector);
          const row = element.closest(entry.rowSelector);
          return section !== null && row !== null && section.contains(row) &&
            entry.suffixes.some((suffix) =>
              element.matches(`[data-automation-id$="--${suffix}"]`)
            );
        });
      }, catalog);
      if (admitted) continue;
      unreviewed.push({ candidate, machineKey: await unknownMachineKey(candidate) });
    }
    const keyCounts = new Map<string, number>();
    for (const { machineKey } of unreviewed) {
      if (machineKey !== null) {
        keyCounts.set(machineKey, (keyCounts.get(machineKey) ?? 0) + 1);
      }
    }
    if (unreviewed.some(({ machineKey }) =>
      machineKey === null || keyCounts.get(machineKey) !== 1
    )) throw new TypeError("Workday unknown required control identity denied");
    const unknown: ProfileControlSnapshot[] = [];
    for (const { candidate, machineKey } of unreviewed) {
      const stableKey = machineKey as string;
      let ordinal = this.#unknownControlOrdinals.get(stableKey);
      if (ordinal === undefined) {
        ordinal = this.#nextUnknownControlOrdinal;
        this.#nextUnknownControlOrdinal += 1;
        this.#unknownControlOrdinals.set(stableKey, ordinal);
      }
      const isRequired = await required(candidate);
      unknown.push({
        controlId: `unknown-required:${ordinal}`,
        fieldId: `unknown.${isRequired ? "required" : "optional"}.${ordinal}`,
        required: isRequired,
        uiBehavior: await unknownUiBehavior(candidate),
        uiVariant: "workday_unknown_required_v1",
        readback: null,
      });
    }
    return unknown;
  }

  async #selectSearchOption(
    control: Locator,
    value: string,
    uiVariant: string,
    interaction: MutableInteraction,
  ): Promise<void> {
    await control.click({ timeout: this.#timeoutMs });
    if (await control.evaluate((element) =>
      (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) &&
      !element.readOnly
    )) await control.fill(value, { timeout: this.#timeoutMs });
    const relationship = await control.getAttribute("aria-controls") ??
      await control.getAttribute("aria-owns");
    if (relationship === null || relationship.trim().split(/\s+/u).length !== 1) {
      throw new TypeError("Workday listbox ownership is unavailable or ambiguous");
    }
    const listboxes = this.#page.locator(`#${cssIdentifier(relationship.trim())}`);
    const listbox = await this.#waitForExactVisible(listboxes);
    interaction.popupBound = true;
    const selected = await this.#waitForSelectableLeaf(listbox, value, uiVariant);
    interaction.visibleOptionCount = selected.visibleOptionCount;
    interaction.selectedOptionOrdinal = selected.selectedOptionOrdinal;
    interaction.optionFocused = await selected.option.evaluate((element) =>
      element.ownerDocument.activeElement === element
    );
    await selected.option.click({ timeout: this.#timeoutMs });
    interaction.optionActivated = true;
    await control.blur({ timeout: this.#timeoutMs });
    await this.#page.waitForTimeout(25);
    interaction.popupClosed = !await listbox.isVisible() &&
      await control.getAttribute("aria-expanded") !== "true";
    interaction.backingValueCommitted = normalize(
      await readback(control, "search_select") ?? "",
    ) === normalize(value);
    interaction.validationCleared = await validationCleared(control);
    if (!interaction.popupClosed) {
      throw new TypeError("Workday selection popup remained open");
    }
    if (!interaction.backingValueCommitted) {
      throw new TypeError("Workday selection backing value did not commit");
    }
    if (!interaction.validationCleared) {
      throw new TypeError("Workday selection validation did not clear");
    }
  }

  async #waitForExactVisible(locator: Locator): Promise<Locator> {
    const deadline = Date.now() + this.#timeoutMs;
    while (Date.now() < deadline) {
      const matches = await visibleLocators(locator);
      if (matches.length === 1) return matches[0]!;
      if (matches.length > 1) {
        throw new TypeError("Workday control is missing or ambiguous");
      }
      await this.#page.waitForTimeout(25);
    }
    throw new TypeError("Workday control is missing or ambiguous");
  }

  async #waitForSelectableLeaf(
    listbox: Locator,
    value: string,
    uiVariant: string,
  ): Promise<{
    readonly option: Locator;
    readonly visibleOptionCount: number;
    readonly selectedOptionOrdinal: number;
  }> {
    const deadline = Date.now() + this.#timeoutMs;
    while (Date.now() < deadline) {
      const candidates = await visibleLocators(listbox.getByRole("option"));
      const leaves: Locator[] = [];
      for (const option of candidates) {
        const automationId = await option.getAttribute("data-automation-id");
        if (
          (uiVariant === "workday_source_select_v1"
            ? automationId !== "promptLeafNode"
            : automationId === "promptCategory") ||
          await option.getAttribute("aria-disabled") === "true"
        ) continue;
        leaves.push(option);
      }
      if (leaves.length > 64) {
        throw new TypeError("Workday selectable leaf is missing or ambiguous");
      }
      const exact: { readonly option: Locator; readonly ordinal: number }[] = [];
      for (const [index, option] of leaves.entries()) {
        if (normalize(await option.innerText()) === normalize(value)) {
          exact.push({ option, ordinal: index + 1 });
        }
      }
      if (exact.length === 1) return {
        option: exact[0]!.option,
        visibleOptionCount: leaves.length,
        selectedOptionOrdinal: exact[0]!.ordinal,
      };
      if (exact.length > 1) {
        throw new TypeError("Workday selectable leaf is missing or ambiguous");
      }
      await this.#page.waitForTimeout(25);
    }
    throw new TypeError("Workday selectable leaf is missing or ambiguous");
  }

  async #selectRadioOption(
    controls: Locator,
    value: string,
    interaction: MutableInteraction,
  ): Promise<void> {
    const visible = await visibleLocators(controls);
    const matches: Locator[] = [];
    for (const radio of visible) {
      if (normalize(await radioOptionLabel(radio)) === normalize(value)) matches.push(radio);
    }
    if (matches.length !== 1) {
      throw new TypeError("Workday radio option is missing or ambiguous");
    }
    await matches[0]!.click({ timeout: this.#timeoutMs });
    interaction.optionActivated = true;
    interaction.visibleOptionCount = visible.length;
    interaction.selectedOptionOrdinal = visible.indexOf(matches[0]!) + 1;
    await matches[0]!.blur({ timeout: this.#timeoutMs });
    await this.#page.waitForTimeout(25);
    interaction.backingValueCommitted = normalize(
      await radioReadback(visible) ?? "",
    ) === normalize(value);
    interaction.validationCleared = await validationCleared(matches[0]!);
    if (!interaction.backingValueCommitted || !interaction.validationCleared) {
      throw new TypeError("Workday radio selection did not commit");
    }
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

async function unknownUiBehavior(
  locator: Locator,
): Promise<ProfileControlSnapshot["uiBehavior"]> {
  return await locator.evaluate((element) => {
    const role = element.getAttribute("role");
    if (role === "checkbox") return "checkbox";
    if (role === "radio" || role === "radiogroup") return "radio_group";
    if (
      element instanceof HTMLSelectElement || role === "combobox" ||
      element.getAttribute("aria-haspopup") === "listbox"
    ) return "search_select";
    if (element instanceof HTMLInputElement) {
      if (element.type === "checkbox") return "checkbox";
      if (element.type === "date" || element.type === "month") return "date";
      if (element.type === "file") return "file";
      if (element.type === "radio") return "radio_group";
      if (element.type === "tel") return "phone";
    }
    return "text";
  });
}

async function unknownMachineKey(locator: Locator): Promise<string | null> {
  return await locator.evaluate((element) => {
    const attributes = [
      element.getAttribute("data-automation-id"),
      element.id,
      element.getAttribute("name"),
      element.getAttribute("aria-controls"),
    ].filter((value): value is string => value !== null && value !== "");
    if (
      attributes.length === 0 ||
      attributes.some((value) => !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(value))
    ) return null;
    const type = element instanceof HTMLInputElement ? element.type : "element";
    return [element.tagName.toLowerCase(), type, ...attributes].join("\u0000");
  });
}

async function readback(
  locator: Locator,
  behavior: ProfileControlSnapshot["uiBehavior"],
): Promise<string | null> {
  if (behavior !== "search_select") {
    const value = await locator.inputValue();
    return value === "" ? null : value;
  }
  const ariaValue = (await locator.getAttribute("aria-valuetext"))?.trim() ?? "";
  if (ariaValue !== "") return ariaValue;
  const selected = (await locator.getAttribute("data-selected-label"))?.trim() ?? "";
  if (selected !== "") return selected;
  const field = locator.locator('xpath=ancestor::*[@data-automation-id][1]');
  const pills = await visibleLocators(field.locator('[data-automation-id="selectedItem"]'));
  if (pills.length !== 1) return null;
  const label = (await pills[0]!.innerText()).replace(/\s+/gu, " ").trim();
  return label === "" ? null : label;
}

async function radioReadback(radios: readonly Locator[]): Promise<string | null> {
  const checked: Locator[] = [];
  for (const radio of radios) {
    if (await radio.isChecked()) checked.push(radio);
  }
  return checked.length === 1 ? await radioOptionLabel(checked[0]!) : null;
}

async function radioOptionLabel(radio: Locator): Promise<string> {
  return await radio.evaluate((element) => {
    if (!(element instanceof HTMLInputElement)) return "";
    const label = element.labels?.length === 1
      ? element.labels[0]?.innerText ?? element.labels[0]?.textContent ?? ""
      : element.getAttribute("aria-label") ?? "";
    return label.replace(/\s+/gu, " ").trim();
  });
}

async function required(locator: Locator): Promise<boolean> {
  if (
    await locator.isDisabled() ||
    await locator.getAttribute("aria-disabled") === "true" ||
    await locator.evaluate((element) =>
      (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) &&
      element.readOnly
    )
  ) return false;
  const ariaLabel = (await locator.getAttribute("aria-label"))?.trim() ?? "";
  const accessibleRequired = /(?:^|\s)Required$/u.test(ariaLabel) &&
    !/(?:^|\s)Not Required$/u.test(ariaLabel);
  return await locator.getAttribute("required") !== null ||
    await locator.getAttribute("aria-required") === "true" ||
    accessibleRequired;
}

async function validationCleared(locator: Locator): Promise<boolean> {
  if (await locator.getAttribute("aria-invalid") === "true") return false;
  const field = locator.locator(
    'xpath=ancestor::*[@data-automation-id="formField"][1]',
  );
  const root = await field.count() === 1 ? field : locator;
  return (await visibleLocators(root.locator(
    '[data-automation-id="errorMessage"], [role="alert"]',
  ))).length === 0;
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

function normalize(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, " ").trim()
    .toLocaleLowerCase("en-US");
}

function emptyInteraction(
  behavior: ProfileControlSnapshot["uiBehavior"],
): MutableInteraction {
  const choice = behavior === "search_select" || behavior === "radio_group";
  const popup = behavior === "search_select";
  return {
    popupBound: popup ? false : null,
    optionFocused: popup ? false : null,
    optionActivated: choice ? false : null,
    popupClosed: popup ? false : null,
    backingValueCommitted: false,
    validationCleared: false,
    visibleOptionCount: choice ? 0 : null,
    selectedOptionOrdinal: choice ? 0 : null,
  };
}

function abort(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Operation cancelled", "AbortError");
}
