import { isDeepStrictEqual } from "node:util";

import {
  copyContractDataGraph,
  generatedReportId,
  journeyId,
  parseErrorEnvelope,
  providerError,
  type FailureContext,
  type FailureReport,
  type FailureReporter,
} from "../../contracts/index.ts";
import {
  acknowledgeNotification,
  type NotificationAdapter,
} from "../notifications/adapter.ts";

interface ReportState {
  readonly report: FailureReport;
  attempts: number;
  delivered: boolean;
}

type Admission =
  | { readonly ok: true; readonly report: FailureReport }
  | {
      readonly ok: false;
      readonly code: "failure_context_invalid" | "report_identity_source_invalid";
    };

export class FactualFailureReporter implements FailureReporter {
  readonly #notify: NotificationAdapter;
  readonly #reports = new Map<string, ReportState>();
  #pending: Promise<void> = Promise.resolve();

  constructor(notify: NotificationAdapter = acknowledgeNotification) {
    this.#notify = notify;
  }

  report(request: Parameters<FailureReporter["report"]>[0], signal: AbortSignal) {
    return this.#serialized(async () => {
      if (signal.aborted) return cancelled();

      const admission = admitReport(request);
      if (!admission.ok) {
        return { ok: false, error: providerError(admission.code) } as const;
      }

      let state = this.#reports.get(admission.report.reportId);
      if (state !== undefined && !isDeepStrictEqual(state.report, admission.report)) {
        return {
          ok: false,
          error: providerError("report_identity_collision"),
        } as const;
      }
      if (state === undefined) {
        state = { report: admission.report, attempts: 0, delivered: false };
        this.#reports.set(admission.report.reportId, state);
      }
      if (state.delivered) return success(state.report);

      while (state.attempts < 2) {
        if (signal.aborted) return cancelled();
        state.attempts += 1;
        try {
          await this.#notify(structuredClone(state.report), signal);
          state.delivered = true;
          return success(state.report);
        } catch {
          if (signal.aborted) return cancelled();
        }
      }
      return {
        ok: false,
        error: providerError("notification_unavailable"),
      } as const;
    });
  }

  #serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#pending.then(operation, operation);
    this.#pending = result.then(() => undefined, () => undefined);
    return result;
  }
}

function admitReport(request: unknown): Admission {
  const copied = copyContractDataGraph(request);
  if (
    !copied.ok ||
    !isRecord(copied.value) ||
    Object.keys(copied.value).length !== 2 ||
    !Object.hasOwn(copied.value, "reportId") ||
    !Object.hasOwn(copied.value, "context")
  ) return { ok: false, code: "failure_context_invalid" };

  const candidate = copied.value;
  let reportId: FailureReport["reportId"];
  try {
    if (typeof candidate.reportId !== "string") throw new TypeError();
    reportId = generatedReportId(candidate.reportId);
  } catch {
    return { ok: false, code: "report_identity_source_invalid" };
  }

  try {
    if (
      !isRecord(candidate.context) ||
      !Object.hasOwn(candidate.context, "journeyId")
    ) throw new TypeError();
    const context = candidate.context;
    const contextKeys = Object.keys(context);
    const requiredKeys = [
      "journeyId",
      "component",
      "phase",
      "step",
      "code",
      "retryable",
      "source",
    ];
    if (
      contextKeys.length < requiredKeys.length ||
      contextKeys.length > requiredKeys.length + 1 ||
      requiredKeys.some((key) => !Object.hasOwn(context, key)) ||
      (contextKeys.length === requiredKeys.length + 1 &&
        !Object.hasOwn(context, "cause"))
    ) throw new TypeError();
    const { journeyId: rawJourneyId, ...observation } = context;
    if (typeof rawJourneyId !== "string") throw new TypeError();
    const parsedJourneyId = journeyId(rawJourneyId);
    const { schemaVersion: _, ...parsedObservation } = parseErrorEnvelope({
      schemaVersion: 2,
      ...observation,
    });
    return {
      ok: true,
      report: {
        reportId,
        context: {
          journeyId: parsedJourneyId,
          ...parsedObservation,
        } as FailureContext,
      },
    };
  } catch {
    return { ok: false, code: "failure_context_invalid" };
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function success(report: FailureReport) {
  return {
    ok: true,
    value: {
      report: structuredClone(report),
      notification: { reportId: report.reportId, delivered: true },
    },
  } as const;
}

function cancelled() {
  return { ok: false, error: providerError("operation_cancelled") } as const;
}
