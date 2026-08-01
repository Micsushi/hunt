import type {
  BrowserReadback,
  BrowserSession,
  FieldIntent,
  FieldVerifier,
  VerificationRequest,
  VerificationResult,
} from "../../contracts/index.ts";

const cancelled = {
  ok: false,
  error: { code: "operation_cancelled", retryable: false },
} as const;

function normalizeScalar(value: string): string {
  return value.normalize("NFC").trim();
}

function normalizeOption(value: string): string {
  return normalizeScalar(value).replace(/\s+/gu, " ");
}

function normalizeTextarea(value: string): string {
  return value.normalize("NFC").replace(/\r\n?/gu, "\n");
}

function matches(intent: FieldIntent, readback: BrowserReadback): boolean {
  switch (intent.kind) {
    case "text":
      return (
        readback.kind === "text" &&
        (intent.behavior === "textarea"
          ? normalizeTextarea(readback.value) ===
            normalizeTextarea(intent.value)
          : normalizeScalar(readback.value) ===
            normalizeScalar(intent.value))
      );
    case "choice":
      return (
        readback.kind === "selected" &&
        readback.option !== null &&
        normalizeOption(readback.option) ===
          normalizeOption(intent.expectedOption)
      );
    case "toggle":
      return (
        readback.kind === "checked" &&
        readback.checked === intent.checked
      );
    case "date":
      return (
        readback.kind === "text" &&
        normalizeScalar(readback.value) === intent.isoDate
      );
    case "resume_upload":
      return (
        readback.kind === "upload" &&
        readback.resumeId === intent.artifact.resumeId &&
        readback.sha256 === intent.artifact.sha256
      );
  }
}

function validRequest(request: VerificationRequest): boolean {
  return (
    request.sessionId !== "" &&
    request.pageId !== "" &&
    request.intent.fieldId !== "" &&
    request.intent.target !== "" &&
    request.receipt.operationId !== "" &&
    request.receipt.fieldId === request.intent.fieldId &&
    request.receipt.behavior === request.intent.behavior
  );
}

export function createFieldVerifier(
  browser: BrowserSession,
  options: { readonly maxAttempts?: number } = {},
): FieldVerifier {
  const maxAttempts = options.maxAttempts ?? 3;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError("maxAttempts must be a positive integer");
  }

  return {
    async verify(request, signal) {
      if (signal.aborted) {
        return cancelled;
      }
      if (!validRequest(request)) {
        return {
          ok: false,
          error: {
            code: "verification_input_invalid",
            retryable: false,
          },
        };
      }

      let last: VerificationResult = {
        kind: "unavailable",
        fieldId: request.intent.fieldId,
      };
      let timedOut = false;
      let observed = false;

      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        if (signal.aborted) {
          return cancelled;
        }

        const result = await browser.observe(
          {
            sessionId: request.sessionId,
            pageId: request.pageId,
          },
          signal,
        );
        if (signal.aborted) {
          return cancelled;
        }
        if (!result.ok) {
          if (result.error.code === "browser_timeout") {
            timedOut = true;
            continue;
          }
          return result;
        }
        observed = true;

        if (
          result.value.sessionId !== request.sessionId ||
          result.value.pageId !== request.pageId
        ) {
          return {
            ok: true,
            value: {
              kind: "rejected",
              fieldId: request.intent.fieldId,
              reason: "stale",
            },
          };
        }

        const targets = result.value.targets.filter(
          ({ token }) => token === request.intent.target,
        );
        if (targets.length > 1) {
          return {
            ok: true,
            value: {
              kind: "ambiguous",
              fieldId: request.intent.fieldId,
            },
          };
        }

        const target = targets[0];
        if (target === undefined) {
          continue;
        }
        if (target.state.visibility === "hidden") {
          return {
            ok: true,
            value: {
              kind: "rejected",
              fieldId: request.intent.fieldId,
              reason: "stale",
            },
          };
        }
        if (target.readback.kind === "unavailable") {
          continue;
        }
        if (matches(request.intent, target.readback)) {
          return {
            ok: true,
            value: {
              kind: "verified",
              fieldId: request.intent.fieldId,
            },
          };
        }
        last = {
          kind: "rejected",
          fieldId: request.intent.fieldId,
          reason: "mismatch",
        };
      }

      return timedOut && !observed
        ? {
            ok: false,
            error: {
              code: "verification_timeout",
              retryable: true,
            },
          }
        : { ok: true, value: last };
    },
  };
}
