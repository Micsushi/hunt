import type { Locator, Page } from "playwright";

import {
  boundedText,
  browserTargetToken,
  MAX_RESUME_ARTIFACT_BYTES,
  sha256Digest,
  type BrowserControl,
  type BrowserMutation,
  type BrowserObservation,
  type BrowserPageId,
  type BrowserReadback,
  type BrowserSessionId,
  type BrowserTargetState,
  type ResumeId,
} from "../contracts/index.ts";

const controlSelector = [
  '[data-automation-id="dateSection"][data-hunt-target-token]',
  "fieldset[data-hunt-target-token]",
  'input:not([type="hidden"])',
  "textarea",
  "select",
  "button",
  '[role="combobox"][data-hunt-target-token]',
  '[role="listbox"]',
  '[role="button"]',
].join(",");

const nextName = /^(?:next|continue|save(?:\s+and)?\s+continue)$/iu;

interface RawControl {
  readonly index: number;
  readonly declaredToken: string;
  readonly name: string;
  readonly required: boolean;
  readonly control: BrowserControl;
  readonly state: BrowserTargetState;
  readonly readback: BrowserReadback;
  readonly radioOptions?: readonly string[];
  readonly interaction?: "owned-popup" | "field-popup" | "composite-date";
}

export interface ResolvedBrowserTarget extends RawControl {
  readonly token: ReturnType<typeof browserTargetToken>;
}

export interface UploadedArtifactReadback {
  readonly resumeId: ResumeId;
  readonly sha256: ReturnType<typeof sha256Digest>;
}

export interface PageInspection {
  readonly observation: BrowserObservation;
  readonly targets: ReadonlyMap<string, readonly ResolvedBrowserTarget[]>;
}

export async function inspectPage(
  page: Page,
  sessionId: BrowserSessionId,
  pageId: BrowserPageId,
  uploads: ReadonlyMap<string, UploadedArtifactReadback>,
): Promise<PageInspection> {
  const raw = await inspectControls(page);
  const targets = new Map<string, ResolvedBrowserTarget[]>();
  const observations: BrowserObservation["targets"][number][] = [];

  for (const item of raw) {
    if (item.declaredToken.length === 0) continue;
    if (item.control.kind === "button" && !nextName.test(item.name)) continue;
    const control = normalizeControl(item.control);
    const name = bounded(item.name);
    const token = browserTargetToken(item.declaredToken);
    const uploaded = uploads.get(token);
    const readback = item.control.kind === "file"
      ? await inspectUploadReadback(page, item.index, uploaded)
      : normalizeReadback(item.readback);
    const target = {
      ...item,
      name,
      control,
      readback,
      token,
      radioOptions: item.radioOptions?.map(bounded),
    };
    const matches = targets.get(token);
    if (matches === undefined) targets.set(token, [target]);
    else matches.push(target);

    observations.push({
      token,
      name,
      required: item.required,
      control,
      state: item.state,
      readback,
      ...(target.radioOptions === undefined || !target.token.startsWith("target-workday-")
        ? {}
        : { options: target.radioOptions }),
    } as BrowserObservation["targets"][number]);
  }

  const url = new URL(page.url());
  return {
    observation: {
      sessionId,
      pageId,
      origin: url.origin,
      path: url.pathname,
      targets: observations,
    },
    targets,
  };
}

