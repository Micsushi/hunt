import {
  createCredentialMutationAdapterFake,
  createLiveCheckpointStoreFake,
  createLiveEvidenceSinkFake,
  createMailboxProviderFake,
  createPersistentBrowserSessionFake,
  createPrivilegedGmailAuthExecutorFake,
  createPrivilegedVerificationNavigatorFake,
  createSecretStoreFake,
  createVerificationArtifactFake,
} from "./fakes.ts";
import type {
  LiveCall,
  LiveFake,
  LivePortMap,
  LivePortName,
} from "./types.ts";

export interface LiveProviderLease<N extends LivePortName> {
  readonly provider: LivePortMap[N];
  readonly calls: readonly LiveCall[];
  readonly cleaned: boolean;
  cleanup(): void | Promise<void>;
}

export interface LiveProviderFactory<N extends LivePortName> {
  readonly name: N;
  create(): LiveProviderLease<N>;
}

export function createLiveProviderFactory<N extends LivePortName>(
  name: N,
  createFake: () => LiveFake<LivePortMap[N]>,
): LiveProviderFactory<N> {
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
          cleaned = true;
        },
      };
    },
  });
}

export async function withLiveProvider<N extends LivePortName, T>(
  factory: LiveProviderFactory<N>,
  use: (
    provider: LivePortMap[N],
    lease: LiveProviderLease<N>,
  ) => T | Promise<T>,
): Promise<T> {
  const lease = factory.create();
  try {
    return await use(lease.provider, lease);
  } finally {
    await lease.cleanup();
  }
}

export const liveProviderFactories = {
  PersistentBrowserSession: createLiveProviderFactory(
    "PersistentBrowserSession",
    createPersistentBrowserSessionFake,
  ),
  SecretStore: createLiveProviderFactory("SecretStore", createSecretStoreFake),
  CredentialMutationAdapter: createLiveProviderFactory(
    "CredentialMutationAdapter",
    createCredentialMutationAdapterFake,
  ),
  PrivilegedGmailAuthExecutor: createLiveProviderFactory(
    "PrivilegedGmailAuthExecutor",
    createPrivilegedGmailAuthExecutorFake,
  ),
  MailboxProvider: createLiveProviderFactory(
    "MailboxProvider",
    createMailboxProviderFake,
  ),
  VerificationArtifact: createLiveProviderFactory(
    "VerificationArtifact",
    createVerificationArtifactFake,
  ),
  PrivilegedVerificationNavigator: createLiveProviderFactory(
    "PrivilegedVerificationNavigator",
    createPrivilegedVerificationNavigatorFake,
  ),
  LiveCheckpointStore: createLiveProviderFactory(
    "LiveCheckpointStore",
    createLiveCheckpointStoreFake,
  ),
  LiveEvidenceSink: createLiveProviderFactory(
    "LiveEvidenceSink",
    createLiveEvidenceSinkFake,
  ),
} as const satisfies {
  readonly [N in LivePortName]: LiveProviderFactory<N>;
};
