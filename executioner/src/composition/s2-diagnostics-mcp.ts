import type {
  OperationId,
  OperationIdentityError,
  PortResult,
} from "../contracts/index.ts";
import { createStage2DiagnosticsMcpFacade } from "../control/mcp/stage2-diagnostics.ts";
import { readAccountAccessDiagnostics } from "../live/evidence/account-access-diagnostics.ts";

export interface Stage2DiagnosticsMcpOptions {
  readonly evidenceRoot: string;
  readonly nextOperationId: () => PortResult<OperationId, OperationIdentityError>;
}

export function createStage2DiagnosticsMcpFromEvidenceRoot(
  options: Stage2DiagnosticsMcpOptions,
) {
  return createStage2DiagnosticsMcpFacade({
    nextOperationId: options.nextOperationId,
    readback: {
      read() {
        const diagnostics = readAccountAccessDiagnostics(options.evidenceRoot);
        return {
          journeyId: diagnostics.journeyId,
          status: diagnostics.status,
          completedSteps: diagnostics.completedSteps,
          terminal: diagnostics.terminal,
        };
      },
    },
  });
}
