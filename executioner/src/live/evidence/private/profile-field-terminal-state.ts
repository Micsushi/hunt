export function advanceProfileFieldTerminalState<
  TPersistent extends string,
  TTerminal extends string,
>(input: {
  readonly mutationExpected: boolean;
  readonly readbackMatches: boolean;
  readonly driverAttempted: boolean;
  readonly answered: boolean;
  readonly prefillAlreadyCorrect: boolean;
  readonly persistentReadback: TPersistent;
  readonly terminalDisposition: TTerminal;
}): {
  readonly persistentReadback:
    | TPersistent
    | "verified_after_rescan"
    | "unverified_after_rescan";
  readonly terminalDisposition:
    | TTerminal
    | "verified"
    | "verified_without_mutation"
    | "verification_failed";
  readonly mutationVerified: boolean;
} {
  if (input.mutationExpected) {
    return input.readbackMatches
      ? {
          persistentReadback: "verified_after_rescan",
          terminalDisposition: "verified",
          mutationVerified: true,
        }
      : {
          persistentReadback: "unverified_after_rescan",
          terminalDisposition: "verification_failed",
          mutationVerified: false,
        };
  }
  if (!input.driverAttempted && input.answered && input.prefillAlreadyCorrect) {
    return {
      persistentReadback: input.persistentReadback,
      terminalDisposition: "verified_without_mutation",
      mutationVerified: false,
    };
  }
  return {
    persistentReadback: input.persistentReadback,
    terminalDisposition: input.terminalDisposition,
    mutationVerified: false,
  };
}
