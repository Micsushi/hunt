import { createHash } from "node:crypto";

import { canonicalMonitorIdentityTitle } from "./external-monitor-runtime.ts";
import { observedStructurePage } from "./external-monitor-page-identity.ts";

export function normalizeObservedAddressHost(address: string): string {
  const normalized = address.normalize("NFC").trim();
  if (normalized.length < 1 || normalized.length > 2_048 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    denied();
  }
  const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//iu.test(normalized)
    ? normalized
    : `https://${normalized}`);
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") denied();
  return url.hostname.toLowerCase();
}

export function observedStructurePageFromIdentityTitle(title: string): string {
  const normalized = normalizeObservedChromeTitle(title);
  if (normalized === "My Information" || normalized === "My Experience") return "profile";
  if (["Application Questions", "Voluntary Disclosures", "Self Identify"].includes(normalized)) {
    return "questionnaire";
  }
  if (normalized === "Review") return "review";
  denied();
}

export function observedStructurePageWithIdentity(
  flags: ReadonlySet<string>,
  activeStageTitles: readonly string[],
  _title: string,
  _expectedTitleSha256: string | undefined,
): string {
  return observedStructurePage(flags, activeStageTitles);
}

export function normalizeObservedChromeTitle(windowTitle: string): string {
  const suffix = " - Google Chrome for Testing";
  const title = windowTitle.endsWith(suffix)
    ? windowTitle.slice(0, -suffix.length)
    : windowTitle;
  const normalized = title.normalize("NFC").replace(/\s+/gu, " ").trim();
  if (normalized.length < 1 || normalized.length > 256 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    denied();
  }
  return normalized;
}

export function selectObservedChromeIdentityTitle(
  expectedTitleSha256: string | undefined,
  windowTitle: string,
  selectedTabTitles: readonly string[],
): string {
  const windowIdentity = normalizeObservedChromeTitle(windowTitle);
  if (expectedTitleSha256 === undefined || !/^[0-9a-f]{64}$/u.test(expectedTitleSha256)) {
    return windowIdentity;
  }
  if (selectedTabTitles.length > 8) denied();
  const candidates = new Set([windowIdentity]);
  for (const candidate of selectedTabTitles) {
    candidates.add(normalizeObservedChromeTitle(candidate));
  }
  const matches = [...candidates].filter((candidate) =>
    createHash("sha256").update(canonicalMonitorIdentityTitle(candidate), "utf8")
      .digest("hex") === expectedTitleSha256);
  return matches.length === 1 ? matches[0]! : windowIdentity;
}

export function observedChromeIdentityTitleSha256s(
  windowTitle: string,
  selectedTabTitles: readonly string[],
): readonly string[] {
  if (selectedTabTitles.length > 8) denied();
  const candidates = new Set([normalizeObservedChromeTitle(windowTitle)]);
  for (const candidate of selectedTabTitles) {
    candidates.add(normalizeObservedChromeTitle(candidate));
  }
  return Object.freeze([...candidates].map((candidate) =>
    createHash("sha256").update(canonicalMonitorIdentityTitle(candidate), "utf8")
      .digest("hex")));
}

function denied(): never {
  throw new Error("external monitor observer denied");
}
