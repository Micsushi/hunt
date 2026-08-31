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
        const result = await driver.drive(request, signal);
        uncertainOperationId = !result.ok && result.error.code === "browser_effect_uncertain"
          ? request.operationId
          : undefined;
        return result;
      },
    }),
    verifier: Object.freeze<FieldVerifier>({
      async verify(request, signal) {
        await options.prepare(signal);
        const result = await verifier.verify(request, signal);
        if (
          result.ok && result.value.kind === "verified" &&
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
