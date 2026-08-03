import type {
  ApprovedTargetBinding,
  OwnedTargetObservation,
  OwnedTargetProbe,
  PersistentPage,
  ValueFreeOwnedPageSnapshot,
} from "./types.ts";
import { PlaywrightAccountPageAdapter } from "./playwright-account-page.ts";
import {
  inspectWorkdayStructure,
  type WorkdayStructuralPage,
} from "./workday-structural-catalog.ts";

interface WorkdayProbePage extends WorkdayStructuralPage {
  url(): string;
}

interface ParsedWorkdayTarget {
  readonly host: string;
  readonly hostFamily: string;
  readonly tenant: string;
  readonly postings: readonly string[];
  readonly routeIsPosting: boolean;
}

export class WorkdayOwnedTargetProbe implements OwnedTargetProbe {
  readonly #accountPage = new PlaywrightAccountPageAdapter();
  readonly #matchedLineage = new WeakMap<object, string>();

  async inspect(
    page: PersistentPage,
    expectedTarget: ApprovedTargetBinding,
    signal: AbortSignal,
  ): Promise<OwnedTargetObservation> {
    if (signal.aborted) throw signal.reason;
    const probePage = page as unknown as WorkdayProbePage;
    const parsed = parseWorkdayTarget(probePage.url());
    if (parsed === undefined) {
      this.#matchedLineage.delete(probePage);
      return { ownership: "foreign" };
    }
    const expected = parseExpectedHost(expectedTarget.approved.host);
    if (expected === undefined) {
      this.#matchedLineage.delete(probePage);
      return { ownership: "foreign" };
    }

    if (parsed.hostFamily !== expected.hostFamily) {
      this.#matchedLineage.delete(probePage);
      return ownedMismatch("host", emptyWorkdaySnapshot());
    }
    if (parsed.tenant !== expectedTarget.approved.tenant) {
      this.#matchedLineage.delete(probePage);
      return ownedMismatch("tenant", emptyWorkdaySnapshot());
    }
    if (parsed.host !== expectedTarget.approved.host) {
      this.#matchedLineage.delete(probePage);
      return ownedMismatch("host", emptyWorkdaySnapshot());
    }
    if (parsed.postings.length > 1) {
      this.#matchedLineage.delete(probePage);
      return owned(emptyWorkdaySnapshot(), { kind: "target_ambiguous" });
    }
    if (
      parsed.postings.length === 1 &&
      parsed.postings[0] !== expectedTarget.approved.posting
    ) {
      this.#matchedLineage.delete(probePage);
      return ownedMismatch("posting", emptyWorkdaySnapshot());
    }
    const lineageKey = targetLineageKey(expectedTarget);
    if (
      parsed.postings.length === 0 &&
      this.#matchedLineage.get(probePage) !== lineageKey
    ) {
      this.#matchedLineage.delete(probePage);
      return owned(emptyWorkdaySnapshot(), { kind: "target_ambiguous" });
    }
    const preliminary = await inspectWorkdayStructure(
      probePage,
      parsed.routeIsPosting,
      {
        inspect: (control) => this.#accountPage.inspect(page, control),
      },
    );
    const snapshot = preliminary.kind === "snapshot"
      ? preliminary.snapshot
      : emptyWorkdaySnapshot();
    if (preliminary.kind === "ambiguous") {
      this.#matchedLineage.delete(probePage);
      return owned(snapshot, { kind: "target_ambiguous" });
    }
    if (preliminary.kind === "posting_unavailable") {
      this.#matchedLineage.delete(probePage);
      return owned(snapshot, {
        kind: "posting_unavailable",
        reason: preliminary.reason,
      });
    }
    if (
      parsed.postings.length === 0 &&
      !hasExactlyOnePostingFreeDescendantTrait(preliminary.snapshot)
    ) {
      this.#matchedLineage.delete(probePage);
      return owned(preliminary.snapshot, { kind: "target_ambiguous" });
    }
    if (parsed.postings.length === 1) {
      this.#matchedLineage.set(probePage, lineageKey);
    }
    return owned(preliminary.snapshot, { kind: "matched" });
  }
}

const postingFreeDescendantTraits = Object.freeze(new Set([
  "structural_trait_page_account_entry_v1",
  "structural_trait_page_email_verification_v1",
  "structural_trait_page_candidate_home_v1",
  "structural_trait_page_profile_step_v1",
  "structural_trait_page_questionnaire_v1",
  "structural_trait_page_review_step_v1",
  "structural_trait_navigation_email_sign_in_choice_v1",
]));

function hasExactlyOnePostingFreeDescendantTrait(
  snapshot: ValueFreeOwnedPageSnapshot,
): boolean {
  const descendants = snapshot.traitIds.filter((trait) =>
    postingFreeDescendantTraits.has(trait)
  );
  return descendants.length === 1 ||
    descendants.length === 2 &&
      descendants.includes("structural_trait_page_account_entry_v1") &&
      descendants.includes("structural_trait_navigation_email_sign_in_choice_v1");
}

function targetLineageKey(expectedTarget: ApprovedTargetBinding): string {
  const { host, tenant, posting } = expectedTarget.approved;
  return `${host}\u0000${tenant}\u0000${posting}`;
}

function parseWorkdayTarget(value: string): ParsedWorkdayTarget | undefined {
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.username !== "" ||
      parsed.password !== ""
    ) return undefined;
    const host = parseExpectedHost(parsed.hostname.toLowerCase());
    if (host === undefined) return undefined;
    const segments = parsed.pathname.split("/").filter(Boolean);
    const jobBoundary = segments.lastIndexOf("job");
    const jobRoute = jobBoundary >= 0 ? segments.slice(jobBoundary + 1) : [];
    const postings = jobRoute.flatMap((segment) => {
      const matched = /_([A-Za-z0-9-]{2,64})$/u.exec(segment);
      return matched === null ? [] : [matched[1]!];
    });
    const postingIndex = jobRoute.findIndex((segment) =>
      /_[A-Za-z0-9-]{2,64}$/u.test(segment)
    );
    return {
      ...host,
      postings: Object.freeze(postings),
      routeIsPosting: postingIndex >= 0 && postingIndex === jobRoute.length - 1,
    };
  } catch {
    return undefined;
  }
}

function parseExpectedHost(
  host: string,
): Pick<ParsedWorkdayTarget, "host" | "hostFamily" | "tenant"> | undefined {
  const matched = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.(wd\d{1,2}\.myworkdayjobs\.(?:com|invalid))$/u.exec(host);
  if (matched === null) return undefined;
  return { host, tenant: matched[1]!, hostFamily: matched[2]! };
}

function emptyWorkdaySnapshot() {
  return Object.freeze({
    schemaVersion: 1 as const,
    traitIds: Object.freeze(["structural_trait_ats_workday_family_v1"]),
    controlCount: 0,
    requiredControlCount: 0,
    optionCount: 0,
  });
}

function ownedMismatch(
  dimension: "host" | "tenant" | "posting",
  snapshot: ValueFreeOwnedPageSnapshot,
): OwnedTargetObservation {
  return owned(snapshot, { kind: "target_mismatch", dimension });
}

function owned(
  snapshot: Extract<OwnedTargetObservation, { ownership: "owned" }>["snapshot"],
  target: Extract<OwnedTargetObservation, { ownership: "owned" }>["target"],
): OwnedTargetObservation {
  return Object.freeze({ ownership: "owned", snapshot, target });
}
