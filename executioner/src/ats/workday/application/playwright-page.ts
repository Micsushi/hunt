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
  }[];
  readonly c3OwnedDuplicateRows: number;
  readonly submitActivated: boolean;
  readonly signature: string;
  readonly transitionKey: string;
  readonly validationKeys: readonly string[];
}
export class PlaywrightWorkdayApplicationPage {
  readonly #page: Page;
  readonly #timeoutMs: number;
  readonly #pageIds: Partial<Record<ApplicationPage, ApplicationPageTruth["pageId"]>>;
  constructor(page: Page, options: PlaywrightWorkdayApplicationPageOptions = {}) {
    this.#page = page;
    this.#timeoutMs = options.timeoutMs ?? 5_000;
    this.#pageIds = options.pageIds ?? {};
  }
  async observe(signal: AbortSignal): Promise<ApplicationPortResult<ApplicationPageTruth>> {
    const snapshot = await this.#readSnapshot(signal);
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
      const action = await singleActionableNext(this.#page, before.value.rootSelector);
      if (action === undefined) return failure("navigation_uncertain", "navigation");
      await action.click({ timeout: this.#timeoutMs });
      clicked = true;
      const after = await this.#waitForChangedSnapshot(before.value.signature, signal);
      if (!after.ok) return after;
      const afterTruth = this.#toTruth(after.value);
      if (!request.allowed.includes(afterTruth.page) || afterTruth.submitActivated) {
        return failure("navigation_uncertain", "navigation");
      }
      if (hasValidationDowngrade(before.value, after.value)) {
        return failure("page_incomplete", "navigation");
      }
      if (
        after.value.transitionKey === before.value.transitionKey &&
        after.value.requiredFields.length <= before.value.requiredFields.length
      ) {
        return failure("browser_effect_uncertain", "navigation");
      }
      return { ok: true, value: { advanced: true } };
    } catch {
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
      return snapshot === null
        ? failure("browser_target_ambiguous", "page_type")
        : { ok: true, value: snapshot };
    } catch {
      return failure(
        signal.aborted ? "operation_cancelled" : "browser_target_stale",
        "ui_behavior",
      );
    }
  }
  async #waitForChangedSnapshot(
    beforeSignature: string,
    signal: AbortSignal,
  ): Promise<ApplicationPortResult<BrowserApplicationSnapshot>> {
    const deadline = Date.now() + this.#timeoutMs;
    while (Date.now() < deadline) {
      if (signal.aborted) return failure("operation_cancelled", "none");
      const after = await this.#readSnapshot(signal);
      if (after.ok && after.value.signature !== beforeSignature) return after;
      const remaining = deadline - Date.now();
      if (remaining > 0) await this.#page.waitForTimeout(Math.min(50, remaining));
    }
    return failure("browser_effect_uncertain", "navigation");
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
async function singleActionableNext(page: Page, rootSelector: string): Promise<Locator | undefined> {
  const root = page.locator(rootSelector);
  if (await root.count() !== 1 || !await root.isVisible()) return undefined;
  const controls = root.getByRole("button", {
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
): BrowserApplicationSnapshot | null {
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
  if (visibleRoots.length !== 1) return null;
  const { page: rootPage, root } = visibleRoots[0]!;
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
    const selectedItems = fieldOwner === null ? [] :
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
    } else if (role === "combobox") {
      const value = control instanceof HTMLInputElement ? control.value :
        control.getAttribute("aria-valuetext") ?? "";
      verified = verified && (value.trim() !== "" || selectedItems.length === 1);
    } else if (
      control instanceof HTMLInputElement ||
      control instanceof HTMLTextAreaElement
    ) {
      verified = verified && control.value.trim() !== "";
    } else if (control.getAttribute("contenteditable") === "true") {
      verified = verified && text(control.textContent) !== "";
    } else if (control.matches('button[data-automation-id="sourcePrompt"]')) {
      verified = verified && selectedItems.length === 1;
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
    visibleRoots[0]!.selector,
    location.href,
    document.body.getAttribute("data-hunt-page-id") ?? "",
    text(activeStep?.textContent),
  ].join("\u0000");
  return {
    page,
    lanes,
    rootSelector: visibleRoots[0]!.selector,
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