async function inspectUploadReadback(
  page: Page,
  index: number,
  uploaded: UploadedArtifactReadback | undefined,
): Promise<BrowserReadback> {
  let live: unknown;
  try {
    live = await page.locator(controlSelector).nth(index).evaluate(
      async (element, maximumBytes) => {
        if (
          !(element instanceof HTMLInputElement) ||
          element.type !== "file" ||
          element.files === null
        ) return { kind: "unavailable" };
        if (element.files.length === 0) return { kind: "empty" };
        if (element.files.length !== 1) return { kind: "unavailable" };
        const file = element.files[0];
        if (file === undefined || file.size === 0 || file.size > maximumBytes) {
          return { kind: "unavailable" };
        }
        if (!globalThis.isSecureContext || globalThis.crypto?.subtle === undefined) {
          return { kind: "unavailable" };
        }
        let bytes: Uint8Array<ArrayBuffer> | undefined;
        try {
          bytes = new Uint8Array(await file.arrayBuffer());
          if (bytes.byteLength === 0 || bytes.byteLength > maximumBytes) {
            return { kind: "unavailable" };
          }
          const size = bytes.byteLength;
          const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
          if (
            element.files.length !== 1 ||
            element.files[0] !== file
          ) {
            return { kind: "unavailable" };
          }
          const sha256 = [...new Uint8Array(digest)]
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join("");
          return { kind: "digest", sha256, size };
        } catch {
          return { kind: "unavailable" };
        } finally {
          bytes?.fill(0);
        }
      },
      MAX_RESUME_ARTIFACT_BYTES,
    );
  } catch {
    return { kind: "unavailable" };
  }

  if (
    typeof live !== "object" ||
    live === null ||
    !("kind" in live) ||
    typeof live.kind !== "string"
  ) return { kind: "unavailable" };
  if (live.kind === "empty") {
    return { kind: "upload", resumeId: null, sha256: null };
  }
  if (
    live.kind !== "digest" ||
    uploaded === undefined ||
    Object.keys(live).sort().join("\n") !== ["kind", "sha256", "size"].join("\n") ||
    !("sha256" in live) ||
    typeof live.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(live.sha256) ||
    !("size" in live) ||
    !Number.isSafeInteger(live.size) ||
    typeof live.size !== "number" ||
    live.size <= 0 ||
    live.size > MAX_RESUME_ARTIFACT_BYTES
  ) return { kind: "unavailable" };
  return live.sha256 === uploaded.sha256
    ? { kind: "upload", ...uploaded }
    : { kind: "unavailable" };
}

