import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ConsoleMessage, Page, Request } from "playwright";

import { MONITOR_SCREENSHOT_FILE } from "./operator-monitor-ack.ts";

const evidenceRevision = "s2-page-local-inspection-v1";
const recordLimit = 128;

interface EventRecord {
  readonly consoleTypes: string[];
  readonly pageErrorNames: string[];
  readonly requestFailures: { readonly resourceType: string; readonly failureClass: string }[];
}

export function createPageLocalInspection(evidenceRoot: string): {
  readonly prepare: (page: unknown) => Promise<void>;
  readonly capture: (page: unknown) => Promise<void>;
} {
  const records = new WeakMap<Page, EventRecord>();

  const prepare = async (input: unknown): Promise<void> => {
    const page = input as Page;
    if (records.has(page)) return;
    const record: EventRecord = {
      consoleTypes: [],
      pageErrorNames: [],
      requestFailures: [],
    };
    records.set(page, record);
    page.on("console", (message: ConsoleMessage) => boundedPush(
      record.consoleTypes,
      message.type().replace(/[^a-z_-]/giu, "_").slice(0, 32),
    ));
    page.on("pageerror", (error: Error) => boundedPush(
      record.pageErrorNames,
      error.name.replace(/[^A-Za-z0-9_.-]/gu, "_").slice(0, 64) || "Error",
    ));
    page.on("requestfailed", (request: Request) => boundedPush(
      record.requestFailures,
      {
        resourceType: request.resourceType().replace(/[^a-z_-]/giu, "_").slice(0, 32),
        failureClass: requestFailureClass(request.failure()?.errorText),
      },
    ));
    await page.addInitScript(installMutationProbe);
    await page.evaluate(installMutationProbe);
  };

  const capture = async (input: unknown): Promise<void> => {
    const page = input as Page;
    await prepare(page);
    const pageRecord = records.get(page)!;
    const live = await page.evaluate(readPageLocalSnapshot);
    const ariaSnapshots: string[] = [];
    const dateOwners = page.locator(
      '[data-automation-id="dateInputWrapper"]',
    );
    for (let index = 0; index < await dateOwners.count(); index += 1) {
      ariaSnapshots.push(await dateOwners.nth(index).ariaSnapshot({ timeout: 5_000 }));
    }
    await mkdir(evidenceRoot, { recursive: true });
    await page.screenshot({
      path: join(evidenceRoot, MONITOR_SCREENSHOT_FILE),
      animations: "disabled",
      fullPage: true,
    });
    const value = Object.freeze({
      schemaVersion: 1,
      evidenceRevision,
      capturedAt: new Date().toISOString(),
      consoleTypes: [...pageRecord.consoleTypes],
      pageErrorNames: [...pageRecord.pageErrorNames],
      requestFailures: [...pageRecord.requestFailures],
      ariaSnapshots,
      ...live,
    });
    const destination = join(evidenceRoot, "page-local-inspection.json");
    const partial = `${destination}.tmp`;
    await writeFile(partial, `${JSON.stringify(value)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(partial, destination);
  };

  return Object.freeze({ prepare, capture });
}

function boundedPush<Value>(target: Value[], value: Value): void {
  if (target.length < recordLimit) target.push(value);
}

function requestFailureClass(value: string | undefined): string {
  if (value === undefined) return "unknown";
  if (/abort|cancel/iu.test(value)) return "aborted";
  if (/timed?\s*out/iu.test(value)) return "timeout";
  if (/name.*not.*resolved|dns/iu.test(value)) return "dns";
  if (/connection|network|internet|reset/iu.test(value)) return "connection";
  return "other";
}

function installMutationProbe(): void {
  const root = document.documentElement as unknown as Record<string, unknown>;
  if (root.__huntPageLocalMutationProbe !== undefined) return;
  const mutations: object[] = [];
  const observer = new MutationObserver((entries) => {
    for (const entry of entries) {
      if (mutations.length >= 128) break;
      const target = entry.target instanceof Element ? entry.target : undefined;
      mutations.push({
        kind: entry.type,
        tag: target?.tagName.toLowerCase() ?? null,
        automationId: target?.getAttribute("data-automation-id") ?? null,
        attribute: entry.attributeName,
        added: entry.addedNodes.length,
        removed: entry.removedNodes.length,
      });
    }
  });
  observer.observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: [
      "aria-controls", "aria-expanded", "aria-invalid", "aria-owns",
      "data-automation-id", "data-hunt-target-token", "role",
    ],
  });
  root.__huntPageLocalMutationProbe = { mutations };
}

function readPageLocalSnapshot(): object {
  const visible = (element: Element): element is HTMLElement => {
    if (!(element instanceof HTMLElement) || element.hidden ||
        element.getAttribute("aria-hidden") === "true") return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" &&
      element.getClientRects().length > 0;
  };
  const bounds = (element: Element) => {
    const box = element.getBoundingClientRect();
    return {
      x: Math.round(box.x), y: Math.round(box.y),
      width: Math.round(box.width), height: Math.round(box.height),
    };
  };
  const valueFormat = (value: string): string => value === ""
    ? "empty"
    : /^\d{1,2}\/\d{1,2}\/\d{4}$/u.test(value) ? "MM/DD/YYYY"
      : /^\d{4}-\d{2}-\d{2}$/u.test(value) ? "YYYY-MM-DD"
        : /^\d+$/u.test(value) ? "digits" : "other_nonempty";
  const reactLayers = (control: Element, owner: Element | null) => {
    const layers: object[] = [];
    let element: Element | null = control;
    for (let domDepth = 0; element !== null && domDepth < 8; domDepth += 1) {
      const record = element as unknown as Record<string, unknown>;
      for (const key of Object.keys(element).filter((name) => name.startsWith("__reactProps$"))) {
        const props = record[key];
        if (typeof props !== "object" || props === null) continue;
        const entries = Object.entries(props);
        layers.push({
          source: "props",
          tag: element.tagName.toLowerCase(),
          domDepth,
          propsKeys: entries.map(([name]) => name).slice(0, 40),
          handlers: entries.filter(([name, handler]) =>
            /^on[A-Z]/u.test(name) && typeof handler === "function"
          ).map(([name, handler]) => ({
            name,
            arity: (handler as (...args: unknown[]) => unknown).length,
          })),
        });
      }
      const fiberKey = Object.keys(element).find((name) =>
        name.startsWith("__reactFiber$") || name.startsWith("__reactInternalInstance$")
      );
      let fiber = fiberKey === undefined ? undefined : record[fiberKey] as {
        readonly memoizedProps?: unknown;
        readonly pendingProps?: unknown;
        readonly return?: unknown;
      } | undefined;
      for (let fiberDepth = 0; fiber !== undefined && fiber !== null && fiberDepth < 16;
        fiberDepth += 1) {
        const props = fiber.memoizedProps ?? fiber.pendingProps;
        if (typeof props === "object" && props !== null) {
          const entries = Object.entries(props);
          const handlers = entries.filter(([name, handler]) =>
            /^on[A-Z]/u.test(name) && typeof handler === "function"
          );
          if (handlers.length > 0) layers.push({
            source: "fiber",
            tag: element.tagName.toLowerCase(),
            domDepth,
            fiberDepth,
            propsKeys: entries.map(([name]) => name).slice(0, 40),
            handlers: handlers.map(([name, handler]) => ({
              name,
              arity: (handler as (...args: unknown[]) => unknown).length,
            })),
          });
        }
        fiber = fiber.return as typeof fiber;
      }
      if (element === owner) break;
      element = element.parentElement;
    }
    return layers;
  };
  const wrappers = [...document.querySelectorAll<HTMLElement>(
    '[data-automation-id="dateInputWrapper"]',
  )].map((wrapper) => {
    const owner = wrapper.closest<HTMLElement>(
      '[data-automation-id="formField"], [data-automation-id^="formField-"]',
    );
    const ownedIds = [wrapper.getAttribute("aria-controls"), wrapper.getAttribute("aria-owns")]
      .flatMap((value) => value?.split(/\s+/u) ?? []).filter(Boolean);
    const inputs = [...wrapper.querySelectorAll<HTMLInputElement>("input")];
    return {
      ownerAutomationId: owner?.getAttribute("data-automation-id") ?? null,
      label: (owner?.querySelector("label, legend")?.textContent ?? "")
        .normalize("NFC").replace(/\s+/gu, " ").trim().slice(0, 256),
      wrapper: {
        automationId: wrapper.getAttribute("data-automation-id"),
        role: wrapper.getAttribute("role"),
        requiredMarker: owner?.querySelector(
          '[data-automation-id="required"], abbr[title="Required"], [aria-label="Required"]',
        ) !== null,
        aria: {
          label: wrapper.getAttribute("aria-label"),
          labelledby: wrapper.getAttribute("aria-labelledby"),
          describedby: wrapper.getAttribute("aria-describedby"),
          controls: wrapper.getAttribute("aria-controls"),
          owns: wrapper.getAttribute("aria-owns"),
          invalid: wrapper.getAttribute("aria-invalid"),
          required: wrapper.getAttribute("aria-required"),
        },
        visible: visible(wrapper),
        bounds: bounds(wrapper),
      },
      inputs: inputs.map((input) => ({
        type: input.type,
        automationId: input.getAttribute("data-automation-id"),
        placeholder: input.placeholder,
        required: input.required,
        valueNonEmpty: input.value !== "",
        valueFormat: valueFormat(input.value),
        aria: {
          label: input.getAttribute("aria-label"),
          labelledby: input.getAttribute("aria-labelledby"),
          describedby: input.getAttribute("aria-describedby"),
          controls: input.getAttribute("aria-controls"),
          owns: input.getAttribute("aria-owns"),
          invalid: input.getAttribute("aria-invalid"),
          required: input.getAttribute("aria-required"),
        },
        visible: visible(input),
        bounds: bounds(input),
        active: document.activeElement === input,
        reactLayers: reactLayers(input, owner),
      })),
      ownedPortals: ownedIds.map((id) => {
        const portal = document.getElementById(id);
        return portal === null ? { id, present: false } : {
          id,
          present: true,
          tag: portal.tagName.toLowerCase(),
          role: portal.getAttribute("role"),
          automationId: portal.getAttribute("data-automation-id"),
          visible: visible(portal),
          bounds: bounds(portal),
          descendantCount: portal.querySelectorAll("*").length,
        };
      }),
    };
  });
  const active = document.activeElement;
  const root = document.documentElement as unknown as Record<string, unknown>;
  const mutationProbe = root.__huntPageLocalMutationProbe as
    { readonly mutations?: readonly object[] } | undefined;
  return {
    dateControls: wrappers,
    activeElement: active instanceof Element ? {
      tag: active.tagName.toLowerCase(),
      type: active instanceof HTMLInputElement ? active.type : null,
      automationId: active.getAttribute("data-automation-id"),
      role: active.getAttribute("role"),
      ownerAutomationId: active.closest(
        '[data-automation-id="formField"], [data-automation-id^="formField-"]',
      )?.getAttribute("data-automation-id") ?? null,
    } : null,
    mutations: mutationProbe?.mutations ?? [],
  };
}
