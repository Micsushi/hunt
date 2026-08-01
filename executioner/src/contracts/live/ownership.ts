import type { S2CommonComponentId } from "../s2-common-wire.ts";
import { livePortNames } from "./ports.ts";

type LivePortName = (typeof livePortNames)[number];

interface LivePortOwnership {
  readonly port: LivePortName;
  readonly owner: S2CommonComponentId;
  readonly consumers: readonly string[];
  readonly privilegedValueConsumers: readonly (
    | "CredentialMutationAdapter"
    | "PrivilegedGmailAuthExecutor"
  )[];
}

export const livePortOwnership = [
  {
    port: "PersistentBrowserSession",
    owner: "F3",
    consumers: ["F9 live coordinator"],
    privilegedValueConsumers: [],
  },
  {
    port: "SecretStore",
    owner: "S2_SECRET_STORE",
    consumers: ["S2 preflight", "secret custodian"],
    privilegedValueConsumers: [
      "CredentialMutationAdapter",
      "PrivilegedGmailAuthExecutor",
    ],
  },
  {
    port: "CredentialMutationAdapter",
    owner: "S2_CREDENTIAL_MUTATION",
    consumers: ["account entry handler"],
    privilegedValueConsumers: [],
  },
  {
    port: "PrivilegedGmailAuthExecutor",
    owner: "S2_GMAIL_AUTH",
    consumers: ["Gmail mailbox provider"],
    privilegedValueConsumers: [],
  },
  {
    port: "MailboxProvider",
    owner: "S2_MAILBOX_PROVIDER",
    consumers: ["account lifecycle", "F9 live coordinator"],
    privilegedValueConsumers: [],
  },
  {
    port: "VerificationArtifact",
    owner: "S2_MAILBOX_PROVIDER",
    consumers: ["account lifecycle", "privileged verification navigator"],
    privilegedValueConsumers: [],
  },
  {
    port: "PrivilegedVerificationNavigator",
    owner: "S2_VERIFICATION_NAVIGATOR",
    consumers: ["account lifecycle"],
    privilegedValueConsumers: [],
  },
  {
    port: "LiveCheckpointStore",
    owner: "S2_RECOVERY_CHECKPOINT",
    consumers: ["F9 live coordinator"],
    privilegedValueConsumers: [],
  },
  {
    port: "LiveEvidenceSink",
    owner: "F11",
    consumers: ["F9 live coordinator"],
    privilegedValueConsumers: [],
  },
] as const satisfies readonly LivePortOwnership[];
