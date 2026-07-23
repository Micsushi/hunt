export class C3RunGuardError extends Error {
  constructor(code, action = "") {
    super(action ? `${code}:${action}` : code);
    this.name = "C3RunGuardError";
    this.code = code;
    this.action = action;
  }
}

export function createRunGuard({
  operationId = "",
  fillRunId = "",
  signal = null,
  isCurrent = () => true,
  heartbeat = () => {},
} = {}) {
  function assertCurrent(action = "") {
    if (signal?.aborted) {
      const reason =
        typeof signal.reason === "string" && signal.reason
          ? signal.reason
          : "operation_cancelled";
      throw new C3RunGuardError(reason, action);
    }
    if (!isCurrent(operationId, fillRunId)) {
      throw new C3RunGuardError("stale_run", action);
    }
    return true;
  }

  return {
    operationId,
    fillRunId,
    assertCurrent,
    beforeMutation(action = "dom_mutation") {
      assertCurrent(action);
      heartbeat({ pendingAction: action });
      return true;
    },
    afterWait(action = "wait") {
      return assertCurrent(action);
    },
  };
}