export async function applyMutation(
  page: Page,
  target: ResolvedBrowserTarget,
  mutation: BrowserMutation,
  upload: Uint8Array | undefined,
  timeoutMs: number,
): Promise<"applied" | "ambiguous" | "invalid"> {
  const locator = page.locator(controlSelector).nth(target.index);
  if (mutation.kind === "set_text") {
    if (target.control.kind !== "text") return "invalid";
    await locator.fill(mutation.text, { timeout: timeoutMs });
    await locator.blur({ timeout: timeoutMs });
    return "applied";
  }
  if (mutation.kind === "set_date") {
    if (target.control.kind !== "date" || !/^\d{4}-\d{2}-\d{2}$/u.test(mutation.isoDate)) {
      return "invalid";
    }
    if (target.interaction === "composite-date") {
      const parts = [
        ["dateSectionMonth", mutation.isoDate.slice(5, 7)],
        ["dateSectionDay", mutation.isoDate.slice(8, 10)],
        ["dateSectionYear", mutation.isoDate.slice(0, 4)],
      ] as const;
      const locators = parts.map(([automationId]) =>
        locator.locator(`[data-automation-id="${automationId}"]`)
      );
      const ready = await Promise.all(locators.map(async (part) =>
        await part.count() === 1 && await part.isVisible() && await part.isEditable()
      ));
      if (ready.some((value) => !value)) {
        return "invalid";
      }
      const previous = await Promise.all(locators.map((part) => part.inputValue()));
      try {
        for (const [index, part] of locators.entries()) {
          await part.fill(parts[index]![1], { timeout: timeoutMs });
        }
        await locators[2]!.blur({ timeout: timeoutMs });
      } catch {
        for (const [index, part] of locators.entries()) {
          if (await part.count() === 1 && await part.isEditable()) {
            await part.fill(previous[index]!, { timeout: timeoutMs }).catch(() => undefined);
          }
        }
        return "invalid";
      }
      return "applied";
    }
    await locator.fill(mutation.isoDate, { timeout: timeoutMs });
    await locator.blur({ timeout: timeoutMs });
    return "applied";
  }
  if (mutation.kind === "set_checked") {
    if (
      target.control.kind !== "choice" ||
      (target.control.choice === "radio" && mutation.checked === false)
    ) {
      return "invalid";
    }
    await locator.setChecked(mutation.checked, { timeout: timeoutMs });
    return "applied";
  }
  if (mutation.kind === "select") {
    if (target.control.kind === "choice" && target.control.choice === "radio") {
      const matches = target.radioOptions?.filter((option) => option === mutation.option) ?? [];
      if (matches.length !== 1) return matches.length === 0 ? "invalid" : "ambiguous";
      const options = locator.getByRole("radio", { name: mutation.option, exact: true });
      const count = await options.count();
      if (count !== 1) return count === 0 ? "invalid" : "ambiguous";
      await options.setChecked(true, { timeout: timeoutMs });
      return "applied";
    }
    if (target.control.kind !== "select") return "invalid";
    const matches = target.control.options.filter((option) => option === mutation.option);
    if (
      target.interaction !== "owned-popup" &&
      target.interaction !== "field-popup" &&
      matches.length !== 1
    ) {
      return matches.length === 0 ? "invalid" : "ambiguous";
    }
    if (target.control.element === "select") {
      await locator.selectOption({ label: mutation.option }, { timeout: timeoutMs });
      return "applied";
    }
    if (target.interaction === "field-popup") {
      await locator.click({ timeout: timeoutMs });
      const exact = await waitForExactFieldPopupOption(page, mutation.option, timeoutMs);
      if (exact.count !== 1 || exact.locator === undefined) {
        await locator.press("Escape", { timeout: timeoutMs }).catch(() => undefined);
        return exact.count === 0 ? "invalid" : "ambiguous";
      }
      await exact.locator.click({ timeout: timeoutMs });
      return "applied";
    }
    let optionOwner = target.interaction === "owned-popup"
      ? await ownedPopup(page, locator)
      : locator;
    const searchable = target.interaction === "owned-popup" &&
      await locator.evaluate((element) => element instanceof HTMLInputElement);
    if (
      target.interaction === "owned-popup" &&
      (optionOwner === undefined || (!searchable && !await optionOwner.isVisible()))
    ) {
      await locator.click({ timeout: timeoutMs });
      optionOwner = await waitForOwnedPopup(page, locator, timeoutMs);
    }
    if (optionOwner === undefined) return "invalid";
    let exact = await exactOwnedOption(optionOwner, mutation.option);
    let previousSearch: string | undefined;
    if (exact.count === 0 && target.interaction === "owned-popup") {
      if (searchable) {
        previousSearch = await locator.inputValue();
        await locator.fill(mutation.option, { timeout: timeoutMs });
        exact = await waitForExactOwnedOption(page, optionOwner, mutation.option, timeoutMs);
      }
    } else if (exact.count === 0) {
      exact = await waitForExactOwnedOption(page, optionOwner, mutation.option, timeoutMs);
    }
    if (exact.count !== 1 || exact.locator === undefined) {
      if (previousSearch !== undefined) await locator.fill(previousSearch, { timeout: timeoutMs });
      return exact.count === 0 ? "invalid" : "ambiguous";
    }
    await exact.locator.click({ timeout: timeoutMs });
    return "applied";
  }
  if (target.control.kind !== "file" || upload === undefined) return "invalid";
  await locator.setInputFiles(
    {
      name: "resume.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from(upload.buffer, upload.byteOffset, upload.byteLength),
    },
    { timeout: timeoutMs },
  );
  return "applied";
}

export async function clickNext(
  page: Page,
  timeoutMs: number,
): Promise<"applied" | "ambiguous" | "invalid"> {
  const matches = page.getByRole("button", { name: nextName });
  const count = await matches.count();
  if (count !== 1) return count === 0 ? "invalid" : "ambiguous";
  await matches.click({ timeout: timeoutMs });
  return "applied";
}

