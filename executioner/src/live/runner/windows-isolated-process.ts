import { spawn } from "node:child_process";
import { resolve } from "node:path";

const MAX_ARGUMENT_BYTES = 32 * 1024;

export function supportsWindowsIsolatedNodeRuntime(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version);
  return match !== null && Number(match[1]) === 22 && Number(match[2]) >= 18;
}

export interface WindowsIsolatedRunnerOptions {
  readonly executable?: string;
  readonly runnerPath?: string;
  readonly signal?: AbortSignal;
  readonly environment?: NodeJS.ProcessEnv;
}

export function runWindowsIsolatedStage2Acceptance(
  arguments_: readonly string[],
  options: WindowsIsolatedRunnerOptions = {},
): Promise<number> {
  const executable = options.executable ?? process.execPath;
  const runnerPath = options.runnerPath ?? resolve(
    import.meta.dirname,
    "..",
    "..",
    "..",
    "scripts",
    "run-s2-real.ts",
  );
  validateInputs(executable, runnerPath, arguments_);
  const encodedArguments = Buffer.from(JSON.stringify(arguments_), "utf8").toString("base64");
  const environment = {
    ...(options.environment ?? process.env),
    HUNT_C3_ISOLATED_NODE: executable,
    HUNT_C3_ISOLATED_RUNNER: runnerPath,
    HUNT_C3_ISOLATED_ARGUMENTS_B64: encodedArguments,
  };
  return new Promise((resolveResult, reject) => {
    const child = spawn(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        windowsIsolatedRunnerScript(),
      ],
      {
        shell: false,
        windowsHide: true,
        stdio: "inherit",
        env: environment,
      },
    );
    let settled = false;
    let cancellationRequested = false;
    let cancellationTimeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error, code?: number) => {
      if (settled) return;
      settled = true;
      if (cancellationTimeout !== undefined) clearTimeout(cancellationTimeout);
      options.signal?.removeEventListener("abort", cancel);
      if (error !== undefined) reject(error);
      else resolveResult(code!);
    };
    const cancel = () => {
      if (settled || cancellationRequested) return;
      cancellationRequested = true;
      child.kill();
      cancellationTimeout = setTimeout(() => {
        finish(new Error("isolated live runner cleanup unconfirmed"));
      }, 5_000);
    };
    child.once("error", () => finish(new Error("isolated live runner unavailable")));
    child.once("close", (code, signal) => {
      if (cancellationRequested) {
        finish(undefined, 130);
        return;
      }
      if (signal !== null || code === null) {
        finish(new Error("isolated live runner unavailable"));
        return;
      }
      finish(undefined, code);
    });
    if (options.signal?.aborted) {
      cancel();
      return;
    }
    options.signal?.addEventListener("abort", cancel, { once: true });
  });
}

