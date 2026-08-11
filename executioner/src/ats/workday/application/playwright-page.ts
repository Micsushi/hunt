import type { Page } from "playwright";

import {
  browserPageId,
  fieldId,
} from "../../../contracts/index.ts";
import type {
  ApplicationHandlerPage,
  ApplicationPage,
  ApplicationPageTruth,
  ApplicationPortFailure,
  ApplicationPortResult,
  ApplicationWalkDependencies,
} from "./page-walk-contract.ts";

export interface PlaywrightWorkdayApplicationPageOptions {
  readonly timeoutMs?: number;
  readonly pageIds?: Partial<Record<ApplicationPage, ApplicationPageTruth["pageId"]>>;
}

export class PlaywrightWorkdayApplicationPage
{
  readonly #page: Page;
  readonly #timeoutMs: number;
  readonly #pageIds: Partial<Record<ApplicationPage, ApplicationPageTruth["pageId"]>>;

  constructor(
    page: Page,
    options: PlaywrightWorkdayApplicationPageOptions = {},
  ) {
    this.#page = page;
    this.#timeoutMs = options.timeoutMs ?? 5_000;
    this.#pageIds = options.pageIds ?? {};
  }

  async observe(
    signal: AbortSignal,
  ): Promise<ApplicationPortResult<ApplicationPageTruth>> {
    if (signal.aborted) return failure("operation_cancelled", "none");
    try {
      const snapshot = await this.#page.evaluate(() => {
        const declared = document.body.getAttribute("data-hunt-application-page");
        const matches = [
          ["resume", document.querySelectorAll(
            'input[type="file"][data-automation-id="file-upload-input-ref"]',
          ).length],
          ["profile", document.querySelectorAll(
            '[data-automation-id="applyFlowMyInfoPage"]',
          ).length],
          ["questionnaire", document.querySelectorAll(
            '[data-automation-id="applyFlowApplicationQuestionsPage"]',
          ).length],
          ["pre_review", document.querySelectorAll(
            '[data-automation-id="applyFlowReviewPage"]',
          ).length],
        ] as const;
        const explicit = ["resume", "profile", "questionnaire", "pre_review"]
          .includes(declared ?? "") ? declared : null;
        const counts = new Map(matches);
        const profileControls = [...document.querySelectorAll<HTMLElement>(
          '[data-automation-id="applyFlowMyInfoPage"] input, ' +
            '[data-automation-id="applyFlowMyInfoPage"] textarea, ' +
            '[data-automation-id="applyFlowMyInfoPage"] select, ' +
            '[data-automation-id="applyFlowMyInfoPage"] [contenteditable="true"], ' +
            '[data-automation-id="applyFlowMyInfoPage"] [role="combobox"], ' +
            '[data-automation-id="applyFlowMyInfoPage"] button[data-automation-id="sourcePrompt"]',
        )].filter((control) => control.offsetParent !== null && !(
          control instanceof HTMLInputElement && control.type === "file" &&
          control.getAttribute("data-automation-id") === "file-upload-input-ref"
        ));
        const combinedResumeProfile = counts.get("resume") === 1 &&
          counts.get("profile") === 1 && profileControls.length > 0;
        const page = explicit ?? (
          counts.get("pre_review") === 1
            ? "pre_review"
            : counts.get("questionnaire") === 1
              ? "questionnaire"
              : combinedResumeProfile
                ? "resume"
                : counts.get("profile") === 1
                  ? "profile"
                  : null
        );
        const pageId = document.body.getAttribute("data-hunt-page-id");
        if (page === null) return null;
        const lanes = page === "pre_review"
          ? []
          : combinedResumeProfile && page === "resume"
            ? ["resume", "profile"]
            : [page];

        const controls = [...document.querySelectorAll<HTMLElement>(
          "input[required], input[aria-required=true], textarea[required], " +
            "textarea[aria-required=true], select[required], select[aria-required=true]",
        )].filter((control) => control.offsetParent !== null);
        const requiredFields: {
          fieldId: string;
          page?: "resume" | "profile" | "questionnaire";
          verification: "verified" | "unverified";
        }[] = [];
        const seenRadioGroups = new Set<string>();
        for (const [index, control] of controls.entries()) {
          const input = control instanceof HTMLInputElement ? control : undefined;
          const radioGroup = input?.type === "radio"
            ? input.name || input.getAttribute("data-hunt-field-id") || `radio-${index}`
            : undefined;
          if (radioGroup !== undefined && seenRadioGroups.has(radioGroup)) continue;
          if (radioGroup !== undefined) seenRadioGroups.add(radioGroup);
          const rawId = control.getAttribute("data-hunt-field-id") ??
            control.getAttribute("data-automation-id") ?? `required-field-${index}`;
          const safeId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(rawId)
            ? rawId
            : `required-field-${index}`;
          let verified = control.getAttribute("aria-invalid") !== "true";
          if (input?.type === "file") {
            const item = document.querySelectorAll('[data-automation-id="file-upload-item"]');
            const success = document.querySelectorAll(
              '[data-automation-id="file-upload-success"], ' +
                '[data-automation-id="file-upload-item"][data-upload-state="success"]',
            );
            verified = verified && input.files?.length === 1 && item.length === 1 &&
              success.length === 1;
          } else if (input?.type === "radio") {
            const radios = [...document.querySelectorAll<HTMLInputElement>(
              `input[type="radio"][name="${CSS.escape(input.name)}"]`,
            )];
            verified = verified && radios.filter(({ checked }) => checked).length === 1;
          } else if (input?.type === "checkbox") {
            verified = verified && input.checked;
          } else if (control instanceof HTMLSelectElement) {
            verified = verified && control.value.trim() !== "";
          } else if (
            control instanceof HTMLInputElement ||
            control instanceof HTMLTextAreaElement
          ) {
            verified = verified && control.value.trim() !== "";
          }
          const resumeOwnedFile = input?.type === "file" &&
            input.getAttribute("data-automation-id") === "file-upload-input-ref";
          const fieldPage: "resume" | "profile" | "questionnaire" | undefined = resumeOwnedFile
            ? "resume"
            : combinedResumeProfile && page === "resume"
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
        for (const row of document.querySelectorAll<HTMLElement>(
          '[data-hunt-c3-owned="true"]',
        )) {
          const values = [...row.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
            "input, textarea, select",
          )].map((control) => control.value.normalize("NFC").trim()).sort();
          const fingerprint = values.join("\u001f");
          if (fingerprint === "") continue;
          const count = fingerprints.get(fingerprint) ?? 0;
          if (count > 0) duplicateRows += 1;
          fingerprints.set(fingerprint, count + 1);
        }
        return {
          page,
          lanes,
          pageId,
          requiredFields,
          c3OwnedDuplicateRows: duplicateRows,
          submitActivated: document.documentElement.getAttribute(
            "data-hunt-submit-activated",
          ) === "true",
        };
      });
      if (snapshot === null) return failure("browser_target_ambiguous", "page_type");
      return {
        ok: true,
        value: Object.freeze({
          page: snapshot.page as ApplicationPage,
          lanes: Object.freeze(snapshot.lanes as ApplicationHandlerPage[]),
          pageId: snapshot.pageId === null
            ? this.#pageIds[snapshot.page as ApplicationPage] ??
              browserPageId(`s2-${snapshot.page.replace("_", "-")}`)
            : browserPageId(snapshot.pageId),
          requiredFields: Object.freeze(snapshot.requiredFields.map((item) =>
            Object.freeze({
              fieldId: fieldId(item.fieldId),
              page: item.page as ApplicationHandlerPage,
              verification: item.verification,
            })
          )),
          c3OwnedDuplicateRows: snapshot.c3OwnedDuplicateRows,
          submitActivated: snapshot.submitActivated,
        }),
      };
    } catch {
      return failure(
        signal.aborted ? "operation_cancelled" : "browser_target_stale",
        "ui_behavior",
      );
    }
  }

  async next(
    request: Parameters<ApplicationWalkDependencies["navigation"]["next"]>[0],
    signal: AbortSignal,
  ): Promise<ApplicationPortResult<{ readonly advanced: true }>> {
    if (signal.aborted) return failure("operation_cancelled", "none");
    const before = await this.observe(signal);
    if (!before.ok) return before;
    if (
      before.value.page !== request.from ||
      before.value.pageId !== request.fromPageId ||
      before.value.submitActivated ||
      before.value.c3OwnedDuplicateRows !== 0 ||
      before.value.requiredFields.some(({ verification }) =>
        verification !== "verified"
      )
    ) return failure("navigation_illegal", "navigation");
    try {
      const beforeSignature = await this.#page.evaluate(applicationPageSignature);
      const controls = this.#page.getByRole("button", {
        name: /^(?:next|continue|save(?:\s+and)?\s+continue)$/iu,
      });
      if (await controls.count() !== 1) {
        return failure("navigation_uncertain", "navigation");
      }
      await controls.click({ timeout: this.#timeoutMs });
      await this.#page.waitForFunction(
        ({ allowed, before }) => {
          const declared = document.body.getAttribute("data-hunt-application-page");
          const page = ["resume", "profile", "questionnaire", "pre_review"]
            .includes(declared ?? "") ? declared :
            document.querySelectorAll('[data-automation-id="applyFlowReviewPage"]').length === 1
              ? "pre_review"
              : document.querySelectorAll('[data-automation-id="applyFlowApplicationQuestionsPage"]').length === 1
                ? "questionnaire"
                : document.querySelectorAll('input[type="file"][data-automation-id="file-upload-input-ref"]').length === 1
                  ? "resume"
                  : document.querySelectorAll('[data-automation-id="applyFlowMyInfoPage"]').length === 1
                    ? "profile"
                    : null;
          const signature = [
            location.href,
            declared ?? "",
            document.body.getAttribute("data-hunt-page-id") ?? "",
            document.querySelector('[data-automation-id="progressBarActiveStep"]')?.textContent ?? "",
            [...document.querySelectorAll("label, legend")]
              .map((item) => item.textContent?.normalize("NFC").replace(/\s+/gu, " ").trim() ?? "")
              .join("\u001f"),
            [...document.querySelectorAll<HTMLElement>("[data-automation-id], input")]
              .map((item) => `${item.getAttribute("data-automation-id") ?? "input"}:${
                item instanceof HTMLInputElement ? item.type : "element"
              }`)
              .join("\u001f"),
          ].join("\u0000");
          return page !== null && allowed.includes(page as ApplicationPage) &&
            signature !== before;
        },
        { allowed: request.allowed, before: beforeSignature },
        { timeout: this.#timeoutMs },
      );
      const after = await this.observe(signal);
      if (!after.ok) return after;
      if (!request.allowed.includes(after.value.page) || after.value.submitActivated) {
        return failure("navigation_uncertain", "navigation");
      }
      return { ok: true, value: { advanced: true } };
    } catch {
      return failure(
        signal.aborted ? "operation_cancelled" : "browser_effect_uncertain",
        "navigation",
      );
    }
  }
}

function applicationPageSignature(): string {
  return [
    location.href,
    document.body.getAttribute("data-hunt-application-page") ?? "",
    document.body.getAttribute("data-hunt-page-id") ?? "",
    document.querySelector('[data-automation-id="progressBarActiveStep"]')?.textContent ?? "",
    [...document.querySelectorAll("label, legend")]
      .map((item) => item.textContent?.normalize("NFC").replace(/\s+/gu, " ").trim() ?? "")
      .join("\u001f"),
    [...document.querySelectorAll<HTMLElement>("[data-automation-id], input")]
      .map((item) => `${item.getAttribute("data-automation-id") ?? "input"}:${
        item instanceof HTMLInputElement ? item.type : "element"
      }`)
      .join("\u001f"),
  ].join("\u0000");
}

function failure(
  code: ApplicationPortFailure["code"],
  unknownLayer: ApplicationPortFailure["unknownLayer"],
): { readonly ok: false; readonly error: ApplicationPortFailure } {
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
