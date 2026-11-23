import type { Page } from "playwright";
import { MAX_RESUME_ARTIFACT_BYTES } from "../../../../contracts/index.ts";
import type { ResumeId } from "../../../../contracts/index.ts";
import { questionnaireUploadFileName } from "../../../../deterministic/resume-identity.ts";
import { workdayResumeUploadFileName } from "./upload.ts";
import { WORKDAY_APPLICATION_PAGE_SELECTORS as pages } from "../page-walk-contract.ts";

export type WorkdayResumeProof = "picker" | "filename" | "download";
export type WorkdayAttachmentObservation = WorkdayResumeProof | "not_shown" | "missing" | "mismatch" | "ambiguous" | "download_failed" | "download_unavailable";
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
    const active = () => [...document.querySelectorAll(selector)].filter(shown);
    const roots = active();
    if (roots.length !== 1) return roots.length ? "ambiguous" : "not_shown";
    const root = roots[0]!;
    const itemSelector = '[data-automation-id="file-upload-item"]';
    const nameSelector = '[data-automation-id="file-upload-item-name"]';
    const ownership = (node: Element) => {
      let resume = false;
      for (let region: Element | null = node; region && region !== root; region = region.parentElement) {
        if (region.querySelectorAll(itemSelector).length > 1 || region.querySelectorAll("input:not([type=hidden]),select,textarea").length > 1) break;
        const labels = [region.getAttribute("aria-label"),
          ...[...region.querySelectorAll(":scope > legend,:scope > label,:scope > .application-label,:scope > h2,:scope > h3,:scope > h4")].filter(shown).map(n=>n.textContent)];
        const ids = region.getAttribute("aria-labelledby")?.trim().split(/\s+/u).filter(Boolean) ?? [];
        for (const [index,id] of ids.entries()) {
          const refs = document.querySelectorAll(`[id="${CSS.escape(id)}"]`);
          if (refs.length > 1 || index === 0 && (!refs[0] || !(refs[0].textContent?.trim() || refs[0].getAttribute("aria-label")?.trim()))) return "other";
          if (refs[0]) labels.push(refs[0].textContent, refs[0].getAttribute("aria-label"));
        }
        if (labels.some(s => /transcript|cover[ -]letter|supporting document|writing sample|passport|portfolio/i.test(s ?? ""))) return "other";
        if (/^formField-resume$/i.test(region.getAttribute("data-automation-id") ?? "") ||
            labels.some(s => /^(?:resume(?:[ /-]?cv)?|résumé|cv|curriculum vitae)(?:\s*\*)?$/i.test(s?.trim() ?? ""))) resume = true;
      }
      return resume ? "resume" : undefined;
    };
    const filename = (item: Element) => {
      const visible = [...item.querySelectorAll(nameSelector)].filter(shown);
      if (visible.length === 1) return (visible[0] as HTMLElement).innerText.trim();
      if (item.querySelector(nameSelector)) return "";
      return [...item.childNodes].filter(n => n.nodeType === Node.TEXT_NODE)
        .map(n => n.textContent?.trim()).find(name => name && /\.pdf$/i.test(name)) ?? "";
    };
    const candidates = () => [...root.querySelectorAll(itemSelector)].filter(shown).filter(item =>
      ownership(item) === "resume" || ownership(item) !== "other" && names.includes(filename(item)));
    const items = candidates();
    if (items.length > 1) return "ambiguous";
    const item = items[0];
    const picker = [...root.querySelectorAll<HTMLInputElement>('input[type=file]')].filter(input =>
      ownership(input) !== "other" && (ownership(input) === "resume" || phase === "resume" && input.matches('[data-automation-id="file-upload-input-ref"]') ||
      [...input.labels ?? []].some(label => /^(?:resume|résumé|cv)(?:\s*\*)?$/i.test(label.textContent?.trim() ?? ""))));
    const selection = picker.length === 1 && picker[0]!.files?.length === 1 ? picker[0]!.files[0] : undefined;
    const current = () => active().length === 1 && active()[0] === root && (item ? candidates().length === 1 && candidates()[0] === item : candidates().length === 0);
    const hex = async (bytes: ArrayBuffer) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
      .map(n=>n.toString(16).padStart(2,"0")).join("");
    const name = item ? filename(item) : "";
    if (name && !names.includes(name)) return "mismatch";
    if (item && name) {
      const links = () => [...item.querySelectorAll<HTMLAnchorElement>("a[href]")].filter(shown).filter(a =>
        a.matches(nameSelector) || !!a.querySelector(nameSelector) || a.hasAttribute("download") ||
        /^(?:download|preview|view)(?: (?:resume|file|document|attachment))?$/i.test((a.getAttribute("aria-label") ?? a.innerText).trim()));
      const anchors = links();
      if (anchors.length > 1) return "ambiguous";
      const otherLinks = [...item.querySelectorAll<HTMLAnchorElement>("a[href]")].filter(a => shown(a) && !anchors.includes(a) &&
        !/^(?:delete|remove)(?: file| resume| attachment)?$/i.test((a.getAttribute("aria-label") ?? a.innerText).trim()));
      if (otherLinks.length) return "download_unavailable";
      // A digest-derived filename may be displayed outside a positively identified résumé group.
      // Report its visible name there, but only fetch a link in the employer’s own résumé section.
      if (anchors.length && ownership(item) !== "resume") return "download_unavailable";
      if (!anchors.length && [...item.querySelectorAll('button,[role=button],[role=link],a[href],iframe[src],embed[src],object[data]')].some(node =>
        shown(node) && /\b(?:download|preview|view)\b/i.test([node.getAttribute("aria-label"), node.getAttribute("title"), (node as HTMLElement).innerText].join(" ")))) return "download_unavailable";
      if (anchors.length === 1) {
        const link = anchors[0]!, url = new URL(link.href);
        if (url.protocol !== "https:" || url.origin !== location.origin || url.username || url.password) return "download_unavailable";
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
          if (!current() || ownership(item) !== "resume" || filename(item) !== name || links().length !== 1 || links()[0] !== link || link.href !== url.href) return "ambiguous";
          return matched ? "download" : "mismatch";
        } catch { return "download_failed"; }
      }
    }
    if (selection) {
      if (!selection.size || selection.size > maxBytes) return "mismatch";
      const matches = await hex(await selection.arrayBuffer()) === sha256;
      if (!current() || !root.contains(picker[0]!) || picker[0]!.files?.length !== 1 || picker[0]!.files[0] !== selection ||
          item && filename(item) !== name) return "ambiguous";
      if (!matches) return "mismatch";
      return name ? "filename" : "picker";
    }
    if (picker.some(input => (input.files?.length ?? 0) > 0)) return "ambiguous";
    if (name) return "filename";
    const emptyResume = [...root.querySelectorAll("h2,h3,h4,legend,[role=heading]")].find(node=>shown(node) &&
      /^(?:resume(?:[ /]cv)?|résumé|cv)$/i.test((node as HTMLElement).innerText.trim()) &&
      /\b(?:no (?:file|resume|attachments?) (?:attached|uploaded|selected)|no attachments)\b/i.test((node.parentElement as HTMLElement)?.innerText ?? ""));
    return emptyResume ? "missing" : "not_shown";
  }, {selector, phase, names: [workdayResumeUploadFileName({artifactId}), questionnaireUploadFileName(sha256)], sha256, maxBytes: MAX_RESUME_ARTIFACT_BYTES});
}