function validateInputs(
  executable: string,
  runnerPath: string,
  arguments_: readonly string[],
): void {
  const values = [executable, runnerPath, ...arguments_];
  if (
    !/^[A-Za-z]:\\[^\0\r\n"]+$/u.test(executable) ||
    !/^[A-Za-z]:\\[^\0\r\n"]+$/u.test(runnerPath) ||
    values.some((value) => typeof value !== "string" || /[\0\r\n"]/u.test(value)) ||
    Buffer.byteLength(JSON.stringify(arguments_), "utf8") > MAX_ARGUMENT_BYTES
  ) {
    throw new TypeError("isolated live runner input invalid");
  }
}

export function windowsIsolatedRunnerScript(): string {
  return String.raw`
& {
$ErrorActionPreference = 'Stop'
$node = $env:HUNT_C3_ISOLATED_NODE
$runner = $env:HUNT_C3_ISOLATED_RUNNER
$argumentsB64 = $env:HUNT_C3_ISOLATED_ARGUMENTS_B64
$env:HUNT_C3_ISOLATED_NODE = $null
$env:HUNT_C3_ISOLATED_RUNNER = $null
$env:HUNT_C3_ISOLATED_ARGUMENTS_B64 = $null
if (-not [IO.Path]::IsPathRooted($node) -or -not [IO.Path]::IsPathRooted($runner)) { exit 121 }
$argumentJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($argumentsB64))
$decodedArguments = ConvertFrom-Json -InputObject $argumentJson
$runnerArguments = [Collections.Generic.List[string]]::new()
foreach ($argument in $decodedArguments) { [void]$runnerArguments.Add([string]$argument) }
if ($runnerArguments.Count -gt 16) { exit 122 }

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class HuntC3IsolatedRunner
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct STARTUPINFO {
        public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
        public int dwX; public int dwY; public int dwXSize; public int dwYSize;
        public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute;
        public int dwFlags; public short wShowWindow; public short cbReserved2;
        public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION {
        public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct STARTUPINFOEX {
        public STARTUPINFO StartupInfo;
        public IntPtr lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
        public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct IO_COUNTERS {
        public ulong ReadOperationCount; public ulong WriteOperationCount; public ulong OtherOperationCount;
        public ulong ReadTransferCount; public ulong WriteTransferCount; public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed;
    }

    public const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    public const uint CREATE_SUSPENDED = 0x00000004;
    public const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    public static readonly IntPtr PROC_THREAD_ATTRIBUTE_JOB_LIST = new IntPtr(0x0002000D);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr CreateDesktop(string name, IntPtr device, IntPtr devmode, int flags, uint access, IntPtr attributes);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CreateProcess(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory, ref STARTUPINFOEX startup, out PROCESS_INFORMATION process);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returnedSize);
    [DllImport("kernel32.dll")] public static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool QueryInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length, out uint returnedLength);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inheritHandle, int processId);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr value);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr GetStdHandle(int kind);
}
'@

function Quote-WindowsArgument([string]$value) {
    if ($value.IndexOf('"') -ge 0 -or $value.IndexOf([char]0) -ge 0) { throw 'invalid argument' }
    $trailing = [regex]::Match($value, '\\+$')
    if ($trailing.Success) { $value += $trailing.Value }
    return '"' + $value + '"'
}

function Get-JobProcessIds([IntPtr]$jobHandle) {
    $capacity = 256
    $bytes = 8 + ($capacity * [IntPtr]::Size)
    $buffer = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes)
    try {
        $returned = [uint32]0
        if (-not [HuntC3IsolatedRunner]::QueryInformationJobObject($jobHandle, 3, $buffer, $bytes, [ref]$returned)) { throw 'job process query failed' }
        $count = [Runtime.InteropServices.Marshal]::ReadInt32($buffer, 4)
        if ($count -lt 0 -or $count -gt $capacity) { throw 'job process query invalid' }
        $ids = [Collections.Generic.List[int]]::new()
        for ($index = 0; $index -lt $count; $index++) {
            $offset = 8 + ($index * [IntPtr]::Size)
            $identifier = if ([IntPtr]::Size -eq 8) { [Runtime.InteropServices.Marshal]::ReadInt64($buffer, $offset) } else { [Runtime.InteropServices.Marshal]::ReadInt32($buffer, $offset) }
            if ($identifier -gt 0 -and $identifier -le [int]::MaxValue) { [void]$ids.Add([int]$identifier) }
        }
        return $ids.ToArray()
    } finally {
        [Runtime.InteropServices.Marshal]::FreeHGlobal($buffer)
    }
}

function Test-ProcessExited([int]$identifier) {
    # SYNCHRONIZE is sufficient and avoids inspecting an unrelated process command line.
    $handle = [HuntC3IsolatedRunner]::OpenProcess([uint32]0x00100000, $false, $identifier)
    if ($handle -eq [IntPtr]::Zero) { return $true }
    try { return [HuntC3IsolatedRunner]::WaitForSingleObject($handle, 5000) -eq 0 }
    finally { [HuntC3IsolatedRunner]::CloseHandle($handle) | Out-Null }
}

function Write-ProcessAudit([string]$root, [int[]]$members, [int]$alive) {
    if (-not [IO.Path]::IsPathRooted($root) -or -not [IO.Directory]::Exists($root)) { throw 'process audit root invalid' }
    $target = [IO.Path]::Combine($root, 'process-audit.json')
    if ([IO.File]::Exists($target)) { throw 'process audit already exists' }
    $partial = [IO.Path]::Combine($root, '.process-audit-' + [guid]::NewGuid().ToString('N') + '.partial')
    try {
        $audit = [ordered]@{
            schemaVersion = 1
            evidenceRevision = 's2-windows-process-audit-v1'
            status = if ($alive -eq 0) { 'pass' } else { 'failed' }
            jobCloseApplied = $true
            membersObservedBeforeClose = $members.Count
            membersAliveAfterClose = $alive
            checkedAt = [DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'")
        }
        [IO.File]::WriteAllText($partial, (($audit | ConvertTo-Json -Compress) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
        [IO.File]::Move($partial, $target)
    } finally {
        if ([IO.File]::Exists($partial)) { [IO.File]::Delete($partial) }
    }
}

$evidenceRoot = $null
for ($index = 0; $index -lt ($runnerArguments.Count - 1); $index++) {
    if ($runnerArguments[$index] -eq '--evidence-root') {
        $evidenceRoot = [IO.Path]::GetFullPath($runnerArguments[$index + 1])
        break
    }
}

$desktopName = 'HuntC3_' + [guid]::NewGuid().ToString('N')
# DESKTOP_CREATEWINDOW | DESKTOP_ENUMERATE | DESKTOP_READOBJECTS | DESKTOP_WRITEOBJECTS.
# Deliberately omit the desktop-switch right.
$desktop = [HuntC3IsolatedRunner]::CreateDesktop($desktopName, [IntPtr]::Zero, [IntPtr]::Zero, 0, [uint32]0x00C3, [IntPtr]::Zero)
if ($desktop -eq [IntPtr]::Zero) { exit 123 }
$job = [HuntC3IsolatedRunner]::CreateJobObject([IntPtr]::Zero, $null)
if ($job -eq [IntPtr]::Zero) { [HuntC3IsolatedRunner]::CloseDesktop($desktop) | Out-Null; exit 124 }
$processInfo = New-Object HuntC3IsolatedRunner+PROCESS_INFORMATION
$attributeList = [IntPtr]::Zero
$jobValue = [IntPtr]::Zero
$created = $false
$childExit = [uint32]125
$jobMembers = @()
$processAuditPassed = $true
try {
    $limits = New-Object HuntC3IsolatedRunner+JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    $basicLimits = New-Object HuntC3IsolatedRunner+JOBOBJECT_BASIC_LIMIT_INFORMATION
    $basicLimits.LimitFlags = [HuntC3IsolatedRunner]::JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    $limits.BasicLimitInformation = $basicLimits
    $limitSize = [Runtime.InteropServices.Marshal]::SizeOf([type]'HuntC3IsolatedRunner+JOBOBJECT_EXTENDED_LIMIT_INFORMATION')
    if (-not [HuntC3IsolatedRunner]::SetInformationJobObject($job, 9, [ref]$limits, $limitSize)) { exit 125 }

    $env:HUNT_C3_WINDOWS_DESKTOP_NAME = $desktopName
    $attributeBytes = [IntPtr]::Zero
    [HuntC3IsolatedRunner]::InitializeProcThreadAttributeList([IntPtr]::Zero, 1, 0, [ref]$attributeBytes) | Out-Null
    if ($attributeBytes -eq [IntPtr]::Zero) { exit 131 }
    $attributeList = [Runtime.InteropServices.Marshal]::AllocHGlobal($attributeBytes.ToInt64())
    if (-not [HuntC3IsolatedRunner]::InitializeProcThreadAttributeList($attributeList, 1, 0, [ref]$attributeBytes)) { exit 132 }
    $jobValue = [Runtime.InteropServices.Marshal]::AllocHGlobal([IntPtr]::Size)
    [Runtime.InteropServices.Marshal]::WriteIntPtr($jobValue, $job)
    if (-not [HuntC3IsolatedRunner]::UpdateProcThreadAttribute($attributeList, 0, [HuntC3IsolatedRunner]::PROC_THREAD_ATTRIBUTE_JOB_LIST, $jobValue, [IntPtr][IntPtr]::Size, [IntPtr]::Zero, [IntPtr]::Zero)) { exit 133 }

    $startup = New-Object HuntC3IsolatedRunner+STARTUPINFOEX
    $startupInfo = New-Object HuntC3IsolatedRunner+STARTUPINFO
    $startupInfo.cb = [Runtime.InteropServices.Marshal]::SizeOf([type]'HuntC3IsolatedRunner+STARTUPINFOEX')
    $startupInfo.lpDesktop = 'winsta0\' + $desktopName
    $startup.lpAttributeList = $attributeList
    # STARTF_USESHOWWINDOW | STARTF_USESTDHANDLES, with SW_HIDE for the runner.
    $startupInfo.dwFlags = 0x00000101
    $startupInfo.wShowWindow = 0
    $startupInfo.hStdInput = [HuntC3IsolatedRunner]::GetStdHandle(-10)
    $startupInfo.hStdOutput = [HuntC3IsolatedRunner]::GetStdHandle(-11)
    $startupInfo.hStdError = [HuntC3IsolatedRunner]::GetStdHandle(-12)
    $startup.StartupInfo = $startupInfo
    $commandLine = New-Object Text.StringBuilder
    [void]$commandLine.Append((Quote-WindowsArgument $node)).Append(' ').Append((Quote-WindowsArgument $runner))
    foreach ($argument in $runnerArguments) { [void]$commandLine.Append(' ').Append((Quote-WindowsArgument ([string]$argument))) }
    $creationFlags = [HuntC3IsolatedRunner]::CREATE_SUSPENDED -bor [HuntC3IsolatedRunner]::EXTENDED_STARTUPINFO_PRESENT
    $created = [HuntC3IsolatedRunner]::CreateProcess($node, $commandLine, [IntPtr]::Zero, [IntPtr]::Zero, $true, $creationFlags, [IntPtr]::Zero, (Split-Path -Parent $runner), [ref]$startup, [ref]$processInfo)
    if (-not $created) {
        [Console]::Error.WriteLine('isolated runner CreateProcess failed: ' + [Runtime.InteropServices.Marshal]::GetLastWin32Error())
        exit 134
    }
    if ([HuntC3IsolatedRunner]::ResumeThread($processInfo.hThread) -eq [uint32]::MaxValue) {
        [HuntC3IsolatedRunner]::TerminateProcess($processInfo.hProcess, 128) | Out-Null
        exit 128
    }
    if ([HuntC3IsolatedRunner]::WaitForSingleObject($processInfo.hProcess, [uint32]::MaxValue) -ne 0) { exit 129 }
    if (-not [HuntC3IsolatedRunner]::GetExitCodeProcess($processInfo.hProcess, [ref]$childExit)) { exit 130 }
} finally {
    $env:HUNT_C3_WINDOWS_DESKTOP_NAME = $null
    if ($attributeList -ne [IntPtr]::Zero) {
        [HuntC3IsolatedRunner]::DeleteProcThreadAttributeList($attributeList)
        [Runtime.InteropServices.Marshal]::FreeHGlobal($attributeList)
    }
    if ($jobValue -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::FreeHGlobal($jobValue) }
    if ($processInfo.hThread -ne [IntPtr]::Zero) { [HuntC3IsolatedRunner]::CloseHandle($processInfo.hThread) | Out-Null }
    if ($processInfo.hProcess -ne [IntPtr]::Zero) { [HuntC3IsolatedRunner]::CloseHandle($processInfo.hProcess) | Out-Null }
    # Query exact job membership, close the job, then prove every observed member exited.
    try { $jobMembers = @(Get-JobProcessIds $job) }
    catch { $processAuditPassed = $false; $jobMembers = @() }
    [HuntC3IsolatedRunner]::CloseHandle($job) | Out-Null
    $aliveAfterClose = 0
    foreach ($identifier in $jobMembers) {
        if (-not (Test-ProcessExited $identifier)) { $aliveAfterClose++ }
    }
    if ($aliveAfterClose -ne 0) { $processAuditPassed = $false }
    [HuntC3IsolatedRunner]::CloseDesktop($desktop) | Out-Null
    if ($evidenceRoot -ne $null) {
        try { Write-ProcessAudit $evidenceRoot $jobMembers $aliveAfterClose }
        catch { $processAuditPassed = $false }
    }
}
if (-not $processAuditPassed) { exit 136 }
exit ([int]$childExit)
}
`.trim();
}
