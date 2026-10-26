import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

let linuxClockTicks: number | undefined;

export function readProcessStartTime(pid: number): string {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("process identity denied");
  if (process.platform === "linux") return linuxProcessStartTime(pid);
  if (process.platform !== "win32") throw new Error("process identity denied");
  const script = `$p=Get-Process -Id ${pid} -ErrorAction Stop; $p.StartTime.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'")`;
  for (const timeout of [5_000, 15_000]) {
    try {
      return execFileSync("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script,
      ], { encoding: "utf8", windowsHide: true, timeout, stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch (error) {
      // A timed-out Windows probe is not evidence that the process exited.
      // Retry once, but still require a fresh exact start-time comparison.
      if (timeout !== 5_000 || !(error instanceof Error) ||
          !("code" in error) || error.code !== "ETIMEDOUT") throw error;
    }
  }
  throw new Error("process identity denied");
}

function linuxProcessStartTime(pid: number): string {
  try {
    if (linuxClockTicks === undefined) {
      const value = execFileSync("/usr/bin/getconf", ["CLK_TCK"], {
        encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      const ticks = Number(value);
      // The timestamp contract has millisecond precision; never collapse distinct ticks.
      if (!/^\d+$/u.test(value) || !Number.isSafeInteger(ticks) || ticks < 1 || 1_000 % ticks !== 0) {
        throw new Error("unsupported clock precision");
      }
      linuxClockTicks = ticks;
    }
    const startTicks = linuxStartTicks(pid);
    const boot = /^btime (\d+)$/mu.exec(readFileSync("/proc/stat", "utf8"))?.[1];
    const bootSeconds = Number(boot);
    const startedAt = bootSeconds * 1_000 + startTicks * (1_000 / linuxClockTicks);
    if (!Number.isSafeInteger(bootSeconds) || bootSeconds < 1 || !Number.isSafeInteger(startedAt) ||
        linuxStartTicks(pid) !== startTicks) throw new Error("unstable process identity");
    return new Date(startedAt).toISOString();
  } catch {
    throw new Error("process identity denied");
  }
}

function linuxStartTicks(pid: number): number {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  // comm is parenthesized and may itself contain spaces, newlines, or parentheses.
  const end = stat.lastIndexOf(") ");
  const fields = stat.slice(end + 2).trim().split(/\s+/u);
  const ticks = Number(fields[19]); // proc_pid_stat field 22; fields starts at state (field 3).
  if (!stat.startsWith(`${pid} (`) || end < 0 || !/^[RSDTtWKPI]$/u.test(fields[0] ?? "") ||
      !/^\d+$/u.test(fields[19] ?? "") || !Number.isSafeInteger(ticks) || ticks < 0) {
    throw new Error("invalid process identity");
  }
  return ticks;
}
