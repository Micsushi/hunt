import type { Page } from "playwright";
import { MAX_RESUME_ARTIFACT_BYTES } from "../../../../contracts/index.ts";
import type { ResumeId } from "../../../../contracts/index.ts";
import { questionnaireUploadFileName } from "../../../../deterministic/resume-identity.ts";
import { workdayResumeUploadFileName } from "./upload.ts";
import { WORKDAY_APPLICATION_PAGE_SELECTORS as pages } from "../page-walk-contract.ts";

export type WorkdayResumeProof = "picker" | "filename" | "download";
export type WorkdayAttachmentObservation = WorkdayResumeProof | "not_shown" | "missing" | "filename_mismatch" | "picker_mismatch" | "mismatch" | "ambiguous" | "download_failed" | "download_unavailable";
export interface WorkdayReviewEvidence {
  upload?: WorkdayResumeProof;
  review: WorkdayResumeProof | "not_shown";
}

/** Reinspect the selected document using only attachment controls exposed in the active Workday section. */
export async function inspectWorkdayResume(page: Page, sha256: string, artifactId: ResumeId,
  phase: "resume" | "questionnaire" | "review"): Promise<WorkdayAttachmentObservation> {
  const selector = phase === "review" ? pages.review : phase === "resume" ? pages.experience :
    [pages.primaryQuestions, pages.secondaryQuestions, pages.supplementaryQuestions, pages.primaryQuestionnaire, pages.applicationQuestions].join(",");
  return page.evaluate(async ({selector, names, sha256, maxBytes, phase}) => {
    const shown = (node: Element) => node.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}) &&
      !node.closest('[hidden],[inert],[aria-hidden=true]');
    const itemSelector = '[data-automation-id="file-upload-item"]';
    const nameSelector = '[data-automation-id="file-upload-item-name"]';
    const controlSelector = 'a,button,[role=button],[role=link],iframe[src],embed[src],object[data]';
    const actionText = (node: Element) => [node.getAttribute("aria-label"), node.getAttribute("title"), (node as HTMLElement).innerText];
    const downloadText = (value: string | null | undefined) => /^(?:download|preview|view)(?: (?:resume|file|document|attachment|pdf))?[.!]?$/i.test(value?.trim() ?? "");
    const explicitDownload = (node: Element) => node.hasAttribute("download") || actionText(node).some(value =>
      downloadText(value) || /\.pdf$/i.test(value?.trim() ?? "")) ||
      node.matches("a[href]") && (node.matches(nameSelector) || !!node.querySelector(nameSelector));
    const removal = (node: Element) => !node.hasAttribute("download") && !actionText(node).some(downloadText) &&
      actionText(node).some(value => /^(?:delete|remove)\b/i.test(value?.trim() ?? ""));
    const downloadControl = (node: Element) => !removal(node) && (explicitDownload(node) ||
      actionText(node).some(value => /\b(?:download|preview|view)\b/i.test(value ?? "")));

    // Workday may lay out a visible attachment without giving its wrapper a box.
    const visibleWrapper = (node: Element) => shown(node) ||
      getComputedStyle(node).display === "contents" && [...node.querySelectorAll("h2,h3,h4," + nameSelector + "," + controlSelector)].some(shown);
    const active = () => [...document.querySelectorAll(selector)].filter(visibleWrapper);
    const roots = active();
    if (roots.length !== 1) return roots.length ? "ambiguous" : "not_shown";
    const root = roots[0]!;
    const isResumeLabel = (text: string | null | undefined) =>
      /^(?:resume(?:[ /-]?cv)?|résumé|cv|curriculum vitae)(?:\s*\*)?$/i.test(text?.trim() ?? "");
    const ownership = (node: Element) => {
      let resume = false, uncertainReference = false;
      // A read-only heading names its own summary group. Labels elsewhere on the
      // enclosing Review summary describe separate fields.
      const group = phase === "review" ? node.closest('[role=group],section') : null;
      const headings = group && group !== root ? [...group.querySelectorAll(":scope > h2,:scope > h3,:scope > h4,:scope > [role=heading]")].filter(shown) : [];
      const reviewOwner = group && headings.length === 1 && isResumeLabel(headings[0]!.textContent) ? group : null;
      if (group && group !== root && headings.length && !reviewOwner) return "other";
      for (let region: Element | null = node; region && region !== root && region !== reviewOwner?.parentElement; region = region.parentElement) {
        if (region.querySelectorAll(itemSelector).length > 1 || region.querySelectorAll("input:not([type=hidden]),select,textarea").length > 1) break;
        const labels = [region.getAttribute("aria-label"),
          ...[...region.querySelectorAll(":scope > legend,:scope > label,:scope > .application-label,:scope > h2,:scope > h3,:scope > h4")].filter(shown).map(n=>n.textContent)];
        const ids = region.getAttribute("aria-labelledby")?.trim().split(/\s+/u).filter(Boolean) ?? [];
        for (const [index,id] of ids.entries()) {
          const refs = document.querySelectorAll(`[id="${CSS.escape(id)}"]`);
          if (refs.length > 1) return "other";
          if (index === 0 && !(refs[0]?.textContent?.trim() || refs[0]?.getAttribute("aria-label")?.trim())) {
            if (!reviewOwner) return "other";
            uncertainReference = true;
          }
          if (refs[0]) labels.push(refs[0].textContent, refs[0].getAttribute("aria-label"));
        }
        if (labels.some(s => /transcript|cover[ -]letter|supporting document|writing sample|passport|portfolio/i.test(s ?? ""))) return "other";
        if (/^formField-resume$/i.test(region.getAttribute("data-automation-id") ?? "") ||
            labels.some(isResumeLabel)) resume = true;
      }
      // The visible heading and row establish filename display, but a broken
      // association must never authorize following an employer link.
      return resume ? uncertainReference ? "displayed_resume" : "resume" : undefined;
    };
    const visibleNames = (item: Element) => [...item.querySelectorAll(nameSelector)].filter(shown);
    const filename = (item: Element) => {
      const visible = visibleNames(item);
      if (visible.length === 1) {
        const text = (visible[0] as HTMLElement).innerText.trim();
        return downloadText(text) ? "" : text;
      }
      if (item.querySelector(nameSelector)) return "";
      return [...item.childNodes].filter(n => n.nodeType === Node.TEXT_NODE)
        .map(n => n.textContent?.trim()).find(name => name && /\.pdf$/i.test(name)) ?? "";
    };
    const actions = (region: Element) => [...region.querySelectorAll(controlSelector)].filter(shown);
    const candidates = () => [...root.querySelectorAll(itemSelector)].filter(visibleWrapper).filter(item => {
      const owner = ownership(item);
      return owner === "resume" || owner === "displayed_resume" || owner !== "other" && (names.includes(filename(item)) || actions(item).some(downloadControl));
    });
    const orphanDownload = () => actions(root).some(node => !node.closest(itemSelector) && downloadControl(node) &&
      ["resume","displayed_resume"].includes(ownership(node) ?? ""));
    const emptyResume = () => {
      const text = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (text.nextNode()) {
        const owner = text.currentNode.parentElement;
        if (!owner || !shown(owner) || !/^no (?:files?|resume|attachments?)(?: (?:has been |have been )?(?:attached|uploaded|selected))?[.!]?$/i.test(text.currentNode.textContent?.trim() ?? "")) continue;
        const scope = ownership(owner);
        if (scope === "resume" || scope === "displayed_resume") return true;
        // Workday also renders a heading followed directly by the empty-state paragraph.
        const heading = owner.previousElementSibling;
        if (!scope && heading?.matches("h2,h3,h4,legend,[role=heading]") && shown(heading) && isResumeLabel(heading.textContent)) return true;
      }
      return false;
    };
    const items = candidates();
    if (items.length > 1) return "ambiguous";
    const item = items[0];
    if (item && visibleNames(item).length > 1) return "ambiguous";
    if (emptyResume()) {
      const employerAttachment = item && (filename(item) || actions(item).some(downloadControl));
      return employerAttachment || orphanDownload() ? "ambiguous" : "missing";
    }
    if (orphanDownload()) return "download_unavailable";
    const picker = [...root.querySelectorAll<HTMLInputElement>('input[type=file]')].filter(input =>
      ownership(input) !== "other" && (ownership(input) === "resume" || phase === "resume" && input.matches('[data-automation-id="file-upload-input-ref"]') ||
      [...input.labels ?? []].some(label => /^(?:resume|résumé|cv)(?:\s*\*)?$/i.test(label.textContent?.trim() ?? ""))));
    const selection = picker.length === 1 && picker[0]!.files?.length === 1 ? picker[0]!.files[0] : undefined;
    const current = () => !emptyResume() && !orphanDownload() && active().length === 1 && active()[0] === root && (item ? candidates().length === 1 && candidates()[0] === item && visibleNames(item).length <= 1 : candidates().length === 0);
    const hex = async (bytes: ArrayBuffer) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
      .map(n=>n.toString(16).padStart(2,"0")).join("");
    const name = item ? filename(item) : "";
    const evidenceActions = () => item ? actions(item).filter(node => downloadControl(node) || node.matches("a[href]") && !removal(node)) : [];
    if (item) {
      // The returned document identifies its contents even if the employer renamed it.
      const controls = evidenceActions();
      if (controls.length > 1) return "ambiguous";
      if (controls.length) {
        const link = controls[0]!;
        if (ownership(item) !== "resume" || ownership(link) !== "resume" || link.closest(itemSelector) !== item || !(link instanceof HTMLAnchorElement) || !link.getAttribute("href")?.trim() || !explicitDownload(link) ||
            actionText(link).some(value => /\b(?:delete|remove|submit|withdraw|transcript|cover[ -]letter|passport)\b/i.test(value ?? ""))) return "download_unavailable";
        const url = URL.parse(link.href);
        if (!url || url.protocol !== "https:" || url.origin !== location.origin || url.username || url.password) return "download_unavailable";
        try {
          const response = await fetch(url, {mode:"same-origin",credentials:"same-origin",redirect:"error",cache:"no-store",signal:AbortSignal.timeout(5000)});
          if (!response.ok || !response.body || Number(response.headers.get("content-length")) > maxBytes ||
              !/^application\/(?:pdf|octet-stream)(?:;|$)/i.test(response.headers.get("content-type") ?? "")) {
            await response.body?.cancel(); return "download_failed";
          }
          const reader = response.body.getReader(), chunks: Uint8Array<ArrayBuffer>[] = [];
          let size = 0;
          try {
            for (;;) {
              const {done,value} = await reader.read(); if (done) break;
              size += value.length;
              if (size > maxBytes) { await reader.cancel(); return "download_failed"; }
              chunks.push(value);
            }
          } finally { reader.releaseLock(); }
          const bytes = await new Blob(chunks).arrayBuffer();
          if (new TextDecoder().decode(bytes.slice(0,5)) !== "%PDF-") return "download_failed";
          const matched = await hex(bytes) === sha256;
          if (!current() || ownership(item) !== "resume" || ownership(link) !== "resume" || filename(item) !== name || evidenceActions().length !== 1 || evidenceActions()[0] !== link || link.href !== url.href) return "ambiguous";
          return matched ? "download" : "mismatch";
        } catch { return "download_failed"; }
      }
    }
    if (name && !names.includes(name)) return "filename_mismatch";
    if (selection) {
      if (!selection.size || selection.size > maxBytes) return "picker_mismatch";
      const matches = await hex(await selection.arrayBuffer()) === sha256;
      if (!current() || !root.contains(picker[0]!) || picker[0]!.files?.length !== 1 || picker[0]!.files[0] !== selection ||
          item && (filename(item) !== name || evidenceActions().length)) return "ambiguous";
      if (!matches) return "picker_mismatch";
      return name && (phase !== "review" || item && ["resume","displayed_resume"].includes(ownership(item) ?? "")) ? "filename" : "picker";
    }
    if (picker.some(input => (input.files?.length ?? 0) > 0)) return "ambiguous";
    if (name && (phase !== "review" || item && ["resume","displayed_resume"].includes(ownership(item) ?? ""))) return "filename";
    return "not_shown";
  }, {selector, phase, names: [workdayResumeUploadFileName({artifactId}), questionnaireUploadFileName(sha256)], sha256, maxBytes: MAX_RESUME_ARTIFACT_BYTES});
}
