import {
  readStage2ExternalMonitorObservation,
  writeStage2ExternalMonitorAcknowledgement,
} from "../src/live/evidence/external-monitor-runtime.ts";
import { parseExternalMonitorAckArgs } from "../src/live/runner/operator-monitor-ack.ts";

try {
  const args = parseExternalMonitorAckArgs(process.argv.slice(2));
  const observation = readStage2ExternalMonitorObservation(
    args.runtimeRoot,
    args.observationPath,
  );
  writeStage2ExternalMonitorAcknowledgement({
    runtimeRoot: args.runtimeRoot,
    evidenceRoot: args.evidenceRoot,
    requestPath: args.monitorRequestPath,
    classification: args.classification,
    ...observation,
  });
  process.stdout.write(`${JSON.stringify({
    status: "acknowledged",
    classification: args.classification,
  })}\n`);
} catch {
  process.stdout.write('{"status":"failed","code":"monitor_acknowledgement_invalid"}\n');
  process.exitCode = 1;
}