async function inspectControls(page: Page): Promise<RawControl[]> {
  const raw = await page.locator(controlSelector).evaluateAll((elements) => {
    const normalize = (value: string | null | undefined): string =>
      (value ?? "").replace(/\s+/gu, " ").trim();
    const nameOf = (element: Element): string => {
      if (element.getAttribute("aria-haspopup") === "listbox") {
        const fieldLabel = normalize(
          element.closest('[data-automation-id="formField"], [data-automation-id^="formField-"]')
            ?.querySelector("label, legend")?.textContent,
        );
        if (fieldLabel.length > 0) return fieldLabel;
      }
      const aria = normalize(element.getAttribute("aria-label"));
      if (aria.length > 0) return aria;
      const labelledBy = element.getAttribute("aria-labelledby");
      if (labelledBy !== null) {
        const text = normalize(labelledBy.split(/\s+/u).map((id) => document.getElementById(id)?.textContent ?? "").join(" "));
        if (text.length > 0) return text;
      }
      if (element instanceof HTMLFieldSetElement) {
        const legend = normalize(element.querySelector(":scope > legend")?.textContent);
        if (legend.length > 0) return legend;
      }
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
        const label = element.labels?.[0]?.cloneNode(true) as HTMLElement | undefined;
        label?.querySelectorAll("input,textarea,select,button").forEach((control) => control.remove());
        const labelText = normalize(label?.textContent);
        if (labelText.length > 0) return labelText;
      }
      const workdayLabel = normalize(
        element.closest('[data-automation-id="formField"], [data-automation-id^="formField-"]')
          ?.querySelector("label, legend")?.textContent,
      );
      if (workdayLabel.length > 0) return workdayLabel;
      const placeholder = normalize(element.getAttribute("placeholder"));
      if (placeholder.length > 0) return placeholder;
      if (element instanceof HTMLInputElement && (element.type === "button" || element.type === "submit")) {
        const value = normalize(element.value);
        if (value.length > 0) return value;
      }
      const text = normalize(element.textContent);
      return text.length > 0 ? text : normalize(element.getAttribute("name"));
    };
    const accessibleRequired = (element: Element): boolean => {
      const labels = element instanceof HTMLInputElement ||
          element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement
        ? [...element.labels ?? []].map((label) => label.textContent ?? "")
        : [];
      const accessibleName = normalize([
        element.getAttribute("aria-label") ?? "",
        ...labels,
      ].join(" "));
      return /(?:^|\s|\()required\)?(?:\s*\*)?$/iu.test(accessibleName) &&
        !/(?:^|\s|\()not required\)?(?:\s*\*)?$/iu.test(accessibleName);
    };
    const groupOf = (input: HTMLInputElement): string => {
      const fieldset = input.closest("fieldset");
      const legend = normalize(fieldset?.querySelector(":scope > legend")?.textContent);
      if (legend.length > 0) return legend;
      const parentGroup = input.closest("[role=group],[role=radiogroup]");
      const aria = normalize(parentGroup?.getAttribute("aria-label"));
      return aria.length > 0 ? aria : normalize(input.name);
    };
    const ownedListboxId = (element: Element): string | undefined => {
      const ids = [element.getAttribute("aria-controls"), element.getAttribute("aria-owns")]
        .flatMap((value) => value?.split(/\s+/u) ?? [])
        .filter((id) => /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u.test(id));
      const unique = [...new Set(ids)];
      return unique.length === 1 ? unique[0] : undefined;
    };
    const ownedListbox = (element: Element): Element | undefined => {
      const id = ownedListboxId(element);
      const candidate = id === undefined ? null : document.getElementById(id);
      return candidate?.getAttribute("role") === "listbox" ? candidate : undefined;
    };
    const selectedPopupLabel = (element: Element): string => {
      const declared = normalize(element.getAttribute("aria-valuetext"));
      if (declared.length > 0) return declared;
      const field = element.closest('[data-automation-id="formField"], [data-automation-id^="formField-"]');
      const selected = field === null
        ? []
        : [...field.querySelectorAll('[data-automation-id="selectedItem"]')]
          .map((item) => normalize(item.textContent))
          .filter(Boolean);
      if (selected.length === 1) return selected[0]!;
      const popupSelected = [...(ownedListbox(element)?.querySelectorAll('[role="option"][aria-selected="true"]') ?? [])]
        .map((item) => normalize(item.textContent)).filter(Boolean);
      if (popupSelected.length === 1) return popupSelected[0]!;
      const buttonText = element instanceof HTMLButtonElement || element.getAttribute("role") === "button"
        ? normalize(element.textContent)
        : "";
      return /^(?:select|select one|choose|choose one)$/iu.test(buttonText) ? "" : buttonText;
    };
    const fieldPopupOptions = (element: Element): string[] => {
      const field = element.closest('[data-automation-id="formField"], [data-automation-id^="formField-"]');
      if (field === null) return [];
      return [...new Set([...field.querySelectorAll(
        '[role="option"], [data-automation-id="promptOption"], [data-automation-id="promptLeafNode"]',
      )].map((option) => normalize(option.textContent)).filter(Boolean))];
    };
    const isMultiSelect = (element: Element): boolean => {
      if (element instanceof HTMLSelectElement && element.multiple) return true;
      if (element.getAttribute("aria-multiselectable") === "true") return true;
      if (ownedListbox(element)?.getAttribute("aria-multiselectable") === "true") return true;
      const field = element.closest('[data-automation-id="formField"], [data-automation-id^="formField-"]');
      return (field?.querySelectorAll('[data-automation-id="selectedItem"]').length ?? 0) > 1;
    };
    const compositeDateReadback = (element: Element): BrowserReadback => {
      const selectors = ["dateSectionMonth", "dateSectionDay", "dateSectionYear"];
      const controls = selectors.map((id) => [...element.querySelectorAll<HTMLInputElement>(`[data-automation-id="${id}"]`)]);
      if (controls.some((matches) => matches.length !== 1)) return { kind: "unavailable" };
      const [month, day, year] = controls.map((matches) => normalize(matches[0]!.value));
      if (month === "" && day === "" && year === "") return { kind: "empty" };
      if (!/^\d{2}$/u.test(month!) || !/^\d{2}$/u.test(day!) || !/^\d{4}$/u.test(year!)) return { kind: "unavailable" };
      const isoDate = `${year}-${month}-${day}`;
      const date = new Date(`${isoDate}T00:00:00.000Z`);
      return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === isoDate
        ? { kind: "text", value: isoDate as never }
        : { kind: "unavailable" };
    };
    return elements.flatMap((element, index) => {
      const compositeOwner = element.closest('[data-automation-id="dateSection"][data-hunt-target-token]');
      if (compositeOwner !== null && compositeOwner !== element) return [];
      if (
        element instanceof HTMLInputElement &&
        element.type === "radio" &&
        element.closest("fieldset[data-hunt-target-token]") !== null
      ) {
        return [];
      }
      const name = nameOf(element);
      if (name.length === 0) return [];
      let control: BrowserControl | undefined;
      let readback: BrowserReadback = { kind: "unavailable" };
      let radioOptions: string[] | undefined;
      let interaction: "owned-popup" | "field-popup" | "composite-date" | undefined;
      if (element.getAttribute("data-automation-id") === "dateSection") {
        control = { kind: "date", element: "input" };
        readback = compositeDateReadback(element);
        interaction = "composite-date";
      } else if (
        element.getAttribute("role") === "combobox" ||
        element.getAttribute("aria-haspopup") === "listbox"
      ) {
        if (isMultiSelect(element)) return [];
        const popupOwnerId = ownedListboxId(element);
        const selected = selectedPopupLabel(element);
        const popupOptions = [...(ownedListbox(element)?.querySelectorAll("[role=option]") ?? [])]
          .map((option) => normalize(option.textContent)).filter(Boolean);
        const options = [...new Set([
          ...popupOptions,
          ...fieldPopupOptions(element),
          ...(selected.length > 0 ? [selected] : []),
        ])] as never[];
        control = { kind: "select", element: "listbox", options };
        readback = { kind: "selected", option: selected.length > 0 ? selected as never : null };
        interaction = popupOwnerId === undefined ? "field-popup" : "owned-popup";
      } else if (element instanceof HTMLFieldSetElement) {
        const radios = [...element.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
        if (radios.length === 0) return [];
        radioOptions = radios.map(nameOf).filter(Boolean);
        const selected = radios.filter((radio) => radio.checked);
        const group = normalize(element.querySelector(":scope > legend")?.textContent);
        if (group.length === 0) return [];
        control = {
          kind: "choice",
          element: "input",
          choice: "radio",
          group: group as never,
          checked: selected.length === 1,
        };
        readback = {
          kind: "selected",
          option: selected.length === 1 ? nameOf(selected[0]!) as never : null,
        };
      } else if (element instanceof HTMLTextAreaElement) {
        control = { kind: "text", element: "textarea" };
        readback = element.value.length === 0 ? { kind: "empty" } : { kind: "text", value: element.value as never };
      } else if (element instanceof HTMLSelectElement) {
        if (isMultiSelect(element)) return [];
        const options = [...element.options].map((option) => normalize(option.text)).filter(Boolean) as never[];
        control = { kind: "select", element: "select", options };
        const selected = element.selectedOptions.length === 1 ? normalize(element.selectedOptions[0]?.text) : "";
        readback = { kind: "selected", option: selected.length > 0 ? selected as never : null };
      } else if (element instanceof HTMLButtonElement || element.getAttribute("role") === "button") {
        control = { kind: "button", element: "button" };
      } else if (element.getAttribute("role") === "listbox") {
        if (isMultiSelect(element)) return [];
        const options = [...element.querySelectorAll("[role=option]")].map((option) => normalize(option.textContent)).filter(Boolean) as never[];
        control = { kind: "select", element: "listbox", options };
        const selected = [...element.querySelectorAll("[role=option][aria-selected=true]")];
        readback = { kind: "selected", option: selected.length === 1 ? normalize(selected[0]?.textContent) as never : null };
      } else if (element instanceof HTMLInputElement) {
        if (element.type === "date") {
          control = { kind: "date", element: "input" };
          readback = element.value.length === 0 ? { kind: "empty" } : { kind: "text", value: element.value as never };
        } else if (element.type === "radio" || element.type === "checkbox") {
          control = { kind: "choice", element: "input", choice: element.type, group: groupOf(element) as never, checked: element.checked };
          readback = { kind: "checked", checked: element.checked };
        } else if (element.type === "file") {
          control = { kind: "file", element: "input" };
        } else if (element.type === "button" || element.type === "submit") {
          control = { kind: "button", element: "button" };
        } else {
          control = { kind: "text", element: "input" };
          readback = element.value.length === 0 ? { kind: "empty" } : { kind: "text", value: element.value as never };
        }
      }
      if (control === undefined) return [];
      // Workday can restore a nonempty draft while retaining aria-invalid.
      // Expose that state as empty so the questionnaire owner re-drives and
      // independently verifies the answer instead of accepting stale text.
      if (element.getAttribute("aria-invalid") === "true" && readback.kind !== "upload") {
        readback = { kind: "empty" };
      }
      const html = element as HTMLElement;
      const style = getComputedStyle(html);
      const visible = style.display !== "none" && style.visibility !== "hidden" && html.getClientRects().length > 0;
      const disabled = "disabled" in element && Boolean((element as HTMLInputElement).disabled) || element.getAttribute("aria-disabled") === "true";
      const enabled = !disabled;
      const state: BrowserTargetState = !visible
        ? { visibility: "hidden", enabled, actionable: false }
        : !enabled
          ? { visibility: "visible", enabled: false, actionable: false }
          : { visibility: "visible", enabled: true, actionable: true };
      const requiredOwner = element.closest(
        '[data-automation-id="formField"], [data-automation-id^="formField-"]',
      );
      return [{
        index,
        declaredToken: normalize(element.getAttribute("data-hunt-target-token")),
        name,
        required: element.hasAttribute("required") ||
          element.getAttribute("aria-required") === "true" ||
          accessibleRequired(element) ||
          (element instanceof HTMLFieldSetElement &&
            [...element.querySelectorAll<HTMLInputElement>('input[type="radio"]')]
              .some((radio) => radio.required)) ||
          (requiredOwner !== null && requiredOwner.querySelector(
            '[data-automation-id="required"], abbr[title="Required"], [aria-label="Required"]',
          ) !== null),
        control,
        state,
        readback,
        radioOptions,
        interaction,
      }];
    });
  });
  return raw as RawControl[];
}

