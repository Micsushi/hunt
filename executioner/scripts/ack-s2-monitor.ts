import { writeOperatorMonitorAcknowledgement } from "../src/live/evidence/operator-monitor-ack.ts";
import { parseOperatorMonitorAckArgs } from "../src/live/runner/operator-monitor-ack.ts";

try {
  const args = parseOperatorMonitorAckArgs(process.argv.slice(2));
  const acknowledgement = writeOperatorMonitorAcknowledgement({
    root: args.evidenceRoot,
    monitorRequestPath: args.monitorRequestPath,
    classification: args.classification,
  });
  process.stdout.write(`${JSON.stringify({
    status: acknowledgement.status,
    journeyId: acknowledgement.journeyId,
    targetHandleId: acknowledgement.targetHandleId,
    monitorRequestSha256: acknowledgement.monitorRequestSha256,
    classification: acknowledgement.classification,
    screenshotSha256: acknowledgement.screenshotSha256,
  })}\n`);
} catch {
  process.stdout.write('{"status":"failed","code":"monitor_acknowledgement_invalid"}\n');
  process.exitCode = 1;
}
