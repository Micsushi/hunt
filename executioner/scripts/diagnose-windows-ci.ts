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
async function compile(keys: readonly string[], operation: "startup" | "json" | "trivial" | "full"): Promise<{ status: number | null; [key: string]: unknown }> {
  const temporary = realpathSync.native(mkdtempSync(join(root, "compile-")));
  const environment: Record<string, string> = {
    SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows", HUNT_TEST_SOURCE: helper,
    TEMP: temporary, TMP: temporary,
  };
  for (const key of keys) {
    const entry = Object.entries(process.env).find(([name]) => name.toUpperCase() === key.toUpperCase());
    if (entry?.[1]) environment[entry[0]] = entry[1];
  }
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
    child.on("close", (status, signal) => resolve({ keys, operation, status, signal,
      milliseconds: Date.now() - start, stdout, stderr }));
  });
}
// Only explicit Windows OS fields; no CI variables, credentials, or policy overrides.
const groups = {
  core: ["PATH", "COMSPEC", "PATHEXT", "APPDATA", "LOCALAPPDATA", "USERPROFILE", "SYSTEMDRIVE"],
  identity: ["OS", "COMPUTERNAME", "USERNAME", "USERDOMAIN", "USERDOMAIN_ROAMINGPROFILE", "HOMEDRIVE", "HOMEPATH"],
  architecture: ["PROCESSOR_ARCHITECTURE", "PROCESSOR_ARCHITEW6432", "NUMBER_OF_PROCESSORS", "PROCESSOR_IDENTIFIER", "PROCESSOR_LEVEL", "PROCESSOR_REVISION"],
  install: ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "CommonProgramFiles", "CommonProgramFiles(x86)", "CommonProgramW6432", "ProgramData", "ALLUSERSPROFILE", "PUBLIC"],
  powershell: ["PSModulePath", "PSModuleAnalysisCachePath", "POWERSHELL_DISTRIBUTION_CHANNEL"],
};
const all = Object.values(groups).flat();
for (const keys of [[], all]) console.log(JSON.stringify(await compile(keys, "json")));
let isolated = false;
for (const keys of Object.values(groups)) {
  const result = await compile(keys, "json");
  console.log(JSON.stringify(result));
  if (result.status === 0 && !isolated) {
    isolated = true;
    for (const key of keys) {
      const single = await compile([key], "json");
      console.log(JSON.stringify(single));
      if (single.status === 0) console.log(JSON.stringify(await compile([key], "full")));
    }
  }
}
