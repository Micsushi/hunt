import {
  journeyId,
  mcpRequestId,
  type JourneyId,
  type McpRequestId,
} from "../../contracts/index.ts";

export interface Stage2AuditMcpRequestIds {
  readonly status: McpRequestId;
  readonly result: McpRequestId;
}

export function stage2AuditMcpRequestIds(
  value: JourneyId,
): Stage2AuditMcpRequestIds {
  const admitted = journeyId(value);
  const suffix = admitted.slice("journey_".length);
  return Object.freeze({
    status: mcpRequestId(`audit-${suffix}-status`),
    result: mcpRequestId(`audit-${suffix}-result`),
  });
}
