import {
  runControlSliceCompatibilityProbe,
  runFieldSliceCompatibilityProbe,
} from "./compatibility-probes.ts";
import {
  runAdmissionOneUseScenario,
  runBrowserInvalidationScenario,
  runEventEvidenceScenario,
  runJourneyControlScenario,
  runJourneyStateScenario,
  runMcpLifecycleScenario,
  runSafetyGuardScenario,
  statefulScenarioProviderFactories,
  type ContractScenarioReport,
} from "./scenarios.ts";

interface ContractScenarioRegistryEntry {
  readonly name: string;
  run(): Promise<ContractScenarioReport>;
}

export const contractScenarioRegistry: readonly ContractScenarioRegistryEntry[] = [
  {
    name: "browser-invalidation",
    run: () => runBrowserInvalidationScenario(statefulScenarioProviderFactories.BrowserSession),
  },
  {
    name: "journey-state-replay",
    run: () => runJourneyStateScenario(statefulScenarioProviderFactories.JourneyStateStore),
  },
  {
    name: "mcp-lifecycle",
    run: () => runMcpLifecycleScenario(statefulScenarioProviderFactories.McpJourneyApi),
  },
  {
    name: "journey-control-lifecycle",
    run: () => runJourneyControlScenario(statefulScenarioProviderFactories.JourneyControl),
  },
  {
    name: "event-evidence-idempotency",
    run: () => runEventEvidenceScenario(
      statefulScenarioProviderFactories.EventSink,
      statefulScenarioProviderFactories.EvidenceStore,
    ),
  },
  {
    name: "admission-one-use",
    run: () => runAdmissionOneUseScenario(statefulScenarioProviderFactories.PrivacyGuard),
  },
  {
    name: "safety-admission-one-use",
    run: () => runSafetyGuardScenario(statefulScenarioProviderFactories.SafetyGuard),
  },
  {
    name: "F2-F8-field-slice",
    run: async () => {
      const report = await runFieldSliceCompatibilityProbe();
      return { name: report.root, ports: report.ports, edges: report.edges };
    },
  },
  {
    name: "MCP-F9-F4-F10-F11-control-slice",
    run: async () => {
      const report = await runControlSliceCompatibilityProbe();
      return { name: report.root, ports: report.ports, edges: report.edges };
    },
  },
];

export async function executeContractScenarioRegistry(): Promise<readonly ContractScenarioReport[]> {
  const results: ContractScenarioReport[] = [];
  for (const entry of contractScenarioRegistry) {
    const result = await entry.run();
    if (result.name !== entry.name) {
      throw new TypeError(`${entry.name} returned mismatched execution evidence`);
    }
    results.push(result);
  }
  return results;
}
