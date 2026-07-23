const DEFAULT_PROGRESS = Object.freeze({
  phase: "preparing",
  substep: "",
  fieldKey: "",
  fieldLabel: "",
  fieldKind: "",
  attempt: 0,
  pendingAction: "",
  popupOwner: "",
});

function copySnapshot(value) {
  return value ? { ...value } : null;
}

export function createOperationStateStore({
  now = () => Date.now(),
  maxRetainedOperations = 100,
  terminalRetentionMs = 5 * 60 * 1000,
} = {}) {
  const byTab = new Map();
  const byOperation = new Map();
  const terminalOperationKeys = [];
  const terminalOperationKeySet = new Set();
  const configuredRetentionLimit = Number(maxRetainedOperations);
  const retentionLimit = Math.max(
    1,
    Number.isFinite(configuredRetentionLimit) ? configuredRetentionLimit : 100,
  );
  const configuredRetentionMs = Number(terminalRetentionMs);
  const retentionMs = Math.max(
    1,
    Number.isFinite(configuredRetentionMs)
      ? configuredRetentionMs
      : 5 * 60 * 1000,
  );

  function operationKey(tabId, operationId, fillRunId) {
    return `${String(tabId)}\u0000${String(operationId || "")}\u0000${String(fillRunId || "")}`;
  }

  function exactState(tabId, operationId, fillRunId) {
    return byOperation.get(operationKey(tabId, operationId, fillRunId)) || null;
  }

  function matches(current, operationId, fillRunId) {
    return Boolean(
      current &&
      current.operationId === String(operationId || "") &&
      current.fillRunId === String(fillRunId || ""),
    );
  }

  function staleResult(current) {
    return {
      ok: false,
      reason: "stale_run",
      operationId: current?.operationId || "",
      fillRunId: current?.fillRunId || "",
    };
  }

  function forgetTerminalKey(key) {
    if (!terminalOperationKeySet.delete(key)) {
      return;
    }
    const index = terminalOperationKeys.indexOf(key);
    if (index >= 0) {
      terminalOperationKeys.splice(index, 1);
    }
  }

  function retainTerminalState(key) {
    forgetTerminalKey(key);
    terminalOperationKeys.push(key);
    terminalOperationKeySet.add(key);
    while (terminalOperationKeys.length > retentionLimit) {
      const expiredKey = terminalOperationKeys.shift();
      terminalOperationKeySet.delete(expiredKey);
      byOperation.delete(expiredKey);
    }
  }

  function pruneExpiredTerminalStates(timestamp = Number(now())) {
    while (terminalOperationKeys.length) {
      const key = terminalOperationKeys[0];
      const state = byOperation.get(key);
      if (
        state &&
        timestamp - Number(state.completedAt || state.updatedAt || 0) <
          retentionMs
      ) {
        break;
      }
      terminalOperationKeys.shift();
      terminalOperationKeySet.delete(key);
      byOperation.delete(key);
      if (state && byTab.get(state.tabId) === state) {
        byTab.delete(state.tabId);
      }
    }
  }

  return {
    start(input = {}) {
      const timestamp = Number(now());
      pruneExpiredTerminalStates(timestamp);
      const state = {
        active: true,
        tabId: input.tabId,
        operationId: String(input.operationId || ""),
        fillRunId: String(input.fillRunId || ""),
        command: String(input.command || input.commandName || ""),
        ...DEFAULT_PROGRESS,
        ...input,
        heartbeatSeq: 1,
        progressSeq: 1,
        startedAt: timestamp,
        lastHeartbeatAt: timestamp,
        lastProgressAt: timestamp,
        updatedAt: timestamp,
        cancelRequested: false,
        cancelRequestedAt: null,
        cancelAcknowledgedAt: null,
        cancelReason: "",
      };
      byTab.set(input.tabId, state);
      const key = operationKey(input.tabId, state.operationId, state.fillRunId);
      forgetTerminalKey(key);
      byOperation.set(key, state);
      return copySnapshot(state);
    },

    isCurrent(tabId, operationId, fillRunId) {
      pruneExpiredTerminalStates();
      const current = byTab.get(tabId);
      return Boolean(
        matches(current, operationId, fillRunId) &&
        current.active &&
        !current.cancelRequested,
      );
    },

    heartbeat(tabId, operationId, fillRunId, patch = {}) {
      const current = byTab.get(tabId);
      if (!matches(current, operationId, fillRunId)) {
        return staleResult(current);
      }
      const timestamp = Number(now());
      Object.assign(current, patch, {
        heartbeatSeq: Number(current.heartbeatSeq || 0) + 1,
        lastHeartbeatAt: timestamp,
        updatedAt: timestamp,
      });
      return { ok: true, snapshot: copySnapshot(current) };
    },

    progress(tabId, operationId, fillRunId, patch = {}) {
      const current = byTab.get(tabId);
      if (!matches(current, operationId, fillRunId)) {
        return staleResult(current);
      }
      const timestamp = Number(now());
      Object.assign(current, patch, {
        progressSeq: Number(current.progressSeq || 0) + 1,
        lastHeartbeatAt: timestamp,
        lastProgressAt: timestamp,
        updatedAt: timestamp,
      });
      return { ok: true, snapshot: copySnapshot(current) };
    },

    requestCancel(tabId, operationId, fillRunId, reason = "agent_cancel") {
      const current = exactState(tabId, operationId, fillRunId);
      if (!current) {
        return staleResult(byTab.get(tabId));
      }
      const timestamp = Number(now());
      current.cancelRequested = true;
      current.cancelRequestedAt = timestamp;
      current.cancelReason = String(reason || "agent_cancel");
      current.updatedAt = timestamp;
      return { ok: true, snapshot: copySnapshot(current) };
    },

    acknowledgeCancel(tabId, operationId, fillRunId) {
      const current = exactState(tabId, operationId, fillRunId);
      if (!current) {
        return staleResult(byTab.get(tabId));
      }
      const timestamp = Number(now());
      current.cancelRequested = true;
      current.cancelAcknowledgedAt = timestamp;
      current.active = false;
      current.updatedAt = timestamp;
      return { ok: true, snapshot: copySnapshot(current) };
    },

    complete(tabId, operationId, fillRunId, patch = {}) {
      const current = exactState(tabId, operationId, fillRunId);
      if (!current) {
        return staleResult(byTab.get(tabId));
      }
      const timestamp = Number(now());
      Object.assign(current, patch, {
        active: false,
        completedAt: timestamp,
        updatedAt: timestamp,
      });
      retainTerminalState(operationKey(tabId, operationId, fillRunId));
      return { ok: true, snapshot: copySnapshot(current) };
    },

    snapshot(tabId) {
      pruneExpiredTerminalStates();
      return copySnapshot(byTab.get(tabId));
    },

    snapshotOperation(tabId, operationId, fillRunId) {
      pruneExpiredTerminalStates();
      return copySnapshot(exactState(tabId, operationId, fillRunId));
    },

    retainedOperationCount() {
      pruneExpiredTerminalStates();
      return byOperation.size;
    },

    clear(tabId, operationId = "", fillRunId = "") {
      const current = byTab.get(tabId);
      if (!current) {
        return { ok: true, cleared: false };
      }
      if (
        (operationId || fillRunId) &&
        !matches(current, operationId, fillRunId)
      ) {
        const exact = exactState(tabId, operationId, fillRunId);
        if (!exact) {
          return staleResult(current);
        }
        const key = operationKey(tabId, operationId, fillRunId);
        byOperation.delete(key);
        forgetTerminalKey(key);
        return { ok: true, cleared: true };
      }
      byTab.delete(tabId);
      const key = operationKey(tabId, current.operationId, current.fillRunId);
      byOperation.delete(key);
      forgetTerminalKey(key);
      return { ok: true, cleared: true };
    },
  };
}
