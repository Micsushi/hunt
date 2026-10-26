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
async function compile(keys: readonly string[], operation: "startup" | "json" | "trivial" | "full", cachePath?: string): Promise<{ status: number | null; [key: string]: unknown }> {
  const temporary = realpathSync.native(mkdtempSync(join(root, "compile-")));
  const environment: Record<string, string> = {
    SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows", HUNT_TEST_SOURCE: helper,
    TEMP: temporary, TMP: temporary,
  };
  for (const key of keys) {
    const entry = Object.entries(process.env).find(([name]) => name.toUpperCase() === key.toUpperCase());
    if (entry?.[1]) environment[entry[0]] = entry[1];
  }
  if (cachePath !== undefined) environment.PSModuleAnalysisCachePath = cachePath;
  const commands = {
    startup: "$ErrorActionPreference='Stop'; [Console]::WriteLine('startup-ok'); exit 0",
    json: "$ErrorActionPreference='Stop'; [Console]::WriteLine('before-json'); $value='{}' | ConvertFrom-Json; [Console]::WriteLine('after-json'); exit 0",
    trivial: "$ErrorActionPreference='Stop'; [Console]::WriteLine('before-trivial'); Add-Type -TypeDefinition 'public class HuntCompilerProbe { public static int Value = 1; }'; [Console]::WriteLine('after-trivial'); exit 0",
    full: script.replace("Add-Type -Path", "[Console]::WriteLine('before-full'); Add-Type -Path")
      .replace("; if($null", "; [Console]::WriteLine('after-full'); if($null"),
  };
  const command = commands[operation];
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
    child.on("close", (status, signal) => resolve({ keys, cachePath, operation, status, signal,
      milliseconds: Date.now() - start, stdout, stderr }));
  });
}
console.log(JSON.stringify({ hostModuleAnalysisCachePath: process.env.PSModuleAnalysisCachePath }));
console.log(JSON.stringify(await compile([], "json")));
for (const operation of ["json", "full"] as const) {
  console.log(JSON.stringify(await compile([], operation, "NUL")));
}
