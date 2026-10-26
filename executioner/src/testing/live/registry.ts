import { livePortNames } from "../../contracts/live/index.ts";
import {
  runCheckpointRestart,
  runCredentialMutationIdempotency,
  runEvidenceCleanupIdempotency,
  runGmailAuthCancellation,
  runMailboxFactualPreservation,
  runPersistentBrowserLifecycle,
  runSecretHandleScope,
  runVerificationArtifactSingleUse,
  runVerificationNavigationIdempotency,
  type LiveScenarioExecution,
} from "./scenarios.ts";
import type { LiveCall, LivePortName, LiveScenarioReport } from "./types.ts";

interface LiveScenarioRegistryEntry {
  readonly name: string;
  readonly port: LivePortName;
  readonly skip: false;
  run(): Promise<LiveScenarioExecution>;
  inspectCalls(): readonly LiveCall[];
}

function entry(
  name: string,
  port: LivePortName,
  run: () => Promise<LiveScenarioExecution>,
): LiveScenarioRegistryEntry {
  let calls: readonly LiveCall[] = [];
  return {
    name,
    port,
    skip: false,
    run: async () => {
      const result = await run();
      calls = result.calls;
      return result;
    },
    inspectCalls: () => calls,
  };
}

export const liveScenarioRegistry = [
  entry("persistent-browser-lifecycle", "PersistentBrowserSession", runPersistentBrowserLifecycle),
  entry("secret-handle-scope", "SecretStore", runSecretHandleScope),
  entry("credential-mutation-idempotency", "CredentialMutationAdapter", runCredentialMutationIdempotency),
  entry("gmail-auth-cancellation", "PrivilegedGmailAuthExecutor", runGmailAuthCancellation),
  entry("mailbox-factual-preservation", "MailboxProvider", runMailboxFactualPreservation),
  entry("verification-artifact-single-use", "VerificationArtifact", runVerificationArtifactSingleUse),
  entry("verification-navigation-idempotency", "PrivilegedVerificationNavigator", runVerificationNavigationIdempotency),
  entry("checkpoint-restart", "LiveCheckpointStore", runCheckpointRestart),
  entry("evidence-cleanup-idempotency", "LiveEvidenceSink", runEvidenceCleanupIdempotency),
] as const satisfies readonly LiveScenarioRegistryEntry[];

if (liveScenarioRegistry.some(({ port }, index) => port !== livePortNames[index])) {
  throw new TypeError("live scenario registry must follow the frozen port order");
}

export async function executeLiveScenarioRegistry(): Promise<
  readonly LiveScenarioReport[]
> {
  const reports: LiveScenarioReport[] = [];
  for (const scenario of liveScenarioRegistry) {
    const execution = await scenario.run();
    if (
      execution.report.name !== scenario.name ||
      execution.report.ports.length !== 1 ||
      execution.report.ports[0] !== scenario.port
    ) {
      throw new TypeError(`${scenario.name} returned mismatched execution evidence`);
    }
    reports.push(execution.report);
  }
  return reports;
}
