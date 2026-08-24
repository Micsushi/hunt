import { createHash } from "node:crypto";
import type { Locator, Page } from "playwright";

import {
  profileInteractiveControlSelector,
  profileRequiredControlSelector,
  profileRepeatableCatalog,
  profileScalarControlCatalog,
  type ProfileControlCatalogEntry,
  type ProfileRepeatableCatalogEntry,
} from "./catalog.ts";
import { retainedProfileTextSha256 } from "./catalog.ts";
import type {
  ProfileCommitRequest,
  ProfileControlSnapshot,
  ProfileControlObservation,
  ProfileInteractionSnapshot,
  ProfilePageSnapshot,
  ProfilePageType,
  ProfileInspectionFacts,
  ProfileRepeatableSection,
  ProfileRowSnapshot,
  WorkdayProfilePagePort,
} from "./types.ts";
import {
  createProfileInspectionFailure,
  profileInspectionFailureFromError,
} from "./inspection.ts";
import type { ProfileInspectionFailure } from "./types.ts";

interface ResolvedControl {
  readonly locator: Locator;
  readonly fieldId: string;
  readonly uiBehavior: ProfileControlSnapshot["uiBehavior"];
  readonly uiVariant: string;
  readonly binderStrategy: ProfileControlObservation["binderStrategy"];
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
  #selectionDiagnosticOrdinal = 0;
  readonly #unknownControlOrdinals = new Map<string, number>();
  readonly #ownedIndexedRows = new Set<string>();
  #inspectionFailure: ProfileInspectionFailure | undefined;
  #inspectionFacts: ProfileInspectionFacts | undefined;
  #nextUnknownControlOrdinal = 1;

  constructor(page: Page, options: PlaywrightWorkdayProfilePageOptions) {
    this.#page = page;
    this.#pageType = options.pageType;
    this.#timeoutMs = options.timeoutMs ?? 5_000;
  }

  async inspect(signal: AbortSignal): Promise<ProfilePageSnapshot> {
    abort(signal);
    this.#inspectionFailure = undefined;
    this.#inspectionFacts = await this.#captureInspectionFacts();
    let profile: Locator;
    try {
      profile = await this.#assertPageType();
    } catch (error) {
      throw this.#recordInspectionFailure(
        "unknown",
        ["profile_root"],
        ["profile.root"],
        [],
        error,
      );
    }
    this.#controls.clear();
    const controls: ProfileControlSnapshot[] = [];
    for (const entry of profileScalarControlCatalog) {
      try {
        controls.push(...await this.#inspectControls(entry, profile.locator(entry.selector)));
      } catch (error) {
        throw this.#recordInspectionFailure(
          "scalar",
          [entry.fieldId],
          ["profile.scalar"],
          [entry.selector],
          error,
        );
      }
    }
    const rows: ProfileRowSnapshot[] = [];
    const repeatableSections: ProfileRepeatableSection[] = [];
    for (const entry of profileRepeatableCatalog) {
      try {
        const section = profile.locator(entry.sectionSelector);
        const sections = await visibleLocators(section);
        if (sections.length > 1) throw new TypeError("ambiguous Workday repeatable section");
        if (sections.length === 0) {
          const indexed = await this.#inspectIndexedRows(entry, profile);
          if (indexed.length > 0) {
            repeatableSections.push(entry.section);
            rows.push(...indexed);
          }
          continue;
        }
        repeatableSections.push(entry.section);
        const candidates = await visibleLocators(sections[0]!.locator(entry.rowSelector));
        for (const row of candidates) rows.push(await this.#inspectRow(entry, row));
      } catch (error) {
        throw this.#recordInspectionFailure(
          "repeatable",
          [entry.section],
          [`profile.repeatable.${entry.section}`],
          [entry.sectionSelector, entry.rowSelector],
          error,
        );
      }
    }
    try {
      controls.push(...await this.#inspectUnknownControls(profile));
    } catch (error) {
      throw this.#recordInspectionFailure(
        "unknown_controls",
        ["unknown_controls"],
        ["profile.unknown_controls"],
        [profileInteractiveControlSelector],
        error,
      );
    }
    abort(signal);
    return { pageType: this.#pageType, controls, rows, repeatableSections };
  }

  inspectionFailure(): ProfileInspectionFailure | undefined {
    return this.#inspectionFailure;
  }

  inspectionFacts(): ProfileInspectionFacts | undefined {
    return this.#inspectionFacts;
  }

