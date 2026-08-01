import type { BrowserObservation, PageIdentity } from "../../contracts/index.ts";
import { workdayPageHandlers } from "./pages/index.ts";

const workdayHosts = ["myworkday.com", "myworkdayjobs.com"] as const;

function isWorkdayOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    if (url.origin !== origin) return false;
    if (
      (url.hostname === "fixture.invalid" ||
        url.hostname === "127.0.0.1" ||
        url.hostname === "[::1]") &&
      (url.protocol === "http:" || url.protocol === "https:")
    ) return true;
    return url.protocol === "https:" && workdayHosts.some((host) =>
      url.hostname === host || url.hostname.endsWith(`.${host}`)
    );
  } catch {
    return false;
  }
}

export function detectWorkdayPage(observation: BrowserObservation): PageIdentity {
  if (
    !isWorkdayOrigin(observation.origin) ||
    typeof observation.path !== "string" ||
    observation.path.length > 2048
  ) return { kind: "unknown" };
  const segments = new Set(observation.path.toLowerCase().split("/").filter(Boolean));
  const matches = workdayPageHandlers.filter((handler) =>
    handler.signatures.some((signature) => segments.has(signature))
  );
  if (matches.length === 0) return { kind: "unknown" };
  if (matches.length > 1) return { kind: "ambiguous" };
  return { kind: "workday", page: matches[0]!.page };
}
