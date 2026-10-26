import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { availableParallelism, freemem, tmpdir, totalmem } from "node:os";
import { join } from "node:path";

// Bounded hosted-runner diagnosis; this does not replace the complete C3 gate.
console.log(JSON.stringify({ node: process.version, uv: process.versions.uv,
  parallelism: availableParallelism(), freeMemory: freemem(), totalMemory: totalmem() }));
const source = readFileSync("src/secrets/windows-dpapi/private/interactive-gmail-oauth-sealer.ts", "utf8");
const csharp = /\$source = @'\r?\n([\s\S]*?)\r?\n'@/u.exec(source)?.[1];
if (!csharp) throw new Error("Missing full helper source");
const root = realpathSync.native(mkdtempSync(join(tmpdir(), "hunt-ci-native-")));
const helper = join(root, "helper.cs");
writeFileSync(helper, csharp);
const script = "$ErrorActionPreference='Stop'; [Console]::WriteLine([IO.Path]::GetTempPath()); Add-Type -Path $env:HUNT_TEST_SOURCE -ReferencedAssemblies 'System.Security.dll','System.Web.dll','System.Web.Extensions.dll'; if($null -eq [HuntInteractiveGmailOAuthSealer].GetMethod('FrameBundle',[Reflection.BindingFlags]'NonPublic,Static')) { exit 41 }; exit 0";
async function compile(mode: "baseline" | "os-environment", trivial: boolean): Promise<unknown> {
  const temporary = realpathSync.native(mkdtempSync(join(root, "compile-")));
  const environment: Record<string, string> = {
    SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows", HUNT_TEST_SOURCE: helper,
    TEMP: temporary, TMP: temporary,
  };
  if (mode === "os-environment") {
    // Only operating-system paths/identity, never arbitrary CI environment or credentials.
    for (const key of ["PATH", "COMSPEC", "PATHEXT", "APPDATA", "LOCALAPPDATA", "USERPROFILE", "SYSTEMDRIVE"]) {
      const entry = Object.entries(process.env).find(([name]) => name.toUpperCase() === key);
      if (entry?.[1]) environment[key] = entry[1];
    }
  }
  const command = trivial
    ? "$ErrorActionPreference='Stop'; [Console]::WriteLine('before-trivial'); Add-Type -TypeDefinition 'public class HuntCompilerProbe { public static int Value = 1; }'; [Console]::WriteLine('after-trivial'); exit 0"
    : script.replace("Add-Type -Path", "[Console]::WriteLine('before-full'); Add-Type -Path")
      .replace("; if($null", "; [Console]::WriteLine('after-full'); if($null");
  const start = Date.now();
  return new Promise((resolve) => {
    const child = spawn("C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
        env: environment,
        windowsHide: true, timeout: 15_000,
      });
    let stdout = "", stderr = "";
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    child.on("error", (error) => { stderr += error.message; });
    child.on("close", (status, signal) => resolve({ mode, trivial, status, signal,
      milliseconds: Date.now() - start, stdout, stderr }));
  });
}
// Serial probes distinguish general compiler startup from full-source compilation.
// The prior 1/2/4 concurrency and canonical-temp probes all timed out on the hosted runner.
for (const mode of ["baseline", "os-environment"] as const) {
  for (const trivial of [true, false]) console.log(JSON.stringify(await compile(mode, trivial)));
}