  #recordInspectionFailure(
    phase: "scalar" | "repeatable" | "unknown_controls" | "unknown",
    bindingIds: readonly string[],
    bindingPaths: readonly string[],
    digestInputs: readonly string[],
    error: unknown,
  ): Error {
    const wrapped = createProfileInspectionFailure(
      error,
      phase,
      bindingIds,
      bindingPaths,
      digestInputs,
      retainedProfileTextSha256,
      this.#inspectionFacts,
    );
    this.#inspectionFailure = profileInspectionFailureFromError(wrapped);
    return wrapped;
  }

  async #captureInspectionFacts(): Promise<ProfileInspectionFacts> {
    const rootSelector = [
      '[data-automation-id="applyFlowMyInfoPage"]',
      '[data-automation-id="applyFlowMyExperiencePage"]',
      '[data-automation-id="applyFlowMyExpPage"]',
    ].join(", ");
    const ownerSelector = '[data-automation-id="formField"], [data-automation-id^="formField-"]';
    const controlSelector = [
      profileInteractiveControlSelector,
      profileRequiredControlSelector,
    ].join(", ");
    const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
    try {
      const frames = this.#page.frames();
      const frameFacts: {
        readonly identityDigest: string;
        readonly domOwnerCandidateCount: number;
        readonly controlCandidateCount: number;
        readonly ownerControlRelationshipDigest: string;
        readonly ownerControlTupleDigests: readonly string[];
        readonly identities: readonly { readonly control: string; readonly semantic: string }[];
        readonly rootCandidateCount: number;
        readonly rootVisibleCount: number;
      }[] = [];
      for (const [frameIndex, frame] of frames.slice(0, 32).entries()) {
        const roots = frame.locator(rootSelector);
        const rootCandidateCount = await roots.count();
        const rootVisibleCount = (await visibleLocators(roots)).length;
        const domOwners = frame.locator(ownerSelector);
        const controls = frame.locator(controlSelector);
        const domOwnerCandidateCount = await domOwners.count();
        const controlCandidateCount = await controls.count();
        const identities = await controls.evaluateAll((elements) => elements.slice(0, 128).map((element) => ({
          control: element.id || element.getAttribute("name") || "missing",
          semantic: element.getAttribute("data-automation-id") || element.getAttribute("role") || "missing",
        })));
        const ownerControlTuples = await domOwners.evaluateAll((elements, selector) => {
          const identity = (element: Element, semantic: boolean): string => [
            element.tagName.toLowerCase(),
            element.id,
            element.getAttribute("name") ?? "",
            element.getAttribute("data-automation-id") ?? "",
            element.getAttribute("role") ?? "",
            semantic ? element.getAttribute("aria-haspopup") ?? "" : "",
          ].join("\u0000");
          return elements.slice(0, 64).flatMap((owner, ownerOrdinal) =>
            [...owner.querySelectorAll(selector)].slice(0, 64).map((control, controlOrdinal) => ({
              ownerOrdinal,
              controlOrdinal,
              ownerIdentity: identity(owner, false),
              controlIdentity: identity(control, false),
              semanticIdentity: identity(control, true),
            }))
          );
        }, controlSelector);
        const ownerControlTupleDigests = ownerControlTuples.map((tuple) => digest(JSON.stringify({
          frameIndex,
          ownerOrdinal: tuple.ownerOrdinal,
          controlOrdinal: tuple.controlOrdinal,
          ownerIdentityDigest: digest(tuple.ownerIdentity),
          controlIdentityDigest: digest(tuple.controlIdentity),
          semanticIdentityDigest: digest(tuple.semanticIdentity),
        })));
        const relationship = { frameIndex, ownerControlTupleDigests };
        frameFacts.push({
          identityDigest: digest(JSON.stringify({ rootCandidateCount, rootVisibleCount, ...relationship })),
          domOwnerCandidateCount,
          controlCandidateCount,
          ownerControlRelationshipDigest: digest(JSON.stringify(relationship)),
          ownerControlTupleDigests,
          identities,
          rootCandidateCount,
          rootVisibleCount,
        });
      }
      const frameCount = frames.length;
      const rootCandidateCount = frameFacts.reduce((count, facts) => count + facts.rootCandidateCount, 0);
      const rootVisibleCount = frameFacts.reduce((count, facts) => count + facts.rootVisibleCount, 0);
      const domOwnerCandidateCount = frameFacts.reduce(
        (count, facts) => count + facts.domOwnerCandidateCount,
        0,
      );
      const controlCandidateCount = frameFacts.reduce(
        (count, facts) => count + facts.controlCandidateCount,
        0,
      );
      const identities = frameFacts.flatMap(({ identities: frameIdentities }) => frameIdentities);
      const controlIdDigests = identities.map(({ control }) => digest(control));
      const semanticIdDigests = identities.map(({ semantic }) => digest(semantic));
      const frameIdentityDigests = frameFacts.map(({ identityDigest }) => identityDigest);
      const frameDomOwnerCandidateCounts = frameFacts.map(({ domOwnerCandidateCount: count }) => count);
      const frameControlCandidateCounts = frameFacts.map(({ controlCandidateCount: count }) => count);
      const frameOwnerControlRelationshipDigests = frameFacts.map(
        ({ ownerControlRelationshipDigest }) => ownerControlRelationshipDigest,
      );
      const frameOwnerControlTupleDigests = frameFacts.flatMap(
        ({ ownerControlTupleDigests: digests }) => digests,
      ).slice(0, 64);
      const structure = JSON.stringify({
        frameCount,
        frameIdentityDigests,
        frameDomOwnerCandidateCounts,
        frameControlCandidateCounts,
        frameOwnerControlRelationshipDigests,
        frameOwnerControlTupleDigests,
        rootCandidateCount,
        rootVisibleCount,
        domOwnerCandidateCount,
        controlCandidateCount,
        controlIdDigests,
        semanticIdDigests,
      });
      const structuralIdentityDigest = digest(structure);
      return Object.freeze({
        frameCount,
        frameIdentityDigests: Object.freeze(frameIdentityDigests),
        frameDomOwnerCandidateCounts: Object.freeze(frameDomOwnerCandidateCounts),
        frameControlCandidateCounts: Object.freeze(frameControlCandidateCounts),
        frameOwnerControlRelationshipDigests: Object.freeze(frameOwnerControlRelationshipDigests),
        frameOwnerControlTupleDigests: Object.freeze(frameOwnerControlTupleDigests),
        structuralIdentityDigest,
        profileRootCandidateCount: rootCandidateCount,
        profileRootVisibleCount: rootVisibleCount,
        domOwnerCandidateCount,
        controlCandidateCount,
        controlIdDigests: Object.freeze(controlIdDigests),
        semanticIdDigests: Object.freeze(semanticIdDigests),
        bindingDigest: digest(JSON.stringify({ structuralIdentityDigest, controlIdDigests, semanticIdDigests })),
        profilePortState: "inspecting" as const,
      });
    } catch {
      const structuralIdentityDigest = digest("profile-inspection-facts-unavailable");
      return Object.freeze({
        frameCount: 0,
        frameIdentityDigests: Object.freeze([]),
        frameDomOwnerCandidateCounts: Object.freeze([]),
        frameControlCandidateCounts: Object.freeze([]),
        frameOwnerControlRelationshipDigests: Object.freeze([]),
        frameOwnerControlTupleDigests: Object.freeze([]),
        structuralIdentityDigest,
        profileRootCandidateCount: 0,
        profileRootVisibleCount: 0,
        domOwnerCandidateCount: 0,
        controlCandidateCount: 0,
        controlIdDigests: Object.freeze([]),
        semanticIdDigests: Object.freeze([]),
        bindingDigest: digest(structuralIdentityDigest),
        profilePortState: "unknown" as const,
      });
    }
  }

  async observeControl(
    controlId: string,
    signal: AbortSignal,
    inspectInteractiveOptions = true,
  ): Promise<ProfileControlObservation> {
    abort(signal);
    const resolved = this.#controls.get(controlId);
    if (resolved === undefined) throw new TypeError("profile control observation binding unavailable");
    const controls = await visibleLocators(resolved.locator);
    if (controls.length === 0) throw new TypeError("profile control observation target unavailable");
    const before = await resolvedReadback(resolved);
    const validationBefore = (await Promise.all(controls.map(validationCleared))).every(Boolean);
    const label = await observedControlLabel(controls[0]!, resolved.uiBehavior);
    const optionLabels = await this.#observeOptionLabels(
      resolved,
      controls,
      // Workday derives this prefilled value from Country; opening its input is
      // not a read-only observation and can wait forever on a non-editable field.
      inspectInteractiveOptions && resolved.fieldId !== "phone.country_code",
    );
    const after = await resolvedReadback(resolved);
    const validationAfter = (await Promise.all(controls.map(validationCleared))).every(Boolean);
    if (before !== after || validationBefore !== validationAfter) {
      throw new TypeError("profile control observation changed backing state");
    }
    const visibleOptionIds = Object.freeze(optionLabels.map(optionId));
    const selected = before === null ? null : optionId(before);
    abort(signal);
    return Object.freeze({
      controlId,
      binderStrategy: resolved.binderStrategy,
      sanitizedLabelSha256: label === null ? null : retainedProfileTextSha256(label),
      backingState: before === null ? "unset" : "set",
      validationState: validationAfter ? "clear" : "invalid",
      optionCatalogState: isChoice(resolved.uiBehavior)
        ? visibleOptionIds.length === 0 ? "unknown" : "observed"
        : "not_applicable",
      visibleOptionIds,
      selectedOptionId: selected !== null && visibleOptionIds.includes(selected) ? selected : null,
    });
  }

  async #observeOptionLabels(
    resolved: ResolvedControl,
    controls: readonly Locator[],
    inspectInteractiveOptions: boolean,
  ): Promise<string[]> {
    if (!isChoice(resolved.uiBehavior)) return [];
    if (resolved.uiBehavior === "radio_group") {
      return uniqueObservedOptions(await Promise.all(controls.map(radioOptionLabel)));
    }
    const control = controls[0]!;
    if (await control.evaluate((element) => element instanceof HTMLSelectElement)) {
      return uniqueObservedOptions(await control.evaluate((element) =>
        element instanceof HTMLSelectElement
          ? [...element.options].filter((option) => !option.disabled)
            .map((option) => option.label || option.textContent || "")
          : []
      ));
    }
    if (!inspectInteractiveOptions) return [];
    const before = await resolvedReadback(resolved);
    const validationBefore = await validationCleared(control);
    await control.focus({ timeout: this.#timeoutMs });
    await control.click({ timeout: this.#timeoutMs });
    await this.#page.waitForTimeout(25);
    let labels: string[] = [];
    try {
      const owner = await exactObservedOptionOwner(this.#page, control);
      if (owner !== undefined) {
        const options = await visibleLocators(owner.locator([
          '[role="option"]',
          '[data-automation-id="promptOption"]',
          '[data-automation-id="promptLeafNode"]',
        ].join(", ")));
        labels = uniqueObservedOptions(await Promise.all(options.slice(0, 64).map((option) =>
          option.innerText()
        )));
      }
    } finally {
      await this.#page.keyboard.press("Escape");
      await control.blur({ timeout: this.#timeoutMs });
      await this.#page.waitForTimeout(25);
      if (before !== await resolvedReadback(resolved) ||
          validationBefore !== await validationCleared(control)) {
        throw new TypeError("profile option observation changed backing state");
      }
    }
    return labels;
  }

  async commit(request: ProfileCommitRequest, signal: AbortSignal): Promise<void> {
    abort(signal);
    const resolved = this.#controls.get(request.controlId);
    if (resolved === undefined || resolved.uiBehavior !== request.uiBehavior) {
      throw new TypeError("profile control binding is stale or incompatible");
    }
    const interaction = emptyInteraction(request.uiBehavior);
    this.#interactions.set(request.controlId, interaction);
    try {
    if (request.uiBehavior === "multi_select") {
      const options = parseOptionList(request.value);
      for (const option of options) {
        if (await selectionReadbackIncludes(resolved.locator, "multi_select", option)) continue;
        await this.#selectSearchOption(resolved.locator, option, interaction, "multi_select");
      }
      interaction.backingValueCommitted = exactOptionListReadback(
        await readback(resolved.locator, "multi_select"),
        options,
      );
      interaction.validationCleared = await validationCleared(resolved.locator);
      if (!interaction.backingValueCommitted || !interaction.validationCleared) {
        throw new TypeError("Workday multi-select value did not commit");
      }
    } else if (request.uiBehavior === "search_select" || request.uiBehavior === "select") {
      if (
        request.uiBehavior === "select" &&
        await resolved.locator.evaluate((element) => element instanceof HTMLSelectElement)
      ) {
        await this.#selectNativeOption(resolved.locator, request.value, interaction);
      } else {
        await this.#selectSearchOption(resolved.locator, request.value, interaction, request.uiBehavior);
      }
    } else if (request.uiBehavior === "radio_group") {
      await this.#selectRadioOption(resolved.locator, request.value, interaction);
    } else if (request.uiBehavior === "checkbox") {
      const checked = request.value === "true";
      if (request.value !== "true" && request.value !== "false") {
        throw new TypeError("Workday checkbox value is invalid");
      }
      if (await resolved.locator.isChecked() !== checked) {
        await resolved.locator.click({ timeout: this.#timeoutMs });
      }
      await resolved.locator.blur({ timeout: this.#timeoutMs });
      await this.#page.waitForTimeout(25);
      interaction.backingValueCommitted = await resolved.locator.isChecked() === checked;
      interaction.validationCleared = await validationCleared(resolved.locator);
      if (!interaction.backingValueCommitted || !interaction.validationCleared) {
        throw new TypeError("Workday checkbox value did not commit");
      }
    } else {
      await resolved.locator.fill(request.value, { timeout: this.#timeoutMs });
      await resolved.locator.blur({ timeout: this.#timeoutMs });
      await this.#page.waitForTimeout(25);
      interaction.backingValueCommitted = scalarReadbackMatches(
        request.uiBehavior,
        await readback(resolved.locator, request.uiBehavior),
        request.value,
      );
      interaction.validationCleared = await validationCleared(resolved.locator);
      if (!interaction.backingValueCommitted || !interaction.validationCleared) {
        throw new TypeError("Workday profile value did not commit");
      }
    }
    } catch (error) {
      if (
        request.uiBehavior === "multi_select" ||
        request.uiBehavior === "search_select" || request.uiBehavior === "select"
      ) {
        await this.#resetFailedSelection(resolved.locator);
      }
      throw error;
    }
    abort(signal);
  }

  async #resetFailedSelection(control: Locator): Promise<void> {
    try {
      await this.#page.keyboard.press("Escape");
      const editable = await control.evaluate((element) =>
        (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) &&
        !element.readOnly
      );
      if (editable) {
        await control.fill("", { timeout: this.#timeoutMs });
        if (!await validationCleared(control)) {
          // A Workday prompt can clear its visible draft before preserving the
          // invalid state. Force a real controlled-input transition so React
          // clears that stale optional validation before page navigation.
          await control.fill(" ", { timeout: this.#timeoutMs });
          await control.fill("", { timeout: this.#timeoutMs });
        }
      }
      await this.#page.keyboard.press("Escape");
      await control.blur({ timeout: this.#timeoutMs });
      await this.#page.waitForTimeout(100);
    } catch {}
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
    const containers = await visibleLocators(this.#page.locator(entry.sectionSelector));
    if (containers.length === 0 && (section === "experience" || section === "education")) {
      const before = new Set(await this.#indexedRowIds(entry));
      const buttons = await visibleLocators(this.#page.getByRole("button", {
        name: "Add Another",
        exact: true,
      }));
      if (buttons.length !== 2) throw new TypeError("Workday indexed repeatable action is ambiguous");
      await buttons[section === "experience" ? 0 : 1]!.click({ timeout: this.#timeoutMs });
      const deadline = Date.now() + this.#timeoutMs;
      while (Date.now() < deadline) {
        const added = (await this.#indexedRowIds(entry)).filter((rowId) => !before.has(rowId));
        if (added.length === 1) {
          this.#ownedIndexedRows.add(added[0]!);
          return added[0]!;
        }
        if (added.length > 1) throw new TypeError("ambiguous indexed Workday row addition");
        await this.#page.waitForTimeout(25);
      }
      throw new TypeError("indexed Workday row did not become visible");
    }
    if (containers.length !== 1) throw new TypeError("ambiguous Workday repeatable section");
    const container = containers[0]!;
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
    if (this.#ownedIndexedRows.has(rowIdentifier)) {
      throw new TypeError("indexed Workday row removal is not yet admitted");
    }
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
      this.#page.locator([
        '[data-automation-id="applyFlowMyInfoPage"]',
        '[data-automation-id="applyFlowMyExperiencePage"]',
        '[data-automation-id="applyFlowMyExpPage"]',
      ].join(", ")),
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
        fieldId: entry.fieldId,
        uiBehavior: entry.uiBehavior,
        uiVariant: entry.uiVariant,
        binderStrategy: "catalog_selector_exact",
      });
      return [{
        controlId,
        fieldId: entry.fieldId,
        required: (await Promise.all(matches.map((match) =>
          required(match, "radiogroup")
        ))).some(Boolean),
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
        fieldId: entry.fieldId,
        uiBehavior: entry.uiBehavior,
        uiVariant: entry.uiVariant,
        binderStrategy: "catalog_selector_exact",
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

  async #inspectIndexedRows(
    entry: ProfileRepeatableCatalogEntry,
    profile: Locator,
  ): Promise<ProfileRowSnapshot[]> {
    if (entry.section !== "experience" && entry.section !== "education") return [];
    const prefix = entry.section === "experience" ? "workExperience-" : "education-";
    const rowIds = await this.#indexedRowIds(entry);
    const rows: ProfileRowSnapshot[] = [];
    for (const identifier of rowIds) {
      const controls: ProfileControlSnapshot[] = [];
      for (const field of entry.fields) {
        if (field.indexed === false) continue;
        controls.push(...await this.#inspectControls({
          fieldId: field.fieldId,
          selector: "",
          uiBehavior: field.uiBehavior,
          uiVariant: field.uiVariant,
        }, profile.locator(`[id="${identifier}--${field.suffix}"]`), identifier));
      }
      rows.push({
        section: entry.section,
        rowId: identifier,
        ownedByC3: this.#ownedIndexedRows.has(identifier),
        controls,
      });
    }
    return rows.filter(({ rowId }) => rowId.startsWith(prefix));
  }

  async #indexedRowIds(entry: ProfileRepeatableCatalogEntry): Promise<string[]> {
    if (entry.section !== "experience" && entry.section !== "education") return [];
    const prefix = entry.section === "experience" ? "workExperience-" : "education-";
    const ids = await this.#page.locator(`[id^="${prefix}"][id*="--"]`).evaluateAll((elements) =>
      elements.flatMap((element) => {
        const split = element.id.indexOf("--");
        return split > 0 ? [element.id.slice(0, split)] : [];
      })
    );
    return [...new Set(ids)].sort();
  }

  async #inspectUnknownControls(
    profile: Locator,
  ): Promise<ProfileControlSnapshot[]> {
    const candidates = await visibleLocators(
      profile.locator(`${profileInteractiveControlSelector}, ${profileRequiredControlSelector}`),
    );
    const catalog = {
      scalarSelectors: profileScalarControlCatalog.map(({ selector }) => selector),
      radioGroupSelectors: profileScalarControlCatalog
        .filter(({ uiBehavior }) => uiBehavior === "radio_group")
        .map(({ selector }) => selector),
      repeatables: profileRepeatableCatalog.map((entry) => ({
        sectionSelector: entry.sectionSelector,
        rowSelector: entry.rowSelector,
        idPrefix: entry.section === "experience" ? "workExperience-" :
          entry.section === "education" ? "education-" :
          entry.section === "skills" ? "skills-" : "website-",
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
        if (element.matches([
          "input:not([type]):not([id]):not([name]):not([data-automation-id])",
          ":not([role]):not([placeholder]):not([aria-label])",
        ].join(""))) {
          const country = element.closest('[data-automation-id="formField-country"]');
          if (country !== null && country.querySelector(
            'button[id="country--country"][role="combobox"], ' +
            'button[id="country--country"][aria-haspopup="listbox"]',
          ) !== null) return true;
        }
        if (
          element.getAttribute("role") === "radiogroup" &&
          reviewed.radioGroupSelectors.some((selector) =>
            element.querySelector(selector) !== null
          )
        ) return true;
        return reviewed.repeatables.some((entry) => {
          if (element.id.startsWith(entry.idPrefix) && entry.suffixes.some((suffix) =>
            element.id.endsWith(`--${suffix}`)
          )) return true;
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
    if (process.env.HUNT_C3_VALUE_FREE_ACCOUNT_TRACE === "1" && unreviewed.length > 0) {
      try {
        const diagnostics = await Promise.all(unreviewed.map(async ({ candidate, machineKey }) =>
          await candidate.evaluate((element, key) => {
            const labels = element instanceof HTMLInputElement ||
                element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement
              ? [...element.labels ?? []].map((label) => label.textContent ?? "")
              : [];
            const ownerAutomationIds: string[] = [];
            let owner = element.parentElement;
            while (owner !== null && ownerAutomationIds.length < 6) {
              const automationId = owner.getAttribute("data-automation-id");
              if (automationId !== null && automationId !== "") ownerAutomationIds.push(automationId);
              owner = owner.parentElement;
            }
            const bounded = (value: string | null): string =>
              (value ?? "").normalize("NFC").replace(/\s+/gu, " ").trim().slice(0, 160);
            return {
              machineKey: key,
              id: bounded(element.id),
              name: bounded(element.getAttribute("name")),
              automationId: bounded(element.getAttribute("data-automation-id")),
              tag: element.tagName.toLocaleLowerCase("en-US"),
              inputType: element instanceof HTMLInputElement ? element.type : "",
              typeAttribute: bounded(element.getAttribute("type")),
              role: bounded(element.getAttribute("role")),
              placeholder: bounded(element.getAttribute("placeholder")),
              className: bounded(element.getAttribute("class")),
              ariaHidden: bounded(element.getAttribute("aria-hidden")),
              ariaControls: bounded(element.getAttribute("aria-controls")),
              tabIndex: element instanceof HTMLElement ? element.tabIndex : null,
              clientWidth: element instanceof HTMLElement ? element.clientWidth : null,
              clientHeight: element instanceof HTMLElement ? element.clientHeight : null,
              label: bounded([
                element.getAttribute("aria-label") ?? "",
                ...labels,
              ].join(" ")),
              ownerAutomationIds,
              ownerControls: [...(element.closest('[data-automation-id^="formField-"]')
                ?.querySelectorAll("input, button, select, textarea") ?? [])]
                .slice(0, 12)
                .map((control) => ({
                  tag: control.tagName.toLocaleLowerCase("en-US"),
                  id: bounded(control.id),
                  automationId: bounded(control.getAttribute("data-automation-id")),
                  type: bounded(control.getAttribute("type")),
                  role: bounded(control.getAttribute("role")),
                  ariaHidden: bounded(control.getAttribute("aria-hidden")),
                  tabIndex: control instanceof HTMLElement ? control.tabIndex : null,
                })),
            };
          }, machineKey)
        ));
        process.stderr.write(`${JSON.stringify({ applicationUnknownProfileControlDiagnostics: diagnostics })}\n`);
      } catch {}
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
      this.#controls.set(`unknown-required:${ordinal}`, {
        locator: candidate,
        fieldId: unknown[unknown.length - 1]!.fieldId,
        uiBehavior: unknown[unknown.length - 1]!.uiBehavior,
        uiVariant: "workday_unknown_required_v1",
        binderStrategy: "opaque_machine_key",
      });
    }
    return unknown;
  }

  async #selectSearchOption(
    control: Locator,
    value: string,
    interaction: MutableInteraction,
    behavior: "search_select" | "select" | "multi_select",
  ): Promise<void> {
    await control.click({ timeout: this.#timeoutMs });
    await this.#captureSelectionDiagnostic("clicked", behavior);
    const editable = await control.evaluate((element) =>
      (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) &&
      !element.readOnly
    );
    if (editable) await control.fill(value, { timeout: this.#timeoutMs });
    await this.#captureSelectionDiagnostic("typed", behavior);
    if (editable && behavior === "multi_select") {
      await control.press("Enter", { timeout: this.#timeoutMs });
      await this.#page.waitForTimeout(250);
      await this.#captureSelectionDiagnostic("search-submitted", behavior);
      if (await selectionReadbackIncludes(control, behavior, value)) {
        interaction.popupBound = false;
        interaction.optionFocused = false;
        interaction.optionActivated = true;
        interaction.popupClosed = await control.getAttribute("aria-expanded") !== "true";
        interaction.visibleOptionCount = 0;
        interaction.selectedOptionOrdinal = 0;
        interaction.backingValueCommitted = true;
        interaction.validationCleared = await validationCleared(control);
        if (!interaction.validationCleared) {
          throw new TypeError("Workday submitted multi-select validation did not clear");
        }
        return;
      }
      if (await this.#selectSubmittedMultiSelectOption(control, value, interaction)) return;
    }
    const relationship = await control.getAttribute("aria-controls") ??
      await control.getAttribute("aria-owns");
    selectionDiagnostic("relationship_observed", behavior, {
      relationshipCount: relationship?.trim().split(/\s+/u).filter(Boolean).length ?? 0,
      editable,
    });
    const relationshipIds = relationship?.trim().split(/\s+/u).filter(Boolean) ?? [];
    if (relationshipIds.length > 1) {
      throw new TypeError("Workday listbox ownership is unavailable or ambiguous");
    }
    const fallbackScope = relationshipIds.length === 0;
    if (fallbackScope) {
      const field = control.locator(
        'xpath=ancestor::*[starts-with(@data-automation-id,"formField")][1]',
      );
      if (process.env.HUNT_C3_VALUE_FREE_ACCOUNT_TRACE === "1") {
        try {
          const structures = await field.locator(
            'button, [role="button"], [data-automation-id], svg',
          ).evaluateAll((elements) => elements.slice(0, 64).map((element) => ({
            tag: element.tagName.toLocaleLowerCase("en-US"),
            automationId: element.getAttribute("data-automation-id") ?? "",
            role: element.getAttribute("role") ?? "",
            ariaLabel: (element.getAttribute("aria-label") ?? "").slice(0, 80),
            visible: getComputedStyle(element).display !== "none" &&
              getComputedStyle(element).visibility !== "hidden" &&
              element.getClientRects().length > 0,
          })));
          process.stderr.write(`${JSON.stringify({
            profileSelectionOwnedStructures: structures,
          })}\n`);
        } catch {}
      }
      if (behavior === "select") {
        const scope = await field.count() === 1 ? field : this.#page.locator("body");
        const selected = await this.#waitForSelectableLeaf(scope, value);
        await this.#captureSelectionDiagnostic("option-found", behavior);
        interaction.popupBound = false;
        interaction.visibleOptionCount = selected.visibleOptionCount;
        interaction.selectedOptionOrdinal = selected.selectedOptionOrdinal;
        interaction.optionFocused = await selected.option.evaluate((element) =>
          element.ownerDocument.activeElement === element
        );
        await selected.option.click({ timeout: this.#timeoutMs });
        interaction.optionActivated = true;
        await control.blur({ timeout: this.#timeoutMs });
        await this.#page.waitForTimeout(25);
        interaction.popupClosed = await control.getAttribute("aria-expanded") !== "true";
        interaction.backingValueCommitted = await selectionReadbackIncludes(
          control,
          behavior,
          value,
        );
        interaction.validationCleared = await validationCleared(control);
        if (
          !interaction.popupClosed || !interaction.backingValueCommitted ||
          !interaction.validationCleared
        ) throw new TypeError("Workday unowned select value did not commit");
        return;
      }
      if (behavior === "multi_select" || behavior === "search_select") {
        if (editable) {
          await control.fill("", { timeout: this.#timeoutMs });
          await control.click({ timeout: this.#timeoutMs });
          await this.#page.waitForTimeout(100);
          if (await this.#selectPromptCatalogOption(
            control,
            value,
            interaction,
            behavior,
          )) return;
        }
        const promptWrappers = await visibleLocators(field.locator(
          '[data-automation-id="responsiveMonikerPrompt"]',
        ));
        const searchButtons = await visibleLocators(field.locator(
          '[data-automation-id="promptSearchButton"]',
        ));
        const activators = promptWrappers.length === 1 ? promptWrappers : searchButtons;
        if (activators.length === 1) {
          const activator = activators[0]!;
          const glyphs = await visibleLocators(activator.locator("svg"));
          if (glyphs.length > 1) {
            throw new TypeError("Workday prompt multi-select glyph is ambiguous");
          }
          if (glyphs.length === 1) {
            const target = await glyphs[0]!.evaluate((glyph) => {
              const rect = glyph.getBoundingClientRect();
              const x = rect.left + rect.width / 2;
              const y = rect.top + rect.height / 2;
              const hit = document.elementFromPoint(x, y);
              return rect.width > 0 && rect.height > 0 &&
                  hit !== null && (hit === glyph || glyph.contains(hit))
                ? { x, y }
                : null;
            });
            if (target === null) {
              throw new TypeError("Workday prompt multi-select glyph is not actionable");
            }
            await this.#page.mouse.click(target.x, target.y);
          } else {
            await activator.click({ timeout: this.#timeoutMs });
          }
          await this.#page.waitForTimeout(100);
          await this.#captureSelectionDiagnostic("prompt-requested", behavior);
          const promptSearches = await visibleLocators(field.locator(
            'input[data-automation-id="searchBox"], textarea[data-automation-id="searchBox"]',
          ));
          if (promptSearches.length > 1) {
            throw new TypeError("Workday prompt search input is ambiguous");
          }
          const promptSearch = promptSearches[0] ?? control;
          if (editable) {
            await promptSearch.fill("", { timeout: this.#timeoutMs });
            await promptSearch.pressSequentially(value, {
              delay: 10,
              timeout: this.#timeoutMs,
            });
            await this.#page.waitForTimeout(500);
            await this.#captureSelectionDiagnostic("prompt-typed", behavior);
          }
          const promptOptions = await visibleLocators(this.#page.locator([
            '[role="option"]',
            '[data-automation-id="promptOption"]',
            '[data-automation-id="promptLeafNode"]',
          ].join(", ")));
          const exactPromptOptions: Locator[] = [];
          for (const option of promptOptions.slice(0, 64)) {
            if (normalize(await option.innerText()) === normalize(value)) {
              exactPromptOptions.push(option);
            }
          }
          if (exactPromptOptions.length > 1) {
            throw new TypeError("Workday prompt multi-select option is ambiguous");
          }
          const selected = exactPromptOptions.length === 1
            ? {
                option: exactPromptOptions[0]!,
                visibleOptionCount: promptOptions.length,
                selectedOptionOrdinal: promptOptions.indexOf(exactPromptOptions[0]!) + 1,
              }
            : undefined;
          if (selected === undefined) {
            const delimiters = ["Enter", "Tab", ","] as const;
            for (const [index, delimiter] of delimiters.entries()) {
              if (index > 0) {
                await promptSearch.click({ timeout: this.#timeoutMs });
                await promptSearch.fill("", { timeout: this.#timeoutMs });
                await promptSearch.pressSequentially(value, {
                  delay: 10,
                  timeout: this.#timeoutMs,
                });
              }
              if (delimiter === ",") {
                await promptSearch.pressSequentially(delimiter, {
                  timeout: this.#timeoutMs,
                });
              } else {
                await promptSearch.press(delimiter, { timeout: this.#timeoutMs });
              }
              await this.#page.waitForTimeout(250);
              await this.#captureSelectionDiagnostic(
                `prompt-delimiter-${delimiter.toLocaleLowerCase("en-US")}`,
                behavior,
              );
              if (await selectionReadbackIncludes(control, behavior, value)) {
                interaction.popupBound = false;
                interaction.visibleOptionCount = 0;
                interaction.selectedOptionOrdinal = 0;
                interaction.optionFocused = false;
                interaction.optionActivated = true;
                interaction.popupClosed = true;
                interaction.backingValueCommitted = true;
                interaction.validationCleared = await validationCleared(control);
                if (!interaction.validationCleared) {
                  throw new TypeError("Workday prompt free-entry validation did not clear");
                }
                return;
              }
            }
            throw new TypeError("Workday prompt multi-select option is unavailable");
          }
          interaction.popupBound = false;
          interaction.visibleOptionCount = selected.visibleOptionCount;
          interaction.selectedOptionOrdinal = selected.selectedOptionOrdinal;
          interaction.optionFocused = await selected.option.evaluate((element) =>
            element.ownerDocument.activeElement === element
          );
          await selected.option.click({ timeout: this.#timeoutMs });
          interaction.optionActivated = true;
          await this.#page.waitForTimeout(100);
          interaction.popupClosed = true;
          interaction.backingValueCommitted = await selectionReadbackIncludes(
            control,
            behavior,
            value,
          );
          interaction.validationCleared = await validationCleared(control);
          if (!interaction.backingValueCommitted || !interaction.validationCleared) {
            throw new TypeError("Workday prompt multi-select value did not commit");
          }
          return;
        }
        if (activators.length > 1) {
          throw new TypeError("Workday prompt multi-select activator is ambiguous");
        }
      }
      if (editable) {
        await control.fill("", { timeout: this.#timeoutMs });
        await control.pressSequentially(value, { delay: 10, timeout: this.#timeoutMs });
      }
      await control.focus({ timeout: this.#timeoutMs });
      await control.press("Enter", { timeout: this.#timeoutMs });
      await this.#page.waitForTimeout(250);
      await this.#captureSelectionDiagnostic("free-entry-committed", behavior);
      interaction.popupBound = false;
      interaction.optionFocused = false;
      interaction.optionActivated = true;
      interaction.popupClosed = true;
      interaction.visibleOptionCount = 0;
      interaction.selectedOptionOrdinal = 0;
      interaction.backingValueCommitted = await selectionReadbackIncludes(
        control,
        behavior,
        value,
      );
      interaction.validationCleared = await validationCleared(control);
      if (!interaction.backingValueCommitted || !interaction.validationCleared) {
        throw new TypeError(
          "Workday listbox ownership is unavailable and free-entry selection did not commit",
        );
      }
      return;
    }
    const listbox = await this.#waitForExactVisible(
      this.#page.locator(`#${cssIdentifier(relationshipIds[0]!)}`),
    );
    if (process.env.HUNT_C3_VALUE_FREE_ACCOUNT_TRACE === "1") {
      try {
        const candidates = await listbox.locator("*").evaluateAll((elements) =>
          elements.flatMap((element) => {
            const style = getComputedStyle(element);
            if (
              style.display === "none" || style.visibility === "hidden" ||
              element.getClientRects().length === 0
            ) return [];
            const text = (element.textContent ?? "").normalize("NFC")
              .replace(/\s+/gu, " ").trim();
            if (text === "" || [...element.children].some((child) =>
              (child.textContent ?? "").normalize("NFC").replace(/\s+/gu, " ").trim() === text
            )) return [];
            return [{
              tag: element.tagName.toLocaleLowerCase("en-US"),
              role: element.getAttribute("role") ?? "",
              automationId: element.getAttribute("data-automation-id") ?? "",
              text: text.slice(0, 160),
            }];
          }).slice(0, 64)
        );
        process.stderr.write(`${JSON.stringify({
          profileSelectionVisibleLeafDiagnostics: {
            relationshipId: relationshipIds[0],
            candidates,
          },
        })}\n`);
      } catch {}
    }
    const expandedCategories = new Set<string>();
    interaction.popupBound = true;
    if (
      await control.getAttribute("id") === "phoneNumber--phoneType" &&
      !await hasExactSelectableCandidate(listbox, value)
    ) {
      await this.#selectV2PhoneType(control, listbox, value, interaction);
      return;
    }
    try {
      const selected = await this.#waitForSelectableLeaf(
        listbox,
        value,
        expandedCategories,
        !fallbackScope,
      );
      await this.#captureSelectionDiagnostic("option-found", behavior);
      interaction.visibleOptionCount = selected.visibleOptionCount;
      interaction.selectedOptionOrdinal = selected.selectedOptionOrdinal;
      interaction.optionFocused = await selected.option.evaluate((element) =>
        element.ownerDocument.activeElement === element
      );
      await selected.option.click({ timeout: this.#timeoutMs });
      interaction.optionActivated = true;
    } catch {
      // `fill` has already entered the query for editable Workday comboboxes.
      // Re-typing appended the same query (for example `PythonPython`) and made
      // an otherwise valid typeahead result impossible to match exactly.
      if (editable) await control.fill(value, { timeout: this.#timeoutMs });
      else await this.#page.keyboard.type(value);
      await this.#page.waitForTimeout(100);
      await this.#captureSelectionDiagnostic("fallback-typed", behavior);
      const activeId = await control.getAttribute("aria-activedescendant") ??
        await listbox.getAttribute("aria-activedescendant");
      interaction.optionFocused = activeId !== null;
      const revealed = await this.#waitForSelectableLeaf(
        listbox,
        value,
        expandedCategories,
        !fallbackScope,
      )
        .catch(() => undefined);
      const active = activeId === null
        ? undefined
        : await exactActiveOption(this.#page, activeId, value);
      if (revealed !== undefined) {
        interaction.visibleOptionCount = revealed.visibleOptionCount;
        interaction.selectedOptionOrdinal = revealed.selectedOptionOrdinal;
        await revealed.option.click({ timeout: this.#timeoutMs });
      } else if (active === undefined) {
        await this.#page.keyboard.press("Enter");
      } else {
        await active.click({ timeout: this.#timeoutMs });
      }
      interaction.optionActivated = true;
      await this.#page.waitForTimeout(100);
      if (
        !await selectionReadbackIncludes(control, behavior, value) &&
        await selectionPopupVisible(listbox, fallbackScope)
      ) {
        const nested = await this.#waitForSelectableLeaf(
          listbox,
          value,
          expandedCategories,
          !fallbackScope,
        )
          .catch(() => undefined);
        if (nested !== undefined) {
          interaction.visibleOptionCount = nested.visibleOptionCount;
          interaction.selectedOptionOrdinal = nested.selectedOptionOrdinal;
          await nested.option.click({ timeout: this.#timeoutMs });
          await this.#page.waitForTimeout(100);
        }
      }
      if (!await selectionReadbackIncludes(control, behavior, value)) {
        selectionDiagnostic("selection_uncommitted", behavior, {
          listboxVisible: await selectionPopupVisible(listbox, fallbackScope),
          activeDescendantPresent: activeId !== null,
        });
        throw new TypeError("Workday selectable leaf is missing or ambiguous");
      }
    }
    await control.blur({ timeout: this.#timeoutMs });
    await this.#page.waitForTimeout(25);
    const closeDeadline = Date.now() + Math.min(this.#timeoutMs, 1_000);
    while (
      Date.now() < closeDeadline &&
      (await selectionPopupVisible(listbox, fallbackScope) ||
        await control.getAttribute("aria-expanded") === "true")
    ) {
      // Workday leaves focus on the selected listbox option. A locator-local
      // press can retarget focus to the combobox and fail to dismiss the popup.
      await this.#page.keyboard.press("Escape");
      await this.#page.waitForTimeout(100);
    }
    interaction.popupClosed = !await selectionPopupVisible(listbox, fallbackScope) &&
      await control.getAttribute("aria-expanded") !== "true";
    interaction.backingValueCommitted = await selectionReadbackIncludes(control, behavior, value);
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

  async #selectSubmittedMultiSelectOption(
    control: Locator,
    value: string,
    interaction: MutableInteraction,
  ): Promise<boolean> {
    const acceptedLabels = equivalentOptionLabels(value);
    const visibleOptions = await visibleLocators(this.#page.locator('[role="option"]'));
    const exact: Locator[] = [];
    for (const option of visibleOptions.slice(0, 128)) {
      if (acceptedLabels.has(normalize(await option.innerText()))) exact.push(option);
    }
    if (exact.length === 0) return false;
    if (exact.length > 1) {
      throw new TypeError("Workday submitted multi-select option is ambiguous");
    }

    const option = exact[0]!;
    const inputs = await visibleLocators(option.locator(
      'input[type="radio"], [role="radio"], input[type="checkbox"], [role="checkbox"]',
    ));
    if (inputs.length > 1) {
      throw new TypeError("Workday submitted multi-select option control is ambiguous");
    }
    interaction.popupBound = false;
    interaction.visibleOptionCount = visibleOptions.length;
    interaction.selectedOptionOrdinal = visibleOptions.indexOf(option) + 1;
    interaction.optionFocused = await option.getAttribute("aria-selected") === "true";
    await (inputs[0] ?? option).click({ timeout: this.#timeoutMs });
    interaction.optionActivated = true;
    await this.#page.waitForTimeout(100);
    await this.#page.keyboard.press("Escape");
    await this.#page.waitForTimeout(25);
    interaction.popupClosed = await control.getAttribute("aria-expanded") !== "true";
    interaction.backingValueCommitted = await selectionReadbackIncludes(
      control,
      "multi_select",
      value,
    );
    interaction.validationCleared = await validationCleared(control);
    if (!interaction.backingValueCommitted || !interaction.validationCleared) {
      throw new TypeError("Workday submitted multi-select option did not commit");
    }
    return true;
  }

  async #selectPromptCatalogOption(
    control: Locator,
    value: string,
    interaction: MutableInteraction,
    behavior: "search_select" | "multi_select",
  ): Promise<boolean> {
    const options = this.#page.locator('[role="option"]:visible');
    const initial = await visibleLocators(options);
    const scopes: Locator[] = [];
    for (const option of initial) {
      if (/^(?:partial list \(first 500 entries\)|all)$/u.test(normalize(await option.innerText()))) {
        scopes.push(option);
      }
    }
    if (scopes.length === 0) return false;
    const all = await exactNormalizedOption(scopes, "All");
    await all.click({ timeout: this.#timeoutMs });
    await this.#page.waitForTimeout(100);
    await control.click({ timeout: this.#timeoutMs });
    await this.#page.waitForTimeout(100);

    const acceptedLabels = equivalentOptionLabels(value);
    let visibleOptionCount = 0;
    for (let ordinal = 1; ordinal <= 2048; ordinal += 1) {
      const candidates: Locator[] = [];
      for (const option of await visibleLocators(options)) {
        const label = normalize(await option.innerText());
        if (!/^(?:partial list \(first 500 entries\)|all)$/u.test(label)) {
          candidates.push(option);
        }
      }
      visibleOptionCount = Math.max(visibleOptionCount, candidates.length);
      const exact: Locator[] = [];
      for (const option of candidates) {
        if (acceptedLabels.has(normalize(await option.innerText()))) exact.push(option);
      }
      if (exact.length > 1) {
        throw new TypeError("Workday prompt catalog option is ambiguous");
      }
      if (exact.length === 1) {
        const option = exact[0]!;
        interaction.popupBound = false;
        interaction.visibleOptionCount = visibleOptionCount;
        interaction.selectedOptionOrdinal = ordinal;
        interaction.optionFocused = await option.getAttribute("aria-selected") === "true";
        const radios = await visibleLocators(option.locator(
          'input[type="radio"], [role="radio"]',
        ));
        if (radios.length > 1) {
          throw new TypeError("Workday prompt catalog radio is ambiguous");
        }
        await (radios[0] ?? option).click({ timeout: this.#timeoutMs });
        interaction.optionActivated = true;
        await this.#page.waitForTimeout(100);
        interaction.popupClosed = (await visibleLocators(options)).length === 0;
        interaction.backingValueCommitted = await selectionReadbackIncludes(
          control,
          behavior,
          value,
        );
        interaction.validationCleared = await validationCleared(control);
        if (!interaction.backingValueCommitted || !interaction.validationCleared) {
          throw new TypeError("Workday prompt catalog value did not commit");
        }
        return true;
      }
      await control.press("ArrowDown", { timeout: this.#timeoutMs });
      if (ordinal % 32 === 0) await this.#page.waitForTimeout(25);
    }
    throw new TypeError("Workday prompt catalog option is unavailable");
  }

  async #selectNativeOption(
    control: Locator,
    value: string,
    interaction: MutableInteraction,
  ): Promise<void> {
    const options = await control.evaluate((element) => {
      if (!(element instanceof HTMLSelectElement)) return null;
      return [...element.options].map((option, index) => ({
        index,
        label: (option.label || option.textContent || "").replace(/\s+/gu, " ").trim(),
        disabled: option.disabled,
      }));
    });
    if (options === null) throw new TypeError("Workday native select is unavailable");
    const matches = options.filter((option) =>
      !option.disabled && normalize(option.label) === normalize(value)
    );
    if (matches.length !== 1) {
      throw new TypeError("Workday native select option is missing or ambiguous");
    }
    await control.selectOption({ index: matches[0]!.index }, { timeout: this.#timeoutMs });
    await control.blur({ timeout: this.#timeoutMs });
    await this.#page.waitForTimeout(25);
    interaction.popupBound = false;
    interaction.optionFocused = false;
    interaction.optionActivated = true;
    interaction.popupClosed = true;
    interaction.visibleOptionCount = options.filter(({ disabled }) => !disabled).length;
    interaction.selectedOptionOrdinal = matches[0]!.index + 1;
    interaction.backingValueCommitted = await selectionReadbackIncludes(control, "select", value);
    interaction.validationCleared = await validationCleared(control);
    if (!interaction.backingValueCommitted || !interaction.validationCleared) {
      throw new TypeError("Workday native select value did not commit");
    }
  }

  async #captureSelectionDiagnostic(
    stage: string,
    behavior: "search_select" | "select" | "multi_select",
  ): Promise<void> {
    if (process.env.HUNT_C3_VALUE_FREE_ACCOUNT_TRACE !== "1") return;
    selectionDiagnostic(stage, behavior, {});
    const root = process.env.HUNT_C3_TRANSIENT_DIAGNOSTIC_ROOT;
    if (root === undefined || root === "") return;
    this.#selectionDiagnosticOrdinal += 1;
    try {
      await this.#page.screenshot({
        path: `${root}\\profile-selection-${String(this.#selectionDiagnosticOrdinal).padStart(3, "0")}-${stage}.png`,
        fullPage: true,
      });
    } catch {
      selectionDiagnostic("screenshot_failed", "multi_select", {});
    }
  }

  async #selectV2PhoneType(
    control: Locator,
    listbox: Locator,
    value: string,
    interaction: MutableInteraction,
  ): Promise<void> {
    const selectionValue = await phoneDeviceTypeSelectionValue(listbox, value);
    await this.#page.keyboard.type(selectionValue);
    await this.#page.waitForTimeout(100);
    const activeId = await control.getAttribute("aria-activedescendant") ??
      await listbox.getAttribute("aria-activedescendant");
    interaction.optionFocused = activeId !== null;
    const active = activeId === null
      ? undefined
      : await exactActiveOption(this.#page, activeId, selectionValue);
    if (await hasExactSelectableCandidate(listbox, selectionValue)) {
      const selected = await this.#waitForSelectableLeaf(listbox, selectionValue);
      interaction.visibleOptionCount = selected.visibleOptionCount;
      interaction.selectedOptionOrdinal = selected.selectedOptionOrdinal;
      await selected.option.click({ timeout: this.#timeoutMs });
    } else if (active !== undefined) {
      await active.click({ timeout: this.#timeoutMs });
    } else {
      await this.#page.keyboard.press("Enter");
    }
    interaction.optionActivated = true;
    await this.#page.waitForTimeout(100);
    for (const key of ["Enter", "Space"] as const) {
      if (normalize(await readback(control, "search_select") ?? "") === normalize(selectionValue)) {
        break;
      }
      await this.#page.keyboard.press(key);
      await this.#page.waitForTimeout(100);
    }
    if (
      normalize(await readback(control, "search_select") ?? "") !== normalize(selectionValue) &&
      await listbox.isVisible() && await hasExactSelectableCandidate(listbox, selectionValue)
    ) {
      const nested = await this.#waitForSelectableLeaf(listbox, selectionValue);
      interaction.visibleOptionCount = nested.visibleOptionCount;
      interaction.selectedOptionOrdinal = nested.selectedOptionOrdinal;
      await nested.option.click({ timeout: this.#timeoutMs });
      await this.#page.waitForTimeout(100);
    }
    await control.blur({ timeout: this.#timeoutMs });
    await this.#page.waitForTimeout(25);
    const closeDeadline = Date.now() + Math.min(this.#timeoutMs, 1_000);
    while (
      Date.now() < closeDeadline &&
      (await listbox.isVisible() || await control.getAttribute("aria-expanded") === "true")
    ) {
      await this.#page.keyboard.press("Escape");
      await this.#page.waitForTimeout(100);
    }
    interaction.popupClosed = !await listbox.isVisible() &&
      await control.getAttribute("aria-expanded") !== "true";
    interaction.backingValueCommitted = normalize(
      await readback(control, "search_select") ?? "",
    ) === normalize(selectionValue);
    interaction.validationCleared = await validationCleared(control);
    if (
      !interaction.popupClosed || !interaction.backingValueCommitted ||
      !interaction.validationCleared
    ) throw new TypeError("Workday selection did not commit");
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
    expandedCategories = new Set<string>(),
    allowTextLeaves = true,
  ): Promise<{
    readonly option: Locator;
    readonly visibleOptionCount: number;
    readonly selectedOptionOrdinal: number;
  }> {
    const deadline = Date.now() + this.#timeoutMs;
    while (Date.now() < deadline) {
      const pool = listbox.locator([
        '[role="option"]:visible',
        '[data-automation-id="promptOption"]:visible',
        '[data-automation-id="promptLeafNode"]:visible',
      ].join(", "));
      const candidates = await selectableCandidateSnapshot(pool);
      const leaves: Locator[] = [];
      const categories: Locator[] = [];
      const leafLabels: (readonly string[])[] = [];
      for (const candidate of candidates) {
        const option = pool.nth(candidate.index);
        if (candidate.automationId === "promptCategory") {
          categories.push(option);
          continue;
        }
        leaves.push(option);
        leafLabels.push(candidate.labels);
      }
      if (leaves.length > 64) {
        throw new TypeError("Workday selectable leaf is missing or ambiguous");
      }
      const exact: { readonly option: Locator; readonly ordinal: number }[] = [];
      for (const [index, labels] of leafLabels.entries()) {
        if (labels.some((label) => equivalentOption(label, value))) {
          exact.push({ option: leaves[index]!, ordinal: index + 1 });
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
      const textLeaves = allowTextLeaves
        ? await exactVisibleTextLeaves(listbox, value)
        : [];
      if (textLeaves.length === 1) return {
        option: textLeaves[0]!,
        visibleOptionCount: Math.max(leaves.length, textLeaves.length),
        selectedOptionOrdinal: 1,
      };
      if (textLeaves.length > 1) {
        throw new TypeError("Workday selectable leaf is missing or ambiguous");
      }
      const category = await expandableCategory(categories, value, expandedCategories);
      if (category !== undefined) {
        expandedCategories.add(category.key);
        await category.option.click({ timeout: this.#timeoutMs });
        await this.#page.waitForTimeout(25);
        continue;
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

async function expandableCategory(
  categories: readonly Locator[],
  value: string,
  expanded: ReadonlySet<string>,
): Promise<{ readonly key: string; readonly option: Locator } | undefined> {
  const available: { readonly key: string; readonly label: string; readonly option: Locator }[] = [];
  for (const option of categories) {
    const label = normalize(await option.innerText());
    const key = [
      await option.getAttribute("id") ?? "",
      await option.getAttribute("data-value") ?? "",
      label,
    ].join("\u0000");
    if (!expanded.has(key)) available.push({ key, label, option });
  }
  if (available.length > 16) {
    throw new TypeError("Workday selectable category is missing or ambiguous");
  }
  const target = normalize(value);
  const related = available.filter(({ label }) =>
    target === label || target.startsWith(`${label}:`)
  );
  const matches = related.length === 0 && available.length === 1 ? available : related;
  if (matches.length !== 1) return undefined;
  return { key: matches[0]!.key, option: matches[0]!.option };
}

async function exactVisibleTextLeaves(listbox: Locator, value: string): Promise<Locator[]> {
  const descendants = listbox.locator("*");
  const indexes = await descendants.evaluateAll((elements, accepted) => {
    const normalizeText = (text: string | null): string =>
      (text ?? "").normalize("NFC").replace(/[\u2018\u2019\u02bc]/gu, "'")
        .replace(/\s+/gu, " ").trim()
        .toLocaleLowerCase("en-US");
    const targets = new Set(accepted);
    return elements.flatMap((element, index) => {
      const style = getComputedStyle(element);
      const text = normalizeText(element.textContent);
      if (
        style.display === "none" || style.visibility === "hidden" ||
        element.getClientRects().length === 0 ||
        element.closest('[data-automation-id="promptCategory"]') !== null ||
        !targets.has(text)
      ) return [];
      const childMatches = [...element.children].some((child) =>
        normalizeText(child.textContent) === text
      );
      return childMatches ? [] : [index];
    });
  }, [...equivalentOptionLabels(value)]);
  return indexes.map((index) => descendants.nth(index));
}

async function selectableCandidateSnapshot(locator: Locator): Promise<readonly {
  readonly index: number;
  readonly automationId: string;
  readonly labels: readonly string[];
}[]> {
  return await locator.evaluateAll((elements) => elements.flatMap((element, index) => {
    const style = getComputedStyle(element);
    if (
      style.display === "none" || style.visibility === "hidden" ||
      element.getClientRects().length === 0 ||
      element.getAttribute("aria-disabled") === "true"
    ) return [];
    return [{
      index,
      automationId: element.getAttribute("data-automation-id") ?? "",
      labels: [
        element.getAttribute("aria-label") ?? "",
        (element as HTMLElement).innerText ?? element.textContent ?? "",
      ],
    }];
  }));
}

async function hasExactSelectableCandidate(listbox: Locator, value: string): Promise<boolean> {
  const pool = listbox.locator([
    '[role="option"]:visible',
    '[data-automation-id="promptOption"]:visible',
    '[data-automation-id="promptLeafNode"]:visible',
  ].join(", "));
  const candidates = await selectableCandidateSnapshot(pool);
  if (candidates.some(({ automationId, labels }) =>
    automationId !== "promptCategory" &&
    labels.some((label) => equivalentOption(label, value))
  )) return true;
  return (await exactVisibleTextLeaves(listbox, value)).length === 1;
}

async function exactActiveOption(
  page: Page,
  identifier: string,
  value: string,
): Promise<Locator | undefined> {
  const option = page.locator(`#${cssIdentifier(identifier)}`);
  if (await option.count() !== 1 || !await option.isVisible()) return undefined;
  const labels = [
    await option.getAttribute("aria-label") ?? "",
    await option.innerText(),
  ];
  if (!labels.some((label) => equivalentOption(label, value))) return undefined;
  const actionable = option.locator(
    'xpath=ancestor-or-self::*[@role="option" or @data-automation-id="promptOption" or @data-automation-id="promptLeafNode"][1]',
  );
  return await actionable.count() === 1 ? actionable : option;
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
  if (behavior === "checkbox") {
    return await locator.isChecked() ? "true" : "false";
  }
  if (behavior !== "search_select" && behavior !== "select" && behavior !== "multi_select") {
    const value = await locator.inputValue();
    return value === "" ? null : value;
  }
  const ariaValue = (await locator.getAttribute("aria-valuetext"))?.trim() ?? "";
  if (ariaValue !== "") return ariaValue;
  const selected = (await locator.getAttribute("data-selected-label"))?.trim() ?? "";
  if (selected !== "") return selected;
  const nativeSelected = await locator.evaluate((element) => {
    if (!(element instanceof HTMLSelectElement) || element.selectedOptions.length !== 1) return "";
    const option = element.selectedOptions[0]!;
    return (option.label || option.textContent || "").replace(/\s+/gu, " ").trim();
  });
  if (nativeSelected !== "" && normalize(nativeSelected) !== "select one") {
    return nativeSelected;
  }
  if (await locator.evaluate((element) => element instanceof HTMLButtonElement)) {
    const label = (await locator.innerText()).replace(/\s+/gu, " ").trim();
    if (label !== "" && normalize(label) !== "select one") return label;
  }
  const field = locator.locator('xpath=ancestor::*[@data-automation-id][1]');
  const pills = await visibleLocators(field.locator('[data-automation-id="selectedItem"]'));
  if (pills.length === 0) return null;
  const labels = (await Promise.all(pills.map(async (pill) =>
    (await pill.innerText()).replace(/\s+/gu, " ").trim()
  ))).filter((label) => label !== "");
  if (labels.length !== pills.length) return null;
  return behavior === "multi_select" && labels.length > 1
    ? JSON.stringify(labels)
    : labels.length === 1 ? labels[0]! : null;
}

async function resolvedReadback(control: ResolvedControl): Promise<string | null> {
  if (control.uiBehavior === "radio_group") {
    return radioReadback(await visibleLocators(control.locator));
  }
  return readback(control.locator, control.uiBehavior);
}

async function observedControlLabel(
  locator: Locator,
  behavior: ProfileControlSnapshot["uiBehavior"],
): Promise<string | null> {
  const value = await locator.evaluate((element, radioGroup) => {
    const normalized = (text: string | null | undefined) => (text ?? "")
      .normalize("NFC").replace(/\s+/gu, " ").trim()
      .replace(/\s+(?:Required)$/iu, "").replace(/\s*\*\s*$/u, "").trim();
    if (radioGroup) {
      const legend = element.closest("fieldset")?.querySelector("legend");
      return normalized(legend?.textContent);
    }
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy !== null && labelledBy !== "") {
      const labels = labelledBy.split(/\s+/u).map((id) => document.getElementById(id)?.textContent ?? "");
      const label = normalized(labels.join(" "));
      if (label !== "") return label;
    }
    const aria = normalized(element.getAttribute("aria-label"));
    if (aria !== "") return aria;
    if (element.id !== "") {
      const owned = [...document.querySelectorAll("label")].find((label) => label.htmlFor === element.id);
      const label = normalized(owned?.textContent);
      if (label !== "") return label;
    }
    const parentLabel = normalized(element.closest("label")?.textContent);
    if (parentLabel !== "") return parentLabel;
    const field = element.closest(
      '[data-automation-id="formField"], [data-automation-id^="formField-"]',
    );
    return normalized(field?.querySelector("legend, label")?.textContent);
  }, behavior === "radio_group");
  return value === "" ? null : value;
}

function uniqueObservedOptions(values: readonly string[]): string[] {
  const normalized = values.map((value) => value.normalize("NFC").replace(/\s+/gu, " ").trim())
    .filter((value) => value !== "");
  if (normalized.length > 64 || new Set(normalized.map(retainedProfileTextSha256)).size !== normalized.length) {
    throw new TypeError("profile option observation is ambiguous");
  }
  return normalized;
}

function optionId(value: string): string {
  return `option_sha256_${retainedProfileTextSha256(value)}`;
}

function isChoice(behavior: ProfileControlSnapshot["uiBehavior"]): boolean {
  return behavior === "search_select" || behavior === "select" ||
    behavior === "multi_select" || behavior === "radio_group";
}

function scalarReadbackMatches(
  behavior: ProfileControlSnapshot["uiBehavior"],
  actual: string | null,
  expected: string,
): boolean {
  if (actual === null) return false;
  if (behavior === "month") {
    return /^(?:0?[1-9]|1[0-2])$/u.test(actual) && Number(actual) === Number(expected);
  }
  return normalize(actual) === normalize(expected);
}

function parseOptionList(value: string): readonly string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TypeError("Workday multi-select value must be an exact JSON string list");
  }
  if (
    !Array.isArray(parsed) || parsed.length === 0 || parsed.length > 128 ||
    parsed.some((item) => typeof item !== "string" || normalize(item) === "")
  ) throw new TypeError("Workday multi-select value must be an exact JSON string list");
  const options = parsed.map((item) => item as string);
  if (new Set(options.map(normalize)).size !== options.length) {
    throw new TypeError("Workday multi-select value contains duplicate options");
  }
  return options;
}

function optionReadbackList(value: string | null): readonly string[] {
  if (value === null) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
      return parsed as string[];
    }
  } catch {}
  return [value];
}

async function selectionReadbackIncludes(
  locator: Locator,
  behavior: "search_select" | "select" | "multi_select",
  value: string,
): Promise<boolean> {
  const observed = await readback(locator, behavior);
  return behavior === "multi_select"
    ? optionReadbackList(observed).some((option) => equivalentOption(option, value))
    : equivalentOption(observed ?? "", value);
}

function exactOptionListReadback(
  readbackValue: string | null,
  expected: readonly string[],
): boolean {
  const actual = optionReadbackList(readbackValue);
  if (actual.length !== expected.length) return false;
  const remaining = [...expected];
  for (const value of actual) {
    const index = remaining.findIndex((candidate) => equivalentOption(value, candidate));
    if (index < 0) return false;
    remaining.splice(index, 1);
  }
  return remaining.length === 0;
}

function equivalentOption(left: string, right: string): boolean {
  return equivalentOptionLabels(left).has(normalize(right));
}

function equivalentOptionLabels(value: string): ReadonlySet<string> {
  const normalized = normalize(value);
  return new Set(new Set(["linkedin", "linkedin corporate page"]).has(normalized)
    ? ["linkedin", "linkedin corporate page"]
    : normalized === "computer science"
    ? [normalized, "computer and information science"]
    : normalized === "computer and information science"
      ? [normalized, "computer science"]
      : [normalized]);
}

async function phoneDeviceTypeSelectionValue(
  listbox: Locator,
  requested: string,
): Promise<string> {
  if (
    normalize(requested) === "mobile" &&
    !await hasExactSelectableCandidate(listbox, requested) &&
    await hasExactSelectableCandidate(listbox, "CELL")
  ) return "CELL";
  return requested;
}

async function exactNormalizedOption(
  options: readonly Locator[],
  expected: string,
): Promise<Locator> {
  const matches: Locator[] = [];
  for (const option of options) {
    if (normalize(await option.innerText()) === normalize(expected)) matches.push(option);
  }
  if (matches.length !== 1) throw new TypeError("Workday prompt scope is ambiguous");
  return matches[0]!;
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

async function required(
  locator: Locator,
  compositeRole?: "radiogroup",
): Promise<boolean> {
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
  const compositeRequired = compositeRole === undefined
    ? false
    : await locator.evaluate(
      (element, role) =>
        element.closest(`[role="${role}"]`)?.getAttribute("aria-required") === "true",
      compositeRole,
    );
  const fieldMarkerRequired = await locator.evaluate((element) => {
    const field = element.closest(
      '[data-automation-id="formField"], [data-automation-id^="formField-"]',
    );
    if (field === null) return false;
    if (field.querySelector(
      '[data-automation-id="required"], abbr[title="Required"], [aria-label="Required"]',
    ) !== null) return true;
    return [...field.querySelectorAll("legend, label")].some((candidate) =>
      /\*\s*$/u.test(candidate.textContent ?? "")
    );
  });
  return await locator.getAttribute("required") !== null ||
    await locator.getAttribute("aria-required") === "true" ||
    accessibleRequired || compositeRequired || fieldMarkerRequired;
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

async function exactObservedOptionOwner(
  page: Page,
  control: Locator,
): Promise<Locator | undefined> {
  const ids = [await control.getAttribute("aria-controls"), await control.getAttribute("aria-owns")]
    .flatMap((value) => value?.trim().split(/\s+/u).filter(Boolean) ?? []);
  if (ids.length > 0) {
    if (ids.some((id) => !/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u.test(id))) return undefined;
    const unique = [...new Set(ids)];
    if (unique.length !== 1) return undefined;
    const owner = page.locator(`[id="${unique[0]}"]`);
    return await owner.count() === 1 && await owner.isVisible() ? owner : undefined;
  }
  const field = control.locator(
    'xpath=ancestor::*[starts-with(@data-automation-id,"formField")][1]',
  );
  if (await field.count() !== 1) return undefined;
  const owners = await visibleLocators(field.locator([
    '[role="listbox"]',
    '[data-automation-id="responsiveMonikerPrompt"]',
  ].join(", ")));
  const optionOwners: Locator[] = [];
  for (const owner of owners) {
    if ((await visibleLocators(owner.locator([
      '[role="option"]',
      '[data-automation-id="promptOption"]',
      '[data-automation-id="promptLeafNode"]',
    ].join(", ")))).length > 0) optionOwners.push(owner);
  }
  return optionOwners.length === 1 ? optionOwners[0] : undefined;
}

async function selectionPopupVisible(
  scope: Locator,
  fallbackScope: boolean,
): Promise<boolean> {
  if (!fallbackScope) return await scope.isVisible();
  return (await selectableCandidateSnapshot(scope.locator([
    '[role="option"]:visible',
    '[data-automation-id="promptOption"]:visible',
    '[data-automation-id="promptLeafNode"]:visible',
  ].join(", ")))).length > 0;
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
  return value.normalize("NFC").replace(/[\u2018\u2019\u02bc]/gu, "'")
    .replace(/\s+/gu, " ").trim()
    .toLocaleLowerCase("en-US");
}

function selectionDiagnostic(
  stage: string,
  behavior: "search_select" | "select" | "multi_select",
  details: Readonly<Record<string, boolean | number>>,
): void {
  if (process.env.HUNT_C3_VALUE_FREE_ACCOUNT_TRACE !== "1") return;
  try {
    process.stderr.write(`${JSON.stringify({
      profileSelectionStage: stage,
      behavior,
      ...details,
    })}\n`);
  } catch {}
}

function emptyInteraction(
  behavior: ProfileControlSnapshot["uiBehavior"],
): MutableInteraction {
  const choice = behavior === "search_select" || behavior === "select" ||
    behavior === "multi_select" || behavior === "radio_group";
  const popup = behavior === "search_select" || behavior === "select" ||
    behavior === "multi_select";
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
