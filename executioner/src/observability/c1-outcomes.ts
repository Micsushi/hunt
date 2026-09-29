import type { TerminalResultV4 } from "../contracts/index.ts";

export const c1OutcomeKinds = [
  "ready_for_review", "blocked", "failed", "cancelled",
] as const;
export type C1OutcomeKind = (typeof c1OutcomeKinds)[number];

export interface C1OutcomeObservation {
  readonly jobId: number;
  readonly outcome: C1OutcomeKind;
  readonly reason?: string;
}

export async function publishC1Outcome(
  baseUrl: string,
  token: string | undefined,
  observation: C1OutcomeObservation,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  if (!Number.isSafeInteger(observation.jobId) || observation.jobId < 1 ||
      !c1OutcomeKinds.includes(observation.outcome) ||
      observation.reason !== undefined && !/^[a-z0-9_.:-]{1,120}$/u.test(observation.reason)) {
    throw new TypeError("C1 outcome denied");
  }
  const target = new URL(`/jobs/${observation.jobId}/c3-outcome`, baseUrl);
  if (!/^https?:$/u.test(target.protocol)) throw new TypeError("C1 endpoint denied");
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetcher(target, {
    method: "POST",
    headers,
    body: JSON.stringify({ outcome: observation.outcome, reason: observation.reason ?? null }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`C1 outcome rejected: ${response.status}`);
}
export type C1TerminalPublisher = (terminal: TerminalResultV4) => Promise<void>;

/** Bind an explicitly selected C1 row to this prepared run's opaque target. */
export function createC1TerminalPublisher(
  targetHandleId: string,
  environment: NodeJS.ProcessEnv = process.env,
  fetcher: typeof fetch = fetch,
): C1TerminalPublisher | undefined {
  const baseUrl = environment.HUNT_C1_OUTCOME_BASE_URL;
  const rawJobId = environment.HUNT_C1_OUTCOME_JOB_ID;
  const target = environment.HUNT_C1_OUTCOME_TARGET_HANDLE_ID;
  const token = environment.HUNT_C1_OUTCOME_TOKEN;
  if ([baseUrl, rawJobId, target, token].every((value) => value === undefined)) return undefined;
  const jobId = Number(rawJobId);
  if (!baseUrl || !rawJobId || !/^[1-9]\d*$/u.test(rawJobId) || !Number.isSafeInteger(jobId) ||
      !target || target !== targetHandleId || !token) throw new TypeError("C1 outcome binding denied");
  const endpoint = new URL(baseUrl);
  if (!/^https?:$/u.test(endpoint.protocol) || endpoint.username || endpoint.password) {
    throw new TypeError("C1 outcome binding denied");
  }
  return async (terminal) => publishC1Outcome(baseUrl, token, {
    jobId,
    outcome: terminal.status === "review_reached" ? "ready_for_review" : terminal.status,
    reason: terminal.status === "failed" ? terminal.errorCode : terminal.status,
  }, fetcher);
}
