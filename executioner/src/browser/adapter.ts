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
  "fieldset[data-hunt-target-token]",
  'input:not([type="hidden"])',
  "textarea",
  "select",
  "button",
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
    });
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
    return "applied";
  }
  if (mutation.kind === "set_date") {
    if (target.control.kind !== "date" || !/^\d{4}-\d{2}-\d{2}$/u.test(mutation.isoDate)) {
      return "invalid";
    }
    await locator.fill(mutation.isoDate, { timeout: timeoutMs });
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
    if (matches.length !== 1) return matches.length === 0 ? "invalid" : "ambiguous";
    if (target.control.element === "select") {
      await locator.selectOption({ label: mutation.option }, { timeout: timeoutMs });
      return "applied";
    }
    const options = locator.getByRole("option", { name: mutation.option, exact: true });
    const count = await options.count();
    if (count !== 1) return count === 0 ? "invalid" : "ambiguous";
    await options.click({ timeout: timeoutMs });
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
      const placeholder = normalize(element.getAttribute("placeholder"));
      if (placeholder.length > 0) return placeholder;
      if (element instanceof HTMLInputElement && (element.type === "button" || element.type === "submit")) {
        const value = normalize(element.value);
        if (value.length > 0) return value;
      }
      const text = normalize(element.textContent);
      return text.length > 0 ? text : normalize(element.getAttribute("name"));
    };
    const groupOf = (input: HTMLInputElement): string => {
      const fieldset = input.closest("fieldset");
      const legend = normalize(fieldset?.querySelector(":scope > legend")?.textContent);
      if (legend.length > 0) return legend;
      const parentGroup = input.closest("[role=group],[role=radiogroup]");
      const aria = normalize(parentGroup?.getAttribute("aria-label"));
      return aria.length > 0 ? aria : normalize(input.name);
    };
    return elements.flatMap((element, index) => {
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
      if (element instanceof HTMLFieldSetElement) {
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
        const options = [...element.options].map((option) => normalize(option.text)).filter(Boolean) as never[];
        control = { kind: "select", element: "select", options };
        const selected = element.selectedOptions.length === 1 ? normalize(element.selectedOptions[0]?.text) : "";
        readback = { kind: "selected", option: selected.length > 0 ? selected as never : null };
      } else if (element instanceof HTMLButtonElement || element.getAttribute("role") === "button") {
        control = { kind: "button", element: "button" };
      } else if (element.getAttribute("role") === "listbox") {
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
      return [{
        index,
        declaredToken: normalize(element.getAttribute("data-hunt-target-token")),
        name,
        required: element.hasAttribute("required") ||
          element.getAttribute("aria-required") === "true" ||
          (element instanceof HTMLFieldSetElement &&
            [...element.querySelectorAll<HTMLInputElement>('input[type="radio"]')]
              .some((radio) => radio.required)),
        control,
        state,
        readback,
        radioOptions,
      }];
    });
  });
  return raw as RawControl[];
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
