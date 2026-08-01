import type {
  ApprovedTargetBinding,
  OwnedTargetObservation,
  OwnedTargetProbe,
  PersistentPage,
  ValueFreeOwnedPageSnapshot,
} from "./types.ts";
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
  async inspect(
    page: PersistentPage,
    expectedTarget: ApprovedTargetBinding,
    signal: AbortSignal,
  ): Promise<OwnedTargetObservation> {
    if (signal.aborted) throw signal.reason;
    const probePage = page as unknown as WorkdayProbePage;
    const parsed = parseWorkdayTarget(probePage.url());
    if (parsed === undefined) return { ownership: "foreign" };
    const expected = parseExpectedHost(expectedTarget.approved.host);
    if (expected === undefined) return { ownership: "foreign" };

    if (parsed.hostFamily !== expected.hostFamily) {
      return ownedMismatch("host", emptyWorkdaySnapshot());
    }
    if (parsed.tenant !== expectedTarget.approved.tenant) {
      return ownedMismatch("tenant", emptyWorkdaySnapshot());
    }
    if (parsed.host !== expectedTarget.approved.host) {
      return ownedMismatch("host", emptyWorkdaySnapshot());
    }
    if (parsed.postings.length !== 1) {
      return owned(emptyWorkdaySnapshot(), { kind: "target_ambiguous" });
    }
    if (parsed.postings[0] !== expectedTarget.approved.posting) {
      return ownedMismatch("posting", emptyWorkdaySnapshot());
    }
    const preliminary = await inspectWorkdayStructure(
      probePage,
      parsed.routeIsPosting,
    );
    const snapshot = preliminary.kind === "snapshot"
      ? preliminary.snapshot
      : emptyWorkdaySnapshot();
    if (preliminary.kind === "ambiguous") {
      return owned(snapshot, { kind: "target_ambiguous" });
    }
    if (preliminary.kind === "posting_unavailable") {
      return owned(snapshot, {
        kind: "posting_unavailable",
        reason: preliminary.reason,
      });
    }
    return owned(preliminary.snapshot, { kind: "matched" });
  }
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
    const postings = segments.flatMap((segment) => {
      const matched = /_([A-Za-z0-9-]{2,64})$/u.exec(segment);
      return matched === null ? [] : [matched[1]!];
    });
    const postingIndex = segments.findIndex((segment) =>
      /_[A-Za-z0-9-]{2,64}$/u.test(segment)
    );
    return {
      ...host,
      postings: Object.freeze(postings),
      routeIsPosting: postingIndex >= 0 && postingIndex === segments.length - 1,
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
