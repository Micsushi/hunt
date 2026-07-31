import type { ContractPortMap, ContractPortName } from "./types.ts";
import {
  createAnswerResolverFake,
  createBrowserSessionFake,
  createCompletionNavigationFake,
  createEvidenceStoreFake,
  createEventSinkFake,
  createFailureReporterFake,
  createFieldDriverFake,
  createFieldVerifierFake,
  createFixtureRuntimeFake,
  createJourneyControlFake,
  createJourneyIntakeFake,
  createJourneyStateStoreFake,
  createMcpJourneyApiFake,
  createPageUnderstandingFake,
  createPrivacyGuardFake,
  createProfileQueryFake,
  createProgressReaderFake,
  createSafetyGuardFake,
} from "./fakes.ts";
import type { ContractCall, ContractFake } from "./types.ts";

export interface ContractProviderLease<N extends ContractPortName> {
  readonly provider: ContractPortMap[N];
  readonly calls: readonly ContractCall[];
  readonly cleaned: boolean;
  cleanup(): void | Promise<void>;
}

export interface ContractProviderFactory<N extends ContractPortName> {
  readonly name: N;
  create(): ContractProviderLease<N>;
}

export function createContractProviderFactory<N extends ContractPortName>(
  name: N,
  createFake: () => ContractFake<ContractPortMap[N]>,
): ContractProviderFactory<N> {
  return Object.freeze({
    name,
    create: () => {
      const fake = createFake();
      let cleaned = false;
      return {
        provider: fake.port,
        calls: fake.calls,
        get cleaned() {
          return cleaned;
        },
        cleanup: () => {
          if (cleaned) return;
          cleaned = true;
        },
      };
    },
  });
}

export async function withContractProvider<
  N extends ContractPortName,
  T,
>(
  providerFactory: ContractProviderFactory<N>,
  use: (provider: ContractPortMap[N], lease: ContractProviderLease<N>) => T | Promise<T>,
): Promise<T> {
  const lease = providerFactory.create();
  try {
    return await use(lease.provider, lease);
  } finally {
    await lease.cleanup();
  }
}

export const contractProviderFactories = {
  FixtureRuntime: createContractProviderFactory("FixtureRuntime", createFixtureRuntimeFake),
  BrowserSession: createContractProviderFactory("BrowserSession", createBrowserSessionFake),
  JourneyIntake: createContractProviderFactory("JourneyIntake", createJourneyIntakeFake),
  ProfileQuery: createContractProviderFactory("ProfileQuery", createProfileQueryFake),
  JourneyStateStore: createContractProviderFactory("JourneyStateStore", createJourneyStateStoreFake),
  PageUnderstanding: createContractProviderFactory("PageUnderstanding", createPageUnderstandingFake),
  AnswerResolver: createContractProviderFactory("AnswerResolver", createAnswerResolverFake),
  FieldDriver: createContractProviderFactory("FieldDriver", createFieldDriverFake),
  FieldVerifier: createContractProviderFactory("FieldVerifier", createFieldVerifierFake),
  CompletionNavigation: createContractProviderFactory("CompletionNavigation", createCompletionNavigationFake),
  JourneyControl: createContractProviderFactory("JourneyControl", createJourneyControlFake),
  McpJourneyApi: createContractProviderFactory("McpJourneyApi", createMcpJourneyApiFake),
  EventSink: createContractProviderFactory("EventSink", createEventSinkFake),
  ProgressReader: createContractProviderFactory("ProgressReader", createProgressReaderFake),
  FailureReporter: createContractProviderFactory("FailureReporter", createFailureReporterFake),
  PrivacyGuard: createContractProviderFactory("PrivacyGuard", createPrivacyGuardFake),
  SafetyGuard: createContractProviderFactory("SafetyGuard", createSafetyGuardFake),
  EvidenceStore: createContractProviderFactory("EvidenceStore", createEvidenceStoreFake),
} as const satisfies {
  readonly [N in ContractPortName]: ContractProviderFactory<N>;
};
