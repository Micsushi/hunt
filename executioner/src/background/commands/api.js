import { buildC3CommandContext } from "./context.js";
import { dispatchC3Command } from "./dispatcher.js";

export async function runC3Command({
  commandName,
  state = {},
  payload = {},
  sender = {},
  actor = null,
  handler,
} = {}) {
  const commandContext = buildC3CommandContext({
    commandName,
    payload,
    sender,
    state,
    actor,
  });
  return dispatchC3Command({
    commandName,
    settings: state.settings || {},
    context: commandContext,
    payload,
    handler,
  });
}