async function ownedPopup(page: Page, control: Locator): Promise<Locator | undefined> {
  const ids = [await control.getAttribute("aria-controls"), await control.getAttribute("aria-owns")]
    .flatMap((value) => value?.split(/\s+/u) ?? [])
    .filter((id) => /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u.test(id));
  const unique = [...new Set(ids)];
  if (unique.length !== 1) return undefined;
  const popup = page.locator(`[id="${unique[0]}"][role="listbox"]`);
  return await popup.count() === 1 ? popup : undefined;
}

async function waitForOwnedPopup(
  page: Page,
  control: Locator,
  timeoutMs: number,
): Promise<Locator | undefined> {
  const ids = [await control.getAttribute("aria-controls"), await control.getAttribute("aria-owns")]
    .flatMap((value) => value?.split(/\s+/u) ?? [])
    .filter((id) => /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u.test(id));
  const unique = [...new Set(ids)];
  if (unique.length !== 1) return undefined;
  const popup = page.locator(`[id="${unique[0]}"][role="listbox"]`);
  try {
    await popup.waitFor({ state: "attached", timeout: timeoutMs });
  } catch {
    return undefined;
  }
  return await popup.count() === 1 ? popup : undefined;
}

async function exactOwnedOption(
  owner: Locator,
  option: string,
): Promise<{ readonly count: number; readonly locator?: Locator }> {
  const exact = owner.getByRole("option", { name: option, exact: true });
  const candidates = await exact.evaluateAll((elements) =>
    elements.map((element, index) => ({
      index,
      leaf: element.getAttribute("data-automation-id") === "promptLeafNode",
    })),
  );
  const leaves = candidates.filter(({ leaf }) => leaf);
  const owned = leaves.length > 0 ? leaves : candidates;
  return {
    count: owned.length,
    ...(owned.length === 1 ? { locator: exact.nth(owned[0]!.index) } : {}),
  };
}

