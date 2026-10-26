import { execFileSync } from "node:child_process";

export function readProcessStartTime(pid: number): string {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("process identity denied");
  if (process.platform !== "win32") {
    if (pid !== process.pid) throw new Error("process identity denied");
    return new Date(Date.now() - process.uptime() * 1_000).toISOString();
  }
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
