import type {
  LiveBrowserSessionV1,
  PersistentBrowserOpenRequest,
  TargetIdentityV1,
} from "../../../contracts/live/index.ts";
import type { ApprovedTargetBinding } from "./types.ts";

export function bindApprovedTarget(
  targetUrl: string,
  identity: PersistentBrowserOpenRequest["target"],
): ApprovedTargetBinding | undefined {
  try {
    const parsed = new URL(targetUrl);
    const host = parsed.hostname.toLowerCase();
    const tenant = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.wd\d{1,3}\.myworkdayjobs\.(?:com|invalid)$/u.exec(host);
    const segment = parsed.pathname.split("/").filter(Boolean).at(-1);
    const posting = /_([A-Za-z0-9-]{2,64})$/u.exec(segment ?? "");
    if (
      parsed.protocol !== "https:" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.search !== "" ||
      parsed.hash !== "" ||
      parsed.origin + parsed.pathname !== targetUrl ||
      tenant === null ||
      posting === null
    ) return undefined;
    return {
      identity,
      approved: { host, tenant: tenant[1]!, posting: posting[1]! },
    };
  } catch {
    return undefined;
  }
}

export function sameTarget(
  left: TargetIdentityV1 | undefined,
  right: TargetIdentityV1,
): boolean {
  return left?.schemaVersion === right.schemaVersion &&
    left.atsFamily === right.atsFamily &&
    left.hostId === right.hostId &&
    left.tenantId === right.tenantId &&
    left.postingId === right.postingId;
}

export function sameSession(
  left: LiveBrowserSessionV1,
  right: LiveBrowserSessionV1,
): boolean {
  return left.schemaVersion === right.schemaVersion &&
    left.journeyId === right.journeyId &&
    left.sessionId === right.sessionId &&
    left.profileLeaseId === right.profileLeaseId &&
    left.leaseExpiresAt === right.leaseExpiresAt &&
    sameTarget(left.target, right.target);
}