async function waitForExactOwnedOption(
  page: Page,
  owner: Locator,
  option: string,
  timeoutMs: number,
): Promise<{ readonly count: number; readonly locator?: Locator }> {
  const deadline = Date.now() + timeoutMs;
  let exact = await exactOwnedOption(owner, option);
  while (exact.count === 0 && Date.now() < deadline) {
    await page.waitForTimeout(Math.min(25, Math.max(1, deadline - Date.now())));
    exact = await exactOwnedOption(owner, option);
  }
  return exact;
}

async function waitForExactFieldPopupOption(
  page: Page,
  option: string,
  timeoutMs: number,
): Promise<{ readonly count: number; readonly locator?: Locator }> {
  const candidates = page.locator(
    '[role="option"], [data-automation-id="promptOption"], [data-automation-id="promptLeafNode"]',
  );
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const exact = await candidates.evaluateAll((elements, expected) => {
      const normalize = (value: string | null | undefined): string =>
        (value ?? "").replace(/\s+/gu, " ").trim();
      return elements.map((element, index) => ({
        index,
        exact: normalize(element.textContent) === expected,
        leaf: element.getAttribute("data-automation-id") === "promptLeafNode",
        visible: element instanceof HTMLElement && element.getClientRects().length > 0 &&
          getComputedStyle(element).display !== "none" &&
          getComputedStyle(element).visibility !== "hidden",
      })).filter(({ exact, visible }) => exact && visible);
    }, option);
    const leaves = exact.filter(({ leaf }) => leaf);
    const matches = leaves.length > 0 ? leaves : exact;
    if (matches.length > 0 || Date.now() >= deadline) {
      return {
        count: matches.length,
        ...(matches.length === 1 ? { locator: candidates.nth(matches[0]!.index) } : {}),
      };
    }
    await page.waitForTimeout(Math.min(25, Math.max(1, deadline - Date.now())));
  }
}

function bounded(value: string) {
  return boundedText(value);
}

function normalizeControl(control: BrowserControl): BrowserControl {
  if (control.kind === "choice") return { ...control, group: bounded(control.group) };
  if (control.kind === "select") {
    return { ...control, options: control.options.map((option) => bounded(option)) };
  }
  return control;
}

function normalizeReadback(readback: BrowserReadback): BrowserReadback {
  if (readback.kind === "text") return { kind: "text", value: bounded(readback.value) };
  if (readback.kind === "selected") {
    return { kind: "selected", option: readback.option === null ? null : bounded(readback.option) };
  }
  return readback;
}
