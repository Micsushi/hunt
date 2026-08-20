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
  '[data-automation-id$="-CheckboxGroup"][data-hunt-target-token]',
  '[data-hunt-exclusive-checkbox-group="true"][data-hunt-target-token]',
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
  readonly interaction?: "owned-popup" | "field-popup" | "composite-date" | "exclusive-checkbox-group";
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
  const locator = page.locator(`[data-hunt-target-token="${target.declaredToken}"]`);
  if (await locator.count() !== 1) return "invalid";
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
      const options = target.interaction === "exclusive-checkbox-group"
        ? await (async () => {
          const checkbox = locator.getByLabel(mutation.option, { exact: true });
          if (await checkbox.count() !== 1 ||
              await checkbox.getAttribute("type") !== "checkbox") return undefined;
          return checkbox;
        })()
        : locator.getByRole("radio", { name: mutation.option, exact: true });
      if (options === undefined) return "invalid";
      const count = await options.count();
      if (count !== 1) return count === 0 ? "invalid" : "ambiguous";
      if (target.interaction === "exclusive-checkbox-group") {
        const groupAutomationId = await locator.getAttribute("data-automation-id");
        const stableGroup = groupAutomationId !== null &&
            /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(groupAutomationId)
          ? () => page.locator(`[data-automation-id="${groupAutomationId}"]`)
          : () => locator;
        const checkboxes = locator.locator('input[type="checkbox"]');
        const checkboxCount = await checkboxes.count();
        if (checkboxCount < 2) return "invalid";
        const taggedSurfaceFor = async (
          selector: string,
          option: string | null,
        ): Promise<Locator | undefined> => {
          const surfaces = stableGroup().locator(selector);
          const matching: Locator[] = [];
          for (let index = 0; index < await surfaces.count(); index += 1) {
            const surface = surfaces.nth(index);
            if (await surface.getAttribute("data-hunt-option-label") === option) {
              matching.push(surface);
            }
          }
          return matching.length === 1 ? matching[0]! : undefined;
        };
        const exactLabelFor = async (option: string): Promise<Locator | undefined> => {
          const labels = stableGroup().locator("label");
          const expected = option.normalize("NFC").replace(/\s+/gu, " ").trim();
          const matching: Locator[] = [];
          for (let index = 0; index < await labels.count(); index += 1) {
            const label = labels.nth(index);
            const text = (await label.textContent() ?? "").normalize("NFC")
              .replace(/\s+/gu, " ").trim();
            if (text === expected) matching.push(label);
          }
          return matching.length === 1 ? matching[0]! : undefined;
        };
        const checkboxPanelFor = async (): Promise<Locator | undefined> => {
          const checkbox = await desiredCheckbox();
          if (checkbox === undefined) return undefined;
          const panel = checkbox.locator(
            'xpath=ancestor::*[@data-automation-id="checkboxPanel"][1]',
          );
          return await panel.count() === 1 ? panel : undefined;
        };
        const isOnlyChecked = async (): Promise<boolean> => {
          const group = stableGroup();
          const checkbox = group.getByLabel(mutation.option, { exact: true });
          return await group.count() === 1 && await checkbox.count() === 1 &&
            await group.locator('input[type="checkbox"]:checked').count() === 1 &&
            await checkbox.isChecked();
        };
        const recordCheckboxAttempt = async (stage: string, outcome: string): Promise<void> => {
          try {
            await stableGroup().evaluate((owner, entry) => {
              const record = owner as unknown as Record<string, unknown>;
              const existing = Array.isArray(record.__huntCheckboxAttempts)
                ? record.__huntCheckboxAttempts as unknown[]
                : [];
              record.__huntCheckboxAttempts = [...existing, {
                ...entry,
                checkedCount: owner.querySelectorAll('input[type="checkbox"]:checked').length,
                optionRowCount: owner.querySelectorAll(
                  '[data-hunt-checkbox-surface="option-row"]',
                ).length,
              }].slice(-12);
            }, { stage, outcome });
          } catch {
            // Diagnostics never change the admitted mutation result.
          }
        };
        const waitUntilOnlyChecked = async (
          initiallyStableSince?: number,
        ): Promise<boolean> => {
          const waitWindow = Math.min(timeoutMs, 5_000);
          const stableWindow = Math.max(50, waitWindow - 150);
          const deadline = Date.now() + waitWindow;
          let stableSince = initiallyStableSince;
          do {
            if (await isOnlyChecked()) {
              stableSince ??= Date.now();
              if (Date.now() - stableSince >= stableWindow) return true;
            } else {
              if (stableSince !== undefined) return false;
              stableSince = undefined;
            }
            await page.waitForTimeout(Math.min(50, Math.max(1, deadline - Date.now())));
          } while (Date.now() < deadline);
          return stableSince !== undefined && await isOnlyChecked() &&
            Date.now() - stableSince >= stableWindow;
        };
        const invokeReactOptionHandler = async (): Promise<"committed" | "absent" | "rejected"> => {
          const checkbox = await desiredCheckbox();
          if (checkbox === undefined) return "absent";
          const result = await checkbox.evaluate(async (element) => {
            const input = element as HTMLInputElement;
            const candidates: Element[] = [];
            const add = (candidate: Element | null | undefined): void => {
              if (candidate !== null && candidate !== undefined && !candidates.includes(candidate)) {
                candidates.push(candidate);
              }
            };
            const panel = input.closest('[data-automation-id="checkboxPanel"]');
            const listItem = input.closest(
              '[data-uxi-widget-type="multiselectlistitem"]',
            );
            const checkboxOwner = input.closest(
              '[data-automation-id$="-CheckboxGroup"], ' +
                '[data-hunt-exclusive-checkbox-group="true"]',
            );
            const checkboxIndex = checkboxOwner === null
              ? -1
              : [...checkboxOwner.querySelectorAll('input[type="checkbox"]')]
                .indexOf(input);
            // Keep the exact native control and its owner chain ahead of the
            // panel subtree. Live Workday panels contain enough decorative
            // descendants to exhaust the bounded candidate budget before the
            // input when the input is appended last. The virtualized list row
            // is equally important: its host onClick owns the real Canvas
            // selection contract while the nested checkbox onChange is a
            // deliberate no-op.
            add(input);
            add(listItem);
            for (
              let owner = input.parentElement;
              owner !== null && owner !== panel && owner !== listItem;
              owner = owner.parentElement
            ) add(owner);
            Array.from(input.labels ?? []).forEach((label) => {
              add(label);
              label.querySelectorAll("span, div").forEach(add);
            });
            add(panel);
            panel?.querySelectorAll(
              '[data-automation-id="promptLeafNode"], [data-uxi-widget-type], label, span, div',
            ).forEach(add);

            const invoked = new Set<unknown>();
            let handlerObserved = false;
            const incrementCheckboxProbe = (key: string, amount = 1): void => {
              const root = document.documentElement as unknown as Record<string, unknown>;
              const current = typeof root.__huntCheckboxProbe === "object" &&
                  root.__huntCheckboxProbe !== null
                ? root.__huntCheckboxProbe as Record<string, number>
                : {};
              current[key] = (current[key] ?? 0) + amount;
              root.__huntCheckboxProbe = current;
            };
            const reactHostChecked = (): boolean | undefined => {
              const record = input as unknown as Record<string, unknown>;
              const propsKey = Object.keys(input).find((key) => key.startsWith("__reactProps$"));
              const direct = propsKey === undefined
                ? undefined
                : record[propsKey] as Record<string, unknown> | undefined;
              if (typeof direct?.checked === "boolean") return direct.checked;
              const fiberKey = Object.keys(input).find((key) =>
                key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$")
              );
              const fiber = fiberKey === undefined
                ? undefined
                : record[fiberKey] as {
                  memoizedProps?: Record<string, unknown>;
                  pendingProps?: Record<string, unknown>;
                } | undefined;
              const props = fiber?.memoizedProps ?? fiber?.pendingProps;
              return typeof props?.checked === "boolean" ? props.checked : undefined;
            };
            const liveOnlyChecked = (): boolean => {
              const ownerAutomationId = checkboxOwner?.getAttribute("data-automation-id") ?? null;
              const desiredLabel = input.getAttribute("aria-label");
              const liveOwner = ownerAutomationId === null
                ? checkboxOwner
                : [...document.querySelectorAll('[data-automation-id]')].find((candidate) =>
                  candidate.getAttribute("data-automation-id") === ownerAutomationId
                ) ?? checkboxOwner;
              if (liveOwner === null) return false;
              const liveInputs = [...liveOwner.querySelectorAll<HTMLInputElement>(
                'input[type="checkbox"]',
              )];
              return liveInputs.filter((candidate) => candidate.checked).length === 1 &&
                liveInputs.some((candidate) =>
                  candidate.checked && candidate.getAttribute("aria-label") === desiredLabel
                );
            };
            const invokeSharedIndexedListSelect = async (
              mode: "exact_option" | "row_item",
            ): Promise<boolean> => {
              if (checkboxOwner === null || checkboxIndex < 0) return false;
              const propsSeen = new Set<unknown>();
              const rowIndexOwners: Record<string, unknown>[] = [];
              const sharedSelects: ((...args: unknown[]) => unknown)[] = [];
              const sharedOptionSelects: {
                select: (...args: unknown[]) => unknown;
                payload: unknown;
              }[] = [];
              const includeSelect = (select: (...args: unknown[]) => unknown): void => {
                if (!sharedSelects.includes(select)) sharedSelects.push(select);
              };
              const inspect = (props: Record<string, unknown> | undefined): void => {
                if (props === undefined || propsSeen.has(props)) return;
                propsSeen.add(props);
                if (props.index === checkboxIndex) rowIndexOwners.push(props);
                if (
                  !Number.isSafeInteger(props.index) &&
                  typeof props.onSelect === "function" &&
                  props.onSelect.length === 1
                ) {
                  const select = props.onSelect as (...args: unknown[]) => unknown;
                  includeSelect(select);
                  const options = props.options;
                  const payload = Array.isArray(options) &&
                      options.length === checkboxOwner.querySelectorAll('input[type="checkbox"]').length
                    ? options[checkboxIndex]
                    : undefined;
                  const payloadKeys = typeof payload === "object" && payload !== null
                    ? Object.keys(payload)
                    : [];
                  if (
                    payloadKeys.includes("id") && payloadKeys.includes("label") &&
                    payloadKeys.includes("required") &&
                    !sharedOptionSelects.some((candidate) => candidate.select === select)
                  ) sharedOptionSelects.push({ select, payload });
                }
              };
              for (const candidate of candidates.slice(0, 16)) {
                const record = candidate as unknown as Record<string, unknown>;
                Object.keys(candidate).filter((key) => key.startsWith("__reactProps$"))
                  .forEach((key) => inspect(record[key] as Record<string, unknown> | undefined));
                const fiberKey = Object.keys(candidate).find((key) =>
                  key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$")
                );
                let fiber = fiberKey === undefined
                  ? undefined
                  : record[fiberKey] as {
                    memoizedProps?: Record<string, unknown>;
                    pendingProps?: Record<string, unknown>;
                    return?: unknown;
                  } | undefined;
                while (fiber !== undefined && fiber !== null) {
                  inspect(fiber.memoizedProps ?? fiber.pendingProps);
                  fiber = fiber.return as typeof fiber;
                }
              }
              incrementCheckboxProbe("candidateCount", Math.min(candidates.length, 16));
              incrementCheckboxProbe("sharedSelectCount", sharedSelects.length);
              incrementCheckboxProbe("sharedOptionSelectCount", sharedOptionSelects.length);
              if (mode === "exact_option") {
                for (const { select, payload } of sharedOptionSelects) {
                  if (invoked.has(select)) continue;
                  handlerObserved = true;
                  invoked.add(select);
                  const payloadRecord = typeof payload === "object" && payload !== null
                    ? payload as Record<string, unknown>
                    : undefined;
                  const exactPayloads = [
                    payload,
                    typeof payloadRecord?.id === "string" ? payloadRecord.id : undefined,
                  ].filter((candidate, index, all) =>
                    candidate !== undefined && all.indexOf(candidate) === index
                  );
                  for (const exactPayload of exactPayloads) {
                    const isIdPayload = typeof exactPayload === "string";
                    incrementCheckboxProbe(isIdPayload ? "exactIdCallCount" : "exactObjectCallCount");
                    checkboxOwner.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
                      .forEach((candidate) => { candidate.checked = false; });
                    try {
                      await Promise.resolve(select(exactPayload));
                      const deadline = Date.now() + 1_000;
                      do {
                        if (liveOnlyChecked() || reactHostChecked() === true || input.checked) {
                          incrementCheckboxProbe("exactCommitCount");
                          return true;
                        }
                        await new Promise<void>((resolve) => setTimeout(resolve, 50));
                      } while (Date.now() < deadline);
                      if (liveOnlyChecked() || reactHostChecked() === true || input.checked) {
                        incrementCheckboxProbe("exactCommitCount");
                        return true;
                      }
                    } catch {
                      incrementCheckboxProbe("exactThrowCount");
                      // Try the other exact option representation or exact owner;
                      // stable readback remains authoritative.
                    }
                    incrementCheckboxProbe("exactRejectedCount");
                  }
                }
                return false;
              }
              if (listItem === null) return false;
              if (rowIndexOwners.length === 0 || sharedSelects.length === 0) return false;
              const itemPayload = rowIndexOwners.flatMap((props) => {
                const direct = [props.item, props.option, props.dataItem, props.value]
                  .filter((value) => value !== undefined && typeof value !== "function");
                const data = props.data;
                const indexed = Array.isArray(data)
                  ? data[checkboxIndex]
                  : typeof data === "object" && data !== null
                  ? ["items", "options", "values"].flatMap((key) => {
                    const values = (data as Record<string, unknown>)[key];
                    return Array.isArray(values) && checkboxIndex < values.length
                      ? [values[checkboxIndex]]
                      : [];
                  })
                  : [];
                const owned = [props.items, props.options, props.values].flatMap((values) =>
                  Array.isArray(values) && checkboxIndex < values.length
                    ? [values[checkboxIndex]]
                    : []
                );
                return [...direct, ...indexed, ...owned];
              }).find((value) => value !== undefined);
              const payload = itemPayload ?? checkboxIndex;
              for (const select of sharedSelects) {
                if (invoked.has(select)) continue;
                handlerObserved = true;
                invoked.add(select);
                checkboxOwner?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
                  .forEach((candidate) => { candidate.checked = false; });
                try {
                  select(payload);
                  await new Promise<void>((resolve) => setTimeout(resolve, 50));
                  if (liveOnlyChecked() || reactHostChecked() === true || input.checked) return true;
                } catch {
                  // Try the next exact nested owner; stable readback remains authoritative.
                }
              }
              return false;
            };
            // The Workday CheckboxGroup owner exposes the exact option array
            // and the form-state onSelect callback. A virtualized row can
            // expose that same callback under an index-bound alias; invoking
            // the alias with row props first both uses the wrong contract and
            // prevents the exact callback from running. Prefer the unique
            // shared option contract before any generic row handler.
            const exactSharedCommitted = await invokeSharedIndexedListSelect("exact_option");
            if (exactSharedCommitted && liveOnlyChecked()) return "committed";
            for (const candidate of candidates.slice(0, 16)) {
              const invoke = async (
                props: Record<string, unknown> | undefined,
                changeContract: "event" | "resolved_boolean",
              ): Promise<void> => {
                if (props === undefined) return;
                const change = props.onChange;
                const click = props.onClick;
                const mouseDown = props.onMouseDown;
                const declaredListItemIndex = listItem?.getAttribute(
                  "data-uxi-multiselectlistitem-index",
                );
                // Some Workday tenants omit the Canvas row's diagnostic index
                // attribute even though the row React props retain the same
                // stable position. Bind that exact position only within the
                // already unique CheckboxGroup and selected list row.
                const listItemIndex = typeof declaredListItemIndex === "string" &&
                    /^\d+$/u.test(declaredListItemIndex)
                  ? Number(declaredListItemIndex)
                  : checkboxIndex;
                const select = props.onSelect;
                const exactListSelect = listItem !== null && typeof select === "function" &&
                  Number.isSafeInteger(listItemIndex) &&
                  listItemIndex >= 0 &&
                  props.index === listItemIndex;
                const handler = exactListSelect
                  ? select
                  : candidate === input && typeof change === "function"
                  ? change
                  : typeof click === "function"
                  ? click
                  : typeof mouseDown === "function"
                  ? mouseDown
                  : typeof change === "function"
                  ? change
                  : undefined;
                if (handler === undefined || invoked.has(handler)) return;
                handlerObserved = true;
                invoked.add(handler);
                const type = exactListSelect || handler === click
                  ? "click"
                  : handler === change
                  ? "change"
                  : handler === mouseDown
                  ? "mousedown"
                  : "click";
                const nativeEvent = type === "change"
                  ? new Event(type, { bubbles: true, cancelable: true })
                  : new MouseEvent(type, {
                    bubbles: true,
                    cancelable: true,
                    detail: type === "click" ? 1 : 0,
                  });
                try {
                  // React's controlled checkbox handler reads the post-toggle
                  // state from event.target. Every trusted surface may already
                  // have been reconciled back to false by the time this exact
                  // owner fallback runs, so present the state a real checkbox
                  // change would expose before invoking the handler.
                  const owner = input.closest(
                    '[data-automation-id$="-CheckboxGroup"], ' +
                      '[data-hunt-exclusive-checkbox-group="true"]',
                  );
                  owner?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
                    .forEach((candidate) => { candidate.checked = candidate === input; });
                  // A directly invoked React prop does not pass through the
                  // browser's dispatch path, so a freshly constructed native
                  // event otherwise has a null target. Owned checkbox handlers
                  // may follow the React ChangeEvent through
                  // `nativeEvent.target.checked`; preserve the real-event
                  // relationship when delivering the exact callback.
                  Object.defineProperties(nativeEvent, {
                    target: { configurable: true, value: input },
                    srcElement: { configurable: true, value: input },
                  });
                  const syntheticEvent = {
                    type,
                    target: input,
                    currentTarget: exactListSelect && listItem !== null ? listItem : candidate,
                    bubbles: true,
                    nativeEvent,
                    shiftKey: false,
                    altKey: false,
                    metaKey: false,
                    ctrlKey: false,
                    preventDefault: () => undefined,
                    stopPropagation: () => undefined,
                    isDefaultPrevented: () => false,
                    isPropagationStopped: () => false,
                    persist: () => undefined,
                  };
                  if (exactListSelect && listItem !== null) {
                    // Workday's virtualized multi-select row owns the real
                    // selection callback. Its list contract receives the
                    // exact row props, click event, and row node; the nested
                    // checkboxPanel onChange is intentionally a no-op.
                    (handler as (item: unknown, event: unknown, node: Element) => unknown)(
                      props,
                      syntheticEvent,
                      listItem,
                    );
                  } else if (handler === change && changeContract === "resolved_boolean") {
                    // Workday's native input owns a React ChangeEvent, while
                    // an enclosing Checkbox component owns the already-
                    // resolved boolean. Both appear as `onChange` in the
                    // fiber. Preserve the event contract on the host fiber and
                    // present the component contract to deeper owners.
                    try {
                      (handler as (checked: boolean, event: unknown) => unknown)(
                        true,
                        syntheticEvent,
                      );
                      await new Promise<void>((resolve) => setTimeout(resolve, 0));
                    } catch {
                      // A one-argument component owner can retain the host
                      // ChangeEvent contract; controlled host state below
                      // decides whether that fallback remains necessary.
                    }
                    if (reactHostChecked() === false) {
                      owner?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
                        .forEach((checkbox) => { checkbox.checked = checkbox === input; });
                      (handler as (event: unknown) => unknown)(syntheticEvent);
                    }
                  } else {
                    (handler as (event: unknown) => unknown)(syntheticEvent);
                  }
                  await new Promise<void>((resolve) => setTimeout(resolve, 0));
                } catch {
                  return;
                }
              };
              const propsKey = Object.keys(candidate).find((key) =>
                key.startsWith("__reactProps$")
              );
              if (propsKey !== undefined) {
                await invoke(
                  (candidate as unknown as Record<string, unknown>)[propsKey] as
                    | Record<string, unknown>
                    | undefined,
                  candidate === input ? "event" : "resolved_boolean",
                );
              }
              const fiberKey = Object.keys(candidate).find((key) =>
                key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$")
              );
              if (fiberKey === undefined) continue;
              let node = (candidate as unknown as Record<string, unknown>)[fiberKey] as {
                memoizedProps?: Record<string, unknown>;
                pendingProps?: Record<string, unknown>;
                return?: unknown;
              } | undefined;
              let fiberDepth = 0;
              while (node !== undefined && node !== null) {
                await invoke(
                  node.memoizedProps ?? node.pendingProps,
                  candidate === input && fiberDepth === 0 ? "event" : "resolved_boolean",
                );
                node = node.return as typeof node;
                fiberDepth += 1;
              }
            }
            await invokeSharedIndexedListSelect("row_item");
            const owner = checkboxOwner;
            return !handlerObserved
              ? "absent"
              : owner !== null && input.checked &&
                  owner.querySelectorAll('input[type="checkbox"]:checked').length === 1
              ? "committed"
              : "rejected";
          });
          // Workday can replace the entire controlled CheckboxGroup while the
          // exact owner callback is still resolving. In that case the captured
          // input and owner are detached and remain unchecked even though the
          // replacement live group contains the committed selection. Reconcile
          // against the stable automation-owned group before rejecting it.
          return result === "rejected" && await isOnlyChecked()
            ? "committed"
            : result;
        };
        const activate = async (
          surfaces: readonly (() => Promise<{
            readonly locator: Locator;
            readonly panelEdge?: true;
            readonly panelStart?: true;
            readonly force?: true;
            readonly keyboard?: true;
          } | undefined>)[],
        ): Promise<"stable" | "transient" | "none"> => {
          const clickTimeout = Math.min(timeoutMs, 1_000);
          let observedTransient = false;
          if (await isOnlyChecked()) {
            return await waitUntilOnlyChecked(Date.now()) ? "stable" : "transient";
          }
          for (const resolveSurface of surfaces) {
            try {
              const surface = await resolveSurface();
              if (surface === undefined || await surface.locator.count() !== 1) continue;
              if (surface.keyboard === true) {
                await surface.locator.press("Space", { timeout: clickTimeout });
                await surface.locator.blur({ timeout: clickTimeout });
              } else if (surface.force === true) {
                await surface.locator.click({ force: true, timeout: clickTimeout });
              } else if (surface.panelEdge === true) {
                const box = await surface.locator.boundingBox();
                if (box === null || box.width < 2 || box.height < 2) continue;
                await surface.locator.click({
                  position: {
                    x: Math.max(1, box.width - 2),
                    y: Math.max(1, box.height / 2),
                  },
                  timeout: clickTimeout,
                });
              } else if (surface.panelStart === true) {
                const box = await surface.locator.boundingBox();
                if (box === null || box.width < 2 || box.height < 2) continue;
                await surface.locator.click({
                  position: {
                    x: Math.min(12, Math.max(1, box.width - 2)),
                    y: Math.max(1, box.height / 2),
                  },
                  timeout: clickTimeout,
                });
              } else {
                await surface.locator.click({ timeout: clickTimeout });
              }
              const checkedSince = Date.now();
              if (!await isOnlyChecked()) continue;
              const stable = await waitUntilOnlyChecked(checkedSince);
              if (stable) return "stable";
              // A controlled Workday CheckboxGroup can optimistically toggle
              // one decorative/native surface and then reconcile it back.
              // Keep trying the remaining exact-option surfaces so the real
              // component owner still gets a trusted activation.
              observedTransient = true;
            } catch {
              // Workday tenants expose different trusted pointer surfaces; try the next one.
            }
          }
          return observedTransient ? "transient" : "none";
        };
        const acceptStableActivation = async (
          activation: "stable" | "transient" | "none",
        ): Promise<boolean> => {
          if (activation !== "stable") return false;
          // A trusted event can leave the native input checked while Workday's
          // controlled React value is still unchanged. Re-deliver the exact
          // selected value to an owned React handler when one exists, then
          // require another stable exclusive readback before accepting it.
          const reactCommit = await invokeReactOptionHandler();
          if (reactCommit === "absent") return true;
          return reactCommit === "committed" && await waitUntilOnlyChecked();
        };
        for (let index = 0; index < checkboxCount; index += 1) {
          const checkbox = checkboxes.nth(index);
          if (
            await checkbox.getAttribute("data-hunt-option-label") !== mutation.option &&
            await checkbox.isChecked()
          ) {
            try {
              await checkbox.setChecked(false, { timeout: Math.min(timeoutMs, 1_000) });
            } catch {
              return "invalid";
            }
          }
        }
        const desiredCheckbox = async (): Promise<Locator | undefined> => {
          const checkbox = stableGroup().getByLabel(mutation.option, { exact: true });
          return await checkbox.count() === 1 ? checkbox : undefined;
        };
        if (process.env.HUNT_C3_VALUE_FREE_ACCOUNT_TRACE === "1") {
          process.stderr.write(`C3_CHECKBOX_DIAGNOSTIC ${JSON.stringify({
            stage: "before_activation",
            structure: await checkboxOwnerStructure(stableGroup()),
          })}\n`);
        }
        const keyboardActivation = await activate([
          async () => {
            const checkbox = await desiredCheckbox();
            return checkbox === undefined ? undefined : { locator: checkbox, keyboard: true };
          },
        ]);
        await recordCheckboxAttempt("keyboard", keyboardActivation);
        if (await acceptStableActivation(keyboardActivation)) return "applied";
        const nativeActivation = await activate([
          async () => {
            const checkbox = await desiredCheckbox();
            return checkbox === undefined ? undefined : { locator: checkbox };
          },
        ]);
        await recordCheckboxAttempt("native", nativeActivation);
        if (await acceptStableActivation(nativeActivation)) return "applied";
        const forcedNativeActivation = await activate([
          async () => {
            const checkbox = await desiredCheckbox();
            return checkbox === undefined ? undefined : { locator: checkbox, force: true };
          },
        ]);
        await recordCheckboxAttempt("forced_native", forcedNativeActivation);
        if (await acceptStableActivation(forcedNativeActivation)) return "applied";
        const trustedActivation = await activate([
          async () => {
            const checkbox = await desiredCheckbox();
            if (checkbox === undefined) return undefined;
            const listItem = checkbox.locator(
              'xpath=ancestor::*[@data-uxi-widget-type="multiselectlistitem"][1]',
            );
            return await listItem.count() === 1 ? { locator: listItem } : undefined;
          },
          async () => {
            const surface = await taggedSurfaceFor(
              '[data-hunt-checkbox-surface="option-row"]', mutation.option,
            );
            return surface === undefined ? undefined : { locator: surface };
          },
          async () => {
            const label = await exactLabelFor(mutation.option);
            return label === undefined ? undefined : { locator: label };
          },
          async () => {
            const panel = await checkboxPanelFor();
            return panel === undefined ? undefined : { locator: panel, panelEdge: true };
          },
          async () => {
            const panel = await checkboxPanelFor();
            return panel === undefined ? undefined : { locator: panel, panelStart: true };
          },
          async () => {
            const checkbox = await desiredCheckbox();
            return checkbox === undefined ? undefined : {
              locator: checkbox.locator("xpath=following-sibling::*[1]"),
            };
          },
          async () => {
            const checkbox = await desiredCheckbox();
            return checkbox === undefined ? undefined : {
              locator: checkbox.locator("xpath=parent::*"),
            };
          },
          async () => {
            const surface = await taggedSurfaceFor(
              '[data-hunt-checkbox-surface="visual"]', mutation.option,
            );
            return surface === undefined ? undefined : { locator: surface };
          },
          async () => {
            const surface = await taggedSurfaceFor(
              '[data-hunt-checkbox-surface="owner"]', mutation.option,
            );
            return surface === undefined ? undefined : { locator: surface };
          },
          async () => {
            const surface = await taggedSurfaceFor(
              '[data-automation-id="checkboxPanel"]', mutation.option,
            );
            return surface === undefined ? undefined : { locator: surface, panelEdge: true };
          },
        ]);
        await recordCheckboxAttempt("trusted_surfaces", trustedActivation);
        if (await acceptStableActivation(trustedActivation)) return "applied";
        // A hidden native Workday checkbox can still own the delegated React
        // change event even when every visible wrapper is decorative. DOM
        // click preserves the checkbox's native toggle-before-event ordering
        // without weakening the same stable exclusive readback.
        let domStable = false;
        try {
          const checkbox = await desiredCheckbox();
          if (checkbox !== undefined) {
            await checkbox.evaluate((element) => (element as HTMLInputElement).click());
            domStable = await waitUntilOnlyChecked();
          }
        } catch {
          // Fall through to the exact React owner fallback.
        }
        await recordCheckboxAttempt("dom_click", domStable ? "stable" : "rejected");
        if (domStable && await acceptStableActivation("stable")) return "applied";
        // Some Workday CheckboxGroup variants update the native checkbox for a
        // pointer event, then reconcile it back because the owning React option
        // handler never ran. Keep this exact-option fallback behind all trusted
        // surfaces and require the same stable, exclusive readback afterward.
        const reactInvoked = await invokeReactOptionHandler();
        const reactStable = reactInvoked === "committed" && await waitUntilOnlyChecked();
        await recordCheckboxAttempt("react_owner", `${reactInvoked}:${reactStable}`);
        if (!reactStable) {
          const structure = await checkboxOwnerStructure(stableGroup());
          try {
            await stableGroup().evaluate((owner, value) => {
              (owner as unknown as Record<string, unknown>).__huntCheckboxStructure = value;
            }, structure);
          } catch {
            // Diagnostics never change the admitted mutation result.
          }
          process.stderr.write(`C3_CHECKBOX_DIAGNOSTIC ${JSON.stringify({
            stage: "after_rejection",
            reactInvoked,
            reactStable,
            structure,
          })}\n`);
          return "invalid";
        }
      } else {
        await options.setChecked(true, { timeout: timeoutMs });
      }
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
      const workdayField = element.closest(
        '[data-automation-id="formField"], [data-automation-id^="formField-"]',
      );
      if (element instanceof HTMLInputElement && element.type === "checkbox") {
        const fieldQuestion = normalize(
          workdayField?.querySelector("label, legend")?.textContent ?? workdayField?.textContent,
        );
        if (fieldQuestion.length > 0) return fieldQuestion;
      }
      if (element.getAttribute("aria-haspopup") === "listbox") {
        const fieldLabel = normalize(
          workdayField?.querySelector("label, legend")?.textContent,
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
        workdayField?.querySelector("label, legend")?.textContent,
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
    const checkboxOptionName = (input: HTMLInputElement): string => {
      const aria = normalize(input.getAttribute("aria-label"));
      if (aria.length > 0) return aria;
      const label = input.labels?.[0]?.cloneNode(true) as HTMLElement | undefined;
      label?.querySelectorAll("input,textarea,select,button").forEach((control) => control.remove());
      const labelText = normalize(label?.textContent);
      return labelText.length > 0 ? labelText : normalize(input.value);
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
      const observed = (() => {
        const encoded = element.getAttribute("data-hunt-popup-options");
        if (encoded === null) return [];
        try {
          const parsed: unknown = JSON.parse(encoded);
          return Array.isArray(parsed) && parsed.every((option) => typeof option === "string")
            ? parsed.map((option) => normalize(option)).filter(Boolean)
            : [];
        } catch {
          return [];
        }
      })();
      if (field === null) return observed;
      return [...new Set([
        ...observed,
        ...[...field.querySelectorAll(
          '[role="option"], [data-automation-id="promptOption"], [data-automation-id="promptLeafNode"]',
        )].map((option) => normalize(option.textContent)).filter(Boolean),
      ])];
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
      const checkboxGroupOwner = element.closest(
        '[data-automation-id$="-CheckboxGroup"][data-hunt-target-token], ' +
          '[data-hunt-exclusive-checkbox-group="true"][data-hunt-target-token]',
      );
      if (checkboxGroupOwner !== null && checkboxGroupOwner !== element) return [];
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
      let interaction: "owned-popup" | "field-popup" | "composite-date" | "exclusive-checkbox-group" | undefined;
      if (element.getAttribute("data-automation-id") === "dateSection") {
        control = { kind: "date", element: "input" };
        readback = compositeDateReadback(element);
        interaction = "composite-date";
      } else if (element.matches(
        '[data-automation-id$="-CheckboxGroup"], ' +
          '[data-hunt-exclusive-checkbox-group="true"]',
      )) {
        const checkboxes = [...element.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
        const options = checkboxes.map(checkboxOptionName).filter(Boolean);
        if (checkboxes.length < 2 || options.length !== checkboxes.length ||
            new Set(options).size !== options.length) return [];
        checkboxes.forEach((checkbox, index) => {
          const option = options[index]!;
          checkbox.setAttribute("data-hunt-option-label", option);
          [...checkbox.labels ?? []].forEach((label) =>
            label.setAttribute("data-hunt-option-label", option)
          );
          checkbox.parentElement?.setAttribute("data-hunt-checkbox-surface", "owner");
          checkbox.parentElement?.setAttribute("data-hunt-option-label", option);
          if (checkbox.nextElementSibling instanceof HTMLElement) {
            checkbox.nextElementSibling.setAttribute("data-hunt-checkbox-surface", "visual");
            checkbox.nextElementSibling.setAttribute("data-hunt-option-label", option);
          }
          checkbox.closest('[data-automation-id="checkboxPanel"]')
            ?.setAttribute("data-hunt-option-label", option);
          for (
            let candidate = checkbox.parentElement;
            candidate !== null && candidate !== element;
            candidate = candidate.parentElement
          ) {
            const candidateText = normalize(candidate.textContent);
            if (
              candidate.querySelectorAll('input[type="checkbox"]').length === 1 &&
              candidateText === option
            ) {
              candidate.setAttribute("data-hunt-checkbox-surface", "option-row");
              candidate.setAttribute("data-hunt-option-label", option);
              break;
            }
          }
        });
        const selected = checkboxes.filter((checkbox) => checkbox.checked);
        control = {
          kind: "choice",
          element: "input",
          choice: "radio",
          group: name as never,
          checked: selected.length === 1,
        };
        readback = {
          kind: "selected",
          option: selected.length === 1 ? checkboxOptionName(selected[0]!) as never : null,
        };
        radioOptions = options;
        interaction = "exclusive-checkbox-group";
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

async function checkboxOwnerStructure(group: Locator) {
  return group.evaluate((owner) => {
    const inputStates: {
      inputIndex: number;
      checked: boolean;
      disabled: boolean;
      labelCount: number;
    }[] = [];
    const domLayers = new Map<string, {
      tag: string;
      automationId: string | null;
      role: string | null;
      classCount: number;
      directHandlers: { name: string; arity: number }[];
      inputIndexes: number[];
    }>();
    const fiberHandlerLayers = new Map<string, {
      hostTag: string;
      hostAutomationId: string | null;
      depth: number;
      handlers: { name: string; arity: number }[];
      inputIndexes: number[];
    }>();
    const selectionLayers = new Map<string, {
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
          }))
          .sort((left, right) => left.name.localeCompare(right.name) || left.arity - right.arity)
        : [];
    const includeIndex = (indexes: number[], inputIndex: number) => {
      if (!indexes.includes(inputIndex)) indexes.push(inputIndex);
    };
    const addSelectionLayer = (
      inputIndex: number,
      element: Element,
      domDepth: number,
      fiberDepth: number,
      props: unknown,
    ) => {
      if (typeof props !== "object" || props === null) return;
      const entries = Object.entries(props);
      const selectionHandlers = entries.filter(([name, value]) =>
        /^(?:onSelect|onRemove)$/u.test(name) && typeof value === "function"
      ).map(([name, value]) => ({
        name,
        arity: (value as (...args: unknown[]) => unknown).length,
        functionId: functionId(value),
      }));
      const rawIndex = (props as Record<string, unknown>).index;
      const index = typeof rawIndex === "number" && Number.isSafeInteger(rawIndex)
        ? rawIndex
        : null;
      const objects = entries.filter(([, value]) => typeof value === "object" && value !== null)
        .slice(0, 24).map(([name, value]) => ({
          name,
          arrayLength: Array.isArray(value) ? value.length : null,
          keys: Array.isArray(value)
            ? typeof value[0] === "object" && value[0] !== null
              ? Object.keys(value[0]).slice(0, 24)
              : []
            : Object.keys(value as object).slice(0, 24),
        }));
      if (selectionHandlers.length === 0 && index === null && objects.length === 0) return;
      const layer = {
        hostTag: element.tagName.toLowerCase(),
        hostAutomationId: element.getAttribute("data-automation-id"),
        domDepth,
        fiberDepth,
        propsKeys: entries.map(([name]) => name).slice(0, 40),
        index,
        handlers: selectionHandlers,
        objects,
      };
      const key = JSON.stringify(layer);
      const existing = selectionLayers.get(key);
      if (existing === undefined) {
        selectionLayers.set(key, { ...layer, inputIndexes: [inputIndex] });
      } else includeIndex(existing.inputIndexes, inputIndex);
    };
    [...owner.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
      .forEach((input, inputIndex) => {
        inputStates.push({
          inputIndex,
          checked: input.checked,
          disabled: input.disabled,
          labelCount: input.labels?.length ?? 0,
        });
        const chain: Element[] = [];
        for (
          let node: Element | null = input;
          node !== null;
          node = node.parentElement
        ) {
          chain.push(node);
          if (node === owner) break;
        }
        chain.forEach((element, domDepth) => {
          const record = element as unknown as Record<string, unknown>;
          const directProps = Object.keys(element).filter((key) => key.startsWith("__reactProps$"));
          const directHandlers = directProps.flatMap((key) => handlers(record[key]));
          directProps.forEach((key) =>
            addSelectionLayer(inputIndex, element, domDepth, -1, record[key])
          );
          const domLayer = {
            tag: element.tagName.toLowerCase(),
            automationId: element.getAttribute("data-automation-id"),
            role: element.getAttribute("role"),
            classCount: element.classList.length,
            directHandlers,
          };
          const domKey = JSON.stringify(domLayer);
          const existingDom = domLayers.get(domKey);
          if (existingDom === undefined) {
            domLayers.set(domKey, { ...domLayer, inputIndexes: [inputIndex] });
          } else {
            includeIndex(existingDom.inputIndexes, inputIndex);
          }
          const fiberKey = Object.keys(element).find((key) =>
            key.startsWith("__reactFiber$") ||
            key.startsWith("__reactInternalInstance$")
          );
          let fiber = fiberKey === undefined
            ? undefined
            : record[fiberKey] as {
              memoizedProps?: unknown;
              pendingProps?: unknown;
              return?: unknown;
            } | undefined;
          for (let depth = 0; fiber !== undefined && fiber !== null && depth < 16; depth += 1) {
            const props = fiber.memoizedProps ?? fiber.pendingProps;
            const layerHandlers = handlers(props);
            addSelectionLayer(inputIndex, element, domDepth, depth, props);
            if (layerHandlers.length > 0) {
              const fiberLayer = {
                hostTag: element.tagName.toLowerCase(),
                hostAutomationId: element.getAttribute("data-automation-id"),
                depth,
                handlers: layerHandlers,
              };
              const layerKey = JSON.stringify(fiberLayer);
              const existingFiber = fiberHandlerLayers.get(layerKey);
              if (existingFiber === undefined) {
                fiberHandlerLayers.set(layerKey, {
                  ...fiberLayer,
                  inputIndexes: [inputIndex],
                });
              } else {
                includeIndex(existingFiber.inputIndexes, inputIndex);
              }
            }
            fiber = fiber.return as typeof fiber;
          }
        });
      });
    return {
      inputStates,
      domLayers: [...domLayers.values()],
      fiberHandlerLayers: [...fiberHandlerLayers.values()],
      selectionLayers: [...selectionLayers.values()],
    };
  });
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
