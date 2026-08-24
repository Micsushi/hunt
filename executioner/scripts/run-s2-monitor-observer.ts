import {
  externalMonitorObserverFailureDiagnostic,
  externalMonitorObserverFailureCode,
  runStage2ExternalMonitorObserver,
} from
  "../src/live/evidence/external-monitor-observer.ts";

try {
  await runStage2ExternalMonitorObserver(process.argv.slice(2));
} catch (error) {
  const failureCode = externalMonitorObserverFailureCode(error);
  if (failureCode !== undefined) {
    const diagnostic = externalMonitorObserverFailureDiagnostic(error);
    process.stderr.write(`${JSON.stringify({
      status: "failed",
      component: "external_monitor_observer",
      failureCode,
      ...(diagnostic ?? {}),
    })}\n`);
  }
  process.exitCode = 1;
}
