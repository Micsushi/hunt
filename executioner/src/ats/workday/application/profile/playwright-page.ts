import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import type { ElementHandle, Locator, Page } from "playwright";

import {
  profileInteractiveControlSelector,
  profileRequiredControlSelector,
  profileRepeatableCatalog,
  profileScalarControlCatalog,
  retainedProfileControlGuide,
  type ProfileControlCatalogEntry,
  type ProfileRepeatableCatalogEntry,
} from "./catalog.ts";
import { nativeCountryControlIds, nativeSocialAccountNames, retainedProfileLabelSha256Matches, retainedProfileTextSha256 } from "./catalog.ts";
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
import { committedMultiSelectReadback } from "./multi-select-readback.ts";
import type { ProfileInspectionFailure } from "./types.ts";
import {
  evaluateSharedUiState,
  sharedSkillOptionLabels,
  sharedUiKnownSemanticAliasMatches,
  sharedUiTypeForBehavior,
} from "../../../../deterministic/ui-state-model.ts";

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
  readonly trace?: (event: string, details?: object) => void;
  readonly inspectMissingOptions?: boolean;
}

export class PlaywrightWorkdayProfilePage implements WorkdayProfilePagePort {
  readonly #page: Page;
  readonly #pageType: ProfilePageType;
  readonly #timeoutMs: number;
  readonly #trace: PlaywrightWorkdayProfilePageOptions["trace"];
  readonly #inspectMissingOptions: boolean;
  readonly #controls = new Map<string, ResolvedControl>();
  readonly #interactions = new Map<string, MutableInteraction>();
  readonly #observedSourceCategories = new Map<string, string>();
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
    this.#trace = options.trace;
    this.#inspectMissingOptions = options.inspectMissingOptions ?? false;
  }

  #readback(
    locator: Locator,
    behavior: ProfileControlSnapshot["uiBehavior"],
  ): Promise<string | null> {
    return readback(locator, behavior, this.#trace);
  }

  #resolvedReadback(control: ResolvedControl): Promise<string | null> {
    return resolvedReadback(control, this.#trace);
  }

  #selectionReadbackIncludes(
    locator: Locator,
    behavior: "search_select" | "select" | "multi_select",
    value: string,
  ): Promise<boolean> {
    return selectionReadbackIncludes(locator, behavior, value, this.#trace, this.#selectionOptionLabels(locator, value));
  }

  #selectionOptionLabels(locator: Locator, value: string): ReadonlySet<string> {
    const fieldId = [...this.#controls.values()].find((control) => control.locator === locator)?.fieldId;
    return fieldId === "skills.values" ? sharedSkillOptionLabels(value) : equivalentOptionLabels(value);
  }

  async inspect(signal: AbortSignal, inspectInteractiveOptions = true): Promise<ProfilePageSnapshot> {
    const started = performance.now();
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
    const unresolvedSelectors = new Set<string>();
    const scalarSnapshots = new Map<ProfileControlCatalogEntry, ProfileControlSnapshot[]>();
    const inspectScalar = async (entry: ProfileControlCatalogEntry) => {
      try {
        const matches = await visibleLocators(profile.locator(entry.selector));
        if (matches.length === 0) {
          scalarSnapshots.set(entry, []);
          return;
        }
        if ((matches.length === 1 || entry.uiBehavior === "radio_group" && matches.length > 0) && retainedProfileControlGuide.some((guide) =>
          guide.identity === entry.fieldId && guide.uiVariant === entry.uiVariant)) {
          const label = await observedControlLabel(matches[0]!, entry.uiBehavior);
          // Generic selectors do not establish question meaning. Native bindings
          // additionally verify the control structure and owning form field.
          if (label !== null && !retainedProfileLabelSha256Matches(
            entry.fieldId, retainedProfileTextSha256(label),
          ) && !await nativeSocialAccountBinding(matches[0]!, entry.fieldId) &&
              !await nativeCountryControlBinding(matches[0]!, entry.fieldId)) {
            if (entry.uiBehavior === "radio_group") {
              if (!(await Promise.all(matches.map(unknownUiBehavior))).every((type) => type === "radio_group")) {
                throw new TypeError("profile radio group UI binding unavailable");
              }
              const key = `radio-group:${entry.selector}`;
              let ordinal = this.#unknownControlOrdinals.get(key);
              if (ordinal === undefined) {
                ordinal = this.#nextUnknownControlOrdinal++;
                this.#unknownControlOrdinals.set(key, ordinal);
              }
              const isRequired = (await Promise.all(matches.map(async (match) =>
                !await validationCleared(match) || await required(match, "radiogroup")))).some(Boolean);
              const snapshots = await this.#inspectControls({
                ...entry, fieldId: `unknown.${isRequired ? "required" : "optional"}.${ordinal}`,
                uiVariant: "workday_unknown_required_v1",
              }, profile.locator(entry.selector), undefined, inspectInteractiveOptions);
              scalarSnapshots.set(entry, snapshots.map((snapshot) => ({ ...snapshot, label })));
              return;
            }
            unresolvedSelectors.add(entry.selector);
            scalarSnapshots.set(entry, []);
            return;
          }
        }
        scalarSnapshots.set(entry, await this.#inspectControls(entry, profile.locator(entry.selector), undefined, inspectInteractiveOptions));
      } catch (error) {
        throw this.#recordInspectionFailure(
          "scalar",
          [entry.fieldId],
          ["profile.scalar"],
          [entry.selector],
          error,
        );
      }
    };
    // Read-only controls can be observed together. Choice discovery may open a
    // popup, so keep those operations sequential and outside the read batch.
    const opensChoices = (entry: ProfileControlCatalogEntry) =>
      this.#inspectMissingOptions && inspectInteractiveOptions && isChoice(entry.uiBehavior);
    const reads = await Promise.allSettled(profileScalarControlCatalog
      .filter((entry) => !opensChoices(entry)).map(inspectScalar));
    for (const result of reads) {
      if (result.status === "rejected") throw result.reason;
    }
    for (const entry of profileScalarControlCatalog.filter(opensChoices)) await inspectScalar(entry);
    for (const entry of profileScalarControlCatalog) controls.push(...scalarSnapshots.get(entry)!);
    const rows: ProfileRowSnapshot[] = [];
    const repeatableSections: ProfileRepeatableSection[] = [];
    for (const entry of profileRepeatableCatalog) {
      try {
        const section = profile.locator(entry.sectionSelector);
        const sections = await visibleLocators(section);
        if (sections.length > 1) throw new TypeError("ambiguous Workday repeatable section");
        if (sections.length === 0) {
          const indexed = await this.#inspectIndexedRows(entry, profile, inspectInteractiveOptions);
          if (indexed.length > 0) {
            repeatableSections.push(entry.section);
            rows.push(...indexed);
          }
          continue;
        }
        repeatableSections.push(entry.section);
        const candidates = await visibleLocators(sections[0]!.locator(entry.rowSelector));
        for (const row of candidates) rows.push(await this.#inspectRow(entry, row, inspectInteractiveOptions));
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
      controls.push(...await this.#inspectUnknownControls(profile, inspectInteractiveOptions, unresolvedSelectors));
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
    this.#trace?.("profile_inspection_completed", {
      durationMs: Math.round(performance.now() - started), fieldCount: controls.length,
    });
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
    this.#trace?.("profile_inspection_failed", { failureStage: phase,
      errorClass: error instanceof Error ? error.name : "unknown",
      underlyingError: error instanceof Error ? /^([a-zA-Z]+\.[a-zA-Z]+):/.exec(error.message)?.[1] ?? "inspection_failed" : "unknown" });
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
    const started = performance.now();
    abort(signal);
    const resolved = this.#controls.get(controlId);
    const bindingId = resolved?.fieldId ?? controlId;
    try {
      if (resolved === undefined) {
        throw new TypeError("profile control observation binding unavailable");
      }
      const controls = await visibleLocators(resolved.locator);
      if (controls.length === 0) {
        throw new TypeError("profile control observation target unavailable");
      }
      if (resolved.binderStrategy === "native_social_account" &&
          !await nativeSocialAccountBinding(controls[0]!, resolved.fieldId)) {
        throw new TypeError("profile native account binding changed");
      }
      if (resolved.binderStrategy === "native_country_control" &&
          !await nativeCountryControlBinding(controls[0]!, resolved.fieldId)) {
        throw new TypeError("profile native country binding changed");
      }
      const before = await this.#resolvedReadback(resolved);
      const validationBefore = (await Promise.all(controls.map(validationCleared))).every(Boolean);
      const label = await observedControlLabel(controls[0]!, resolved.uiBehavior);
      const optionLabels = await this.#observeOptionLabels(
        resolved,
        controls,
        // Workday derives this prefilled value from Country; opening its input is
        // not a read-only observation and can wait forever on a non-editable field.
        inspectInteractiveOptions &&
          resolved.fieldId !== "phone.country_code" &&
          (resolved.fieldId !== "skills.values" || this.#inspectMissingOptions) &&
          // Dynamic choices have no fixed catalog to reconcile after selection.
          // Re-read backing and validation without reopening a committed popup.
          (before === null || resolved.uiBehavior !== "multi_select" && !["education.school", "education.field_of_study"].includes(resolved.fieldId) && !retainedProfileControlGuide.some(guide =>
            guide.identity === resolved.fieldId && guide.behavior === "search_select" &&
            guide.allowedOptions.length === 0)),
      );
      const after = await this.#resolvedReadback(resolved);
      const validationAfter = (await Promise.all(controls.map(validationCleared))).every(Boolean);
      if (before !== after || validationBefore !== validationAfter) {
        throw new TypeError("profile control observation changed backing state");
      }
      const visibleOptionIds = Object.freeze(optionLabels.map(optionId));
      const selected = before === null ? null : optionId(before);
      abort(signal);
      this.#trace?.("profile_control_observation_completed", {
        fieldId: resolved.fieldId, durationMs: Math.round(performance.now() - started),
      });
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
    } catch (error) {
      if (signal.aborted) throw error;
      throw this.#recordInspectionFailure(
        "unknown_controls",
        [bindingId],
        ["profile.control.observation"],
        [bindingId],
        error,
      );
    }
  }

  async #openPromptSearch(activator: Locator, control: Locator, inspectCatalog = false): Promise<void> {
    const sourcePrompt = await control.getAttribute("id") === "source--source";
    const componentOwnerActivated = await activator.evaluate((element, { source, inspectCatalog }) => {
      if (!(element instanceof HTMLElement)) {
        throw new TypeError("Workday prompt search owner is unavailable");
      }
      const record = element as unknown as Record<string, unknown>;
      const fiberKey = Object.keys(element).find((name) =>
        name.startsWith("__reactFiber$") || name.startsWith("__reactInternalInstance$")
      );
      let fiber = fiberKey === undefined ? undefined : record[fiberKey] as {
        readonly memoizedProps?: unknown;
        readonly pendingProps?: unknown;
        readonly return?: unknown;
      } | undefined;
      const handlers = new Set<() => unknown>();
      for (let depth = 0; fiber !== undefined && fiber !== null && depth < 32; depth += 1) {
        const props = fiber.memoizedProps ?? fiber.pendingProps;
        if (typeof props === "object" && props !== null) {
          const inputHandler = (props as { readonly onSelectInputClick?: unknown }).onSelectInputClick;
          const iconHandler = (props as { readonly onPromptIconClick?: unknown }).onPromptIconClick;
          const handler = source
            ? inspectCatalog ? iconHandler ?? inputHandler : inputHandler
            : iconHandler;
          if (typeof handler === "function") handlers.add(handler as () => unknown);
        }
        fiber = fiber.return as typeof fiber;
      }
      if (handlers.size > 1) throw new TypeError("Workday prompt component owner is ambiguous");
      const handler = [...handlers][0];
      if (handler === undefined) return false;
      handler();
      return true;
    }, { source: sourcePrompt, inspectCatalog });
    if (!componentOwnerActivated) await activator.click({ timeout: this.#timeoutMs });
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
      return uniqueObservedOptions(await unknownAllowedOptions(control));
    }
    if (!inspectInteractiveOptions) return [];
    const started = performance.now();
    const before = await this.#resolvedReadback(resolved);
    const promptCatalog = resolved.uiBehavior === "multi_select" ||
      resolved.uiBehavior === "search_select" && await control.evaluate(element => {
        const widgetId = element.getAttribute("data-uxi-multiselect-id");
        return element.getAttribute("data-uxi-widget-type") === "selectinput" &&
          widgetId !== null && element.closest(
            '[data-automation-id="multiSelectContainer"][data-uxi-widget-type="multiselect"]',
          )?.id === widgetId;
      }) ||
      ["source.how_did_you_hear", "education.school", "education.field_of_study"].includes(resolved.fieldId);
    const priorCatalogs = promptCatalog
      ? await this.#page.locator('[role="listbox"]:visible').elementHandles()
      : undefined;
    let labels: string[] = [];
    let searchDraft: string | undefined;
    let observationStage = "focus";
    try {
      await control.focus({ timeout: this.#timeoutMs });
      observationStage = "click";
      await control.click({ timeout: this.#timeoutMs });
      observationStage = "resolve_owner";
      await this.#page.waitForTimeout(25);
      let owner = promptCatalog
        ? await exactPromptCatalogOwner(this.#page, control, priorCatalogs)
        : await exactObservedOptionOwner(this.#page, control);
      if ((owner === undefined || (await observedOptionLabels(owner)).length === 0) &&
          promptCatalog && resolved.uiBehavior === "search_select") {
        const icons = await visibleLocators(control.locator(
          'xpath=ancestor::*[@data-automation-id="multiSelectContainer"][1]',
        ).locator('[data-automation-id="promptIcon"]'));
        if (icons.length === 1) {
          observationStage = "open_prompt_catalog";
          await this.#openPromptSearch(icons[0]!, control, true);
          owner = await exactPromptCatalogOwner(this.#page, control, priorCatalogs);
        }
      }
      if ((owner === undefined || (await observedOptionLabels(owner)).length === 0) &&
          this.#inspectMissingOptions && (resolved.uiBehavior === "multi_select" ||
            resolved.uiBehavior === "search_select" && await control.getAttribute("enterkeyhint") === "search") &&
          await control.evaluate(element => element instanceof HTMLInputElement && !element.readOnly)) {
        // Enter can select a suggestion even when the input advertises search.
        // Discover choices without submitting text, then restore the draft.
        observationStage = "search_draft";
        searchDraft ??= await control.inputValue();
        await control.fill("", { timeout: this.#timeoutMs });
        await control.pressSequentially("a", { timeout: this.#timeoutMs });
        const deadline = Date.now() + Math.min(this.#timeoutMs, 5_000);
        do {
          owner = await exactPromptCatalogOwner(this.#page, control, priorCatalogs);
          if (owner !== undefined && (await observedOptionLabels(owner)).length > 0) break;
          await this.#page.waitForTimeout(50);
        } while (Date.now() < deadline);
      }
      if ((owner === undefined || (await observedOptionLabels(owner)).length === 0) &&
          ["education.school", "education.field_of_study"].includes(resolved.fieldId) &&
          await control.evaluate((element) => element instanceof HTMLInputElement)) {
        observationStage = "search_draft";
        searchDraft ??= await control.inputValue();
        const queries = resolved.fieldId === "education.school" ? ["Other", "University"] : ["Other"];
        for (const query of queries) {
          await control.fill(query, { timeout: this.#timeoutMs });
          await control.press("Enter", { timeout: this.#timeoutMs });
          const deadline = Date.now() + Math.min(this.#timeoutMs, 5_000);
          do {
            owner = await exactPromptCatalogOwner(this.#page, control, priorCatalogs);
            if (owner !== undefined && (await observedOptionLabels(owner)).length > 0 ||
                await this.#resolvedReadback(resolved) !== before) break;
            await this.#page.waitForTimeout(50);
          } while (Date.now() < deadline);
          if (owner !== undefined && (await observedOptionLabels(owner)).length > 0 ||
              await this.#resolvedReadback(resolved) !== before) break;
        }
      }
      if (owner === undefined && resolved.fieldId === "source.how_did_you_hear") {
        observationStage = "open_source_catalog";
        await this.#captureSelectionDiagnostic("input-source-observation-empty", "search_select");
        const buttons = await visibleLocators(control.locator(
          'xpath=ancestor::*[starts-with(@data-automation-id,"formField")][1]',
        ).locator('[data-automation-id="promptSearchButton"]'));
        if (buttons.length > 1) throw new TypeError("Workday prompt search owner is ambiguous");
        if (buttons.length === 1) {
          await buttons[0]!.click({ timeout: this.#timeoutMs });
          owner = await exactPromptCatalogOwner(this.#page, control, priorCatalogs);
          if (owner === undefined) {
            await this.#captureSelectionDiagnostic("native-source-observation-empty", "search_select");
            await this.#openPromptSearch(buttons[0]!, control, true);
            owner = await exactPromptCatalogOwner(this.#page, control, priorCatalogs);
          }
        }
      }
      if (promptCatalog && owner !== undefined) {
        const scopes = await visibleLocators(owner.locator('[role="option"]'));
        const scopeLabels = await Promise.all(scopes.map(option => option.innerText()));
        // These two Workday navigation entries choose a catalog scope, not an
        // answer. Discover its leaves without activating a radio/checkbox.
        if (scopeLabels.length === 2 && scopeLabels.every(promptScopeLabel) &&
            scopeLabels.some(label => normalize(label) === "all") &&
            scopeLabels.some(label => normalize(label) !== "all") &&
            (await Promise.all(scopes.map(option => option.locator(
              'input, [role="checkbox"], [role="radio"]',
            ).count()))).every(count => count === 0)) {
          observationStage = "expand_catalog_scope";
          // Discover a bounded set of actual choices. The unbounded All request
          // can time out server-side even when search and the partial list work.
          await (await exactNormalizedOption(scopes, "Partial List (First 500 Entries)"))
            .click({ timeout: this.#timeoutMs });
          // Large catalogs expose a busy prompt before mounting their listbox.
          // Wait for this control's request instead of treating loading as empty.
          const widget = await control.getAttribute("data-uxi-multiselect-id");
          if (widget !== null) {
            await this.#page.locator(
              `[data-automation-id="responsiveMonikerPrompt"][data-associated-widget=${JSON.stringify(widget)}][aria-busy="true"]`,
            ).waitFor({ state: "hidden", timeout: 30_000 });
          }
          // Scope navigation opens its leaves asynchronously. Clicking the
          // input again toggles that pending catalog closed.
          const deadline = Date.now() + Math.min(this.#timeoutMs, 5_000);
          do {
            owner = await exactPromptCatalogOwner(this.#page, control, priorCatalogs);
            labels = owner === undefined ? [] : (await observedOptionLabels(owner)).filter(label => !promptScopeLabel(label));
            if (labels.length > 0) break;
            await this.#page.waitForTimeout(50);
          } while (Date.now() < deadline);
          if (labels.length === 0) throw new TypeError("Workday catalog scope has no selectable options");
        }
      }
      // Structural prompts can expose categories before selectable answers.
      // Explore one bounded branch for synthetic discovery; never record a
      // navigation category as an answer or activate a selectable leaf here.
      if (promptCatalog && resolved.fieldId.startsWith("unknown.")) {
        for (let depth = 0; owner !== undefined && depth < 4; depth += 1) {
          const options = await visibleLocators(owner.locator('[role="option"]'));
          const branches: Locator[] = [];
          const leaves: Locator[] = [];
          for (const option of options) {
            const navigation = await option.locator('[data-automation-id="promptLeafNode"] svg[role="presentation"]').count() > 0 &&
              await option.locator('input, [role="checkbox"], [role="radio"]').count() === 0;
            (navigation ? branches : leaves).push(option);
          }
          if (leaves.length > 0) {
            labels = uniqueObservedOptions(await Promise.all(leaves.map(option => option.innerText())));
            break;
          }
          if (branches.length === 0) break;
          observationStage = "expand_prompt_category";
          const previous = await owner.innerText();
          await (await promptOptionActivation(branches[0]!)).click({ timeout: this.#timeoutMs });
          const deadline = Date.now() + Math.min(this.#timeoutMs, 5_000);
          do {
            owner = await exactPromptCatalogOwner(this.#page, control, priorCatalogs);
            if (owner !== undefined && await owner.innerText() !== previous) break;
            await this.#page.waitForTimeout(50);
          } while (Date.now() < deadline);
          if (owner !== undefined && await owner.innerText() === previous) {
            throw new TypeError("Workday prompt category did not advance");
          }
          if (depth === 3) throw new TypeError("Workday prompt category depth exceeded");
        }
      }
      if (owner !== undefined) {
        if (resolved.fieldId === "source.how_did_you_hear") {
          this.#observedSourceCategories.clear();
          const categories: Locator[] = [];
          for (const option of await visibleLocators(owner.locator('[role="option"]'))) {
            if (await option.locator(
              '[data-automation-id="promptLeafNode"] svg[role="presentation"]',
            ).count() === 1 && await option.locator(
              'input, [role="checkbox"], [role="radio"]',
            ).count() === 0) categories.push(option);
          }
          const categoryLabels = await Promise.all(categories.map(category => category.innerText()));
          categoryLabels.sort((a, b) => Number(normalize(b) === "career websites") - Number(normalize(a) === "career websites"));
          for (const label of categoryLabels) {
            if (owner === undefined) throw new TypeError("Workday source catalog is unavailable");
            const category = await preferredPromptOption(
              await visibleLocators(owner.locator('[role="option"]')), new Set([normalize(label)]),
            );
            if (category === undefined) throw new TypeError("Workday source category is unavailable");
            observationStage = "expand_source_category";
            const categoryLabel = (await category.innerText()).trim();
            await (await promptOptionActivation(category)).click({ timeout: this.#timeoutMs });
            await this.#page.waitForTimeout(100);
            const widget = await control.getAttribute("data-uxi-multiselect-id");
            if (widget !== null) {
              await this.#page.locator(
                `[data-automation-id="responsiveMonikerPrompt"][data-associated-widget=${JSON.stringify(widget)}][aria-busy="true"]`,
              ).waitFor({ state: "hidden", timeout: 30_000 });
            }
            owner = await exactPromptCatalogOwner(this.#page, control, priorCatalogs);
            const leaves = owner === undefined ? [] : await visibleLocators(owner.locator('[role="option"]'));
            const leafLabels = uniqueObservedOptions(await Promise.all(leaves.map(async option => {
              const label = await option.innerText();
              const selectable = await option.locator('input, [role="checkbox"], [role="radio"]').count() > 0;
              return selectable || normalize(label) !== normalize(categoryLabel) ? label : "";
            })));
            for (const label of leafLabels) this.#observedSourceCategories.set(normalize(label), categoryLabel);
            if (leafLabels.length > 0) { labels = leafLabels; break; }
            // Empty categories still expose their exact heading as Back. Return
            // to the same catalog and inspect the next observed category.
            const back = await visibleLocators(this.#page.getByText(categoryLabel, { exact: true }));
            if (back.length !== 1) throw new TypeError("Workday source category back control is ambiguous");
            await back[0]!.click({ timeout: this.#timeoutMs });
            owner = await exactPromptCatalogOwner(this.#page, control, priorCatalogs);
          }
          if (categoryLabels.length > 0 && this.#observedSourceCategories.size === 0) {
            throw new TypeError("Workday source categories have no selectable options");
          }
        }
        if (labels.length === 0 && owner !== undefined) labels = await observedOptionLabels(owner);
      }
      if (labels.length === 0 && (resolved.uiBehavior === "search_select" ||
          resolved.uiBehavior === "select" || resolved.uiBehavior === "multi_select")) {
        await this.#captureSelectionDiagnostic("observation-empty", resolved.uiBehavior);
      }
    } catch (error) {
      this.#trace?.("profile_option_observation_failed", {
        fieldId: resolved.fieldId,
        failureStage: observationStage,
        errorType: error instanceof Error && error.name === "TimeoutError" ? "timeout" : "other",
        underlyingError: error instanceof Error && error.message === "Workday source category back control is ambiguous"
          ? "source_back_ambiguous" : "unclassified",
        durationMs: Math.round(performance.now() - started),
      });
      if (resolved.uiBehavior === "search_select" || resolved.uiBehavior === "select" ||
          resolved.uiBehavior === "multi_select") {
        await this.#captureSelectionDiagnostic("observation-failed", resolved.uiBehavior);
      }
      throw error;
    } finally {
      let cleanupStage = "release_catalog_handles";
      try {
        await Promise.all((priorCatalogs ?? []).map(handle => handle?.dispose()));
        cleanupStage = "restore_search";
        if (searchDraft !== undefined) {
          // Workday can auto-select its sole search result. Undo only that new,
          // exactly owned token before returning discovered choices to the filler.
          const discovered = await this.#resolvedReadback(resolved);
          if (before === null && discovered !== null && resolved.uiBehavior === "search_select") {
            const owner = control.locator('xpath=ancestor::*[starts-with(@data-automation-id,"formField")][1]');
            const tokens = await visibleLocators(owner.locator('[data-automation-id="selectedItem"]'));
            const remove = owner.locator('[data-automation-id="DELETE_charm"]:visible');
            if (tokens.length !== 1 || await remove.count() !== 1) {
              throw new TypeError("profile discovery selection rollback is ambiguous");
            }
            await remove.click({ timeout: this.#timeoutMs });
            if (await this.#resolvedReadback(resolved) !== null) {
              throw new TypeError("profile discovery selection rollback did not settle");
            }
            if (!labels.includes(discovered)) labels.push(discovered);
          }
          await control.fill(searchDraft, { timeout: this.#timeoutMs });
        }
        cleanupStage = "dismiss_catalog";
        await this.#page.keyboard.press("Escape");
        await control.blur({ timeout: this.#timeoutMs });
        if (promptCatalog && (await visibleLocators(this.#page.locator(
          '[data-automation-id="activeListContainer"][role="listbox"]',
        ))).length > 0) {
          const heading = (await this.#assertPageType()).locator('h1, h2, h3, h4, h5, h6, [role="heading"]').first();
          if (await heading.count() === 1) await heading.click({ timeout: this.#timeoutMs });
          // Workday scope popups can ignore Escape and outside clicks. Toggle
          // only this control's still-open catalog, never a neighboring popup.
          if (await exactPromptCatalogOwner(this.#page, control) !== undefined) {
            await control.click({ timeout: this.#timeoutMs });
            await control.blur({ timeout: this.#timeoutMs });
          }
        }
        cleanupStage = "verify_unchanged";
        await this.#page.waitForTimeout(25);
        if (before !== await this.#resolvedReadback(resolved)) {
          throw new TypeError("profile option observation changed backing state");
        }
      } catch (error) {
        this.#trace?.("profile_option_observation_cleanup_failed", {
          fieldId: resolved.fieldId,
          failureStage: cleanupStage,
          errorType: error instanceof Error && error.name === "TimeoutError" ? "timeout" : "other",
          underlyingError: error instanceof Error && error.message === "profile option observation changed backing state"
            ? "backing_state_changed" : "unclassified",
          durationMs: Math.round(performance.now() - started),
        });
        throw error;
      }
    }
    this.#trace?.("profile_option_observation_completed", {
      fieldId: resolved.fieldId, durationMs: Math.round(performance.now() - started),
      observedOptionCount: labels.length,
    });
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
    if (request.uiBehavior === "file") {
      if (await this.#readback(resolved.locator, "file") === request.value &&
          await validationCleared(resolved.locator)) {
        interaction.backingValueCommitted = true;
        interaction.validationCleared = true;
        return;
      }
      if (request.syntheticFile === undefined || request.value !== request.syntheticFile.name) {
        throw new TypeError("synthetic profile file artifact is missing");
      }
      let uploadError: unknown;
      try {
        await resolved.locator.setInputFiles({
          name: request.syntheticFile.name,
          mimeType: request.syntheticFile.mimeType,
          buffer: Buffer.from(request.syntheticFile.bytes.buffer,
            request.syntheticFile.bytes.byteOffset, request.syntheticFile.bytes.byteLength),
        }, { timeout: this.#timeoutMs });
      } catch (error) { uploadError = error; }
      // A remount can lose the browser action's reply after upload succeeded.
      // Reconcile the owned receipt and filename without transferring twice.
      const deadline = Date.now() + (uploadError === undefined ? this.#timeoutMs : Math.min(this.#timeoutMs, 5_000));
      do {
        abort(signal);
        try {
          interaction.backingValueCommitted = await this.#readback(resolved.locator, "file") === request.value;
          interaction.validationCleared = await validationCleared(resolved.locator);
        } catch {
          interaction.backingValueCommitted = false;
          interaction.validationCleared = false;
        }
        if (interaction.backingValueCommitted && interaction.validationCleared) break;
        await this.#page.waitForTimeout(50);
      } while (Date.now() < deadline);
      if (!interaction.backingValueCommitted || !interaction.validationCleared) {
        throw uploadError ?? new TypeError("Workday profile file did not commit");
      }
      this.#trace?.("profile_file_upload_reconciled", { fieldId: resolved.fieldId,
        underlyingError: uploadError === undefined ? "acknowledged" : "action_error_reconciled" });
    } else if (request.uiBehavior === "multi_select" &&
        await resolved.locator.evaluate((element) => element instanceof HTMLSelectElement)) {
      const options = parseOptionList(request.value);
      await resolved.locator.selectOption(
        options.map((label) => ({ label })),
        { timeout: this.#timeoutMs },
      );
      await resolved.locator.blur({ timeout: this.#timeoutMs });
      await this.#page.waitForTimeout(25);
      interaction.popupBound = false;
      interaction.optionFocused = false;
      interaction.optionActivated = true;
      interaction.popupClosed = true;
      interaction.visibleOptionCount = await resolved.locator.locator("option").count();
      interaction.selectedOptionOrdinal = null;
      interaction.backingValueCommitted = exactOptionListReadback(
        await this.#readback(resolved.locator, "multi_select"),
        options,
        resolved.fieldId,
      );
      interaction.validationCleared = await validationCleared(resolved.locator);
      if (!interaction.backingValueCommitted || !interaction.validationCleared) {
        throw new TypeError("Workday native multi-select value did not commit");
      }
    } else if (request.uiBehavior === "multi_select" &&
        await resolved.locator.getAttribute("role") === "listbox") {
      const options = parseOptionList(request.value);
      for (const option of options) {
        if (await this.#selectionReadbackIncludes(resolved.locator, "multi_select", option)) continue;
        const matches = resolved.locator.getByRole("option", { name: option, exact: true });
        if (await matches.count() !== 1) {
          throw new TypeError("Workday ARIA multi-select option is missing or ambiguous");
        }
        await matches.click({ timeout: this.#timeoutMs });
      }
      interaction.popupBound = false;
      interaction.optionFocused = false;
      interaction.optionActivated = true;
      interaction.popupClosed = false;
      interaction.visibleOptionCount = await resolved.locator.getByRole("option").count();
      interaction.selectedOptionOrdinal = null;
      interaction.backingValueCommitted = exactOptionListReadback(
        await this.#readback(resolved.locator, "multi_select"),
        options,
        resolved.fieldId,
      );
      interaction.validationCleared = await validationCleared(resolved.locator);
      if (!interaction.backingValueCommitted || !interaction.validationCleared) {
        throw new TypeError("Workday ARIA multi-select value did not commit");
      }
    } else if (request.uiBehavior === "multi_select") {
      const options = parseOptionList(request.value);
      for (const option of options) {
        if (await this.#selectionReadbackIncludes(resolved.locator, "multi_select", option)) continue;
        await this.#selectSearchOption(resolved.locator, option, interaction, "multi_select");
      }
      interaction.backingValueCommitted = exactOptionListReadback(
        await this.#readback(resolved.locator, "multi_select"),
        options,
        resolved.fieldId,
      );
      interaction.validationCleared = await validationCleared(resolved.locator);
      if (!interaction.backingValueCommitted || !interaction.validationCleared) {
        throw new TypeError("Workday multi-select value did not commit");
      }
    } else if (request.uiBehavior === "search_select" || request.uiBehavior === "select") {
      const sourceBacking = resolved.fieldId === "source.how_did_you_hear"
        ? await committedPromptPrefill(resolved.locator, request.value) : undefined;
      if (sourceBacking === false &&
          await this.#selectionReadbackIncludes(resolved.locator, request.uiBehavior, request.value)) {
        throw new TypeError("Workday saved source does not match its controlled backing");
      }
      if (await this.#selectionReadbackIncludes(resolved.locator, request.uiBehavior, request.value) &&
          await validationCleared(resolved.locator)) {
        // A saved choice is already complete. Reopening its prompt can target
        // hidden search inputs or toggle the selected token unnecessarily.
        interaction.backingValueCommitted = true;
        interaction.validationCleared = true;
      } else if (resolved.fieldId === "source.how_did_you_hear" &&
          await committedPromptPrefill(resolved.locator, request.value) ||
          resolved.fieldId === "education.school" &&
          equivalentOption(await committedMultiSelectReadback(resolved.locator) ?? "", request.value)) {
        interaction.backingValueCommitted = true;
        interaction.validationCleared = await validationCleared(resolved.locator);
        if (!interaction.validationCleared) throw new TypeError("Workday saved prompt validation is invalid");
      } else if (
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
      if (await checkboxReadback(resolved.locator) !== checked) {
        await resolved.locator.click({ timeout: this.#timeoutMs });
      }
      await resolved.locator.blur({ timeout: this.#timeoutMs });
      await this.#page.waitForTimeout(25);
      interaction.backingValueCommitted = await checkboxReadback(resolved.locator) === checked;
      interaction.validationCleared = await validationCleared(resolved.locator);
      if (!interaction.backingValueCommitted || !interaction.validationCleared) {
        throw new TypeError("Workday checkbox value did not commit");
      }
    } else {
      const entries = [{ control: resolved, value: request.value }];
      if (request.pairedDate !== undefined) {
        const paired = this.#controls.get(request.pairedDate.controlId);
        if (paired === undefined || paired.uiBehavior !== request.pairedDate.uiBehavior ||
            !["month", "year"].includes(request.uiBehavior) ||
            paired.uiBehavior === request.uiBehavior) throw new TypeError("profile date pair is invalid");
        const owner = resolved.locator.locator("xpath=ancestor::*[@data-automation-id='dateInputWrapper'][1]");
        if (await owner.count() === 1) {
          const handle = await paired.locator.elementHandle();
          try {
            if (handle === null || !await owner.evaluate((element, other) => element.contains(other), handle)) {
              throw new TypeError("profile date pair owner differs");
            }
          } finally { await handle?.dispose(); }
          entries.push({ control: paired, value: request.pairedDate.value });
          entries.sort((a, b) => a.control.uiBehavior === b.control.uiBehavior ? 0 :
            a.control.uiBehavior === "month" ? -1 : 1);
        }
      }
      // The visible segment selects the widget's active field. Focusing its tiny
      // backing input alone can redirect typing into the previously selected field.
      for (const { control, value } of entries) {
        if (control.uiBehavior === "month" || control.uiBehavior === "year") {
          const inputId = await control.locator.getAttribute("id");
          const segment = control.locator.locator("xpath=..");
          if (inputId?.endsWith("-input") &&
              await segment.getAttribute("id") === inputId.slice(0, -6)) {
            await segment.click({ timeout: this.#timeoutMs });
            await control.locator.press("ControlOrMeta+A", { timeout: this.#timeoutMs });
            await control.locator.pressSequentially(value, { timeout: this.#timeoutMs });
          } else {
            await control.locator.focus({ timeout: this.#timeoutMs });
            await control.locator.fill(value, { timeout: this.#timeoutMs });
          }
        } else {
          await control.locator.fill(value, { timeout: this.#timeoutMs });
        }
      }
      // Leave the combined widget only after both planned date parts are present.
      await entries.at(-1)!.control.locator.blur({ timeout: this.#timeoutMs });
      await this.#page.waitForTimeout(25);
      interaction.backingValueCommitted = (await Promise.all(entries.map(async ({ control, value }) =>
        scalarReadbackMatches(control.uiBehavior, await this.#readback(control.locator, control.uiBehavior), value)
      ))).every(Boolean);
      interaction.validationCleared = (await Promise.all(entries.map(({ control }) =>
        validationCleared(control.locator)))).every(Boolean);
      if (!interaction.backingValueCommitted || !interaction.validationCleared) {
        throw new TypeError("Workday profile value did not commit");
      }
    }
    const sharedType = sharedUiTypeForBehavior(request.uiBehavior);
    if (sharedType === undefined || !evaluateSharedUiState({
      type: sharedType,
      ownerState: "exact",
      backingState: interaction.backingValueCommitted ? "committed" : "empty",
      stabilizationState: "stable",
      readbackState: interaction.backingValueCommitted ? "matches" : "empty",
      validationState: interaction.validationCleared ? "clear" : "invalid",
    }).navigationEligible) {
      throw new TypeError("Workday profile shared UI state did not commit");
    }
    } catch (error) {
      if (["search_select", "select", "multi_select"].includes(request.uiBehavior) && !signal.aborted) {
        // A successful selection can remount its popup before the action returns.
        // Dismiss residual search UI, then reconcile the exact committed value;
        // the handler's independent verifier still owns final acceptance.
        await this.#resetFailedSelection(resolved.locator);
        try {
          const observed = await this.#readback(resolved.locator, request.uiBehavior);
          const matches = request.uiBehavior === "multi_select"
            ? exactOptionListReadback(observed, parseOptionList(request.value), resolved.fieldId)
            : observed !== null && equivalentOption(observed, request.value);
          if (matches && await resolved.locator.count() === 1 && await resolved.locator.isVisible() &&
              (resolved.fieldId !== "source.how_did_you_hear" ||
                await committedPromptPrefill(resolved.locator, request.value) !== false) &&
              await validationCleared(resolved.locator) &&
              await resolved.locator.getAttribute("aria-expanded") !== "true" &&
              await exactPromptCatalogOwner(this.#page, resolved.locator) === undefined) {
            interaction.backingValueCommitted = true;
            interaction.validationCleared = true;
            interaction.popupClosed = true;
            abort(signal);
            return;
          }
        } catch { /* Preserve the original error when exact readback is unavailable. */ }
      }
      if (process.env.HUNT_C3_VALUE_FREE_ACCOUNT_TRACE === "1" &&
          ["search_select", "select", "multi_select"].includes(request.uiBehavior)) {
        try {
          const observed = await this.#readback(resolved.locator, request.uiBehavior);
          const digest = (value: string) => createHash("sha256").update(normalize(value)).digest("hex");
          const knownErrors = [
            "Workday profile shared UI state did not commit",
            "Workday prompt catalog value did not commit",
            "Workday submitted multi-select option did not commit",
            "Workday selected-item ownership is ambiguous",
            "Workday selected-item owner is incomplete or ambiguous",
            "Workday prompt catalog option is unavailable",
          ];
          process.stderr.write(`${JSON.stringify({ profileFailedSelectionReadback: {
            fieldId: resolved.fieldId,
            expectedSha256: digest(request.value),
            observedSha256: observed === null ? null : digest(observed),
            matchesNow: observed !== null && equivalentOption(observed, request.value),
            error: error instanceof Error && knownErrors.includes(error.message) ? error.message : "other",
          } })}\n`);
        } catch { /* Optional diagnostics must not replace the original failure. */ }
      }
      this.#trace?.("profile_driver_failed", {
        fieldId: resolved.fieldId,
        uiBehavior: request.uiBehavior,
        errorClass: error instanceof Error && error.name === "TimeoutError" ? "timeout" : "commit_failed",
        backingValueCommitted: interaction.backingValueCommitted,
        validationCleared: interaction.validationCleared,
      });
      if (
        request.uiBehavior === "multi_select" ||
        request.uiBehavior === "search_select" || request.uiBehavior === "select"
      ) {
        selectionDiagnostic("driver-failed", request.uiBehavior, {
          timeout: error instanceof Error && error.name === "TimeoutError",
          activationAmbiguous: error instanceof Error && error.message === "Workday prompt catalog activation is ambiguous",
          optionAmbiguous: error instanceof Error && error.message === "Workday prompt typeahead option is ambiguous",
          submittedOptionAmbiguous: error instanceof Error && error.message === "Workday submitted multi-select option is ambiguous",
          submittedControlAmbiguous: error instanceof Error && error.message === "Workday submitted multi-select option control is ambiguous",
          submittedNotCommitted: error instanceof Error && error.message === "Workday submitted multi-select option did not commit",
          promptOwnerAmbiguous: error instanceof Error && error.message === "Workday source prompt owner is ambiguous",
          backingValueCommitted: interaction.backingValueCommitted,
          validationCleared: interaction.validationCleared,
        });
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
    inspectInteractiveOptions = true,
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
        binderStrategy: entry.fieldId.startsWith("unknown.") ? "opaque_machine_key" : "catalog_selector_exact",
      });
      const valid = (await Promise.all(matches.map((match) =>
        validationCleared(match)
      ))).every(Boolean);
      return [{
        controlId,
        fieldId: entry.fieldId,
        required: !valid || (await Promise.all(matches.map((match) =>
          required(match, "radiogroup")
        ))).some(Boolean),
        uiBehavior: entry.uiBehavior,
        uiVariant: entry.uiVariant,
        readback: valid ? await radioReadback(matches) : null,
        allowedOptions: uniqueObservedOptions(await Promise.all(matches.map(radioOptionLabel))),
      }];
    }
    if (matches.length > 1) {
      throw new TypeError("ambiguous Workday profile control binding");
    }
    const snapshots: ProfileControlSnapshot[] = [];
    for (const [index, match] of matches.entries()) {
      const controlId = [rowIdValue ?? "scalar", entry.fieldId, index].join(":");
      this.#controls.set(controlId, {
        locator: match,
        fieldId: entry.fieldId,
        uiBehavior: entry.uiBehavior,
        uiVariant: entry.uiVariant,
        binderStrategy: await nativeSocialAccountBinding(match, entry.fieldId)
          ? "native_social_account" : await nativeCountryControlBinding(match, entry.fieldId)
          ? "native_country_control" : "catalog_selector_exact",
      });
      const [currentReadback, isRequired] = await Promise.all([
        this.#readback(match, entry.uiBehavior), required(match),
      ]);
      const allowedOptions = this.#inspectMissingOptions && isChoice(entry.uiBehavior)
        ? currentReadback === null
          ? await this.#observeOptionLabels(this.#controls.get(controlId)!, [match],
            inspectInteractiveOptions && entry.fieldId !== "phone.country_code")
          : [currentReadback]
        : [];
      // Blur during catalog discovery may reveal required-field validation.
      // Report its current state instead of treating validation as an answer edit.
      const currentValid = await validationCleared(match);
      snapshots.push({
        controlId,
        fieldId: entry.fieldId,
        required: !currentValid || isRequired,
        uiBehavior: entry.uiBehavior,
        uiVariant: entry.uiVariant,
        readback: currentValid ? currentReadback : null,
        ...(allowedOptions.length === 0 ? {} : { allowedOptions }),
      });
    }
    return snapshots;
  }

  async #inspectRow(
    entry: ProfileRepeatableCatalogEntry,
    row: Locator,
    inspectInteractiveOptions: boolean,
  ): Promise<ProfileRowSnapshot> {
    const identifier = await rowId(row);
    const controls: ProfileControlSnapshot[] = [];
    for (const field of entry.fields) {
      const locator = row.locator(`[data-automation-id$="--${field.suffix}"]`);
      const variants = entry.fields.filter(candidate =>
        candidate.fieldId === field.fieldId && candidate.suffix === field.suffix);
      if (variants.length > 1) {
        const visible = await visibleLocators(locator);
        if (visible.length === 1) {
          const observedBehavior = await unknownUiBehavior(visible[0]!);
          const variant = variants.find(candidate => candidate.uiBehavior === observedBehavior);
          if (variant === undefined) throw new TypeError("unsupported Workday repeatable control variant");
          if (variant !== field) continue;
        }
      }
      controls.push(...await this.#inspectControls({
        fieldId: field.fieldId,
        selector: "",
        uiBehavior: field.uiBehavior,
        uiVariant: field.uiVariant,
      }, locator, identifier, inspectInteractiveOptions));
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
    inspectInteractiveOptions: boolean,
  ): Promise<ProfileRowSnapshot[]> {
    if (indexedRepeatablePrefixes(entry.section).length === 0) return [];
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
        }, profile.locator(`[id="${identifier}--${field.suffix}"]`), identifier, inspectInteractiveOptions));
      }
      rows.push({
        section: entry.section,
        rowId: identifier,
        ownedByC3: this.#ownedIndexedRows.has(identifier),
        controls,
      });
    }
    return rows;
  }

  async #indexedRowIds(entry: ProfileRepeatableCatalogEntry): Promise<string[]> {
    const prefixes = indexedRepeatablePrefixes(entry.section);
    if (prefixes.length === 0) return [];
    const ids = await this.#page.locator(prefixes.map(prefix =>
      `[id^="${prefix}"][id*="--"]`).join(", ")).evaluateAll((elements) =>
      elements.flatMap((element) => {
        const split = element.id.indexOf("--");
        return split > 0 ? [element.id.slice(0, split)] : [];
      })
    );
    return [...new Set(ids)].sort();
  }

  async #inspectUnknownControls(
    profile: Locator,
    inspectInteractiveOptions: boolean,
    unresolvedSelectors: ReadonlySet<string>,
  ): Promise<ProfileControlSnapshot[]> {
    const candidates = await visibleLocators(
      profile.locator(`${profileInteractiveControlSelector}, ${profileRequiredControlSelector}`),
    );
    // Workday hides native upload inputs behind a visible owned drop zone.
    const uploads = profile.locator('input[type="file"][data-automation-id="file-upload-input-ref"]');
    for (let index = 0; index < await uploads.count(); index += 1) {
      const upload = uploads.nth(index);
      if (!await upload.isVisible() && await upload.locator(
        'xpath=ancestor::*[@data-fkit-id][1]',
      ).isVisible()) candidates.push(upload);
    }
    const catalog = {
      scalarSelectors: profileScalarControlCatalog.map(({ selector }) => selector)
        .filter((selector) => !unresolvedSelectors.has(selector)),
      choiceSelectors: profileScalarControlCatalog
        .filter(({ uiBehavior }) => uiBehavior === "search_select")
        .map(({ selector }) => selector),
      radioGroupSelectors: profileScalarControlCatalog
        .filter(({ uiBehavior }) => uiBehavior === "radio_group")
        .map(({ selector }) => selector),
      repeatables: profileRepeatableCatalog.map((entry) => ({
        sectionSelector: entry.sectionSelector,
        rowSelector: entry.rowSelector,
        idPrefixes: entry.section === "skills" ? ["skills-"] : indexedRepeatablePrefixes(entry.section),
        suffixes: entry.fields.map(({ suffix }) => suffix),
      })),
    };
    const unreviewed: { readonly candidate: Locator; readonly machineKey: string | null }[] = [];
    for (const candidate of candidates) {
      const admitted = await candidate.evaluate((element, reviewed) => {
        if (element.getAttribute("role") === "radio" &&
            element.closest('[role="radiogroup"]') !== null) return true;
        if (element.matches('input[type="file"][data-automation-id="file-upload-input-ref"]')) {
          const owner = element.closest('[data-fkit-id]');
          return owner === null || owner.getAttribute('data-fkit-id') === 'resumeAttachments--attachments';
        }
        if (reviewed.scalarSelectors.some((selector) => element.matches(selector))) {
          return true;
        }
        if (element.matches([
          "input:not([type]):not([id]):not([name]):not([data-automation-id])",
          ":not([role]):not([placeholder]):not([aria-label])",
        ].join(""))) {
          const owner = element.closest(
            '[data-automation-id="formField"], [data-automation-id^="formField-"]',
          );
          if (owner !== null && reviewed.scalarSelectors.some((selector) =>
            owner.querySelector(selector) !== null
          )) return true;
        }
        if (element instanceof HTMLInputElement && element.matches(
          'input[type="text"]:not([id]):not([name]):not([data-automation-id]):not([role]):not([placeholder]):not([aria-label]):not([required]):not([aria-required="true"])',
        ) && element.clientWidth === 0 && element.clientHeight === 0 &&
            element.labels?.length === 0) {
          const owner = element.closest('[data-automation-id^="formField-"]');
          if (owner !== null && reviewed.choiceSelectors.some((selector) =>
            owner.querySelector(selector) !== null
          )) return true;
        }
        if (
          element.getAttribute("role") === "radiogroup" &&
          reviewed.radioGroupSelectors.some((selector) =>
            element.querySelector(selector) !== null
          )
        ) return true;
        return reviewed.repeatables.some((entry) => {
          if (entry.idPrefixes.some(prefix => element.id.startsWith(prefix)) && entry.suffixes.some((suffix) =>
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
      if (await candidate.isDisabled()) continue;
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
      const emptyDatePart = !isRequired ? await candidate.evaluate(element => {
        const owner = element.closest('[data-automation-id="dateInputWrapper"][role="group"]');
        if (!owner || owner.getAttribute('aria-required') === 'true') return null;
        const parts = ['Month', 'Day', 'Year'];
        const inputs = parts.map(part => [...owner.querySelectorAll<HTMLInputElement>(`input[role="spinbutton"][data-automation-id="dateSection${part}-input"]`)]);
        if (inputs.some(matches => matches.length !== 1 || matches[0]!.value !== '' || matches[0]!.required || matches[0]!.getAttribute('aria-required') === 'true')) return null;
        const index = inputs.findIndex(matches => matches[0] === element);
        return index < 0 ? null : parts[index]!;
      }) : null;
      const uiBehavior = emptyDatePart === "Month" ? "month" : emptyDatePart === "Year" ? "year" : emptyDatePart === "Day" ? "number" : await unknownUiBehavior(candidate);
      const uiVariant = emptyDatePart === null ? "workday_unknown_required_v1" : "workday_empty_optional_date_segment_v1";
      const resolved: ResolvedControl = {
        locator: candidate,
        fieldId: `unknown.${isRequired ? "required" : "optional"}.${ordinal}`,
        uiBehavior,
        uiVariant,
        binderStrategy: "opaque_machine_key",
      };
      const currentReadback = await this.#readback(candidate, uiBehavior).catch(() => null);
      let allowedOptions = await unknownAllowedOptions(candidate);
      if (allowedOptions.length === 0 && isChoice(uiBehavior) &&
          uiBehavior !== "radio_group" && this.#inspectMissingOptions && inspectInteractiveOptions) {
        // Match known scalar choices: read a valid committed value without
        // reopening its popup. Cleared or invalid dependencies discover afresh.
        allowedOptions = currentReadback !== null &&
            (uiBehavior === "search_select" || uiBehavior === "select") &&
            await validationCleared(candidate)
          ? [currentReadback]
          : await this.#observeOptionLabels(resolved, [candidate], true);
      }
      const constraints = await unknownConstraints(candidate);
      const label = await observedControlLabel(candidate, uiBehavior) ?? stableKey;
      unknown.push({
        controlId: `unknown-required:${ordinal}`,
        fieldId: `unknown.${isRequired ? "required" : "optional"}.${ordinal}`,
        label,
        required: isRequired,
        uiBehavior,
        uiVariant,
        readback: currentReadback,
        ...(allowedOptions.length === 0 ? {} : { allowedOptions }),
        ...(constraints === undefined ? {} : { constraints }),
      });
      this.#controls.set(`unknown-required:${ordinal}`, resolved);
    }
    return unknown;
  }

  async #selectSearchOption(
    control: Locator,
    value: string,
    interaction: MutableInteraction,
    behavior: "search_select" | "select" | "multi_select",
  ): Promise<void> {
    const resolved = [...this.#controls.values()].find(candidate => candidate.locator === control);
    if (resolved?.fieldId === "source.how_did_you_hear" &&
        !this.#observedSourceCategories.has(normalize(value)) &&
        await control.evaluate(element => element instanceof HTMLInputElement && !element.readOnly)) {
      // A stored answer can reach this path without an interactive inspection.
      // Discover its category before attempting to select the leaf.
      await this.#observeOptionLabels(resolved, [control], true);
    }
    const priorCatalogs = behavior === "multi_select" || /^(?:source--source|education-[^\s]+--(?:school|fieldOfStudy))$/u.test(await control.getAttribute("id") ?? "")
      ? await this.#page.locator('[role="listbox"]:visible').elementHandles()
      : undefined;
    try {
      await this.#selectSearchOptionWithOwner(control, value, interaction, behavior, priorCatalogs);
    } finally {
      await Promise.all((priorCatalogs ?? []).map(handle => handle?.dispose()));
    }
  }

  async #selectSearchOptionWithOwner(
    control: Locator,
    value: string,
    interaction: MutableInteraction,
    behavior: "search_select" | "select" | "multi_select",
    priorCatalogs: readonly (ElementHandle | null)[] | undefined,
  ): Promise<void> {
    await control.click({ timeout: this.#timeoutMs });
    await this.#captureSelectionDiagnostic("clicked", behavior);
    const editable = await control.evaluate((element) =>
      (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) &&
      !element.readOnly
    );
    if (editable && behavior === "search_select") {
      await control.fill("", { timeout: this.#timeoutMs });
      await control.pressSequentially(value, { delay: 10, timeout: this.#timeoutMs });
      await this.#page.waitForTimeout(500);
    } else if (editable) {
      await control.fill(value, { timeout: this.#timeoutMs });
    }
    await this.#captureSelectionDiagnostic("typed", behavior);
    if (editable && (behavior === "multi_select" ||
        /^education-[^\s]+--school$/u.test(await control.getAttribute("id") ?? ""))) {
      await control.press("Enter", { timeout: this.#timeoutMs });
      await this.#page.waitForTimeout(250);
      await this.#captureSelectionDiagnostic("search-submitted", behavior);
      if (await this.#selectionReadbackIncludes(control, behavior, value)) {
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
      if (behavior !== "select" &&
          await this.#selectSubmittedPromptOption(control, value, interaction, behavior, priorCatalogs)) return;
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
      if (
        editable && (behavior === "multi_select" || behavior === "search_select") &&
        await this.#selectPromptCatalogOption(control, value, interaction, behavior, priorCatalogs)
      ) return;
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
        interaction.backingValueCommitted = await this.#selectionReadbackIncludes(
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
        }
        const promptWrappers = await visibleLocators(field.locator(
          '[data-automation-id="responsiveMonikerPrompt"]',
        ));
        const searchButtons = await visibleLocators(field.locator(
          '[data-automation-id="promptSearchButton"]',
        ));
        if (promptWrappers.length > 1 || searchButtons.length > 1) {
          throw new TypeError("Workday prompt multi-select activator is ambiguous");
        }
        const activator = searchButtons[0] ?? promptWrappers[0];
        if (activator !== undefined) {
          if (await activator.getAttribute("data-automation-id") === "promptSearchButton") {
            await this.#openPromptSearch(activator, control);
          } else {
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
          if (await this.#selectPromptCatalogOption(control, value, interaction, behavior, priorCatalogs)) return;
          const promptOptions = await visibleLocators(this.#page.locator([
            '[role="option"]',
            '[data-automation-id="promptOption"]',
            '[data-automation-id="promptLeafNode"]',
          ].join(", ")));
          if (process.env.HUNT_C3_VALUE_FREE_ACCOUNT_TRACE === "1") {
            try {
              const options = await Promise.all(promptOptions.slice(0, 64).map(async (option) => ({
                role: await option.getAttribute("role") ?? "",
                automationId: await option.getAttribute("data-automation-id") ?? "",
                label: (await option.innerText()).replace(/\s+/gu, " ").trim().slice(0, 160),
              })));
              process.stderr.write(`${JSON.stringify({ profilePromptVisibleOptions: options })}\n`);
            } catch {}
          }
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
            // Multi-select free entry was already attempted on the owning input
            // before the exact retained Skills prompt was opened. When that
            // prompt has no options, retrying delimiters against its search
            // input is redundant and can wait through a Workday remount.
            const emptySkillsPrompt = behavior === "multi_select" &&
              await control.getAttribute("id") === "skills--skills" &&
              await field.getAttribute("data-automation-id") === "formField-skills" &&
              promptOptions.length === 0;
            if (emptySkillsPrompt) {
              throw new TypeError("Workday prompt multi-select option is unavailable");
            }
            const delimiters = ["Enter", "Tab", ","] as const;
            for (const [index, delimiter] of delimiters.entries()) {
              if (index > 0) {
                if (!await promptSearch.isVisible()) break;
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
              if (await this.#selectionReadbackIncludes(control, behavior, value)) {
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
          interaction.backingValueCommitted = await this.#selectionReadbackIncludes(
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
      }
      if (editable) {
        await control.fill("", { timeout: this.#timeoutMs });
        await control.pressSequentially(value, { delay: 10, timeout: this.#timeoutMs });
      }
      await control.focus({ timeout: this.#timeoutMs });
      await control.press("Enter", { timeout: this.#timeoutMs });
      // Enter can commit asynchronously. Observe the owned value without
      // repeating Enter or accepting the search draft as a saved selection.
      const commitDeadline = Date.now() + Math.min(this.#timeoutMs, 5_000);
      do {
        interaction.backingValueCommitted = await this.#selectionReadbackIncludes(control, behavior, value);
        interaction.validationCleared = await validationCleared(control);
        if (interaction.backingValueCommitted && interaction.validationCleared) break;
        await this.#page.waitForTimeout(50);
      } while (Date.now() < commitDeadline);
      await this.#captureSelectionDiagnostic("free-entry-committed", behavior);
      interaction.popupBound = false;
      interaction.optionFocused = false;
      interaction.optionActivated = true;
      interaction.popupClosed = true;
      interaction.visibleOptionCount = 0;
      interaction.selectedOptionOrdinal = 0;
      interaction.backingValueCommitted = await this.#selectionReadbackIncludes(
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
    const selectionTimeoutMs = behavior === "multi_select"
      ? Math.min(this.#timeoutMs, 5_000)
      : this.#timeoutMs;
    const selectionDeadline = Date.now() + selectionTimeoutMs;
    const remainingSelectionTime = () => Math.max(1, selectionDeadline - Date.now());
    const listbox = await this.#waitForExactVisible(
      await exactIdLocator(this.#page, relationshipIds[0]!),
      selectionTimeoutMs,
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
    const selectionValue = await flatSourceSelectionValue(control, listbox, value);
    if (
      await control.getAttribute("id") === "phoneNumber--phoneType" &&
      !await hasExactSelectableCandidate(listbox, selectionValue)
    ) {
      await this.#selectV2PhoneType(control, listbox, selectionValue, interaction);
      return;
    }
    try {
      const selected = await this.#waitForSelectableLeaf(
        listbox,
        selectionValue,
        expandedCategories,
        !fallbackScope,
        remainingSelectionTime(),
      );
      await this.#captureSelectionDiagnostic("option-found", behavior);
      interaction.visibleOptionCount = selected.visibleOptionCount;
      interaction.selectedOptionOrdinal = selected.selectedOptionOrdinal;
      interaction.optionFocused = await selected.option.evaluate((element) =>
        element.ownerDocument.activeElement === element
      );
      await selected.option.click({ timeout: this.#timeoutMs });
      interaction.optionActivated = true;
    } catch (error) {
      if (error instanceof Error && error.message === "Workday selectable leaf is ambiguous") throw error;
      // `fill` has already entered the query for editable Workday comboboxes.
      // Re-typing appended the same query (for example `PythonPython`) and made
      // an otherwise valid typeahead result impossible to match exactly.
      if (editable) await control.fill(selectionValue, { timeout: this.#timeoutMs });
      else await this.#page.keyboard.type(selectionValue);
      await this.#page.waitForTimeout(100);
      await this.#captureSelectionDiagnostic("fallback-typed", behavior);
      const activeId = await control.getAttribute("aria-activedescendant") ??
        await listbox.getAttribute("aria-activedescendant");
      interaction.optionFocused = activeId !== null;
      const revealed = await this.#waitForSelectableLeaf(
        listbox,
        selectionValue,
        expandedCategories,
        !fallbackScope,
        remainingSelectionTime(),
      )
        .catch(error => {
          if (error instanceof Error && error.message === "Workday selectable leaf is ambiguous") throw error;
          return undefined;
        });
      const active = activeId === null
        ? undefined
        : await exactActiveOption(this.#page, activeId, selectionValue);
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
        !await this.#selectionReadbackIncludes(control, behavior, selectionValue) &&
        await selectionPopupVisible(listbox, fallbackScope)
      ) {
        const nested = await this.#waitForSelectableLeaf(
          listbox,
          selectionValue,
          expandedCategories,
          !fallbackScope,
          remainingSelectionTime(),
        )
          .catch(error => {
            if (error instanceof Error && error.message === "Workday selectable leaf is ambiguous") throw error;
            return undefined;
          });
        if (nested !== undefined) {
          interaction.visibleOptionCount = nested.visibleOptionCount;
          interaction.selectedOptionOrdinal = nested.selectedOptionOrdinal;
          await nested.option.click({ timeout: this.#timeoutMs });
          await this.#page.waitForTimeout(100);
        }
      }
      if (!await this.#selectionReadbackIncludes(control, behavior, selectionValue)) {
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
    interaction.backingValueCommitted = await this.#selectionReadbackIncludes(
      control,
      behavior,
      selectionValue,
    );
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

  async #selectSubmittedPromptOption(
    control: Locator,
    value: string,
    interaction: MutableInteraction,
    behavior: "search_select" | "multi_select",
    priorCatalogs: readonly (ElementHandle | null)[] | undefined,
    searchSkillAliases = true,
  ): Promise<boolean> {
    const acceptedLabels = this.#selectionOptionLabels(control, value);
    const skill = [...this.#controls.values()].some(candidate =>
      candidate.locator === control && candidate.fieldId === "skills.values");
    // A submitted search can still be loading after the initial animation.
    // Do not fall through to clearing/retyping and cancel its pending request.
    const deadline = Date.now() + (await control.getAttribute("enterkeyhint") === "search"
      ? Math.min(this.#timeoutMs, 5_000) : 0);
    let visibleOptions: Locator[] = [];
    let exact: Locator[] = [];
    do {
      // Enter may commit a free-entry tag asynchronously while its search UI
      // is still visible. Observe that result before attempting another effect.
      if (await this.#selectionReadbackIncludes(control, behavior, value)) {
        interaction.popupBound = false;
        interaction.optionFocused = false;
        interaction.optionActivated = true;
        interaction.visibleOptionCount = 0;
        interaction.selectedOptionOrdinal = 0;
        await this.#page.keyboard.press("Escape");
        interaction.popupClosed = await control.getAttribute("aria-expanded") !== "true";
        interaction.backingValueCommitted = true;
        interaction.validationCleared = await validationCleared(control);
        if (!interaction.validationCleared) throw new TypeError("Workday submitted multi-select validation did not clear");
        return true;
      }
      const owner = await exactPromptCatalogOwner(this.#page, control, priorCatalogs);
      const options = owner?.locator('[role="option"]:visible');
      // Read one result window together. Virtualized rows can disappear between
      // separate innerText calls as scrolling or an Enter commit updates it.
      const labels = options === undefined ? [] : await options.allInnerTexts();
      // Virtualized rows can change position before activation. Keep the
      // answer identity in the locator so a shifted row cannot receive its click.
      visibleOptions = labels.map(label => options!.filter({
        hasText: new RegExp("^\\s*" + label.trim().split(/\s+/u)
          .map(part => part.replace(/[.*+?^$()|[\]{}\\]/g, "\\$&"))
          .join("\\s+") + "\\s*$", "u"),
      }).first());
      exact = [];
      const literal: Locator[] = [];
      for (const [index, text] of labels.slice(0, 128).entries()) {
        const option = visibleOptions[index]!;
        const label = normalize(text);
        if (label === normalize(value)) literal.push(option);
        if (acceptedLabels.has(label)) exact.push(option);
      }
      // Equivalent labels are fallbacks, not competing answers when the
      // catalog also offers the requested label verbatim.
      if (literal.length > 0) exact = literal;
      if (exact.length > 0 || Date.now() >= deadline) break;
      if (owner !== undefined) await advanceOptionWindow(owner);
      await this.#page.waitForTimeout(50);
    } while (Date.now() < deadline);
    if (exact.length === 0) {
      // Broad skill searches may omit the exact language from their result
      // window. Search the same semantic aliases used for independent readback.
      if (searchSkillAliases && skill) {
        for (const alias of acceptedLabels) {
          if (alias === normalize(value)) continue;
          await this.#page.keyboard.press("Escape");
          await control.fill(alias, { timeout: this.#timeoutMs });
          await control.press("Enter", { timeout: this.#timeoutMs });
          if (await this.#selectSubmittedPromptOption(
            control, value, interaction, behavior, priorCatalogs, false,
          )) return true;
        }
      }
      return false;
    }
    // A skill catalog can contain multiple IDs for the same canonical skill.
    // Select one equivalent entry, never duplicate tokens or a related product.
    if (exact.length > 1 && !skill) {
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
    // The Workday row owns selection; its nested checkbox can toggle without
    // committing a token to the form.
    const leaves = await visibleLocators(option.locator('[data-automation-id="promptLeafNode"]'));
    // Enter may commit after the earlier observation. Do not toggle that
    // already-saved answer off when its result remains visible.
    if (!await this.#selectionReadbackIncludes(control, behavior, value)) {
      try {
        await (leaves.length === 1 ? leaves[0]! : inputs[0] ?? await promptOptionActivation(option))
          .click({ timeout: Math.min(this.#timeoutMs, 5_000) });
      } catch (error) {
        // Enter can save the answer while Playwright waits for its option to
        // settle. Accept that exact committed token, never a vanished row alone.
        if (!await this.#selectionReadbackIncludes(control, behavior, value)) throw error;
      }
    }
    interaction.optionActivated = true;
    const commitDeadline = Date.now() + Math.min(this.#timeoutMs, 5_000);
    do {
      interaction.backingValueCommitted = await this.#selectionReadbackIncludes(control, behavior, value);
      if (interaction.backingValueCommitted) break;
      await this.#page.waitForTimeout(50);
    } while (Date.now() < commitDeadline);
    await this.#page.keyboard.press("Escape");
    await this.#page.waitForTimeout(25);
    interaction.popupClosed = await control.getAttribute("aria-expanded") !== "true";
    interaction.backingValueCommitted = await this.#selectionReadbackIncludes(
      control,
      behavior,
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
    priorCatalogs?: readonly (ElementHandle | null)[],
  ): Promise<boolean> {
    const owner = await exactPromptCatalogOwner(this.#page, control, priorCatalogs);
    if (owner === undefined) return false;
    let options = owner.locator([
      '[role="option"]:visible',
      '[data-automation-id="promptOption"]:visible',
      '[data-automation-id="promptLeafNode"]:visible',
    ].join(", "));
    const initial = await visibleLocators(options);
    const acceptedLabels = this.#selectionOptionLabels(control, value);
    const initialLabels = await Promise.all(initial.map(async (option) =>
      normalize(await option.innerText())
    ));
    if (process.env.HUNT_C3_VALUE_FREE_ACCOUNT_TRACE === "1") {
      process.stderr.write(`${JSON.stringify({
        profilePromptTypeaheadVisibleOptions: initialLabels.slice(0, 64),
      })}\n`);
      if (await control.getAttribute("id") === "source--source") {
        process.stderr.write(`${JSON.stringify({
          profileSourceOptionStructure: await options.evaluateAll(elements => elements.slice(0, 32).map(element => ({
            tag: element.tagName,
            role: element.getAttribute("role"),
            automationId: element.getAttribute("data-automation-id"),
            expanded: element.getAttribute("aria-expanded"),
            hasPopup: element.getAttribute("aria-haspopup"),
            descendants: [...element.querySelectorAll('[data-automation-id], [role], input')].slice(0, 16).map(child => ({
              tag: child.tagName,
              role: child.getAttribute("role"),
              automationId: child.getAttribute("data-automation-id"),
              type: child.getAttribute("type"),
            })),
          }))),
        })}\n`);
      }
    }
    const initialExact: { readonly option: Locator; readonly rank: number }[] = [];
    for (const [index, option] of initial.entries()) {
      const automationId = await option.getAttribute("data-automation-id");
      if (!acceptedLabels.has(initialLabels[index]!) || automationId === "selectedItem") continue;
      const row = option.locator('xpath=ancestor-or-self::*[@role="option"][1]');
      if (await control.getAttribute("id") === "source--source" && await row.count() === 1 &&
          await row.locator('svg[role="presentation"]').count() > 0 &&
          await row.locator('input, [role="checkbox"], [role="radio"]').count() === 0) continue;
      initialExact.push({
        option,
        rank: await option.getAttribute("role") === "option"
          ? 0
          : automationId === "promptLeafNode" ? 1 : 2,
      });
    }
    const preferredRank = Math.min(...initialExact.map(({ rank }) => rank));
    const preferredExact = initialExact.filter(({ rank }) => rank === preferredRank);
    if (preferredExact.length > 1) {
      throw new TypeError("Workday prompt typeahead option is ambiguous");
    }
    if (preferredExact.length === 1) {
      const option = preferredExact[0]!.option;
      return await this.#commitPromptCatalogOption(
        control,
        value,
        interaction,
        behavior,
        option,
        initial.length,
        initial.indexOf(option) + 1,
        options,
      );
    }
    const sourceCategory = (await control.getAttribute("id") === "source--source"
      ? this.#observedSourceCategories.get(normalize(value)) : undefined) ?? sourcePromptCategory(value);
    if (behavior === "search_select" && sourceCategory !== undefined) {
      const category = await preferredPromptOption(initial, new Set([normalize(sourceCategory)]));
      if (category !== undefined) {
        await (await promptOptionActivation(category)).click({ timeout: this.#timeoutMs });
        await this.#page.waitForTimeout(100);
        const nestedOwner = await exactPromptCatalogOwner(this.#page, control, priorCatalogs) ??
          (await owner.isVisible() ? owner : undefined);
        if (nestedOwner === undefined) {
          throw new TypeError("Workday source prompt category lost its owner");
        }
        options = nestedOwner.locator([
          '[role="option"]:visible',
          '[data-automation-id="promptOption"]:visible',
          '[data-automation-id="promptLeafNode"]:visible',
        ].join(", "));
        const nested = await visibleLocators(options);
        const nestedExact = await preferredPromptOption(nested, acceptedLabels);
        if (process.env.HUNT_C3_VALUE_FREE_ACCOUNT_TRACE === "1") {
          process.stderr.write(`${JSON.stringify({
            profilePromptCategoryVisibleOptions: (await Promise.all(nested.map(async (option) =>
              normalize(await option.innerText())
            ))).slice(0, 64),
          })}\n`);
        }
        if (nestedExact === undefined) {
          throw new TypeError("Workday source prompt category option is unavailable");
        }
        return await this.#commitPromptCatalogOption(
          control,
          value,
          interaction,
          behavior,
          nestedExact,
          nested.length,
          nested.indexOf(nestedExact) + 1,
          options,
        );
      }
    }
    const scopes: Locator[] = [];
    for (const option of initial) {
      if (promptScopeLabel(await option.innerText())) {
        scopes.push(option);
      }
    }
    if (scopes.length === 0) return false;
    const scope = await preferredPromptOption(
      scopes, new Set(["partial list (first 500 entries)"]),
    ) ?? await exactNormalizedOption(scopes, "All");
    await scope.click({ timeout: this.#timeoutMs });
    await this.#page.waitForTimeout(100);
    await control.click({ timeout: this.#timeoutMs });
    await control.fill(value, { timeout: this.#timeoutMs });
    await this.#page.waitForTimeout(500);

    const candidates: Locator[] = [];
    const candidateLabels: string[] = [];
    for (const option of await visibleLocators(options)) {
      const label = normalize(await option.innerText());
      if (!promptScopeLabel(label)) {
        candidates.push(option);
        candidateLabels.push(label);
      }
    }
    if (process.env.HUNT_C3_VALUE_FREE_ACCOUNT_TRACE === "1") {
      process.stderr.write(`${JSON.stringify({
        profilePromptCatalogVisibleOptions: candidateLabels.slice(0, 64),
      })}\n`);
    }
    const exact = candidates.filter((_, index) => acceptedLabels.has(candidateLabels[index]!));
    if (exact.length > 1) {
      throw new TypeError("Workday prompt catalog option is ambiguous");
    }
    if (exact.length === 0) throw new TypeError("Workday prompt catalog option is unavailable");
    return await this.#commitPromptCatalogOption(
      control,
      value,
      interaction,
      behavior,
      exact[0]!,
      candidates.length,
      candidates.indexOf(exact[0]!) + 1,
      options,
    );
  }

  async #commitPromptCatalogOption(
    control: Locator,
    value: string,
    interaction: MutableInteraction,
    behavior: "search_select" | "multi_select",
    option: Locator,
    visibleOptionCount: number,
    selectedOptionOrdinal: number,
    options: Locator,
  ): Promise<boolean> {
    interaction.popupBound = false;
    interaction.visibleOptionCount = visibleOptionCount;
    interaction.selectedOptionOrdinal = selectedOptionOrdinal;
    interaction.optionFocused = await option.getAttribute("aria-selected") === "true";
    const activation = await promptOptionActivation(option);
    try {
      try {
        await activation.click({
          timeout: behavior === "multi_select"
            ? Math.min(this.#timeoutMs, 5_000)
            : this.#timeoutMs,
        });
        interaction.optionActivated = true;
      } finally {
        await this.#page.keyboard.press("Escape");
        await control.blur({ timeout: this.#timeoutMs });
        await this.#page.waitForTimeout(100);
      }
    } catch (error) {
      // A Workday prompt row can commit and remount while Playwright is still
      // waiting for its stale activation target. Reconcile exact field-owned
      // backing truth promptly instead of spending the full page budget or
      // repeating an effect whose outcome is already committed.
      interaction.backingValueCommitted = await this.#selectionReadbackIncludes(
        control,
        behavior,
        value,
      );
      interaction.validationCleared = await validationCleared(control);
      if (!interaction.backingValueCommitted || !interaction.validationCleared) {
        throw error;
      }
    }
    interaction.popupClosed = (await visibleLocators(options)).length === 0;
    interaction.backingValueCommitted = await this.#selectionReadbackIncludes(
      control,
      behavior,
      value,
    );
    interaction.validationCleared = await validationCleared(control);
    if (!interaction.backingValueCommitted || !interaction.validationCleared) {
      if (process.env.HUNT_C3_VALUE_FREE_ACCOUNT_TRACE === "1") {
        await this.#captureSelectionDiagnostic("prompt-uncommitted", behavior);
        process.stderr.write(`${JSON.stringify({
          profilePromptUncommittedVisibleOptions: (await options.allInnerTexts()).slice(0, 64).map(normalize),
        })}\n`);
      }
      throw new TypeError("Workday prompt catalog value did not commit");
    }
    if (await control.getAttribute("id") === "source--source") {
      await this.#captureSelectionDiagnostic("prompt-committed", behavior);
    }
    return true;
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
    interaction.backingValueCommitted = await this.#selectionReadbackIncludes(control, "select", value);
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
    try {
      const structure = await this.#page.evaluate(() => {
        type Fiber = {
          readonly memoizedProps?: unknown;
          readonly pendingProps?: unknown;
          readonly memoizedState?: unknown;
          readonly return?: Fiber | null;
          readonly type?: unknown;
          readonly elementType?: unknown;
        };
        type DiagnosticState = {
          readonly nodes: WeakMap<Element, number>;
          nextNodeId: number;
        };
        const root = globalThis as typeof globalThis & {
          __huntProfileSelectionDiagnosticState?: DiagnosticState;
        };
        const state = root.__huntProfileSelectionDiagnosticState ??= {
          nodes: new WeakMap<Element, number>(),
          nextNodeId: 1,
        };
        const nodeId = (element: Element): number => {
          const existing = state.nodes.get(element);
          if (existing !== undefined) return existing;
          const next = state.nextNodeId;
          state.nextNodeId += 1;
          state.nodes.set(element, next);
          return next;
        };
        const componentName = (value: unknown): string => {
          if (typeof value === "string") return value.slice(0, 80);
          if (typeof value === "function") return (value.name || "anonymous").slice(0, 80);
          if (typeof value === "object" && value !== null) {
            const named = value as { readonly displayName?: unknown; readonly name?: unknown };
            if (typeof named.displayName === "string") return named.displayName.slice(0, 80);
            if (typeof named.name === "string") return named.name.slice(0, 80);
          }
          return "unknown";
        };
        const handlers = (props: unknown) => typeof props === "object" && props !== null
          ? Object.entries(props).filter(([name, value]) =>
            /^on[A-Z]/u.test(name) && typeof value === "function"
          ).map(([name, value]) => ({
            name,
            arity: (value as (...args: unknown[]) => unknown).length,
          })).slice(0, 24)
          : [];
        const field = document.getElementById("source--source")?.closest(
          '[data-automation-id="formField"], [data-automation-id^="formField-"]',
        ) ?? document.querySelector(
          '[data-automation-id="formField-source"], [data-automation-id^="formField-source--"]',
        );
        const selectors = [
          '[id="source--source"]',
          '[data-automation-id="selectedItem"]',
          '[data-automation-id="multiSelectContainer"]',
          'input[data-automation-id="searchBox"]',
          '[data-automation-id="monikerSearchBox"]',
          '[data-automation-id="promptSearchButton"]',
          '[data-automation-id="promptSearchButton"] svg',
          '[data-automation-id="responsiveMonikerPrompt"]',
        ];
        return selectors.flatMap((selector) => {
          const elements = field === null ? [] : [...field.querySelectorAll(selector)];
          return elements.slice(0, 4).map((element) => {
            const record = element as unknown as Record<string, unknown>;
            const propsKeys = Object.keys(element).filter((key) => key.startsWith("__reactProps$"));
            const ownProps = propsKeys.flatMap((key) => {
              const props = record[key];
              return typeof props === "object" && props !== null
                ? [{ keys: Object.keys(props).slice(0, 40), handlers: handlers(props) }]
                : [];
            });
            const fiberKey = Object.keys(element).find((key) =>
              key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$")
            );
            let fiber = fiberKey === undefined ? undefined : record[fiberKey] as Fiber | undefined;
            const shape = (value: unknown): string => Array.isArray(value)
              ? `array:${value.length}:${value[0] !== null && typeof value[0] === "object" ? Object.keys(value[0]).slice(0, 12).join(",") : typeof value[0]}`
              : value !== null && typeof value === "object" ? `object:${Object.keys(value).slice(0, 12).join(",")}` : typeof value;
            const propsShape = (props: unknown): Record<string, string> => props !== null && typeof props === "object"
              ? Object.fromEntries(Object.entries(props).slice(0, 40).map(([key, value]) => [key, shape(value)])) : {};
            const fiberLayers: { component: string; handlers: ReturnType<typeof handlers>; propsShape: Record<string, string>; stateShape: Record<string, string> }[] = [];
            for (let depth = 0; fiber !== undefined && fiber !== null && depth < 16; depth += 1) {
              const props = fiber.memoizedProps ?? fiber.pendingProps;
              const layerHandlers = handlers(props);
              const component = componentName(fiber.elementType ?? fiber.type);
              if (component !== "unknown" || layerHandlers.length > 0) {
                fiberLayers.push({ component, handlers: layerHandlers, propsShape: propsShape(props), stateShape: propsShape(fiber.memoizedState) });
              }
              fiber = fiber.return ?? undefined;
            }
            const rect = element.getBoundingClientRect();
            const x = rect.left + rect.width / 2;
            const y = rect.top + rect.height / 2;
            const hit = rect.width > 0 && rect.height > 0 ? document.elementFromPoint(x, y) : null;
            return {
              selector,
              nodeId: nodeId(element),
              tag: element.tagName.toLocaleLowerCase("en-US"),
              automationId: element.getAttribute("data-automation-id") ?? "",
              role: element.getAttribute("role") ?? "",
              ariaExpanded: element.getAttribute("aria-expanded"),
              ariaControlsCount: element.getAttribute("aria-controls")?.trim()
                .split(/\s+/u).filter(Boolean).length ?? 0,
              visible: getComputedStyle(element).display !== "none" &&
                getComputedStyle(element).visibility !== "hidden" && rect.width > 0 && rect.height > 0,
              bounds: {
                x: Math.round(rect.x),
                y: Math.round(rect.y),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
              },
              hit: hit === null ? null : {
                tag: hit.tagName.toLocaleLowerCase("en-US"),
                automationId: hit.getAttribute("data-automation-id") ?? "",
                nodeId: nodeId(hit),
              },
              ownProps,
              fiberLayers,
            };
          });
        });
      });
      process.stderr.write(`${JSON.stringify({ profileSelectionStructure: structure })}\n`);
      const catalogs = await this.#page.locator(
        '[role="listbox"], [data-automation-id="activeListContainer"], [data-automation-id="responsiveMonikerPrompt"]',
      ).evaluateAll(elements => elements.slice(0, 16).map(element => ({
        role: element.getAttribute("role"),
        automationId: element.getAttribute("data-automation-id"),
        visible: element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden",
        optionCount: element.querySelectorAll('[role="option"], [data-automation-id="promptOption"], [data-automation-id="promptLeafNode"]').length,
        ownsFocus: element.contains(document.activeElement),
        sourceFieldOwned: element.closest('[data-automation-id="formField-source"]') !== null,
      })));
      process.stderr.write(`${JSON.stringify({ profileSelectionCatalogs: catalogs })}\n`);
    } catch {}
    const root = process.env.HUNT_C3_TRANSIENT_DIAGNOSTIC_ROOT;
    if (root === undefined || root === "") return;
    this.#selectionDiagnosticOrdinal += 1;
    try {
      const structure = await this.#page.locator(
        '[data-automation-id="formField-source"], [data-automation-id="activeListContainer"]',
      ).evaluateAll(elements => elements.filter(element => element.getClientRects().length > 0)
        .map(element => element.outerHTML));
      writeFileSync(`${root}\\profile-selection-${String(this.#selectionDiagnosticOrdinal).padStart(3, "0")}-${stage}.json`,
        JSON.stringify(structure), { mode: 0o600 });
      await this.#page.screenshot({
        path: `${root}\\profile-selection-${String(this.#selectionDiagnosticOrdinal).padStart(3, "0")}-${stage}.png`,
        fullPage: false,
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

  async #waitForExactVisible(
    locator: Locator,
    timeoutMs = this.#timeoutMs,
  ): Promise<Locator> {
    const deadline = Date.now() + timeoutMs;
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
    timeoutMs = this.#timeoutMs,
  ): Promise<{
    readonly option: Locator;
    readonly visibleOptionCount: number;
    readonly selectedOptionOrdinal: number;
  }> {
    const deadline = Date.now() + timeoutMs;
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
        throw new TypeError("Workday selectable leaf is ambiguous");
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
        throw new TypeError("Workday selectable leaf is ambiguous");
      }
      if (await advanceOptionWindow(listbox)) {
        await this.#page.waitForTimeout(50);
        continue;
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
    const visible = await controls.count() === 1 &&
        await controls.getAttribute("role") === "radiogroup"
      ? await visibleLocators(controls.locator('[role="radio"], input[type="radio"]'))
      : await visibleLocators(controls);
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

async function flatSourceSelectionValue(
  control: Locator,
  listbox: Locator,
  requested: string,
): Promise<string> {
  if (
    await control.getAttribute("id") !== "source--source" ||
    normalize(requested) !== "recruiter" ||
    await hasExactSelectableCandidate(listbox, requested)
  ) return requested;
  return await hasExactSelectableCandidate(listbox, "Direct Sourcing")
    ? "Direct Sourcing"
    : requested;
}

async function exactActiveOption(
  page: Page,
  identifier: string,
  value: string,
): Promise<Locator | undefined> {
  const option = await exactIdLocator(page, identifier);
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
    if (role === "listbox" && element.getAttribute("aria-multiselectable") === "true") {
      return "multi_select";
    }
    if (element instanceof HTMLSelectElement) {
      return element.multiple ? "multi_select" : "select";
    }
    if (element instanceof HTMLTextAreaElement) return "textarea";
    if (
      role === "combobox" ||
      element.getAttribute("aria-haspopup") === "listbox"
    ) return "search_select";
    if (element instanceof HTMLInputElement) {
      // Workday prompts can omit ARIA combobox semantics. Bind the input to
      // its own widget before treating it as a choice rather than free text.
      const widgetId = element.getAttribute("data-uxi-multiselect-id");
      const widget = element.closest('[data-automation-id="multiSelectContainer"][data-uxi-widget-type="multiselect"]');
      if (element.getAttribute("data-uxi-widget-type") === "selectinput" &&
          widgetId && widget?.id === widgetId &&
          [...widget.querySelectorAll('input[data-uxi-widget-type="selectinput"]')]
            .filter(input => input.getAttribute("data-uxi-multiselect-id") === widgetId).length === 1) {
        return "search_select";
      }
      if (element.type === "checkbox") return "checkbox";
      if (element.type === "date") return "date";
      if (element.type === "month") return "month";
      if (element.type === "file") return "file";
      if (element.type === "radio") return "radio_group";
      if (element.type === "tel") return "phone";
      if (element.type === "number") return "number";
      if (element.type === "url") return "url";
    }
    return "text";
  });
}

async function unknownConstraints(
  locator: Locator,
): Promise<ProfileControlSnapshot["constraints"] | undefined> {
  return await locator.evaluate((element) => {
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) &&
        !(element instanceof HTMLElement && element.isContentEditable)) return undefined;
    const numeric = (value: string | null): number | null => {
      if (value === null || value.trim() === "") return null;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    };
    if (element instanceof HTMLInputElement && element.type === "file") {
      const acceptedExtensions = element.accept.split(",").map((item) => item.trim().toLowerCase())
        .filter((item) => /^\.[a-z0-9]{1,10}$/u.test(item));
      const exposedMaximum = Number(element.getAttribute("data-max-file-size") ?? "");
      return {
        inputType: "text" as const,
        min: null,
        max: null,
        step: null,
        minLength: null,
        maxLength: null,
        pattern: null,
        acceptedExtensions,
        maxFileBytes: Number.isSafeInteger(exposedMaximum) && exposedMaximum > 0
          ? exposedMaximum
          : null,
      };
    }
    const inputType = element instanceof HTMLInputElement &&
        ["email", "url", "number"].includes(element.type)
      ? element.type as "email" | "url" | "number"
      : "text" as const;
    const maxLength = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
      ? element.maxLength
      : Number(element.getAttribute("maxlength") ?? -1);
    return {
      inputType,
      min: numeric(element.getAttribute("min")),
      max: numeric(element.getAttribute("max")),
      step: numeric(element.getAttribute("step")),
      minLength: (() => {
        const value = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
          ? element.minLength
          : Number(element.getAttribute("minlength") ?? -1);
        return Number.isSafeInteger(value) && value >= 0 ? value : null;
      })(),
      maxLength: Number.isSafeInteger(maxLength) && maxLength >= 0 ? maxLength : null,
      pattern: element.getAttribute("pattern"),
    };
  });
}

async function unknownAllowedOptions(locator: Locator): Promise<readonly string[]> {
  return Object.freeze(await locator.evaluate((element) => {
    const normalize = (value: string | null | undefined) =>
      (value ?? "").normalize("NFC").replace(/\s+/gu, " ").trim();
    const owner = element.closest(
      '[data-automation-id="formField"], [data-automation-id^="formField-"]',
    ) ?? element;
    const options = element instanceof HTMLSelectElement
      ? [...element.options].filter((option) => !option.disabled &&
          !(option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled))
        .map((option) => normalize(option.label || option.textContent))
      : [...owner.querySelectorAll(
          '[role="option"], [role="radio"], input[type="radio"], input[type="checkbox"]',
        )].filter(option => option.closest(
          '[data-automation-id="selectedItem"], [data-automation-id="selectedItemList"]',
        ) === null).map((option) => {
          if (option instanceof HTMLInputElement) {
            return normalize(option.labels?.[0]?.textContent ?? option.getAttribute("aria-label"));
          }
          return normalize(option.getAttribute("aria-label") ?? option.textContent);
        });
    return [...new Set(options.filter((option) => option !== "" &&
      !/^(?:select|select one|choose|choose one)$/iu.test(option)))].slice(0, 128);
  }));
}

async function unknownMachineKey(locator: Locator): Promise<string | null> {
  return await locator.evaluate((element) => {
    const type = element instanceof HTMLInputElement ? element.type : "element";
    if (element instanceof HTMLInputElement && element.type === "file") {
      const owner = element.closest('[data-fkit-id]');
      const key = owner?.getAttribute('data-fkit-id');
      if (key && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(key) &&
          element.ownerDocument.querySelectorAll(`[data-fkit-id="${key}"]`).length === 1 &&
          owner!.querySelectorAll('input[type="file"]').length === 1) {
        return ["input", "file", "workday-upload", key].join("\u0000");
      }
    }

    // Opening a Workday prompt adds searchBox/aria-controls to the same input.
    // Prefer the input ID: React can remount its owner with a new widget UUID.
    const widgetId = element.getAttribute("data-uxi-multiselect-id");
    const widget = element.closest('[data-automation-id="multiSelectContainer"][data-uxi-widget-type="multiselect"]');
    if (element instanceof HTMLInputElement &&
        element.getAttribute("data-uxi-widget-type") === "selectinput" &&
        widgetId && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(widgetId) &&
        widget?.id === widgetId &&
        element.ownerDocument.querySelectorAll(`[id="${widgetId}"]`).length === 1 &&
        [...widget.querySelectorAll('input[data-uxi-widget-type="selectinput"]')]
          .filter(input => input.getAttribute("data-uxi-multiselect-id") === widgetId).length === 1) {
      const inputId = element.id;
      if (inputId && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(inputId) &&
          element.ownerDocument.querySelectorAll(`[id="${inputId}"]`).length === 1) {
        return [element.tagName.toLowerCase(), type, "workday-prompt-input", inputId].join("\u0000");
      }
      return [element.tagName.toLowerCase(), type, "workday-prompt", widgetId].join("\u0000");
    }
    const automationId = element.getAttribute("data-automation-id");
    // A unique automation identity survives React replacing generated DOM IDs.
    // Repeated automation identities still need the full disambiguating key.
    if (automationId !== null && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(automationId) &&
        element.ownerDocument.querySelectorAll(
          `[data-automation-id="${automationId}"]`,
        ).length === 1) {
      return [element.tagName.toLowerCase(), type, "automation", automationId].join("\u0000");
    }
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
    return [element.tagName.toLowerCase(), type, ...attributes].join("\u0000");
  });
}

async function readback(
  locator: Locator,
  behavior: ProfileControlSnapshot["uiBehavior"],
  trace?: (event: string, details?: object) => void,
): Promise<string | null> {
  if (behavior === "checkbox") {
    return await checkboxReadback(locator) ? "true" : "false";
  }
  if (behavior === "file") {
    return await locator.evaluate((element) => {
      if (!(element instanceof HTMLInputElement) || element.type !== "file") return null;
      if (element.getAttribute("data-automation-id") === "file-upload-input-ref") {
        const owner = element.closest('[data-fkit-id]');
        const items = owner?.querySelectorAll('[data-automation-id="file-upload-item"]');
        if (items?.length !== 1 || owner?.querySelector('[data-automation-id="file-upload-error"]')) return null;
        const item = items[0]!;
        if (!item.matches('[data-upload-state="success"]') && !item.querySelector(
          '[data-automation-id="file-upload-success"], [data-automation-id="file-upload-successful"]',
        )) return null;
        const names = item.querySelectorAll('[data-automation-id="file-upload-item-name"]');
        return names.length === 1 ? names[0]!.textContent?.trim() || null : null;
      }
      if (element.files === null || element.files.length !== 1) return null;
      return element.files[0]?.name ?? null;
    });
  }
  if (behavior === "radio_group") {
    const ownerRole = await locator.getAttribute("role");
    const radios = ownerRole === "radiogroup"
      ? await visibleLocators(locator.locator('[role="radio"], input[type="radio"]'))
      : await visibleLocators(locator);
    return radioReadback(radios);
  }
  if (behavior === "text" && await locator.evaluate((element) =>
    element instanceof HTMLElement && element.isContentEditable
  )) {
    const value = (await locator.textContent() ?? "").normalize("NFC")
      .replace(/\s+/gu, " ").trim();
    return value === "" ? null : value;
  }
  if (behavior !== "search_select" && behavior !== "select" && behavior !== "multi_select") {
    const value = await locator.inputValue();
    return value === "" ? null : value;
  }
  const committed = behavior === "multi_select" || behavior === "search_select"
    ? await committedMultiSelectReadback(locator, trace)
    : null;
  if (committed !== null) return behavior === "search_select" && optionReadbackList(committed).length !== 1
    ? null : committed;
  const ariaValue = (await locator.getAttribute("aria-valuetext"))?.trim() ?? "";
  if (ariaValue !== "") return ariaValue;
  const selected = (await locator.getAttribute("data-selected-label"))?.trim() ?? "";
  if (selected !== "") return selected;
  const directSelected = await locator.evaluate((element) => {
    const normalize = (value: string | null | undefined) => (value ?? "")
      .normalize("NFC").replace(/\s+/gu, " ").trim();
    if (element instanceof HTMLSelectElement) {
      const labels = [...element.selectedOptions]
        .map((option) => normalize(option.label || option.textContent)).filter(Boolean);
      return labels.length > 1 ? JSON.stringify(labels) : labels[0] ?? "";
    }
    if (element.getAttribute("role") === "listbox") {
      const labels = [...element.querySelectorAll('[role="option"][aria-selected="true"]')]
        .map((option) => normalize(option.getAttribute("aria-label") ?? option.textContent))
        .filter(Boolean);
      return labels.length > 1 ? JSON.stringify(labels) : labels[0] ?? "";
    }
    return "";
  });
  if (directSelected !== "" && normalize(directSelected) !== "select one") {
    return directSelected;
  }
  if (await locator.evaluate((element) => element instanceof HTMLButtonElement)) {
    const label = (await locator.innerText()).replace(/\s+/gu, " ").trim();
    if (label !== "" && normalize(label) !== "select one") return label;
  }
  const field = locator.locator(
    'xpath=ancestor::*[@data-automation-id="formField" or starts-with(@data-automation-id,"formField-")][1]',
  );
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

async function resolvedReadback(
  control: ResolvedControl,
  trace?: (event: string, details?: object) => void,
): Promise<string | null> {
  if (control.uiBehavior === "radio_group") {
    return radioReadback(await visibleLocators(control.locator));
  }
  return readback(control.locator, control.uiBehavior, trace);
}

async function nativeCountryControlBinding(locator: Locator, fieldId: string): Promise<boolean> {
  const id = nativeCountryControlIds[fieldId];
  if (id === undefined) return false;
  return locator.evaluate((element, expectedId) => {
    if (element.id !== expectedId) return false;
    const key = expectedId.split("--")[1];
    const owner = element.closest('[data-automation-id^="formField-"]');
    if (owner?.getAttribute("data-automation-id") !== `formField-${key}`) return false;
    return key === "country"
      ? element instanceof HTMLButtonElement && element.name === "country" &&
        element.getAttribute("aria-haspopup") === "listbox"
      : element instanceof HTMLInputElement && element.type === "text" &&
        element.closest('[data-automation-id="multiSelectContainer"]') !== null;
  }, id);
}

async function nativeSocialAccountBinding(locator: Locator, fieldId: string): Promise<boolean> {
  const names = nativeSocialAccountNames[fieldId];
  if (names === undefined) return false;
  return locator.evaluate((element, allowedNames) => {
    if (!(element instanceof HTMLInputElement) || !["text", "url"].includes(element.type) ||
        !allowedNames.includes(element.name) ||
        element.id !== `socialNetworkAccounts--${element.name}`) return false;
    const owner = element.closest('[data-automation-id^="formField-"]');
    return owner?.getAttribute("data-automation-id") === `formField-${element.name}` &&
      owner.querySelectorAll("input:not([type=hidden]),textarea,select").length === 1;
  }, names);
}

async function observedControlLabel(
  locator: Locator,
  behavior: ProfileControlSnapshot["uiBehavior"],
): Promise<string | null> {
  const value = await locator.evaluate((element, radioGroup) => {
    const normalized = (text: string | null | undefined) => (text ?? "")
      .normalize("NFC").replace(/\s+/gu, " ").trim()
      .replace(/\s+(?:Not )?Required$/iu, "").replace(/\s*\*\s*$/u, "")
      .replace(/\s*:\s*$/u, "").trim();
    const labelText = (label: Element | null | undefined): string => {
      if (label == null) return "";
      const copy = label.cloneNode(true) as Element;
      copy.querySelectorAll('input, select, textarea, button, [role="listbox"], [role="option"], [data-automation-id="selectedItem"]')
        .forEach((child) => child.remove());
      return normalized(copy.textContent);
    };
    if (radioGroup) {
      const legend = element.closest("fieldset")?.querySelector("legend");
      return normalized(legend?.textContent);
    }
    if (element.id !== "") {
      const owned = [...document.querySelectorAll("label")].find((label) => label.htmlFor === element.id);
      const label = labelText(owned);
      if (label !== "") return label;
    }
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy !== null && labelledBy !== "") {
      const labels = labelledBy.split(/\s+/u).map((id) => document.getElementById(id)?.textContent ?? "");
      const label = normalized(labels.join(" "));
      if (label !== "") return label;
    }
    let aria = normalized(element.getAttribute("aria-label"));
    if (element.getAttribute("role") === "combobox" || element.hasAttribute("aria-haspopup")) {
      const values = [element.getAttribute("aria-valuetext"), element.getAttribute("data-selected-label"),
        element instanceof HTMLButtonElement ? element.textContent : null, "Select One"];
      for (const value of values.map(normalized).filter(Boolean)) {
        if (aria.endsWith(` ${value}`)) { aria = aria.slice(0, -value.length).trim(); break; }
      }
    }
    if (aria !== "") return aria;
    const parentLabel = labelText(element.closest("label"));
    if (parentLabel !== "") return parentLabel;
    const field = element.closest(
      '[data-automation-id="formField"], [data-automation-id^="formField-"]',
    );
    return labelText(field?.querySelector("legend, label"));
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

function promptScopeLabel(value: string): boolean {
  return /^(?:partial list \(first 500 entries\)|all)$/u.test(normalize(value));
}

async function observedOptionLabels(owner: Locator): Promise<string[]> {
  const options = await visibleLocators(owner.locator([
    '[role="option"]:not([aria-disabled="true"])',
    '[data-automation-id="promptOption"]:not([role="option"] *)',
    '[data-automation-id="promptLeafNode"]:not([role="option"] *)',
  ].join(", ")));
  const labels = await Promise.all(options.slice(0, 64).map(option => option.innerText()));
  // Discovery records possible answer labels, not a commitment to an option.
  // Duplicate labels elsewhere must not block selecting a unique answer; the
  // commit path still requires one matching option in this owner.
  const distinct = new Map(labels.map(label => [retainedProfileTextSha256(label), label]));
  return uniqueObservedOptions([...distinct.values()].filter(label =>
    !/^(?:select|select one|choose|choose one|no items|no matches found|no results found)\.?$/iu.test(label.trim())));
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
  trace?: (event: string, details?: object) => void,
  acceptedLabels = equivalentOptionLabels(value),
): Promise<boolean> {
  const observed = await readback(locator, behavior, trace);
  return behavior === "multi_select"
    ? optionReadbackList(observed).some((option) => acceptedLabels.has(normalize(option)))
    : acceptedLabels.has(normalize(observed ?? ""));
}

function exactOptionListReadback(
  readbackValue: string | null,
  expected: readonly string[],
  fieldId?: string,
): boolean {
  if (fieldId !== undefined && readbackValue !== null) {
    const aliasMatch = sharedUiKnownSemanticAliasMatches(fieldId, readbackValue, JSON.stringify(expected));
    if (aliasMatch !== undefined) return aliasMatch;
  }
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
    : new Set(["recruiter", "recruiter outreach"]).has(normalized)
    ? ["recruiter", "recruiter outreach"]
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
    if (await radio.getAttribute("aria-checked") === "true" ||
        await radio.evaluate((element) =>
          element instanceof HTMLInputElement && element.checked
        )) checked.push(radio);
  }
  return checked.length === 1 ? await radioOptionLabel(checked[0]!) : null;
}

async function radioOptionLabel(radio: Locator): Promise<string> {
  return await radio.evaluate((element) => {
    const label = element instanceof HTMLInputElement && element.labels?.length === 1
      ? element.labels[0]?.innerText ?? element.labels[0]?.textContent ?? ""
      : element.getAttribute("aria-label") ?? element.textContent ?? "";
    return label.replace(/\s+/gu, " ").trim();
  });
}

async function checkboxReadback(control: Locator): Promise<boolean> {
  const aria = await control.getAttribute("aria-checked");
  if (aria === "true" || aria === "false") return aria === "true";
  return await control.isChecked();
}

async function required(
  locator: Locator,
  compositeRole?: "radiogroup",
): Promise<boolean> {
  if (await locator.isDisabled()) return false;
  return locator.evaluate((element, role) => {
    if (element.getAttribute("aria-disabled") === "true" ||
      (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) &&
      element.readOnly
    ) return false;
    const ariaLabel = element.getAttribute("aria-label")?.trim() ?? "";
    const accessibleRequired = /(?:^|\s)Required$/u.test(ariaLabel) &&
      !/(?:^|\s)Not Required$/u.test(ariaLabel);
    const compositeRequired = role !== undefined &&
      element.closest(`[role="${role}"]`)?.getAttribute("aria-required") === "true";
    if (element.hasAttribute("required") ||
        element.getAttribute("aria-required") === "true" ||
        accessibleRequired || compositeRequired) return true;
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
  }, compositeRole);
}

async function validationCleared(locator: Locator): Promise<boolean> {
  if (await locator.getAttribute("aria-invalid") === "true") return false;
  const validationSelector = '[data-automation-id="errorMessage"], [role="alert"]';
  const field = locator.locator(
    'xpath=ancestor::*[@data-automation-id="formField" or starts-with(@data-automation-id,"formField-")][1]',
  );
  if (await field.count() !== 1) {
    return (await visibleLocators(locator.locator(validationSelector))).length === 0;
  }
  const directValidationVisible = await field.evaluate((owner, selector) => {
    const fieldSelector = '[data-automation-id="formField"], [data-automation-id^="formField-"]';
    return [...owner.querySelectorAll(selector)].some((candidate) => {
      if (candidate.closest(fieldSelector) !== owner) return false;
      const style = getComputedStyle(candidate);
      return style.display !== "none" && style.visibility !== "hidden" &&
        style.visibility !== "collapse" && candidate.getClientRects().length > 0;
    });
  }, validationSelector);
  return !directValidationVisible;
}

async function visibleLocators(locator: Locator): Promise<Locator[]> {
  const count = await locator.count();
  const matches = Array.from({ length: count }, (_, index) => locator.nth(index));
  const visible = await Promise.all(matches.map((item) => item.isVisible()));
  return matches.filter((_, index) => visible[index]);
}

async function advanceOptionWindow(owner: Locator): Promise<boolean> {
  return owner.evaluate(element => {
    const before = element.scrollTop;
    const next = Math.min(element.scrollHeight - element.clientHeight,
      before + Math.max(1, Math.floor(element.clientHeight * 0.8)));
    if (element.clientHeight <= 0 || next <= before) return false;
    element.scrollTop = next;
    return element.scrollTop > before;
  });
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
    return await owner.count() === 1 && await owner.isVisible() &&
      await owner.getAttribute("data-automation-id") !== "selectedItemList" ? owner : undefined;
  }
  const field = control.locator(
    'xpath=ancestor::*[starts-with(@data-automation-id,"formField")][1]',
  );
  if (await field.count() !== 1) return undefined;
  const owners = await visibleLocators(field.locator([
    '[role="listbox"]:not([data-automation-id="selectedItemList"])',
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

async function exactPromptCatalogOwner(
  page: Page,
  control: Locator,
  priorCatalogs?: readonly (ElementHandle | null)[],
): Promise<Locator | undefined> {
  const source = await control.getAttribute("id") === "source--source";
  const education = /^education-[^\s]+--(?:school|fieldOfStudy)$/u.test(await control.getAttribute("id") ?? "");
  const deadline = Date.now() + (source || education ? 1_500 : 0);
  do {
    const ownedIds = [await control.getAttribute("aria-controls"), await control.getAttribute("aria-owns")]
      .flatMap(value => value?.trim().split(/\s+/u).filter(Boolean) ?? []);
    // Focus and newly visible popups cannot disambiguate duplicate declared owners.
    for (const id of new Set(ownedIds)) {
      if (/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u.test(id) &&
          await page.locator(`[id="${id}"]`).count() > 1) return undefined;
    }
    const focused = page.locator(":focus");
    if (
      await focused.count() === 1 && await focused.isVisible() &&
      await focused.getAttribute("role") === "listbox" &&
      await focused.getAttribute("data-automation-id") !== "selectedItemList"
    ) return focused;
    const observed = await exactObservedOptionOwner(page, control);
    if (observed !== undefined) return observed;
    if (source || priorCatalogs !== undefined) {
      const candidates = await visibleLocators(page.locator(
        priorCatalogs !== undefined ? '[role="listbox"]:not([data-automation-id="selectedItemList"])' : '[data-automation-id="activeListContainer"][role="listbox"]',
      ));
      const sourceOwners: Locator[] = [];
      for (const candidate of candidates) {
        if (priorCatalogs !== undefined) {
          if (!await candidate.evaluate((element, prior) => prior.includes(element), [...priorCatalogs])) {
            sourceOwners.push(candidate);
          }
          continue;
        }
        const labels = new Set((await candidate.locator([
          '[role="option"]',
          '[data-automation-id="promptOption"]',
          '[data-automation-id="promptLeafNode"]',
        ].join(", ")).allInnerTexts()).map(normalize));
        if (labels.has("career event") && labels.has("direct source")) {
          sourceOwners.push(candidate);
        }
      }
      if (sourceOwners.length > 1) {
        throw new TypeError("Workday source prompt owner is ambiguous");
      }
      if (sourceOwners.length === 1 && (await visibleLocators(sourceOwners[0]!.locator(
        '[role="option"], [data-automation-id="promptOption"], [data-automation-id="promptLeafNode"]',
      ))).length > 0) return sourceOwners[0];
    }
    if (Date.now() < deadline) await page.waitForTimeout(50);
  } while (Date.now() < deadline);
  return undefined;
}

async function promptOptionActivation(option: Locator): Promise<Locator> {
  const radios = await visibleLocators(option.locator('input[type="radio"], [role="radio"]'));
  const leaves = await visibleLocators(option.locator('[data-automation-id="promptLeafNode"]'));
  if (radios.length > 1 || leaves.length > 1) {
    throw new TypeError("Workday prompt catalog activation is ambiguous");
  }
  return radios[0] ?? leaves[0] ?? option;
}

async function preferredPromptOption(
  options: readonly Locator[],
  acceptedLabels: ReadonlySet<string>,
): Promise<Locator | undefined> {
  const matches: { readonly option: Locator; readonly rank: number }[] = [];
  for (const option of options) {
    const automationId = await option.getAttribute("data-automation-id");
    if (
      automationId === "selectedItem" ||
      !acceptedLabels.has(normalize(await option.innerText()))
    ) continue;
    matches.push({
      option,
      rank: await option.getAttribute("role") === "option"
        ? 0
        : automationId === "promptLeafNode" ? 1 : 2,
    });
  }
  if (matches.length === 0) return undefined;
  const preferredRank = Math.min(...matches.map(({ rank }) => rank));
  const preferred = matches.filter(({ rank }) => rank === preferredRank);
  if (preferred.length !== 1) {
    throw new TypeError("Workday prompt catalog option is ambiguous");
  }
  return preferred[0]!.option;
}

async function committedPromptPrefill(control: Locator, expected: string): Promise<boolean | undefined> {
  return control.evaluate((element, value) => {
    const normalize = (text: string) => text.replace(/\s+/gu, " ").trim();
    const owner = element.closest('[data-automation-id="formField"], [data-automation-id^="formField-"]');
    const tokens = [...owner?.querySelectorAll('[data-automation-id="selectedItem"]') ?? []]
      .filter(token => token.getClientRects().length > 0 && getComputedStyle(token).visibility !== "hidden");
    const node = element as unknown as Record<string, unknown>;
    const fiberKey = Object.keys(node).find(key => key.startsWith("__reactFiber$"));
    let fiber = fiberKey === undefined ? undefined : node[fiberKey] as Record<string, unknown> | undefined;
    let found = false;
    for (let depth = 0; fiber != null && depth < 16; depth += 1) {
      const props = fiber.memoizedProps as Record<string, unknown> | undefined;
      if (props != null && Array.isArray(props.selectedValues)) {
        const selected = props.selectedValues;
        if (selected.length !== 1 || typeof selected[0] !== "object" || selected[0] === null) return false;
        const item = selected[0] as Record<string, unknown>;
        if (typeof item.id !== "string" || item.id.trim() === "" ||
            typeof item.text !== "string" || normalize(item.text) !== normalize(value)) return false;
        found = true;
      }
      fiber = fiber.return as Record<string, unknown> | undefined;
    }
    if (!found) return undefined;
    return tokens.length === 1 && normalize(tokens[0]!.textContent ?? "") === normalize(value);
  }, expected);
}

function sourcePromptCategory(value: string): string | undefined {
  return equivalentOptionLabels(value).has("recruiter") ? "Direct Source" : undefined;
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

function indexedRepeatablePrefixes(section: ProfileRepeatableSection): readonly string[] {
  if (section === "experience") return ["workExperience-"];
  if (section === "education") return ["education-"];
  if (section === "websites") return ["webAddress-", "website-", "websites-"];
  return [];
}

function repeatableEntry(section: ProfileRepeatableSection): ProfileRepeatableCatalogEntry {
  const entry = profileRepeatableCatalog.find((item) => item.section === section);
  if (entry === undefined) throw new TypeError("unsupported Workday repeatable section");
  return entry;
}

async function exactIdLocator(page: Page, value: string): Promise<Locator> {
  if (value.length === 0 || value.length > 128 || /[\u0000-\u0020\u007f]/u.test(value)) {
    throw new TypeError("invalid Workday listbox identifier");
  }
  const escaped = await page.evaluate((id) => CSS.escape(id), value);
  return page.locator(`#${escaped}`);
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
