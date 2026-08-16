import type { Locator, Page } from "playwright";
import { browserPageId, fieldId } from "../../../contracts/index.ts";
import {
  WORKDAY_APPLICATION_PAGE_SELECTORS,
  type ApplicationHandlerPage,
  type ApplicationPage,
  type ApplicationPageTruth,
  type ApplicationPortFailure,
  type ApplicationPortResult,
  type ApplicationWalkDependencies,
} from "./page-walk-contract.ts";
export interface PlaywrightWorkdayApplicationPageOptions { readonly timeoutMs?: number;
  readonly navigationSettleTimeoutMs?: number;
  readonly pageIds?: Partial<Record<ApplicationPage, ApplicationPageTruth["pageId"]>>; }
interface BrowserApplicationSnapshot {
  readonly page: ApplicationPage;
  readonly lanes: readonly ApplicationHandlerPage[];
  readonly rootSelector: string;
  readonly pageId: string | null;
  readonly requiredFields: readonly {
    readonly fieldId: string;
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
    };
  }[];
  readonly c3OwnedDuplicateRows: number;
  readonly submitActivated: boolean;
  readonly signature: string;
  readonly transitionKey: string;
  readonly validationKeys: readonly string[];
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
export class PlaywrightWorkdayApplicationPage {
  readonly #page: Page;
  readonly #timeoutMs: number;
  readonly #navigationSettleTimeoutMs: number;
  readonly #pageIds: Partial<Record<ApplicationPage, ApplicationPageTruth["pageId"]>>;
  constructor(page: Page, options: PlaywrightWorkdayApplicationPageOptions = {}) {
    this.#page = page;
    this.#timeoutMs = options.timeoutMs ?? 5_000;
    this.#navigationSettleTimeoutMs = options.navigationSettleTimeoutMs ?? this.#timeoutMs;
    this.#pageIds = options.pageIds ?? {};
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
    ) return failure("navigation_illegal", "navigation");
    let clicked = false;
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
        await handle.click({ timeout: this.#navigationSettleTimeoutMs });
        navigationDiagnostic("admitted_control_activated");
      } catch {
        navigationDiagnostic("activation_failed");
        // Destination readback owns the result.
      }
      navigationDiagnostic("destination_readback_started");
      const after = await this.#waitForChangedSnapshot(
        before.value,
        signal,
      );
      navigationDiagnostic(after.ok ? "destination_readback_succeeded" : "destination_readback_failed");
      if (!after.ok) return after;
      const afterTruth = this.#toTruth(after.value);
      if (!request.allowed.includes(afterTruth.page) || afterTruth.submitActivated) {
        navigationDiagnostic("destination_not_allowed", {
          beforePage: before.value.page,
          afterPage: after.value.page,
          allowedPages: request.allowed,
          rootChanged: after.value.rootSelector !== before.value.rootSelector,
          transitionChanged: after.value.transitionKey !== before.value.transitionKey,
          submitActivated: afterTruth.submitActivated,
        });
        return failure("navigation_uncertain", "navigation");
      }
      if (hasValidationDowngrade(before.value, after.value)) {
        navigationDiagnostic("validation_downgrade", {
          beforePage: before.value.page,
          afterPage: after.value.page,
          rootChanged: after.value.rootSelector !== before.value.rootSelector,
        });
        return failure("page_incomplete", "navigation");
      }
      if (
        after.value.page === before.value.page &&
        after.value.rootSelector === before.value.rootSelector &&
        after.value.transitionKey === before.value.transitionKey &&
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
  async #readSnapshot(signal: AbortSignal): Promise<ApplicationPortResult<BrowserApplicationSnapshot>> {
    if (signal.aborted) return failure("operation_cancelled", "none");
    try {
      const snapshot = await this.#page.evaluate(
        readApplicationSnapshot, WORKDAY_APPLICATION_PAGE_SELECTORS,
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
  ): Promise<ApplicationPortResult<BrowserApplicationSnapshot>> {
    for (let pass = 0; pass < 2; pass += 1) {
      const deadline = Date.now() + this.#navigationSettleTimeoutMs;
      while (Date.now() < deadline) {
        if (signal.aborted) return failure("operation_cancelled", "none");
        const after = await this.#readSnapshot(signal);
        if (
          after.ok && after.value.signature !== before.signature &&
          (after.value.page !== before.page ||
            after.value.rootSelector !== before.rootSelector ||
            (before.page === "questionnaire" && after.value.page === "questionnaire" &&
              after.value.transitionKey !== before.transitionKey) ||
            after.value.requiredFields.length > before.requiredFields.length ||
            hasValidationDowngrade(before, after.value))
        ) {
          const stable = await this.#confirmStableDestination(after.value, signal);
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
        await loading.count() !== 1
      ) break;
      if (process.env.HUNT_C3_VALUE_FREE_ACCOUNT_TRACE === "1") {
        process.stderr.write('{"applicationNavigationRecovery":"owned_loading_reload"}\n');
      }
      try {
        await this.#page.reload({
          waitUntil: "domcontentloaded",
          timeout: this.#navigationSettleTimeoutMs,
        });
      } catch {
        break;
      }
    }
    return failure("browser_effect_uncertain", "navigation");
  }
  async #confirmStableDestination(
    candidate: BrowserApplicationSnapshot,
    signal: AbortSignal,
  ): Promise<BrowserApplicationSnapshot | undefined> {
    const deadline = Date.now() + Math.min(1_000, this.#navigationSettleTimeoutMs);
    let confirmed = candidate;
    while (Date.now() < deadline) {
      await this.#page.waitForTimeout(Math.min(100, Math.max(1, deadline - Date.now())));
      if (signal.aborted || await this.#page.locator(
        '[data-automation-id="applyFlowLoadingPage"]:visible',
      ).count() !== 0) return undefined;
      const observed = await this.#readSnapshot(signal);
      if (
        !observed.ok ||
        observed.value.page !== candidate.page ||
        observed.value.rootSelector !== candidate.rootSelector ||
        observed.value.transitionKey !== candidate.transitionKey
      ) return undefined;
      confirmed = observed.value;
    }
    return confirmed;
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
    return Object.freeze({
      page: snapshot.page,
      lanes: Object.freeze([...snapshot.lanes]),
      pageId: snapshot.pageId === null
        ? this.#pageIds[snapshot.page] ??
          browserPageId(`s2-${snapshot.page.replace("_", "-")}`)
        : browserPageId(snapshot.pageId),
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
function readApplicationSnapshot(
  selectors: typeof WORKDAY_APPLICATION_PAGE_SELECTORS,
): BrowserApplicationSnapshot | BrowserApplicationAmbiguity {
  const visible = (element: Element): element is HTMLElement => {
    if (!(element instanceof HTMLElement) || element.hidden ||
        element.getAttribute("aria-hidden") === "true") return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" &&
      style.visibility !== "collapse" && element.getClientRects().length > 0;
  };
  const text = (value: string | null | undefined): string =>
    (value ?? "").normalize("NFC").replace(/\s+/gu, " ").trim();
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
    'input:not([type="hidden"])',
    "textarea",
    "select",
    '[contenteditable="true"]',
    '[role="combobox"]',
    '[role="radio"]',
    '[role="checkbox"]',
    '[tabindex]:not([tabindex="-1"])',
    'button[data-automation-id="sourcePrompt"]',
    '[aria-required="true"]',
  ].join(", ");
  const candidates = [...new Set(root.querySelectorAll<HTMLElement>(candidateSelector))]
    .filter((control) => (visible(control) || resumeInputs.includes(
      control as HTMLInputElement,
    )) &&
      !("disabled" in control && control.disabled === true) &&
      control.getAttribute("aria-disabled") !== "true");
  const requiredControls = candidates.filter((control) => {
    if (control.hasAttribute("required") ||
        control.getAttribute("aria-required") === "true") return true;
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
    return field !== null && field.querySelector(
      '[data-automation-id="required"], abbr[title="Required"], [aria-label="Required"]',
    ) !== null;
  });
  const requiredFields: BrowserApplicationSnapshot["requiredFields"][number][] = [];
  const seenRadioGroups = new Set<string>();
  for (const [index, control] of requiredControls.entries()) {
    const input = control instanceof HTMLInputElement ? control : undefined;
    const role = control.getAttribute("role");
    const fieldOwner = control.closest<HTMLElement>(
      '[data-automation-id="formField"], [data-automation-id^="formField-"]',
    );
    const rawId = [
      control.getAttribute("data-hunt-field-id"),
      control.getAttribute("data-automation-id"),
      control.id,
      input?.name,
    ].find((value): value is string => typeof value === "string" && value !== "") ??
      `required-field-${index}`;
    const safeId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(rawId)
      ? rawId
      : `required-field-${index}`;
    const radioKey = input?.type === "radio" || role === "radio"
      ? input?.name || fieldOwner?.getAttribute("data-automation-id") || safeId
      : undefined;
    if (radioKey !== undefined && seenRadioGroups.has(radioKey)) continue;
    if (radioKey !== undefined) seenRadioGroups.add(radioKey);
    let verified = control.getAttribute("aria-invalid") !== "true";
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
    if (input?.type === "file") {
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
    } else if (descendantRadios.length > 0) {
      // Workday visually exposes styled labels while keeping the native radio
      // inputs hidden, and its required group container may omit an ARIA role.
      // Checked state is authoritative inside the required composite control.
      verified = verified && descendantRadios.filter(isChecked).length === 1;
    } else if (input?.type === "radio") {
      const radios = input.name === ""
        ? [input]
        : [...root.querySelectorAll<HTMLInputElement>(
          `input[type="radio"][name="${CSS.escape(input.name)}"]`,
        )].filter(visible);
      verified = verified && radios.filter(({ checked }) => checked).length === 1;
    } else if (input?.type === "checkbox") {
      verified = verified && input.checked;
    } else if (role === "radio" || role === "checkbox") {
      verified = verified && control.getAttribute("aria-checked") === "true";
    } else if (control instanceof HTMLSelectElement) {
      verified = verified && control.value.trim() !== "";
    } else if (role === "combobox" || control.matches('button[aria-haspopup="listbox"]')) {
      const value = control instanceof HTMLInputElement ? control.value :
        control.getAttribute("aria-valuetext") ?? text(control.textContent);
      const normalizedValue = text(value).toLocaleLowerCase("en-US");
      const placeholder = /^(?:select one|select|choose|none)$/u.test(normalizedValue);
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
        inputNonEmpty: input?.value.trim() !== "",
        ariaValueNonEmpty: text(control.getAttribute("aria-valuetext")) !== "",
      },
    });
  }
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
  const validationKeys = [...root.querySelectorAll<HTMLElement>(
    '[aria-invalid="true"], [role="alert"], [data-automation-id="inputAlert"], ' +
      '[data-automation-id*="error" i]',
  )].filter(visible).map((item) => [
    item.getAttribute("data-automation-id") ?? "",
    item.id,
    item.getAttribute("role") ?? "",
    text(item.textContent),
  ].join(":"));
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
  const signature = [
    location.href,
    root.getAttribute("data-automation-id") ?? "",
    document.body.getAttribute("data-hunt-page-id") ?? "",
    text(activeStep?.textContent),
    controlSignature.join("\u001f"),
    labels.join("\u001f"),
    validationKeys.join("\u001f"),
  ].join("\u0000");
  const transitionKey = [
    page,
    rootSelector,
    location.href,
    document.body.getAttribute("data-hunt-page-id") ?? "",
    text(activeStep?.textContent),
  ].join("\u0000");
  return {
    page,
    lanes,
    rootSelector,
    pageId: document.body.getAttribute("data-hunt-page-id"),
    requiredFields,
    c3OwnedDuplicateRows: duplicateRows,
    submitActivated: document.documentElement.getAttribute("data-hunt-submit-activated") === "true",
    signature,
    transitionKey,
    validationKeys,
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
