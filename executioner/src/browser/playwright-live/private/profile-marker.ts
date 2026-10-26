import type {
  LiveBrowserSessionV1,
  PersistentBrowserOpenRequest,
} from "../../../contracts/live/index.ts";
import { sameTarget } from "./target-binding.ts";
import type { ProfileMarkerV1 } from "./types.ts";

export function isExactMarker(
  value: unknown,
  request: PersistentBrowserOpenRequest,
  runtime: { readonly admittedAt: string; readonly leaseExpiresAt: string },
): value is ProfileMarkerV1 {
  if (value === null || typeof value !== "object") return false;
  const marker = value as Partial<ProfileMarkerV1>;
  const admittedAt = Date.parse(String(marker.admittedAt));
  const leaseExpiresAt = Date.parse(String(marker.leaseExpiresAt));
  const recoveryAt = Date.parse(runtime.admittedAt);
  return marker.schemaVersion === 1 &&
    marker.journeyId === request.journeyId &&
    marker.profileLeaseId === request.profileLeaseId &&
    typeof marker.sessionId === "string" &&
    marker.sessionId.startsWith("live_session_") &&
    Number.isFinite(admittedAt) &&
    Number.isFinite(leaseExpiresAt) &&
    Number.isFinite(recoveryAt) &&
    leaseExpiresAt - admittedAt === 24 * 60 * 60 * 1_000 &&
    recoveryAt >= admittedAt &&
    recoveryAt < leaseExpiresAt &&
    sameTarget(marker.target, request.target);
}

export function sessionFromMarker(
  marker: ProfileMarkerV1,
  request: PersistentBrowserOpenRequest,
): LiveBrowserSessionV1 {
  return {
    schemaVersion: 1,
    journeyId: request.journeyId,
    sessionId: marker.sessionId,
    profileLeaseId: request.profileLeaseId,
    target: request.target,
    leaseExpiresAt: marker.leaseExpiresAt,
  };
}
