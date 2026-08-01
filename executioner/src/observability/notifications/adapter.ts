import type { FailureReport } from "../../contracts/index.ts";

export type NotificationAdapter = (
  report: FailureReport,
  signal: AbortSignal,
) => Promise<void>;

export const acknowledgeNotification: NotificationAdapter = async () => {};
