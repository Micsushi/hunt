import { runStage2ExternalMonitorObserver } from
  "../src/live/evidence/external-monitor-observer.ts";

try {
  await runStage2ExternalMonitorObserver(process.argv.slice(2));
} catch {
  process.exitCode = 1;
}
