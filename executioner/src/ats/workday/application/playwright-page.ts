import { createHash } from "node:crypto";
import type { Locator, Page } from "playwright";
import { browserPageId, fieldId } from "../../../contracts/index.ts";
import {
  annotateCheckboxGroups,
  checkboxGroupKindAttribute,
  supportedControlSelector,
} from "../../../deterministic/supported-controls.ts";
import {
  WORKDAY_APPLICATION_PAGE_SELECTORS,
  type ApplicationHandlerPage,
  type ApplicationPage,
  type ApplicationPageTruth,
  type ApplicationPortFailure,
  type ApplicationPortResult,
  type ApplicationWalkDependencies,
} from "./page-walk-contract.ts";
import {
  armNavigationWitness,
  freezeNavigationWitness,
  markNavigationWitnessClicked,
  readNavigationActionBusySeen,
} from "./navigation-witness.ts";
export interface PlaywrightWorkdayApplicationPageOptions { readonly timeoutMs?: number;
  readonly navigationSettleTimeoutMs?: number;
  readonly pageIds?: Partial<Record<ApplicationPage, ApplicationPageTruth["pageId"]>>;
  readonly prepareQuestionnaireSnapshot?: (signal: AbortSignal) => Promise<void>; }
interface BrowserApplicationSnapshot {
  readonly page: ApplicationPage;
  readonly lanes: readonly ApplicationHandlerPage[];
  readonly rootSelector: string;
  readonly pageId: string | null;
  readonly requiredFields: readonly {
    readonly fieldId: string;
    readonly semanticKey: string;
    readonly page?: ApplicationHandlerPage;
    readonly verification: "verified" | "unverified";
    readonly diagnostic: {
      readonly tag: string;
      readonly role: string | null;
      readonly inputType: string | null;
      readonly descendantRadioCount: number;
      readonly descendantCheckedCount: number;
      readonly fieldOwnerRadioCount: number;
      readonly fieldOwnerCheckedCount: number;
      readonly nearestSelectedItemCount: number;
      readonly fieldOwnerSelectedItemCount: number;
      readonly inputNonEmpty: boolean;
      readonly ariaValueNonEmpty: boolean;
      readonly textNonEmpty: boolean;
      readonly ariaDescribedByPresent: boolean;
      readonly referencedValidation: boolean;
      readonly ownedValidation: boolean;
      readonly unownedValidation: boolean;
      readonly fieldOwnerInputNonEmptyCount: number;
      readonly dateReactHandlerLayers?: readonly {
        readonly hostTag: string;
        readonly domDepth: number;
        readonly fiberDepth: number;
        readonly propsKeys: readonly string[];
        readonly handlers: readonly {
          readonly name: string;
          readonly arity: number;
          readonly functionId: number;
        }[];
      }[];
      readonly checkboxReactHandlerLayers?: readonly {
        readonly hostTag: string;
        readonly hostAutomationId: string | null;
        readonly domDepth: number;
        readonly fiberDepth: number;
        readonly propsKeys: readonly string[];
        readonly index: number | null;
        readonly handlers: readonly {
          readonly name: string;
          readonly arity: number;
          readonly functionId: number;
        }[];
        readonly objects: readonly {
          readonly name: string;
          readonly arrayLength: number | null;
          readonly keys: readonly string[];
        }[];
        readonly inputIndexes: readonly number[];
      }[];
    };
  }[];
  readonly c3OwnedDuplicateRows: number;
  readonly submitActivated: boolean;
  readonly signature: string;
  readonly semanticDestinationFingerprint: string;
  readonly semanticDestinationComparable: boolean;
  readonly transitionKey: string;
  readonly physicalPageOccurrenceKey: string;
  readonly physicalDomKey: string;
  readonly navigationWitness: string;
  readonly validationKeys: readonly string[];
  readonly validationOwners: readonly string[];
}
interface BrowserApplicationAmbiguity {
  readonly ambiguity: readonly {
    readonly page: "profile" | "experience" | "questionnaire" | "pre_review";
    readonly contains: readonly number[];
  }[];
  readonly structures: readonly {
    readonly id: string;
    readonly visible: boolean;
  }[];
}
const destinationStabilityWindowMs = 3_000;
const questionnaireOccurrences = new WeakMap<Page, { epoch: number; nextAction: number }>();
export class PlaywrightWorkdayApplicationPage {
  readonly #page: Page;
  readonly #timeoutMs: number;
  readonly #navigationSettleTimeoutMs: number;
  readonly #pageIds: Partial<Record<ApplicationPage, ApplicationPageTruth["pageId"]>>;
  readonly #prepareQuestionnaireSnapshot?: (signal: AbortSignal) => Promise<void>;
  constructor(page: Page, options: PlaywrightWorkdayApplicationPageOptions = {}) {
    this.#page = page;
    this.#timeoutMs = options.timeoutMs ?? 5_000;
    this.#navigationSettleTimeoutMs = options.navigationSettleTimeoutMs ?? this.#timeoutMs;
    this.#pageIds = options.pageIds ?? {};
    this.#prepareQuestionnaireSnapshot = options.prepareQuestionnaireSnapshot;
    if (!questionnaireOccurrences.has(page)) {
      questionnaireOccurrences.set(page, { epoch: 0, nextAction: 0 });
    }
  }
  async observe(signal: AbortSignal): Promise<ApplicationPortResult<ApplicationPageTruth>> {
    const snapshot = await this.#readSnapshot(signal);
    if (snapshot.ok && process.env.HUNT_C3_VALUE_FREE_ACCOUNT_TRACE === "1") {
      try {
        process.stderr.write(`${JSON.stringify({
          applicationRequiredFieldDiagnostics: snapshot.value.requiredFields.map((field) => ({
            fieldId: field.fieldId,
            verification: field.verification,
            ...(field.verification === "verified" ? {} : field.diagnostic),
          })),
        })}\n`);
      } catch {}
    }
    return snapshot.ok ? { ok: true, value: this.#toTruth(snapshot.value) } : snapshot;
  }
  async next(request: Parameters<ApplicationWalkDependencies["navigation"]["next"]>[0], signal: AbortSignal):
    Promise<ApplicationPortResult<{ readonly advanced: true }>> {
    if (signal.aborted) return failure("operation_cancelled", "none");
    const before = await this.#readSnapshot(signal);
    if (!before.ok) return before;
    const beforeTruth = this.#toTruth(before.value);
    if (
      beforeTruth.page !== request.from ||
      beforeTruth.pageId !== request.fromPageId ||
      beforeTruth.submitActivated ||
      beforeTruth.c3OwnedDuplicateRows !== 0 ||
      beforeTruth.requiredFields.some(({ verification }) =>
        verification !== "verified"
      )
    ) {
      navigationDiagnostic("source_guard_failed", {
        pageMatched: beforeTruth.page === request.from,
        pageIdMatched: beforeTruth.pageId === request.fromPageId,
        submitActivated: beforeTruth.submitActivated,
        duplicateRows: beforeTruth.c3OwnedDuplicateRows,
        unverifiedRequiredCount: beforeTruth.requiredFields.filter(({ verification }) =>
          verification !== "verified"
        ).length,
      });
      return failure("navigation_illegal", "navigation");
    }
    let clicked = false;
    let navigationActionId: string | undefined;
    try {
      const action = await this.#waitForActionableNext(before.value.rootSelector, signal);
      if (action === undefined) return failure("navigation_uncertain", "navigation");
      clicked = true;
      navigationDiagnostic("action_admitted");
      // Activate the admitted element itself with a trusted browser gesture.
      // A DOM click is untrusted and some Workday transitions ignore it. Keep
      // a fixed handle so a footer remount cannot retarget the gesture onto a
      // final Submit control.
      try {
        navigationDiagnostic("hit_test_started");
        const handle = await action.elementHandle();
        if (handle === null) throw new Error("navigation control detached");
        // Workday commits focused search/select drafts on blur. Move focus to
        // the admitted button before activation so its click sees that commit.
        await handle.focus();
        const activated = await handle.evaluate((control) => {
          if (!(control instanceof HTMLButtonElement) || control.disabled ||
              control.getAttribute("aria-disabled") === "true") return false;
          const label = (control.innerText || control.textContent || "")
            .normalize("NFC").replace(/\s+/gu, " ").trim();
          return /^(?:next|continue|save(?:\s+and)?\s+continue)$/iu.test(label);
        });
        if (!activated) throw new Error("navigation control activation denied");
        navigationActionId = await this.#armNavigationWitness(before.value.rootSelector);
        await handle.click({ timeout: this.#navigationSettleTimeoutMs });
        navigationDiagnostic("admitted_control_activated");
      } catch {
        navigationDiagnostic("activation_failed");
        // Destination readback owns the result.
      }
      navigationDiagnostic("destination_readback_started");
      let after = await this.#waitForChangedSnapshot(
        before.value,
        signal,
        navigationActionId,
      );
      if (
        !after.ok && after.error.code === "browser_effect_uncertain" &&
        await this.#unchangedSourceStillRetryable(before.value, signal)
      ) {
        navigationDiagnostic("unchanged_source_retry_started");
        const retryAction = await this.#waitForActionableNext(
          before.value.rootSelector,
          signal,
        );
        if (retryAction !== undefined) {
          try {
            const handle = await retryAction.elementHandle();
            if (handle === null) throw new Error("navigation control detached");
            await handle.focus();
            const admitted = await handle.evaluate((control) => {
              if (!(control instanceof HTMLButtonElement) || control.disabled ||
                  control.getAttribute("aria-disabled") === "true") return false;
              const label = (control.innerText || control.textContent || "")
                .normalize("NFC").replace(/\s+/gu, " ").trim();
              return /^(?:next|continue|save(?:\s+and)?\s+continue)$/iu.test(label);
            });
            if (!admitted) throw new Error("navigation control activation denied");
            navigationActionId = await this.#armNavigationWitness(before.value.rootSelector);
            await handle.click({ timeout: this.#navigationSettleTimeoutMs });
            navigationDiagnostic("unchanged_source_retry_activated");
          } catch {
            navigationDiagnostic("unchanged_source_retry_activation_failed");
          }
          after = await this.#waitForChangedSnapshot(before.value, signal, navigationActionId);
        }
      }
      navigationDiagnostic(after.ok ? "destination_readback_succeeded" : "destination_readback_failed");
      if (!after.ok) return after;
      const afterTruth = this.#toTruth(after.value);
      if (hasValidationDowngrade(before.value, after.value)) {
        navigationDiagnostic("validation_downgrade", {
          beforePage: before.value.page,
          afterPage: after.value.page,
          rootChanged: after.value.rootSelector !== before.value.rootSelector,
          beforeRequiredCount: before.value.requiredFields.length,
          afterRequiredCount: after.value.requiredFields.length,
          afterUnverifiedFieldIds: after.value.requiredFields
            .filter(({ verification }) => verification === "unverified")
            .map(({ fieldId }) => fieldId),
          validationOwners: after.value.validationOwners,
        });
        return failure("page_incomplete", "navigation");
      }
      if (!request.allowed.includes(afterTruth.page) || afterTruth.submitActivated) {
        navigationDiagnostic("destination_not_allowed", {
          beforePage: before.value.page,
          afterPage: after.value.page,
          allowedPages: request.allowed,
          rootChanged: after.value.rootSelector !== before.value.rootSelector,
          transitionChanged: after.value.transitionKey !== before.value.transitionKey,
          submitActivated: afterTruth.submitActivated,
          beforeRequiredCount: before.value.requiredFields.length,
          afterRequiredCount: after.value.requiredFields.length,
          afterUnverifiedFieldIds: after.value.requiredFields
            .filter(({ verification }) => verification === "unverified")
            .map(({ fieldId }) => fieldId),
          validationOwners: after.value.validationOwners,
        });
        return failure("navigation_uncertain", "navigation");
      }
      if (
        after.value.page === before.value.page &&
        after.value.rootSelector === before.value.rootSelector &&
        after.value.transitionKey === before.value.transitionKey &&
        after.value.navigationWitness !== navigationActionId &&
        after.value.requiredFields.length <= before.value.requiredFields.length
      ) {
        navigationDiagnostic("semantic_guard_failed", {
          beforePage: before.value.page,
          afterPage: after.value.page,
          rootChanged: false,
          transitionChanged: false,
          beforeRequiredCount: before.value.requiredFields.length,
          afterRequiredCount: after.value.requiredFields.length,
        });
        return failure("browser_effect_uncertain", "navigation");
      }
      if (advancesQuestionnaireOccurrence(before.value, after.value, navigationActionId)) {
        questionnaireOccurrences.get(this.#page)!.epoch += 1;
      }
      navigationDiagnostic("navigation_advanced", {
        beforePage: before.value.page,
        afterPage: after.value.page,
        rootChanged: after.value.rootSelector !== before.value.rootSelector,
        transitionChanged: after.value.transitionKey !== before.value.transitionKey,
        beforeRequiredCount: before.value.requiredFields.length,
        afterRequiredCount: after.value.requiredFields.length,
      });
      return { ok: true, value: { advanced: true } };
    } catch {
      navigationDiagnostic(clicked ? "navigation_exception_after_admission" : "navigation_exception_before_admission");
      return failure(
        signal.aborted
          ? "operation_cancelled"
          : clicked
            ? "browser_effect_uncertain"
            : "navigation_uncertain",
        "navigation",
      );
    }
  }
  async #readSnapshot(
    signal: AbortSignal,
    prepareQuestionnaire = true,
    navigationActionId?: string,
  ): Promise<ApplicationPortResult<BrowserApplicationSnapshot>> {
    if (signal.aborted) return failure("operation_cancelled", "none");
    try {
      if (prepareQuestionnaire) {
        if (navigationActionId !== undefined) {
          await this.#freezeNavigationWitness(navigationActionId);
        }
        await this.#prepareQuestionnaireSnapshot?.(signal);
      }
      if (signal.aborted) return failure("operation_cancelled", "none");
      await annotateCheckboxGroups(this.#page);
      const snapshot = await this.#page.evaluate(
        readApplicationSnapshot, {
          selectors: WORKDAY_APPLICATION_PAGE_SELECTORS,
          checkboxGroupAttribute: checkboxGroupKindAttribute,
          supportedControls: supportedControlSelector,
        },
      );
      if ("ambiguity" in snapshot) {
        if (process.env.HUNT_C3_VALUE_FREE_ACCOUNT_TRACE === "1") {
          try {
            process.stderr.write(`${JSON.stringify({
              applicationPageAmbiguity: snapshot.ambiguity,
              applicationPageStructures: snapshot.structures,
            })}\n`);
          } catch {}
        }
        return failure("browser_target_ambiguous", "page_type");
      }
      return { ok: true, value: snapshot };
    } catch {
      return failure(
        signal.aborted ? "operation_cancelled" : "browser_target_stale",
        "ui_behavior",
      );
    }
  }
  async #waitForChangedSnapshot(
    before: BrowserApplicationSnapshot,
    signal: AbortSignal,
    navigationActionId: string | undefined,
  ): Promise<ApplicationPortResult<BrowserApplicationSnapshot>> {
    let persistedNavigationActionId: string | undefined;
    let currentActionBusySeen = false;
    for (let pass = 0; pass < 2; pass += 1) {
      const deadline = Date.now() + this.#navigationSettleTimeoutMs;
      while (Date.now() < deadline) {
        if (signal.aborted) return failure("operation_cancelled", "none");
        if (navigationActionId !== undefined && !currentActionBusySeen) {
          currentActionBusySeen = await this.#navigationActionBusySeen(navigationActionId);
        }
        const rawAfter = await this.#readSnapshot(signal, false);
        let rawCurrentActionWitness = navigationActionId !== undefined && rawAfter.ok &&
          rawAfter.value.navigationWitness === navigationActionId;
        const rawCandidateChanged = rawAfter.ok && (
          hasIndependentDestinationEvidence(before, rawAfter.value) ||
          rawAfter.value.requiredFields.length > before.requiredFields.length ||
          hasValidationDowngrade(before, rawAfter.value)
        );
        const preparationAdmitted = rawAfter.ok && navigationActionId !== undefined && (
          rawCurrentActionWitness || persistedNavigationActionId === navigationActionId ||
          rawCandidateChanged && !currentActionBusySeen
        );
        if (preparationAdmitted) {
          rawCurrentActionWitness = (await this.#freezeNavigationWitness(navigationActionId)) ||
            rawCurrentActionWitness;
        }
        const after = preparationAdmitted
          ? await this.#readSnapshot(signal, true, navigationActionId)
          : rawAfter;
        const persistedDestinationProven = navigationActionId !== undefined &&
          persistedNavigationActionId === navigationActionId && after.ok &&
          hasIndependentDestinationEvidence(before, after.value);
        const currentActionWitness = navigationActionId !== undefined && (
          after.ok && after.value.navigationWitness === navigationActionId ||
          persistedDestinationProven
        );
        if (
          after.ok && (after.value.signature !== before.signature || currentActionWitness) &&
          (hasIndependentDestinationEvidence(before, after.value) ||
            (before.page === "questionnaire" && after.value.page === "questionnaire" &&
              currentActionWitness) ||
            after.value.requiredFields.length > before.requiredFields.length ||
            hasValidationDowngrade(before, after.value))
        ) {
          const candidate = persistedDestinationProven && navigationActionId !== undefined
            ? { ...after.value, navigationWitness: navigationActionId }
            : after.value;
          const stable = await this.#confirmStableDestination(
            candidate,
            signal,
            persistedDestinationProven ? persistedNavigationActionId : undefined,
            persistedDestinationProven ? before.semanticDestinationFingerprint : undefined,
            navigationActionId,
          );
          if (stable !== undefined) return { ok: true, value: stable };
          navigationDiagnostic("destination_candidate_unstable", {
            candidatePage: after.value.page,
            rootChanged: after.value.rootSelector !== before.rootSelector,
          });
        }
        const remaining = deadline - Date.now();
        if (remaining > 0) await this.#page.waitForTimeout(Math.min(50, remaining));
      }
      if (pass > 0 || signal.aborted) break;
      const source = this.#page.locator(before.rootSelector);
      const applicationShell = this.#page.locator(
        '[data-automation-id="applyFlowPage"]:visible',
      );
      const loading = this.#page.locator(
        '[data-automation-id="applyFlowLoadingPage"]:visible',
      );
      const sourceCount = await source.count();
      if (
        await applicationShell.count() !== 1 || sourceCount > 1 ||
        (sourceCount === 1 && await source.isVisible()) ||
        await loading.count() !== 1 ||
        await applicationShell.locator(
          '[data-automation-id="applyFlowLoadingPage"]:visible',
        ).count() !== 1
      ) break;
      if (navigationActionId === undefined) break;
      currentActionBusySeen = currentActionBusySeen ||
        await this.#navigationActionBusySeen(navigationActionId);
      if (!currentActionBusySeen) break;
      if (process.env.HUNT_C3_VALUE_FREE_ACCOUNT_TRACE === "1") {
        process.stderr.write('{"applicationNavigationRecovery":"owned_loading_reload"}\n');
      }
      try {
        await this.#page.reload({
          waitUntil: "domcontentloaded",
          timeout: this.#navigationSettleTimeoutMs,
        });
        persistedNavigationActionId = navigationActionId;
      } catch {
        break;
      }
    }
    return failure("browser_effect_uncertain", "navigation");
  }
  async #navigationActionBusySeen(actionId: string): Promise<boolean> {
    try {
      return await this.#page.evaluate(readNavigationActionBusySeen, actionId);
    } catch {
      return false;
    }
  }
  async #freezeNavigationWitness(actionId: string): Promise<boolean> {
    try {
      return await this.#page.evaluate(freezeNavigationWitness, actionId);
    } catch {
      return false;
    }
  }
  async #armNavigationWitness(rootSelector: string): Promise<string> {
    const occurrence = questionnaireOccurrences.get(this.#page)!;
    occurrence.nextAction += 1;
    const actionId = `navigation-${occurrence.nextAction}`;
    const armed = await this.#page.evaluate(armNavigationWitness, { rootSelector, actionId });
    if (!armed) throw new TypeError("navigation witness controller unavailable");
    await this.#page.evaluate(markNavigationWitnessClicked, actionId);
    return actionId;
  }
  async #confirmStableDestination(
    candidate: BrowserApplicationSnapshot,
    signal: AbortSignal,
    persistedNavigationActionId?: string,
    sourceSemanticDestinationFingerprint?: string,
    navigationActionId?: string,
  ): Promise<BrowserApplicationSnapshot | undefined> {
    if (sourceSemanticDestinationFingerprint !== undefined &&
        candidate.semanticDestinationFingerprint === sourceSemanticDestinationFingerprint) {
      return undefined;
    }
    const deadline = Date.now() + Math.min(
      destinationStabilityWindowMs,
      this.#navigationSettleTimeoutMs,
    );
    let confirmed = candidate;
    while (Date.now() < deadline) {
      await this.#page.waitForTimeout(Math.min(100, Math.max(1, deadline - Date.now())));
      if (signal.aborted || await this.#page.locator(
        '[data-automation-id="applyFlowLoadingPage"]:visible',
      ).count() !== 0) return undefined;
      const observed = await this.#readSnapshot(signal, true, navigationActionId);
      const observedWitness = persistedNavigationActionId === candidate.navigationWitness &&
          observed.ok && observed.value.navigationWitness === "none"
        ? persistedNavigationActionId
        : observed.ok ? observed.value.navigationWitness : "none";
      if (
        !observed.ok ||
        observed.value.page !== candidate.page ||
        observed.value.rootSelector !== candidate.rootSelector ||
        observed.value.transitionKey !== candidate.transitionKey ||
        observed.value.semanticDestinationFingerprint !==
          candidate.semanticDestinationFingerprint ||
        (sourceSemanticDestinationFingerprint !== undefined &&
          observed.value.semanticDestinationFingerprint ===
            sourceSemanticDestinationFingerprint) ||
        observedWitness !== candidate.navigationWitness
      ) return undefined;
      confirmed = observedWitness === observed.value.navigationWitness
        ? observed.value
        : { ...observed.value, navigationWitness: observedWitness };
    }
    return confirmed;
  }
  async #unchangedSourceStillRetryable(
    before: BrowserApplicationSnapshot,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (signal.aborted) return false;
    // This is still part of the armed navigation action. Preparation can open
    // a popup and emit controller loading; it must never manufacture the
    // evidence used to decide whether the trusted navigation click is retryable.
    const current = await this.#readSnapshot(signal, false);
    return current.ok &&
      current.value.signature === before.signature &&
      current.value.transitionKey === before.transitionKey &&
      !current.value.submitActivated &&
      current.value.requiredFields.length === before.requiredFields.length &&
      current.value.requiredFields.every(({ verification }) => verification === "verified") &&
      !hasValidationDowngrade(before, current.value);
  }
  async #waitForActionableNext(
    rootSelector: string,
    signal: AbortSignal,
  ): Promise<Locator | undefined> {
    const deadline = Date.now() + this.#navigationSettleTimeoutMs;
    let probeFailures = 0;
    while (Date.now() < deadline) {
      if (signal.aborted) return undefined;
      try {
        const action = await singleActionableNext(this.#page, rootSelector);
        if (action !== undefined) return action;
      } catch {
        probeFailures += 1;
      }
      const remaining = deadline - Date.now();
      if (remaining > 0) await this.#page.waitForTimeout(Math.min(50, remaining));
    }
    if (process.env.HUNT_C3_VALUE_FREE_ACCOUNT_TRACE === "1") {
      try {
        const root = this.#page.locator(rootSelector);
        const loading = this.#page.locator(
          '[data-automation-id="applyFlowLoadingPage"]:visible',
        );
        const controls = this.#page.getByRole("button", {
          name: /^(?:next|continue|save(?:\s+and)?\s+continue)$/iu,
        });
        const candidates = [];
        for (let index = 0; index < await controls.count(); index += 1) {
          const candidate = controls.nth(index);
          candidates.push({
            visible: await candidate.isVisible(),
            enabled: await candidate.isEnabled(),
            ariaDisabled: await candidate.getAttribute("aria-disabled"),
            automationId: await candidate.getAttribute("data-automation-id"),
          });
        }
        process.stderr.write(`${JSON.stringify({
          applicationNavigationActionDiagnostics: {
            rootCount: await root.count(),
            rootVisible: await root.count() === 1 && await root.isVisible(),
            loadingCount: await loading.count(),
            probeFailures,
            candidates,
          },
        })}\n`);
      } catch {}
    }
    return undefined;
  }
  #toTruth(snapshot: BrowserApplicationSnapshot): ApplicationPageTruth {
    const configuredPageId = this.#pageIds[snapshot.page];
    const physicalQuestionnairePageId = snapshot.page === "questionnaire"
      ? browserPageId(`s2-questionnaire-${createHash("sha256")
        .update(`${snapshot.physicalPageOccurrenceKey}\u0000${
          questionnaireOccurrences.get(this.#page)?.epoch ?? 0
        }`, "utf8").digest("hex").slice(0, 24)}`)
      : undefined;
    return Object.freeze({
      page: snapshot.page,
      lanes: Object.freeze([...snapshot.lanes]),
      pageId: physicalQuestionnairePageId ?? configuredPageId ?? (
        snapshot.pageId === null
          ? browserPageId(`s2-${snapshot.page.replace("_", "-")}`)
          : browserPageId(snapshot.pageId)
      ),
      requiredFields: Object.freeze(snapshot.requiredFields.map((item) =>
        Object.freeze({
          fieldId: fieldId(item.fieldId),
          ...(item.page === undefined ? {} : { page: item.page }),
          verification: item.verification,
        })
      )),
      c3OwnedDuplicateRows: snapshot.c3OwnedDuplicateRows,
      submitActivated: snapshot.submitActivated,
    });
  }
}
function advancesQuestionnaireOccurrence(
  before: BrowserApplicationSnapshot,
  after: BrowserApplicationSnapshot,
  navigationActionId: string | undefined,
): boolean {
  if (before.page !== "questionnaire" || after.page !== "questionnaire") return false;
  return navigationActionId !== undefined && after.navigationWitness === navigationActionId;
}
function navigationDiagnostic(
  event: string,
  details: Record<string, boolean | number | string | readonly string[]> = {},
): void {
  if (process.env.HUNT_C3_VALUE_FREE_ACCOUNT_TRACE !== "1") return;
  try {
    process.stderr.write(`${JSON.stringify({ applicationNavigationStage: event, ...details })}\n`);
  } catch {}
}
async function singleActionableNext(page: Page, rootSelector: string): Promise<Locator | undefined> {
  const root = page.locator(rootSelector);
  if (await root.count() !== 1) return undefined;
  const rootVisible = await root.isVisible();
  if (!rootVisible &&
      await page.locator('[data-automation-id="applyFlowLoadingPage"]:visible').count() !== 1) {
    return undefined;
  }
  // Workday renders Save and Continue in a sticky application footer that is
  // a sibling of the physical page root. Validate the root above, then search
  // the owned page for the one exact non-submit navigation action.
  const controls = page.getByRole("button", {
    name: /^(?:next|continue|save(?:\s+and)?\s+continue)$/iu,
  });
  const actionable: Locator[] = [];
  for (let index = 0; index < await controls.count(); index += 1) {
    const candidate = controls.nth(index);
    if (
      await candidate.isVisible() &&
      await candidate.isEnabled() &&
      await candidate.getAttribute("aria-disabled") !== "true"
    ) actionable.push(candidate);
  }
  return actionable.length === 1 ? actionable[0] : undefined;
}
function hasValidationDowngrade(
  before: BrowserApplicationSnapshot,
  after: BrowserApplicationSnapshot,
): boolean {
  if (
    after.page !== before.page ||
    after.rootSelector !== before.rootSelector ||
    after.transitionKey !== before.transitionKey
  ) return false;
  const beforeFields = new Map(before.requiredFields.map((item) => [
    `${item.page ?? ""}:${item.fieldId}`,
    item.verification,
  ]));
  const afterKeys = new Set(after.requiredFields.map((item) =>
    `${item.page ?? ""}:${item.fieldId}`
  ));
  const regressed = after.requiredFields.some((item) =>
    item.verification === "unverified" &&
    beforeFields.get(`${item.page ?? ""}:${item.fieldId}`) === "verified"
  );
  if (regressed) return true;
  const newField = [...afterKeys].some((key) => !beforeFields.has(key));
  const priorValidation = new Set(before.validationKeys);
  return !newField && after.validationKeys.some((key) => !priorValidation.has(key));
}
function hasIndependentDestinationEvidence(
  before: BrowserApplicationSnapshot,
  after: BrowserApplicationSnapshot,
): boolean {
  if (after.page !== before.page || after.rootSelector !== before.rootSelector) return true;
  return before.semanticDestinationComparable && after.semanticDestinationComparable &&
    after.semanticDestinationFingerprint !== before.semanticDestinationFingerprint;
}
async function readApplicationSnapshot(
  input: {
    readonly selectors: typeof WORKDAY_APPLICATION_PAGE_SELECTORS;
    readonly checkboxGroupAttribute: string;
    readonly supportedControls: string;
  },
): Promise<BrowserApplicationSnapshot | BrowserApplicationAmbiguity> {
  const { selectors, checkboxGroupAttribute, supportedControls } = input;
  const visible = (element: Element): element is HTMLElement => {
    if (!(element instanceof HTMLElement) || element.hidden ||
        element.getAttribute("aria-hidden") === "true") return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" &&
      style.visibility !== "collapse" && element.getClientRects().length > 0;
  };
  const text = (value: string | null | undefined): string =>
    (value ?? "").normalize("NFC").replace(/\s+/gu, " ").trim();
  const referencedText = (element: Element): string => text(
    (element.getAttribute("aria-labelledby") ?? "").split(/\s+/u)
      .filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" "),
  );
  const accessibleName = (
    element: Element,
    fallbackText = true,
    includeDirectLabel = true,
  ): string => {
    const referenced = referencedText(element);
    if (referenced !== "") return referenced;
    const ariaLabel = text(element.getAttribute("aria-label"));
    if (ariaLabel !== "") return ariaLabel;
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ||
        element instanceof HTMLSelectElement) {
      const native = text([...element.labels ?? []].map((label) => label.textContent ?? "").join(" "));
      if (native !== "") return native;
    }
    const owned = text(element.querySelector(
      includeDirectLabel
        ? ":scope > legend, :scope > label, :scope > [role=heading], :scope > h1, :scope > h2, :scope > h3"
        : ":scope > legend, :scope > [role=heading], :scope > h1, :scope > h2, :scope > h3",
    )?.textContent);
    return owned || (fallbackText ? text(element.textContent) : "");
  };
  const effectiveNumber = (value: string | null): string => {
    const normalized = text(value);
    if (normalized === "") return "";
    const numeric = Number(normalized);
    return Number.isFinite(numeric) ? String(numeric) : normalized;
  };
  const globalState = globalThis as unknown as Record<string, unknown>;
  const navigationAction = globalState.__huntWorkdayNavigationAction as {
    readonly actionId?: string;
    readonly controller?: HTMLElement;
    readonly settled?: boolean;
  } | undefined;
  const navigationWitness = navigationAction?.settled === true &&
      navigationAction.controller?.isConnected === true &&
      globalState.__huntWorkdayNavigationWitness === navigationAction.actionId
    ? navigationAction.actionId ?? "none"
    : "none";
  const semanticHash = (value: string): string => {
    let state = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      state ^= value.charCodeAt(index);
      state = Math.imul(state, 16777619);
    }
    return (state >>> 0).toString(16).padStart(8, "0");
  };
  const collisionResistantHash = async (value: string): Promise<string> => {
    const encoded = new TextEncoder().encode(value);
    if (globalThis.crypto.subtle !== undefined) {
      const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", encoded));
      return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    }
    // Workday is a secure origin in production, but Playwright's setContent
    // fixtures are not. Keep the identical SHA-256 contract in that context.
    const constants = new Uint32Array([
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
      0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
      0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
      0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
      0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
      0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
      0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
      0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
      0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ]);
    const paddedLength = Math.ceil((encoded.length + 9) / 64) * 64;
    const padded = new Uint8Array(paddedLength);
    padded.set(encoded);
    padded[encoded.length] = 0x80;
    const bitLength = encoded.length * 8;
    const view = new DataView(padded.buffer);
    view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000));
    view.setUint32(paddedLength - 4, bitLength >>> 0);
    const state = new Uint32Array([
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ]);
    const words = new Uint32Array(64);
    const rotateRight = (word: number, count: number): number =>
      word >>> count | word << (32 - count);
    for (let offset = 0; offset < paddedLength; offset += 64) {
      for (let index = 0; index < 16; index += 1) {
        words[index] = view.getUint32(offset + index * 4);
      }
      for (let index = 16; index < 64; index += 1) {
        const left = words[index - 15]!;
        const right = words[index - 2]!;
        const sigma0 = rotateRight(left, 7) ^ rotateRight(left, 18) ^ left >>> 3;
        const sigma1 = rotateRight(right, 17) ^ rotateRight(right, 19) ^ right >>> 10;
        words[index] = (words[index - 16]! + sigma0 + words[index - 7]! + sigma1) >>> 0;
      }
      let [a, b, c, d, e, f, g, h] = state;
      for (let index = 0; index < 64; index += 1) {
        const sum1 = rotateRight(e!, 6) ^ rotateRight(e!, 11) ^ rotateRight(e!, 25);
        const choice = e! & f! ^ ~e! & g!;
        const temporary1 = (h! + sum1 + choice + constants[index]! + words[index]!) >>> 0;
        const sum0 = rotateRight(a!, 2) ^ rotateRight(a!, 13) ^ rotateRight(a!, 22);
        const majority = a! & b! ^ a! & c! ^ b! & c!;
        const temporary2 = (sum0 + majority) >>> 0;
        [a, b, c, d, e, f, g, h] = [
          (temporary1 + temporary2) >>> 0, a, b, c,
          (d! + temporary1) >>> 0, e, f, g,
        ];
      }
      for (const [index, word] of [a, b, c, d, e, f, g, h].entries()) {
        state[index] = (state[index]! + word!) >>> 0;
      }
    }
    return [...state].map((word) => word.toString(16).padStart(8, "0")).join("");
  };
  const validDateValue = (rawValue: string): boolean => {
    const value = rawValue.replace(
      /[\s\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/gu,
      "",
    );
    const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/u.exec(value);
    const isoDate = match === null
      ? /^\d{4}-\d{2}-\d{2}$/u.test(value) ? value : ""
      : `${match[3]}-${match[1]!.padStart(2, "0")}-${match[2]!.padStart(2, "0")}`;
    const parsed = new Date(`${isoDate}T00:00:00.000Z`);
    return /^\d{4}-\d{2}-\d{2}$/u.test(isoDate) &&
      !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === isoDate;
  };
  const roots = [
    ["profile", selectors.myInformation],
    ["experience", selectors.experience],
    ["questionnaire", selectors.primaryQuestions],
    ["questionnaire", selectors.primaryQuestionnaire],
    ["questionnaire", selectors.applicationQuestions],
    ["questionnaire", selectors.voluntaryDisclosuresAndSelfIdentify],
    ["pre_review", selectors.review],
  ] as const;
  const visibleRoots = roots.flatMap(([page, selector]) =>
    [...document.querySelectorAll<HTMLElement>(selector)]
      .filter(visible)
      .map((root) => ({ page, root, selector }))
  );
  const physicalRoots = visibleRoots.filter(({ root: candidate }) =>
    visibleRoots.every(({ root: component }) =>
      candidate === component || candidate.contains(component)
    )
  );
  if (physicalRoots.length !== 1) {
    return {
      ambiguity: visibleRoots.map(({ page, root }, index) => ({
        page,
        contains: visibleRoots.flatMap(({ root: component }, componentIndex) =>
          index !== componentIndex && root.contains(component) ? [componentIndex] : []
        ),
      })),
      structures: [...document.querySelectorAll<HTMLElement>(
        "[data-automation-id]",
      )].slice(0, 64).flatMap((element) => {
        const id = element.getAttribute("data-automation-id") ?? "";
        return /^[A-Za-z][A-Za-z0-9_-]{0,127}$/u.test(id)
          ? [{ id, visible: visible(element) }]
          : [];
      }),
    };
  }
  const { page: rootPage, root, selector: rootSelector } = physicalRoots[0]!;
  const resumeInputs = [...root.querySelectorAll<HTMLInputElement>(
    'input[type="file"][data-automation-id="file-upload-input-ref"]',
  )].filter((input) => !input.disabled && input.getAttribute("aria-disabled") !== "true");
  const profileControls = [...root.querySelectorAll<HTMLElement>(
    'input, textarea, select, [contenteditable="true"], [role="combobox"], ' +
      'button[data-automation-id="sourcePrompt"]',
  )].filter((control) => visible(control) && !resumeInputs.includes(
    control as HTMLInputElement,
  ));
  const profileRoot = rootPage === "profile" || rootPage === "experience";
  const combinedResumeProfile = profileRoot &&
    resumeInputs.length === 1 && profileControls.length > 0;
  const declaredValue = document.body.getAttribute("data-hunt-application-page");
  const declared = ["resume", "profile", "questionnaire", "pre_review"]
      .includes(declaredValue ?? "")
    ? declaredValue as ApplicationPage
    : undefined;
  const page: ApplicationPage = declared ?? (
    combinedResumeProfile || (profileRoot && resumeInputs.length === 1)
      ? "resume"
      : rootPage === "experience"
        ? "profile"
        : rootPage
  );
  const lanes: readonly ApplicationHandlerPage[] = page === "pre_review"
    ? []
    : combinedResumeProfile && page === "resume"
      ? ["resume", "profile"]
      : [page];
  const candidateSelector = [
    '[data-automation-id="dateSection"]',
    '[data-automation-id="dateInputWrapper"]',
    '[data-automation-id$="-CheckboxGroup"]',
    supportedControls,
    ...(profileRoot ? [
      'button[aria-required="true"]',
      '[required]',
      '[aria-required="true"]',
      '[tabindex]',
      '[data-hunt-field-id]',
    ] : []),
  ].join(", ");
  const physicalRadioScope = root.getRootNode() as Document | ShadowRoot;
  const rootNativeRadios = [...root.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
  const physicalFormContext = root.closest<HTMLFormElement>("form");
  const physicalForms = new Set<HTMLFormElement>([
    ...(root instanceof HTMLFormElement ? [root] : []),
    ...(physicalFormContext === null ? [] : [physicalFormContext]),
    ...root.querySelectorAll<HTMLFormElement>("form"),
    ...rootNativeRadios.flatMap((radio) => radio.form === null ? [] : [radio.form]),
  ]);
  const physicalRadioBoundary = physicalFormContext ??
    root.closest<HTMLElement>('[data-automation-id="applyFlowPage"]') ?? root;
  const effectivelyDisabledRadio = (radio: HTMLInputElement): boolean => {
    if (radio.matches(":disabled")) return true;
    const radioBoundary = physicalRadioBoundary.contains(radio)
      ? physicalRadioBoundary
      : radio.closest<HTMLElement>('[data-automation-id="applyFlowPage"], form') ??
        (radio.getRootNode() instanceof ShadowRoot
          ? (radio.getRootNode() as ShadowRoot).host
          : document.documentElement);
    let current: Element | null = radio;
    while (current !== null) {
      if (current.getAttribute("aria-disabled")?.toLocaleLowerCase("en-US") === "true") {
        return true;
      }
      if (current === radioBoundary) break;
      current = current.parentElement;
    }
    return false;
  };
  const nativeRadioDiscoveryInputs = [...physicalRadioScope.querySelectorAll<HTMLInputElement>(
    'input[type="radio"]',
  )].filter((radio) =>
    (root.contains(radio) || radio.form !== null && physicalForms.has(radio.form)) &&
    text(radio.name) !== "" && !effectivelyDisabledRadio(radio)
  );
  const nativeRadioDiscoverySet = new Set<HTMLElement>(nativeRadioDiscoveryInputs);
  const registryCandidates = [...root.querySelectorAll<HTMLElement>(supportedControls)];
  const promotedGroupOwners = registryCandidates.flatMap((control) => {
    const owner = control.closest<HTMLElement>(
      `[${checkboxGroupAttribute}="exclusive"], [${checkboxGroupAttribute}="multiple"]`,
    );
    return owner === null ? [] : [owner];
  });
  const candidates = [...new Set([
    ...root.querySelectorAll<HTMLElement>(candidateSelector),
    ...promotedGroupOwners,
    ...nativeRadioDiscoveryInputs,
  ])]
    .filter((control) => (visible(control) || resumeInputs.includes(
      control as HTMLInputElement,
    ) || nativeRadioDiscoverySet.has(control)) &&
      (control instanceof HTMLInputElement && control.type === "radio"
        ? !effectivelyDisabledRadio(control)
        : !control.matches(":disabled") && control.getAttribute("aria-disabled") !== "true"))
    .filter((control) => {
      const genericCheckboxOwner = control.closest<HTMLElement>(
        '[data-automation-id="formField"], [data-automation-id^="formField-"]',
      );
      const genericGroupKind = genericCheckboxOwner?.getAttribute(checkboxGroupAttribute);
      const isGenericCheckboxGroup = genericGroupKind === "exclusive" ||
        genericGroupKind === "multiple";
      if (isGenericCheckboxGroup) return genericCheckboxOwner === control;
      if (control.matches(
        '[data-automation-id="formField"], [data-automation-id^="formField-"]',
      )) return false;
      const dateOwner = control.closest<HTMLElement>(
        '[data-automation-id="dateSection"], [data-automation-id="dateInputWrapper"]',
      );
      if (dateOwner !== null && dateOwner !== control) return false;
      if (control.matches('[data-automation-id$="-CheckboxGroup"]') &&
          control.getAttribute(checkboxGroupAttribute) === "independent") return false;
      const checkboxGroupOwner = control.closest<HTMLElement>(
        `[${checkboxGroupAttribute}="exclusive"], [${checkboxGroupAttribute}="multiple"]`,
      );
      return checkboxGroupOwner === null || checkboxGroupOwner === control;
    });
  const requiredControls = candidates.filter((control) => {
    if (control.hasAttribute("required") ||
        control.getAttribute("aria-required") === "true") return true;
    if ((control.getAttribute(checkboxGroupAttribute) === "exclusive" ||
         control.getAttribute(checkboxGroupAttribute) === "multiple") &&
        control.querySelector('[required], [aria-required="true"]') !== null) return true;
    const labels = control instanceof HTMLInputElement ||
        control instanceof HTMLTextAreaElement ||
        control instanceof HTMLSelectElement
      ? [...control.labels ?? []].map((label) => label.textContent ?? "")
      : [];
    const accessibleName = text([
      control.getAttribute("aria-label") ?? "",
      ...labels,
    ].join(" "));
    const accessibleRequired = /(?:^|\s|\()required\)?(?:\s*\*)?$/iu.test(
      accessibleName,
    ) && !/(?:^|\s|\()not required\)?(?:\s*\*)?$/iu.test(accessibleName);
    if (accessibleRequired) return true;
    const field = control.closest(
      '[data-automation-id="formField"], [data-automation-id^="formField-"]',
    );
    const fieldLabel = text(field?.querySelector("label, legend")?.textContent);
    const requiredWorkdayDate = control.matches(
      '[data-automation-id="dateSection"], [data-automation-id="dateInputWrapper"]',
    ) && fieldLabel.endsWith("*") &&
      !/(?:^|\s|\()not required\)?(?:\s*\*)?$/iu.test(fieldLabel);
    if (requiredWorkdayDate) return true;
    return field !== null && field.querySelector(
      '[data-automation-id="required"], abbr[title="Required"], [aria-label="Required"]',
    ) !== null;
  });
  const requiredFields: BrowserApplicationSnapshot["requiredFields"][number][] = [];
  const semanticDestinationFields: string[] = [];
  let semanticDestinationComparable = true;
  const requiredControlSet = new Set(requiredControls);
  const promotedGroupOwnerSet = new Set(promotedGroupOwners);
  const seenRadioGroups = new Set<string>();
  type SemanticOwnerContext = {
    readonly tag: string;
    readonly automationId: string;
    readonly role: string;
    readonly accessibleName: string;
    readonly heading: string;
  };
  const semanticOwnerEntry = (element: Element): SemanticOwnerContext | undefined => {
    const automationId = element.getAttribute("data-automation-id") ?? "";
    const stableAutomationId = /(?:formField|[0-9a-f]{8,}|\d{4,})/iu.test(automationId)
      ? ""
      : automationId;
    const role = element.getAttribute("role") ?? "";
    const ownerAccessibleName = accessibleName(element, false, false);
    const heading = text(element.querySelector(
      ":scope > legend, :scope > h1, :scope > h2, :scope > h3, :scope > [role=heading]",
    )?.textContent);
    if (stableAutomationId === "" && role === "" && ownerAccessibleName === "" &&
        heading === "" && element !== root) return undefined;
    return {
      tag: element.tagName.toLocaleLowerCase("en-US"),
      automationId: stableAutomationId,
      role,
      accessibleName: ownerAccessibleName,
      heading,
    };
  };
  type NativeRadioModel = {
    readonly members: readonly HTMLInputElement[];
    readonly questionLabel: string;
    readonly required: boolean;
    readonly groupKey: string;
    readonly fieldId: string;
    readonly ownerContext: readonly SemanticOwnerContext[];
  };
  type PendingNativeRadioModel = Omit<NativeRadioModel, "groupKey" | "fieldId"> & {
    readonly canonical: string;
    readonly stableOwnerCoordinate: string;
  };
  const nativeRadioModelByMember = new Map<HTMLInputElement, NativeRadioModel>();
  const pendingNativeRadioModels: PendingNativeRadioModel[] = [];
  const nativeRadioGroups = new Map<object, Map<string, HTMLInputElement[]>>();
  for (const anchor of nativeRadioDiscoveryInputs) {
    const name = text(anchor.name);
    if (name === "") continue;
    const owner = anchor.form ?? anchor.getRootNode();
    const ownerGroups = nativeRadioGroups.get(owner) ?? new Map<string, HTMLInputElement[]>();
    if (ownerGroups.has(name)) continue;
    const scope = anchor.form?.ownerDocument ?? anchor.getRootNode();
    const members = [...(scope as Document | ShadowRoot)
      .querySelectorAll<HTMLInputElement>('input[type="radio"]')]
      .filter((member) => member.form === anchor.form &&
        member.getRootNode() === anchor.getRootNode() && text(member.name) === name &&
        !effectivelyDisabledRadio(member));
    ownerGroups.set(name, members);
    nativeRadioGroups.set(owner, ownerGroups);

    const structuredOwners = [...new Set(members.flatMap((member) => {
      const memberOwners: HTMLElement[] = [];
      const fieldset = member.closest<HTMLElement>("fieldset");
      const ariaGroup = member.closest<HTMLElement>('[role="radiogroup"]');
      if (fieldset !== null) memberOwners.push(fieldset);
      if (ariaGroup !== null && ariaGroup !== fieldset) memberOwners.push(ariaGroup);
      return memberOwners;
    }))];
    const structuredNames = structuredOwners.map((candidate) => accessibleName(candidate, false))
      .filter(Boolean).sort();
    const referencedIdSets = members.map((member) =>
      (member.getAttribute("aria-labelledby") ?? "").split(/\s+/u).filter(Boolean)
    ).filter((ids) => ids.length > 0);
    const sharedReferenceIds = referencedIdSets.length === 0 ? [] :
      referencedIdSets[0]!.filter((id) => referencedIdSets.every((ids) => ids.includes(id)));
    const sharedReferenceNames = sharedReferenceIds.map((id) =>
      text(document.getElementById(id)?.textContent)
    ).filter(Boolean).sort();
    const questionNames = [...new Set([...structuredNames, ...sharedReferenceNames])].sort();
    const questionLabel = text(questionNames.join(" ")) || accessibleName(anchor);
    const memberCatalog = members.map((member) => ({
      label: accessibleName(member),
      value: text(member.value),
      required: member.required || member.getAttribute("aria-required") === "true",
    })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    const required = members.some((member) =>
      member.required || member.getAttribute("aria-required") === "true"
    ) || structuredOwners.some((candidate) =>
      candidate.hasAttribute("required") || candidate.getAttribute("aria-required") === "true" ||
      candidate.querySelector(
        '[data-automation-id="required"], abbr[title="Required"], [aria-label="Required"]',
      ) !== null
    );
    const nativeOwner = anchor.form;
    const ownerContext: SemanticOwnerContext[] = [];
    let ownerElement: Element | null = nativeOwner ?? (
      owner instanceof ShadowRoot ? owner.host : root
    );
    for (let depth = 0; ownerElement !== null && depth < 8; depth += 1) {
      const entry = semanticOwnerEntry(ownerElement);
      if (entry !== undefined) ownerContext.push(entry);
      if (ownerElement === document.body) break;
      ownerElement = ownerElement.parentElement;
    }
    ownerContext.reverse();
    const stableOwnerCoordinate = JSON.stringify(ownerContext);
    const canonical = JSON.stringify({
      owner: stableOwnerCoordinate,
      name,
      questionNames,
      memberCatalog,
    });
    pendingNativeRadioModels.push({
      members,
      questionLabel,
      required,
      canonical,
      stableOwnerCoordinate,
      ownerContext,
    });
  }
  const nativeRadioEquivalence = new Map<string, PendingNativeRadioModel[]>();
  for (const pending of pendingNativeRadioModels) {
    const equivalent = nativeRadioEquivalence.get(pending.canonical) ?? [];
    equivalent.push(pending);
    nativeRadioEquivalence.set(pending.canonical, equivalent);
  }
  for (const [canonical, equivalent] of nativeRadioEquivalence) {
    equivalent.sort((left, right) => left.stableOwnerCoordinate.localeCompare(
      right.stableOwnerCoordinate,
    ));
    const digest = await collisionResistantHash(canonical);
    equivalent.forEach((pending, occurrence) => {
      const groupKey = `${digest}:${occurrence}`;
      const model: NativeRadioModel = {
        members: pending.members,
        questionLabel: pending.questionLabel,
        required: pending.required,
        groupKey,
        fieldId: `native-radio-${digest.slice(0, 32)}-${occurrence}`,
        ownerContext: pending.ownerContext,
      };
      pending.members.forEach((member) => nativeRadioModelByMember.set(member, model));
    });
  }
  for (const [index, control] of candidates.entries()) {
    const input = control instanceof HTMLInputElement ? control : undefined;
    const role = control.getAttribute("role");
    const fieldOwner = control.closest<HTMLElement>(
      '[data-automation-id="formField"], [data-automation-id^="formField-"]',
    );
    const ownsAriaRadioGroup = control.matches('fieldset, [role="radiogroup"]') &&
      control.querySelector('input[type="radio"], [role="radio"]') !== null;
    const ownsNamedNativeRadio = ownsAriaRadioGroup && [...control.querySelectorAll<HTMLInputElement>(
      'input[type="radio"]',
    )].some((member) => text(member.name) !== "");
    // A native named radio keeps browser form/tree-root membership even when
    // Workday wraps the members in a radiogroup. Its input candidates carry
    // the shared radiogroup/fieldset prompt without fabricating a second group.
    if (ownsNamedNativeRadio) continue;
    const nativeRadioName = input?.type === "radio" ? text(input.name) : "";
    const nativeRadioModel = input?.type === "radio" && nativeRadioName !== ""
      ? nativeRadioModelByMember.get(input)
      : undefined;
    const nativeMembershipOwner = nativeRadioModel === undefined
      ? undefined
      : input?.form ?? input?.getRootNode();
    const ariaRadioOwner = ownsAriaRadioGroup
      ? control
      : role === "radio"
        ? control.closest<HTMLElement>('[role="radiogroup"], fieldset') ?? control
        : input?.type === "radio" && nativeRadioName === ""
          ? control.closest<HTMLElement>("fieldset") ?? control
          : undefined;
    const radioMembershipOwner = nativeMembershipOwner ?? ariaRadioOwner;
    const radioQuestionOwner = nativeMembershipOwner === undefined
      ? ariaRadioOwner
      : nativeMembershipOwner instanceof HTMLElement ? nativeMembershipOwner : root;
    const radioGroupKey = nativeRadioModel?.groupKey ?? (radioMembershipOwner === undefined
      ? undefined
      : `aria:${semanticHash(accessibleName(radioMembershipOwner as Element))}`);
    const radioMembers = radioMembershipOwner === undefined
      ? []
      : nativeMembershipOwner !== undefined
        ? [...nativeRadioModel?.members ?? []]
        : [...(ariaRadioOwner ?? control).querySelectorAll<HTMLElement>(
          'input[type="radio"], [role="radio"]',
        )].filter(visible);
    const structuredQuestionOwners = radioMembers.map((member) =>
      member.closest<HTMLElement>('fieldset, [role="radiogroup"]')
    );
    const sharedQuestionOwner = structuredQuestionOwners[0] !== null &&
        structuredQuestionOwners.every((owner) => owner === structuredQuestionOwners[0])
      ? structuredQuestionOwners[0] ?? undefined
      : undefined;
    const memberQuestionReferences = radioMembers.map((member) =>
      (member.getAttribute("aria-labelledby") ?? "").split(/\s+/u).filter(Boolean)
    );
    const sharedQuestionReferenceIds = memberQuestionReferences.length === 0
      ? []
      : memberQuestionReferences[0]!.filter((id) =>
        memberQuestionReferences.every((ids) => ids.includes(id))
      );
    const sharedQuestionReference = text(sharedQuestionReferenceIds.map((id) =>
      document.getElementById(id)?.textContent ?? ""
    ).join(" "));
    if (radioGroupKey !== undefined && seenRadioGroups.has(radioGroupKey)) continue;
    if (radioGroupKey !== undefined) seenRadioGroups.add(radioGroupKey);
    const fingerprintControl = nativeRadioModel === undefined
      ? sharedQuestionOwner ?? radioQuestionOwner ?? control
      : control;
    const completionRequired = nativeRadioModel?.required ?? (
      requiredControlSet.has(control) ||
      radioMembers.some((member) => requiredControlSet.has(member))
    );
    const requiredIndex = requiredControls.findIndex((candidate) =>
      candidate === control || radioMembers.includes(candidate)
    );
    const nativeRadioFieldId = nativeMembershipOwner === undefined
      ? undefined
      : nativeRadioModel?.fieldId;
    const rawId = [
      nativeRadioFieldId,
      control.getAttribute("data-hunt-field-id"),
      control.getAttribute("data-automation-id"),
      control.id,
      input?.name,
    ].find((value): value is string => typeof value === "string" && value !== "") ??
      (completionRequired ? `required-field-${Math.max(0, requiredIndex)}` : `semantic-field-${index}`);
    const safeId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(rawId)
      ? rawId
      : completionRequired ? `required-field-${Math.max(0, requiredIndex)}` : `semantic-field-${index}`;
    const questionLabel = nativeMembershipOwner !== undefined
      ? nativeRadioModel?.questionLabel ?? text([...new Set([
        accessibleName(fingerprintControl, false),
        sharedQuestionReference,
      ].filter(Boolean))].join(" "))
      : accessibleName(fingerprintControl) ||
      (fieldOwner === null ? "" : accessibleName(fieldOwner));
    const semanticOwnerContext: SemanticOwnerContext[] = [];
    let semanticOwner: Element | null = fingerprintControl ?? fieldOwner;
    for (let depth = 0;
      semanticOwner !== null && root.contains(semanticOwner) && depth < 8;
      depth += 1
    ) {
      const entry = semanticOwnerEntry(semanticOwner);
      if (entry !== undefined) semanticOwnerContext.push(entry);
      if (semanticOwner === root) break;
      semanticOwner = semanticOwner.parentElement;
    }
    semanticOwnerContext.reverse();
    if (nativeRadioModel !== undefined) {
      semanticOwnerContext.splice(
        0,
        semanticOwnerContext.length,
        ...nativeRadioModel.ownerContext,
      );
    }
    const semanticControls = radioMembershipOwner !== undefined
      ? [fingerprintControl, ...radioMembers.filter((member) => member !== fingerprintControl)]
      : control.matches(
      '[data-automation-id="dateSection"], [data-automation-id="dateInputWrapper"], ' +
        '[data-automation-id$="-CheckboxGroup"], ' +
        `[${checkboxGroupAttribute}="exclusive"], [${checkboxGroupAttribute}="multiple"]`,
      )
        ? [control, ...control.querySelectorAll<HTMLElement>(
          'input:not([type="hidden"]), textarea, select, [role="radio"], [role="checkbox"], ' +
            '[role="combobox"], button[aria-haspopup="listbox"]',
        )]
        : [control];
    const constraints = semanticControls.map((item) => ({
      tag: item.tagName.toLocaleLowerCase("en-US"),
      automationId: (() => {
        const value = text(item.getAttribute("data-automation-id"));
        return /(?:formField|[0-9a-f]{8,}|\d{4,})/iu.test(value) ? "" : value;
      })(),
      type: item instanceof HTMLInputElement ? item.type : "",
      role: item.getAttribute("role") ?? "",
      required: item.hasAttribute("required") || item.getAttribute("aria-required") === "true",
      min: effectiveNumber(item.getAttribute("min")),
      max: effectiveNumber(item.getAttribute("max")),
      step: effectiveNumber(item.getAttribute("step")),
      minLength: item instanceof HTMLInputElement || item instanceof HTMLTextAreaElement
        ? item.minLength < 0 ? "" : String(item.minLength)
        : effectiveNumber(item.getAttribute("minlength")),
      maxLength: item instanceof HTMLInputElement || item instanceof HTMLTextAreaElement
        ? item.maxLength < 0 ? "" : String(item.maxLength)
        : effectiveNumber(item.getAttribute("maxlength")),
      pattern: item.getAttribute("pattern") ?? "",
      accept: item.getAttribute("accept") ?? "",
      inputMode: item.getAttribute("inputmode") ?? "",
      placeholder: text(item.getAttribute("placeholder")),
      multiple: item.hasAttribute("multiple"),
      readOnly: item.hasAttribute("readonly") || item.getAttribute("aria-readonly") === "true",
    })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    const semanticLeaf = fingerprintControl.matches(
      "input, textarea, select, [contenteditable=true]",
    )
      ? fingerprintControl
      : fingerprintControl.querySelector<HTMLElement>(
        "input:not([type=hidden]), textarea, select, [contenteditable=true], " +
          "[role=combobox], [role=listbox], [role=radiogroup], [role=checkbox]",
      ) ?? control;
    const formattedDate = semanticLeaf instanceof HTMLInputElement &&
      (semanticLeaf.type === "text" || semanticLeaf.type === "tel") &&
      (/^M{1,2}\s*\/\s*D{1,2}\s*\/\s*Y{2,4}$/iu.test(text(semanticLeaf.placeholder)) ||
        /^date(?:\s*\*)?$/iu.test(questionLabel));
    const supportedBehavior = radioMembershipOwner !== undefined
      ? "radio"
      : fingerprintControl.matches(
      '[data-automation-id="dateSection"], [data-automation-id="dateInputWrapper"]',
    ) || semanticLeaf instanceof HTMLInputElement &&
        (semanticLeaf.type === "date" || formattedDate)
      ? "date"
      : semanticLeaf instanceof HTMLTextAreaElement ? "textarea"
      : semanticLeaf instanceof HTMLInputElement && semanticLeaf.type === "file" ? "file_upload"
      : semanticLeaf instanceof HTMLSelectElement ? "select"
      : fingerprintControl.getAttribute("aria-haspopup") === "listbox" ||
          semanticLeaf.getAttribute("role") === "combobox" ||
          semanticLeaf.getAttribute("role") === "listbox"
        ? "listbox"
        : fingerprintControl instanceof HTMLFieldSetElement ||
            semanticLeaf.getAttribute("role") === "radiogroup" ||
            fingerprintControl.getAttribute("data-hunt-checkbox-selection-mode") === "exclusive"
          ? "radio"
          : semanticLeaf instanceof HTMLInputElement && semanticLeaf.type === "checkbox" ||
              semanticLeaf.getAttribute("role") === "checkbox"
            ? "checkbox"
            : semanticLeaf.getAttribute("contenteditable") === "true"
              ? "contenteditable"
              : "text";
    const catalog: { label: string; value: string; disabled: boolean }[] = [];
    const appendEncodedCatalog = (element: Element) => {
      const encoded = element.getAttribute("data-hunt-popup-options") ??
        element.getAttribute("data-hunt-deferred-options");
      if (encoded === null) return;
      try {
        const decoded = JSON.parse(encoded) as unknown;
        if (!Array.isArray(decoded)) return;
        for (const option of decoded) {
          if (typeof option === "string") {
            catalog.push({ label: text(option), value: text(option), disabled: false });
          }
        }
      } catch {
        // A malformed catalog is still represented by its absence; snapshot
        // observation must never expose the raw attribute outside the browser.
      }
    };
    for (const item of semanticControls) {
      if (item instanceof HTMLSelectElement) {
        catalog.push(...[...item.options].map((option) => ({
          label: text(option.label || option.textContent),
          value: text(option.value),
          disabled: option.disabled,
        })));
      }
      if (item.getAttribute("role") === "listbox" || item.getAttribute("role") === "radiogroup") {
        const memberSelector = item.getAttribute("role") === "listbox" ? '[role="option"]' : '[role="radio"]';
        catalog.push(...[...item.querySelectorAll<HTMLElement>(memberSelector)].map((member) => ({
          label: accessibleName(member),
          value: text(member.getAttribute("data-value") ?? member.getAttribute("aria-valuetext") ??
            member.getAttribute("value") ?? member.textContent),
          disabled: member.getAttribute("aria-disabled") === "true",
        })));
      }
      appendEncodedCatalog(item);
      if (item instanceof HTMLInputElement && ["radio", "checkbox"].includes(item.type) ||
          item.getAttribute("role") === "radio" || item.getAttribute("role") === "checkbox") {
        const itemInput = item instanceof HTMLInputElement ? item : undefined;
        catalog.push({
          label: accessibleName(item),
          value: text(itemInput?.value ?? item.getAttribute("data-value")),
          disabled: item.matches(":disabled") ||
            item.getAttribute("aria-disabled") === "true",
        });
      }
    }
    catalog.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    const semanticEligible = control.matches([
      supportedControls,
      '[data-automation-id="dateSection"]',
      '[data-automation-id="dateInputWrapper"]',
      '[data-automation-id$="-CheckboxGroup"]',
    ].join(", ")) || promotedGroupOwnerSet.has(control);
    if (semanticEligible && supportedBehavior === "listbox" && catalog.length === 0) {
      semanticDestinationComparable = false;
    }
    if (semanticEligible) semanticDestinationFields.push(JSON.stringify({
      questionLabel,
      behavior: {
        supported: supportedBehavior,
        tag: fingerprintControl.tagName.toLocaleLowerCase("en-US"),
        type: input?.type ?? "",
        role: role ?? "",
        popup: fingerprintControl.getAttribute("aria-haspopup") ?? "",
        contentEditable: fingerprintControl.getAttribute("contenteditable") ?? "",
        nativeGroupName: nativeRadioName,
      },
      selectionMode: fingerprintControl.getAttribute("data-hunt-checkbox-selection-mode") ===
          "multiple" || fingerprintControl.getAttribute(checkboxGroupAttribute) === "multiple" ||
          fingerprintControl instanceof HTMLSelectElement && fingerprintControl.multiple ||
          fingerprintControl.getAttribute("aria-multiselectable") === "true"
        ? "multiple"
        : "single",
      constraints,
      catalog,
      ownerContext: semanticOwnerContext,
    }));
    if (!completionRequired) continue;
    const nativeInvalid = (
      control instanceof HTMLInputElement ||
      control instanceof HTMLTextAreaElement ||
      control instanceof HTMLSelectElement
    ) && !control.validity.valid;
    const referencedMessages = [
      control.getAttribute("aria-errormessage"),
      control.getAttribute("aria-describedby"),
    ].filter((ids): ids is string => ids !== null)
      .flatMap((ids) => ids.split(/\s+/u))
      .map((id) => document.getElementById(id));
    const referencedValidation = referencedMessages.some((element) =>
      element !== null && visible(element) && text(element.textContent) !== "" &&
      element.matches(
        '[role="alert"], [data-automation-id="inputAlert"], ' +
        '[data-automation-id*="error" i], [id*="error" i]',
      )
    );
    const ownedValidation = fieldOwner !== null && [...fieldOwner.querySelectorAll<HTMLElement>(
      '[role="alert"], [data-automation-id="inputAlert"], [data-automation-id*="error" i]',
    )].some((element) => visible(element) && text(element.textContent) !== "");
    const unownedValidation = fieldOwner === null &&
      control.getAttribute("aria-invalid") === "true" &&
      [...root.querySelectorAll<HTMLElement>(
        '[role="alert"], [data-automation-id="inputAlert"], [data-automation-id*="error" i]',
      )].some((element) => visible(element) && text(element.textContent) !== "");
    // Workday can leave aria-invalid="true" on a conditionally revealed
    // textarea after a successful fill and blur. Treat the flag as stale only
    // when native validity passes and no owned, referenced, or unowned visible
    // validation message corroborates it.
    let verified = !nativeInvalid && !referencedValidation &&
      !ownedValidation && !unownedValidation;
    let dateReactHandlerLayers:
      BrowserApplicationSnapshot["requiredFields"][number]["diagnostic"]["dateReactHandlerLayers"];
    let checkboxReactHandlerLayers:
      BrowserApplicationSnapshot["requiredFields"][number]["diagnostic"]["checkboxReactHandlerLayers"];
    // Workday renders tokenized combobox selections beside the input inside the
    // nearest automation-owned ancestor. `closest()` on the control itself can
    // stop at the input, while the broader form-field owner can contain several
    // unrelated selected items. Match the profile observer's ancestor semantics.
    const selectionOwner = control.parentElement?.closest<HTMLElement>(
      '[data-automation-id]',
    ) ?? fieldOwner;
    const selectedItems = selectionOwner === null ? [] :
      [...selectionOwner.querySelectorAll<HTMLElement>(
        '[data-automation-id="selectedItem"]',
      )].filter((item) => visible(item) && text(item.textContent) !== "");
    const descendantRadios = [...control.querySelectorAll<HTMLElement>(
      'input[type="radio"], [role="radio"]',
    )];
    const fieldOwnerRadios = fieldOwner === null ? [] :
      [...fieldOwner.querySelectorAll<HTMLElement>(
        'input[type="radio"], [role="radio"]',
      )];
    const isChecked = (radio: HTMLElement): boolean =>
      radio instanceof HTMLInputElement
        ? radio.checked
        : radio.getAttribute("aria-checked") === "true";
    const fieldOwnerSelectedItems = fieldOwner === null ? [] :
      [...fieldOwner.querySelectorAll<HTMLElement>(
        '[data-automation-id="selectedItem"]',
      )].filter((item) => visible(item) && text(item.textContent) !== "");
    if (control.matches(
      '[data-automation-id="dateSection"], [data-automation-id="dateInputWrapper"]',
    )) {
      const parts = ["dateSectionMonth", "dateSectionDay", "dateSectionYear"].map(
        (automationId) => [...control.querySelectorAll<HTMLInputElement>(
          `[data-automation-id="${automationId}"], [data-automation-id="${automationId}-input"]`,
        )],
      );
      const formattedInputs = [...control.querySelectorAll<HTMLInputElement>(
        'input:not([type="hidden"])',
      )].filter((candidate) =>
        visible(candidate) && (candidate.type === "text" || candidate.type === "tel")
      );
      const segmented = parts.every((matches) => matches.length === 1);
      if (segmented) {
        const values = parts.map((matches) => matches[0]!.value.trim());
        verified = verified && validDateValue(
          `${values[2]}-${values[0]!.padStart(2, "0")}-${values[1]!.padStart(2, "0")}`,
        );
      } else {
        verified = verified && formattedInputs.length === 1 &&
          validDateValue(formattedInputs[0]!.value);
      }
    } else if (
      input !== undefined && (input.type === "text" || input.type === "tel") &&
      (
        /^M{1,2}[\s\u200E\u200F\u202A-\u202E\u2066-\u2069]*\/[\s\u200E\u200F\u202A-\u202E\u2066-\u2069]*D{1,2}[\s\u200E\u200F\u202A-\u202E\u2066-\u2069]*\/[\s\u200E\u200F\u202A-\u202E\u2066-\u2069]*Y{2,4}$/iu.test(
          input.placeholder.trim(),
        ) || /^date(?:\s*\*)?$/iu.test(
          (fieldOwner?.querySelector("label, legend")?.textContent ?? "").replace(/\s+/gu, " ").trim(),
        ) || [...(fieldOwner?.querySelectorAll('button[aria-label]') ?? [])]
          .filter((button) => visible(button) &&
            /^(?:open )?(?:calendar|date picker)$/iu.test(
              (button.getAttribute("aria-label") ?? "").trim(),
            )
          ).length === 1
      )
    ) {
      verified = verified && validDateValue(input.value);
      if (!verified) {
        const layers = new Map<string, NonNullable<typeof dateReactHandlerLayers>[number]>();
        const functionIds = new Map<unknown, number>();
        const functionId = (value: unknown): number => {
          const existing = functionIds.get(value);
          if (existing !== undefined) return existing;
          const next = functionIds.size + 1;
          functionIds.set(value, next);
          return next;
        };
        const addLayer = (element: Element, domDepth: number, fiberDepth: number, props: unknown) => {
          if (typeof props !== "object" || props === null) return;
          const entries = Object.entries(props);
          const handlers = entries.filter(([name, value]) =>
            /^on[A-Z]/u.test(name) && typeof value === "function"
          ).map(([name, value]) => ({
            name,
            arity: (value as (...args: unknown[]) => unknown).length,
            functionId: functionId(value),
          }));
          if (handlers.length === 0) return;
          const layer = {
            hostTag: element.tagName.toLocaleLowerCase("en-US"),
            domDepth,
            fiberDepth,
            propsKeys: entries.map(([name]) => name).slice(0, 40),
            handlers,
          };
          layers.set(JSON.stringify(layer), layer);
        };
        let element: Element | null = input;
        for (let domDepth = 0; element !== null && domDepth < 8; domDepth += 1) {
          const record = element as unknown as Record<string, unknown>;
          Object.keys(element).filter((key) => key.startsWith("__reactProps$"))
            .forEach((key) => addLayer(element!, domDepth, -1, record[key]));
          const fiberKey = Object.keys(element).find((key) =>
            key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$")
          );
          let fiber = fiberKey === undefined ? undefined : record[fiberKey] as {
            memoizedProps?: unknown;
            pendingProps?: unknown;
            return?: unknown;
          } | undefined;
          for (let fiberDepth = 0; fiber !== undefined && fiber !== null && fiberDepth < 16; fiberDepth += 1) {
            addLayer(element, domDepth, fiberDepth, fiber.memoizedProps ?? fiber.pendingProps);
            fiber = fiber.return as typeof fiber;
          }
          if (element === fieldOwner) break;
          element = element.parentElement;
        }
        dateReactHandlerLayers = [...layers.values()];
      }
    } else if (
      control.getAttribute(checkboxGroupAttribute) === "exclusive" ||
      control.getAttribute(checkboxGroupAttribute) === "multiple"
    ) {
      const checkboxes = [...control.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
      const checked = checkboxes.filter((item) => item.checked).length;
      verified = verified && checkboxes.length >= 2 && (
        control.getAttribute(checkboxGroupAttribute) === "multiple" ? checked >= 1 : checked === 1
      );
      const layers = new Map<string, {
        hostTag: string;
        hostAutomationId: string | null;
        domDepth: number;
        fiberDepth: number;
        propsKeys: string[];
        index: number | null;
        handlers: { name: string; arity: number; functionId: number }[];
        objects: { name: string; arrayLength: number | null; keys: string[] }[];
        inputIndexes: number[];
      }>();
      const functionIds = new Map<unknown, number>();
      const functionId = (value: unknown): number => {
        const existing = functionIds.get(value);
        if (existing !== undefined) return existing;
        const next = functionIds.size + 1;
        functionIds.set(value, next);
        return next;
      };
      const handlers = (props: unknown) =>
        typeof props === "object" && props !== null
          ? Object.entries(props)
            .filter(([name, value]) => /^on[A-Z]/u.test(name) && typeof value === "function")
            .map(([name, value]) => ({
              name,
              arity: (value as (...args: unknown[]) => unknown).length,
              functionId: functionId(value),
            }))
            .sort((left, right) => left.name.localeCompare(right.name) ||
              left.arity - right.arity || left.functionId - right.functionId)
          : [];
      const addLayer = (
        inputIndex: number,
        element: Element,
        domDepth: number,
        fiberDepth: number,
        props: unknown,
      ) => {
        if (typeof props !== "object" || props === null) return;
        const entries = Object.entries(props);
        const layerHandlers = handlers(props);
        if (layerHandlers.length === 0) return;
        const rawIndex = (props as Record<string, unknown>).index;
        const layer = {
          hostTag: element.tagName.toLocaleLowerCase("en-US"),
          hostAutomationId: element.getAttribute("data-automation-id"),
          domDepth,
          fiberDepth,
          propsKeys: entries.map(([name]) => name).slice(0, 40),
          index: typeof rawIndex === "number" && Number.isSafeInteger(rawIndex) ? rawIndex : null,
          handlers: layerHandlers,
          objects: entries.filter(([, value]) => typeof value === "object" && value !== null)
            .slice(0, 24).map(([name, value]) => ({
              name,
              arrayLength: Array.isArray(value) ? value.length : null,
              keys: Array.isArray(value)
                ? typeof value[0] === "object" && value[0] !== null
                  ? Object.keys(value[0]).slice(0, 24)
                  : []
                : Object.keys(value as object).slice(0, 24),
            })),
        };
        const key = JSON.stringify(layer);
        const existing = layers.get(key);
        if (existing === undefined) {
          layers.set(key, { ...layer, inputIndexes: [inputIndex] });
        } else if (!existing.inputIndexes.includes(inputIndex)) {
          existing.inputIndexes.push(inputIndex);
        }
      };
      checkboxes.forEach((checkbox, inputIndex) => {
        let element: Element | null = checkbox;
        for (let domDepth = 0; element !== null && domDepth < 8; domDepth += 1) {
          const record = element as unknown as Record<string, unknown>;
          Object.keys(element)
            .filter((key) => key.startsWith("__reactProps$"))
            .forEach((key) => addLayer(inputIndex, element!, domDepth, -1, record[key]));
          const fiberKey = Object.keys(element).find((key) =>
            key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$")
          );
          let fiber = fiberKey === undefined
            ? undefined
            : record[fiberKey] as {
              memoizedProps?: unknown;
              pendingProps?: unknown;
              return?: unknown;
            } | undefined;
          for (let fiberDepth = 0; fiber !== undefined && fiber !== null && fiberDepth < 16; fiberDepth += 1) {
            addLayer(
              inputIndex,
              element,
              domDepth,
              fiberDepth,
              fiber.memoizedProps ?? fiber.pendingProps,
            );
            fiber = fiber.return as typeof fiber;
          }
          if (element === control) break;
          element = element.parentElement;
        }
      });
      checkboxReactHandlerLayers = [...layers.values()];
    } else if (input?.type === "file") {
      const visibleFileInputs = [...root.querySelectorAll<HTMLInputElement>(
        'input[type="file"]',
      )].filter(visible);
      const uploadOwner = fieldOwner ?? (
        visibleFileInputs.length === 1 ? root : input.parentElement
      );
      const items = uploadOwner === null ? [] : [...uploadOwner.querySelectorAll<HTMLElement>(
        '[data-automation-id="file-upload-item"]',
      )].filter(visible);
      const successes = uploadOwner === null ? [] : [...uploadOwner.querySelectorAll<HTMLElement>(
        '[data-automation-id="file-upload-success"], ' +
          '[data-automation-id="file-upload-item"][data-upload-state="success"]',
      )].filter(visible);
      verified = verified && input.files?.length === 1 &&
        items.length === 1 && successes.length === 1;
    } else if (radioMembershipOwner !== undefined) {
      // Browser radio ownership is form-or-tree-root plus native name. Reuse
      // that exact admitted member set for completion instead of requerying a
      // wider Workday root that may contain an independent same-name group.
      verified = verified && radioMembers.length > 0 &&
        radioMembers.filter(isChecked).length === 1;
    } else if (descendantRadios.length > 0) {
      // Workday visually exposes styled labels while keeping the native radio
      // inputs hidden, and its required group container may omit an ARIA role.
      // Checked state is authoritative inside the required composite control.
      verified = verified && descendantRadios.filter(isChecked).length === 1;
    } else if (input?.type === "checkbox") {
      verified = verified && input.checked;
    } else if (role === "radio" || role === "checkbox") {
      verified = verified && control.getAttribute("aria-checked") === "true";
    } else if (control instanceof HTMLSelectElement) {
      verified = verified && control.value.trim() !== "";
    } else if (role === "combobox" || control.matches([
      'button[aria-haspopup="listbox"]',
      'button[data-automation-id="sourcePrompt"]',
      'button[id="country--country"]',
      'button[id="address--countryRegion"]',
      'button[id="phoneNumber--phoneType"]',
    ].join(", ")) || control instanceof HTMLButtonElement && [
      "country--country",
      "address--countryRegion",
      "phoneNumber--phoneType",
    ].includes(safeId)) {
      const declared = text(control.getAttribute("aria-valuetext"));
      const declaredPlaceholder = /^(?:select one|select|choose|choose one)$/u.test(
        declared.toLocaleLowerCase("en-US"),
      );
      const selectedLabel = text(control.getAttribute("data-selected-label"));
      const selectedLabelPlaceholder = /^(?:select one|select|choose|choose one)$/u.test(
        selectedLabel.toLocaleLowerCase("en-US"),
      );
      const value = control instanceof HTMLInputElement
        ? control.value
        : declared !== "" && !declaredPlaceholder
          ? declared
          : selectedLabel !== "" && !selectedLabelPlaceholder
            ? selectedLabel
            : text(control.textContent);
      const normalizedValue = text(value).toLocaleLowerCase("en-US");
      const placeholder = /^(?:select one|select|choose|choose one)$/u.test(normalizedValue);
      verified = verified && (
        normalizedValue !== "" && !placeholder || selectedItems.length === 1
      );
    } else if (selectedItems.length === 1) {
      // Workday's tokenized country-code input is a plain text input with an
      // intentionally empty backing value. Its one visible nonempty token is the
      // committed selection even when no combobox role is present.
      verified = verified && true;
    } else if (
      control instanceof HTMLInputElement ||
      control instanceof HTMLTextAreaElement
    ) {
      verified = verified && control.value.trim() !== "";
    } else if (control.getAttribute("contenteditable") === "true") {
      verified = verified && text(control.textContent) !== "";
    } else {
      verified = false;
    }
    const resumeOwnedFile = input?.type === "file" &&
      input.getAttribute("data-automation-id") === "file-upload-input-ref";
    const fieldPage: ApplicationHandlerPage | undefined = resumeOwnedFile
      ? "resume"
      : combinedResumeProfile
        ? "profile"
        : page === "resume" || page === "profile" || page === "questionnaire"
          ? page
          : undefined;
    requiredFields.push({
      fieldId: safeId,
      semanticKey: semanticHash([
        questionLabel,
        control.tagName,
        input?.type ?? "",
        role ?? "",
        nativeMembershipOwner === undefined ? "" : radioGroupKey ?? "",
      ].join("\u0000")),
      ...(fieldPage === undefined ? {} : { page: fieldPage }),
      verification: verified ? "verified" : "unverified",
      diagnostic: {
        tag: control.tagName.toLocaleLowerCase("en-US"),
        role,
        inputType: input?.type ?? null,
        descendantRadioCount: descendantRadios.length,
        descendantCheckedCount: descendantRadios.filter(isChecked).length,
        fieldOwnerRadioCount: fieldOwnerRadios.length,
        fieldOwnerCheckedCount: fieldOwnerRadios.filter(isChecked).length,
        nearestSelectedItemCount: selectedItems.length,
        fieldOwnerSelectedItemCount: fieldOwnerSelectedItems.length,
        inputNonEmpty: (
          control instanceof HTMLInputElement ||
          control instanceof HTMLTextAreaElement
        ) && control.value.trim() !== "",
        ariaValueNonEmpty: text(control.getAttribute("aria-valuetext")) !== "",
        textNonEmpty: text(control.textContent) !== "",
        ariaDescribedByPresent: text(control.getAttribute("aria-describedby")) !== "",
        referencedValidation,
        ownedValidation,
        unownedValidation,
        fieldOwnerInputNonEmptyCount: fieldOwner === null ? 0 :
          [...fieldOwner.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
            "input, textarea",
          )].filter((candidate) => candidate.value.trim() !== "").length,
        ...(dateReactHandlerLayers === undefined ? {} : { dateReactHandlerLayers }),
        ...(checkboxReactHandlerLayers === undefined ? {} : { checkboxReactHandlerLayers }),
      },
    });
  }
  const semanticDestinationMultiplicity = new Map<string, number>();
  for (const field of semanticDestinationFields) {
    semanticDestinationMultiplicity.set(
      field,
      (semanticDestinationMultiplicity.get(field) ?? 0) + 1,
    );
  }
  const semanticDestinationCanonical = JSON.stringify(
    [...semanticDestinationMultiplicity.entries()].sort(([left], [right]) =>
      left.localeCompare(right)
    ),
  );
  const semanticDestinationFingerprint = await collisionResistantHash(
    semanticDestinationCanonical,
  );
  const fingerprints = new Map<string, number>();
  let duplicateRows = 0;
  for (const row of [...root.querySelectorAll<HTMLElement>(
    '[data-hunt-c3-owned="true"]',
  )].filter(visible)) {
    const values = [...row.querySelectorAll<
      HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
    >("input, textarea, select")]
      .filter(visible)
      .map((control) => control.value.normalize("NFC").trim())
      .sort();
    const fingerprint = values.join("\u001f");
    if (fingerprint === "") continue;
    const count = fingerprints.get(fingerprint) ?? 0;
    if (count > 0) duplicateRows += 1;
    fingerprints.set(fingerprint, count + 1);
  }
  const validationElements = [...root.querySelectorAll<HTMLElement>(
    '[aria-invalid="true"], [role="alert"], [data-automation-id="inputAlert"], ' +
      '[data-automation-id*="error" i]',
  )].filter(visible);
  const validationKeys = validationElements.map((item) => [
    item.getAttribute("data-automation-id") ?? "",
    item.id,
    item.getAttribute("role") ?? "",
    text(item.textContent),
  ].join(":"));
  const validationOwners = [...new Set(validationElements.flatMap((item) => {
    const owner = item.closest<HTMLElement>('[data-automation-id^="formField-"]');
    const id = owner?.getAttribute("data-automation-id") ??
      item.getAttribute("data-automation-id") ?? item.id;
    return /^[A-Za-z][A-Za-z0-9_-]{0,127}$/u.test(id) ? [id] : [];
  }))];
  const activeStep = [...document.querySelectorAll<HTMLElement>(
    '[data-automation-id="progressBarActiveStep"]',
  )].find(visible);
  const controlSignature = candidates.map((control) => [
    control.tagName,
    control.getAttribute("type") ?? "",
    control.getAttribute("role") ?? "",
    control.getAttribute("data-automation-id") ?? "",
    control.getAttribute("data-hunt-field-id") ?? "",
    control.id,
    control.getAttribute("name") ?? "",
  ].join(":"));
  const labels = [...root.querySelectorAll<HTMLElement>("label, legend, h1, h2")]
    .filter(visible)
    .map((item) => text(item.textContent));
  if (typeof globalState.__huntPhysicalQuestionnaireContext !== "string") {
    const nonce = new Uint32Array(2);
    globalThis.crypto.getRandomValues(nonce);
    globalState.__huntPhysicalQuestionnaireContext = [...nonce]
      .map((value) => value.toString(16).padStart(8, "0")).join("");
  }
  let physicalNodes = globalState.__huntPhysicalQuestionnaireNodes;
  if (!(physicalNodes instanceof WeakMap)) {
    physicalNodes = new WeakMap<Element, number>();
    globalState.__huntPhysicalQuestionnaireNodes = physicalNodes;
    globalState.__huntPhysicalQuestionnaireNodeSequence = 0;
  }
  const instanceId = (element: Element): number => {
    const nodes = physicalNodes as WeakMap<Element, number>;
    const existing = nodes.get(element);
    if (existing !== undefined) return existing;
    const sequence = Number(globalState.__huntPhysicalQuestionnaireNodeSequence ?? 0) + 1;
    globalState.__huntPhysicalQuestionnaireNodeSequence = sequence;
    nodes.set(element, sequence);
    return sequence;
  };
  const physicalDomKey = [
    globalState.__huntPhysicalQuestionnaireContext,
    instanceId(root),
    ...requiredControls.map(instanceId),
  ].join(":");
  const physicalPageOccurrenceKey = [
    page,
    rootSelector,
    location.pathname,
    location.search,
    root.getAttribute("data-automation-id") ?? "",
    text(activeStep?.textContent),
  ].join("\u0000");
  const signature = [
    location.href,
    root.getAttribute("data-automation-id") ?? "",
    physicalPageOccurrenceKey,
    text(activeStep?.textContent),
    controlSignature.join("\u001f"),
    labels.join("\u001f"),
    validationKeys.join("\u001f"),
    physicalDomKey,
    semanticDestinationFingerprint,
    navigationWitness,
  ].join("\u0000");
  const transitionKey = [
    page,
    rootSelector,
    location.href,
    physicalPageOccurrenceKey,
    text(activeStep?.textContent),
  ].join("\u0000");
  return {
    page,
    lanes,
    rootSelector,
    pageId: page === "questionnaire" ? null : document.body.getAttribute("data-hunt-page-id"),
    requiredFields,
    c3OwnedDuplicateRows: duplicateRows,
    submitActivated: document.documentElement.getAttribute("data-hunt-submit-activated") === "true",
    signature,
    semanticDestinationFingerprint,
    semanticDestinationComparable,
    transitionKey,
    physicalPageOccurrenceKey,
    physicalDomKey,
    navigationWitness,
    validationKeys,
    validationOwners,
  };

}
function failure(code: ApplicationPortFailure["code"],
  unknownLayer: ApplicationPortFailure["unknownLayer"]):
  { readonly ok: false; readonly error: ApplicationPortFailure } {
  return {
    ok: false,
    error: {
      code,
      classifier: unknownLayer === "navigation"
        ? "page_navigation"
        : "workday_page",
      primitive: unknownLayer === "navigation" ? "next" : "page_observation",
      unknownLayer,
    },
  };
}
