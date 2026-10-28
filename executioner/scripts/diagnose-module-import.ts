import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Temporary, synthetic-only comparison; removed after qualification.
const root = realpathSync.native(mkdtempSync(join(tmpdir(), "hunt-module-import-")));
const source = readFileSync("src/secrets/windows-dpapi/private/interactive-gmail-oauth-sealer.ts", "utf8");
const csharp = /\$source = @'\r?\n([\s\S]*?)\r?\n'@/u.exec(source)?.[1];
if (!csharp) throw new Error("Missing helper source");
const helper = join(root, "helper.cs");
writeFileSync(helper, csharp);
const utility = String.raw`Import-Module "$PSHOME\Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1" -ErrorAction Stop; `;
const json = String.raw`$value = '{"value":42}' | ConvertFrom-Json; if ($value.value -ne 42) { exit 2 }; [Console]::WriteLine('json-ok')`;
const full = String.raw`Add-Type -Path $env:HUNT_TEST_SOURCE -ReferencedAssemblies 'System.Security.dll','System.Web.dll','System.Web.Extensions.dll'; if ($null -eq [HuntInteractiveGmailOAuthSealer].GetMethod('FrameBundle',[Reflection.BindingFlags]'NonPublic,Static')) { exit 3 }; [Console]::WriteLine('helper-ok')`;
for (const [name, command] of [
  ["baseline-json", json],
  ["explicit-json", utility + json],
  ["explicit-helper", utility + full],
  ["no-autoload-json", "$PSModuleAutoLoadingPreference='None'; " + utility + json],
  ["no-autoload-helper", "$PSModuleAutoLoadingPreference='None'; " + utility + full],
  ["qualified-json", json.replace("ConvertFrom-Json", "Microsoft.PowerShell.Utility\\ConvertFrom-Json")],
] as const) {
  const started = Date.now();
  const result = spawnSync("C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; " + command], {
      env: { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows", HUNT_TEST_SOURCE: helper, TEMP: root, TMP: root },
      windowsHide: true, timeout: 15_000, encoding: "utf8", maxBuffer: 32_768,
    });
  console.log(JSON.stringify({ name, status: result.status, signal: result.signal,
    milliseconds: Date.now() - started, error: result.error?.message,
    stdout: result.stdout, stderr: result.stderr }));
}
