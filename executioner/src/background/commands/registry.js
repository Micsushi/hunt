export const C3_COMMANDS = Object.freeze({
  detectPage: "c3.detect_page",
  fillPage: "c3.fill_page",
  fillRemainingWithLlm: "c3.fill_remaining_with_llm",
  pageWalk: "c3.page_walk",
  clickNextAfterFill: "c3.click_next_after_fill",
  clearPage: "c3.clear_page",
  cancelSession: "c3.cancel_session",
  getProgress: "c3.get_progress",
  snapshotPage: "c3.snapshot_page",
  inspectFields: "c3.inspect_fields",
  inspectValidation: "c3.inspect_validation",
});

export const C3_COMMAND_REGISTRY = Object.freeze({
  [C3_COMMANDS.detectPage]: {
    name: C3_COMMANDS.detectPage,
    mutatesPage: false,
    summary: "Detect the active apply page state.",
  },
  [C3_COMMANDS.fillPage]: {
    name: C3_COMMANDS.fillPage,
    mutatesPage: true,
    summary: "Fill the current apply page.",
  },
  [C3_COMMANDS.fillRemainingWithLlm]: {
    name: C3_COMMANDS.fillRemainingWithLlm,
    mutatesPage: true,
    summary: "Fill remaining fields using generated answers.",
  },
  [C3_COMMANDS.pageWalk]: {
    name: C3_COMMANDS.pageWalk,
    mutatesPage: true,
    summary: "Continue filling subsequent apply pages.",
  },
  [C3_COMMANDS.clickNextAfterFill]: {
    name: C3_COMMANDS.clickNextAfterFill,
    mutatesPage: true,
    summary: "Click the safe next action after a fill.",
  },
  [C3_COMMANDS.clearPage]: {
    name: C3_COMMANDS.clearPage,
    mutatesPage: true,
    summary: "Clear fields on the current apply page.",
  },
  [C3_COMMANDS.cancelSession]: {
    name: C3_COMMANDS.cancelSession,
    mutatesPage: true,
    summary: "Cancel the current C3 session action.",
  },
  [C3_COMMANDS.getProgress]: {
    name: C3_COMMANDS.getProgress,
    mutatesPage: false,
    summary: "Read current C3 fill progress.",
  },
  [C3_COMMANDS.snapshotPage]: {
    name: C3_COMMANDS.snapshotPage,
    mutatesPage: false,
    summary: "Capture a sanitized page snapshot.",
  },
  [C3_COMMANDS.inspectFields]: {
    name: C3_COMMANDS.inspectFields,
    mutatesPage: false,
    summary: "Inspect visible fields.",
  },
  [C3_COMMANDS.inspectValidation]: {
    name: C3_COMMANDS.inspectValidation,
    mutatesPage: false,
    summary: "Inspect visible validation state.",
  },
});

export function getC3Command(commandName) {
  return C3_COMMAND_REGISTRY[commandName] || null;
}

export function assertKnownC3Command(commandName) {
  const command = getC3Command(commandName);
  if (!command) {
    throw new Error(`Unknown C3 command: ${commandName}`);
  }
  return command;
}
