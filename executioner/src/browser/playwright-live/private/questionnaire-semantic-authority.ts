import { disposeResumeArtifact, type ResolvedResumeArtifact } from "../../../contracts/index.ts";
import type {
  BrowserPageId,
  BrowserSession,
  BrowserSessionId,
  FieldDriver,
  FieldVerifier,
  OperationId,
} from "../../../contracts/index.ts";

export interface QuestionnaireSemanticAuthorityOptions {
  readonly sessionId: BrowserSessionId;
  readonly pageId: BrowserPageId;
  readonly createDriverBrowser: () => BrowserSession;
  readonly captureUploadArtifact?: () => ResolvedResumeArtifact;
  readonly verifierBrowser: BrowserSession;
  readonly createDriver: (browser: BrowserSession) => FieldDriver;
  readonly createVerifier: (browser: BrowserSession) => FieldVerifier;
  readonly prepare: (signal: AbortSignal) => Promise<void>;
  readonly driverRebindFailed?: (
    request: Parameters<FieldDriver["drive"]>[0],
    code: string,
  ) => void;
}

export function createQuestionnaireSemanticAuthority(
  options: QuestionnaireSemanticAuthorityOptions,
) {
  const ownedBrowsers = new Set<BrowserSession>([options.verifierBrowser]);
  let driverBrowser = options.createDriverBrowser();
  let driver = options.createDriver(driverBrowser);
  const verifier = options.createVerifier(options.verifierBrowser);
  let uncertainOperationId: OperationId | undefined;
  ownedBrowsers.add(driverBrowser);

  const authority = {
    observe(signal: AbortSignal) {
      return driverBrowser.observe({
        sessionId: options.sessionId,
        pageId: options.pageId,
      }, signal);
    },
    driver: Object.freeze<FieldDriver>({
      async drive(request, signal) {
        await options.prepare(signal);
        const rebound = await driverBrowser.observe({
          sessionId: options.sessionId,
          pageId: options.pageId,
        }, signal);
        if (!rebound.ok) {
          options.driverRebindFailed?.(request, rebound.error.code);
          return {
            ok: false as const,
            error: { code: "driver_target_invalid" as const, retryable: false as const },
          };
        }
        const artifact = request.intent.kind === "resume_upload"
          ? options.captureUploadArtifact?.() : undefined;
        try {
          if (artifact !== undefined && request.intent.kind === "resume_upload" &&
              (artifact.resumeId !== request.intent.artifact.resumeId || artifact.sha256 !== request.intent.artifact.sha256)) {
            throw new TypeError("questionnaire upload artifact identity changed");
          }
          const current = artifact !== undefined && request.intent.kind === "resume_upload"
            ? { ...request, intent: { ...request.intent, artifact } } : request;
          const result = await driver.drive(current, signal);
          uncertainOperationId = !result.ok && result.error.code === "browser_effect_uncertain"
            ? request.operationId
            : undefined;
          return result;
        } finally {
          if (artifact !== undefined) disposeResumeArtifact(artifact);
        }
      },
    }),
    verifier: Object.freeze<FieldVerifier>({
      async verify(request, signal) {
        await options.prepare(signal);
        const result = await verifier.verify(request, signal);
        if (
          result.ok && (result.value.kind === "verified" ||
            (request.intent.kind === "text" && result.value.kind === "rejected" &&
              result.value.reason === "mismatch")) &&
          uncertainOperationId === request.receipt.operationId
        ) {
          driverBrowser = options.createDriverBrowser();
          ownedBrowsers.add(driverBrowser);
          driver = options.createDriver(driverBrowser);
          uncertainOperationId = undefined;
        }
        return result;
      },
    }),
    async close(signal: AbortSignal): Promise<void> {
      for (const browser of ownedBrowsers) {
        await browser.close({ sessionId: options.sessionId }, signal);
      }
    },
  };
  return Object.freeze(authority);
}
