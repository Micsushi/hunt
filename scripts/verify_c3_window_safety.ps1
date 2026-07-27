param(
    [string]$Ports = "",
    [string]$BatchId = "",
    [bool]$EnforceMinimized = $true,
    [string]$Output = ""
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class C3WindowSafetyTools {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct WINDOWPLACEMENT {
        public int length;
        public int flags;
        public int showCmd;
        public POINT ptMinPosition;
        public POINT ptMaxPosition;
        public RECT rcNormalPosition;
        public RECT rcDevice;
    }

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumDesktopWindows(
        IntPtr hDesktop,
        EnumWindowsProc lpfn,
        IntPtr lParam
    );

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr OpenDesktop(
        string lpszDesktop,
        int dwFlags,
        bool fInherit,
        uint dwDesiredAccess
    );

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool CloseDesktop(IntPtr hDesktop);

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern bool GetWindowPlacement(IntPtr hWnd, ref WINDOWPLACEMENT lpwndpl);

    [DllImport("user32.dll")]
    public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
}
"@

function Get-WindowTitle {
    param([Parameter(Mandatory=$true)][IntPtr]$Handle)
    $builder = New-Object System.Text.StringBuilder 512
    [C3WindowSafetyTools]::GetWindowText($Handle, $builder, $builder.Capacity) | Out-Null
    $builder.ToString()
}

function Get-WindowClass {
    param([Parameter(Mandatory=$true)][IntPtr]$Handle)
    $builder = New-Object System.Text.StringBuilder 256
    [C3WindowSafetyTools]::GetClassName($Handle, $builder, $builder.Capacity) | Out-Null
    $builder.ToString()
}

function Get-NormalWindowBounds {
    param([Parameter(Mandatory=$true)][IntPtr]$Handle)
    $placement = New-Object C3WindowSafetyTools+WINDOWPLACEMENT
    $placement.length = [Runtime.InteropServices.Marshal]::SizeOf([type]"C3WindowSafetyTools+WINDOWPLACEMENT")
    if (-not [C3WindowSafetyTools]::GetWindowPlacement($Handle, [ref]$placement)) {
        return [pscustomobject]@{
            available = $false
            left = 0
            top = 0
            right = 0
            bottom = 0
        }
    }
    [pscustomobject]@{
        available = $true
        left = $placement.rcNormalPosition.Left
        top = $placement.rcNormalPosition.Top
        right = $placement.rcNormalPosition.Right
        bottom = $placement.rcNormalPosition.Bottom
    }
}

function Get-WindowOwner {
    param([Parameter(Mandatory=$true)][IntPtr]$Handle)
    [uint32]$processId = 0
    [C3WindowSafetyTools]::GetWindowThreadProcessId($Handle, [ref]$processId) | Out-Null
    $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
    [pscustomobject]@{
        handle = $Handle.ToInt64()
        processId = [int]$processId
        processName = if ($process) { $process.ProcessName } else { "" }
        title = Get-WindowTitle -Handle $Handle
    }
}

$portSet = @{}
if ($Ports.Trim()) {
    $Ports -split "," |
        ForEach-Object { $_.Trim() } |
        Where-Object { $_ } |
        ForEach-Object { $portSet[[int]$_] = $true }
}

$laneProcesses = Get-CimInstance Win32_Process |
    Where-Object {
        $_.Name -eq "chrome.exe" -and
        $_.CommandLine -match "ChromeC3PlaywrightParallel" -and
        $_.CommandLine -match "--remote-debugging-port=(\d+)"
    } |
    Where-Object {
        if ($BatchId -and $_.CommandLine -notmatch [regex]::Escape($BatchId)) {
            return $false
        }
        if ($portSet.Count -gt 0) {
            if ($_.CommandLine -match "--remote-debugging-port=(\d+)") {
                return $portSet.ContainsKey([int]$Matches[1])
            }
            return $false
        }
        $true
    }

if (-not $laneProcesses) {
    throw "No matching Hunt p Chrome lane processes found."
}

$pidSet = @{}
foreach ($process in $laneProcesses) {
    $pidSet[[uint32]$process.ProcessId] = $process
}

$windows = New-Object System.Collections.Generic.List[object]
$callback = [C3WindowSafetyTools+EnumWindowsProc]{
    param([IntPtr]$hWnd, [IntPtr]$lParam)
    [uint32]$windowProcessId = 0
    [C3WindowSafetyTools]::GetWindowThreadProcessId($hWnd, [ref]$windowProcessId) | Out-Null
    if (-not $pidSet.ContainsKey($windowProcessId)) {
        return $true
    }
    if ((Get-WindowClass -Handle $hWnd) -ne "Chrome_WidgetWin_1") {
        return $true
    }
    $commandLine = [string]$pidSet[$windowProcessId].CommandLine
    $port = $null
    if ($commandLine -match "--remote-debugging-port=(\d+)") {
        $port = [int]$Matches[1]
    }
    $windows.Add([pscustomobject]@{
        handle = $hWnd
        processId = [int]$windowProcessId
        port = $port
        title = Get-WindowTitle -Handle $hWnd
        visibleBefore = [C3WindowSafetyTools]::IsWindowVisible($hWnd)
        minimizedBefore = [C3WindowSafetyTools]::IsIconic($hWnd)
        normalBounds = Get-NormalWindowBounds -Handle $hWnd
        isolatedDesktop = $false
    }) | Out-Null
    $true
}
[C3WindowSafetyTools]::EnumWindows($callback, [IntPtr]::Zero) | Out-Null

$desktopPorts = @(
    $laneProcesses |
        ForEach-Object {
            if ($_.CommandLine -match "--remote-debugging-port=(\d+)") {
                [int]$Matches[1]
            }
        } |
        Sort-Object -Unique
)
foreach ($desktopPort in $desktopPorts) {
    # DESKTOP_READOBJECTS | DESKTOP_ENUMERATE.
    $desktopHandle = [C3WindowSafetyTools]::OpenDesktop(
        "HuntC3_$desktopPort",
        0,
        $false,
        0x0041
    )
    if ($desktopHandle -eq [IntPtr]::Zero) {
        continue
    }
    try {
        [C3WindowSafetyTools]::EnumDesktopWindows(
            $desktopHandle,
            $callback,
            [IntPtr]::Zero
        ) | Out-Null
        foreach ($isolatedWindow in $windows | Where-Object { $_.port -eq $desktopPort }) {
            $isolatedWindow.isolatedDesktop = $true
        }
    } finally {
        [C3WindowSafetyTools]::CloseDesktop($desktopHandle) | Out-Null
    }
}

if ($windows.Count -eq 0) {
    throw "No top-level windows found for matching Hunt p Chrome lanes."
}

$foregroundBefore = [C3WindowSafetyTools]::GetForegroundWindow()
if ($EnforceMinimized) {
    foreach ($window in $windows) {
        if (-not $window.minimizedBefore) {
            # SW_SHOWMINNOACTIVE: show minimized without activating the window.
            [C3WindowSafetyTools]::ShowWindowAsync($window.handle, 7) | Out-Null
        }
    }
    Start-Sleep -Milliseconds 300
}
$foregroundAfter = [C3WindowSafetyTools]::GetForegroundWindow()

$failures = New-Object System.Collections.Generic.List[object]
$windowResults = @()
$secondaryScreens = @([System.Windows.Forms.Screen]::AllScreens | Where-Object { -not $_.Primary })
foreach ($window in $windows) {
    $minimizedAfter = [C3WindowSafetyTools]::IsIconic($window.handle)
    $wasForeground = $foregroundBefore -eq $window.handle
    $isForeground = $foregroundAfter -eq $window.handle
    $bounds = Get-NormalWindowBounds -Handle $window.handle
    $secondaryScreen = if ($bounds.available) {
        $secondaryScreens | Where-Object {
            $area = $_.WorkingArea
            $bounds.left -ge $area.Left -and
            $bounds.top -ge $area.Top -and
            $bounds.right -le $area.Right -and
            $bounds.bottom -le $area.Bottom
        } | Select-Object -First 1
    } else {
        $null
    }
    if (-not $window.minimizedBefore -and -not $window.isolatedDesktop) {
        $failures.Add([pscustomobject]@{
            code = "lane_window_not_minimized_before_check"
            port = $window.port
            processId = $window.processId
        }) | Out-Null
    }
    if (-not $minimizedAfter -and -not $window.isolatedDesktop) {
        $failures.Add([pscustomobject]@{
            code = "lane_window_not_minimized"
            port = $window.port
            processId = $window.processId
        }) | Out-Null
    }
    if ($wasForeground) {
        $failures.Add([pscustomobject]@{
            code = "lane_window_was_foreground_before_check"
            port = $window.port
            processId = $window.processId
        }) | Out-Null
    }
    if ($isForeground) {
        $failures.Add([pscustomobject]@{
            code = "lane_window_is_foreground"
            port = $window.port
            processId = $window.processId
        }) | Out-Null
    }
    if ($bounds.available -and -not $secondaryScreen -and -not $window.isolatedDesktop) {
        $failures.Add([pscustomobject]@{
            code = "lane_window_not_on_secondary_monitor"
            port = $window.port
            processId = $window.processId
            normalBounds = $bounds
        }) | Out-Null
    }
    $windowResults += [pscustomobject]@{
        handle = $window.handle.ToInt64()
        processId = $window.processId
        port = $window.port
        title = $window.title
        visibleBefore = $window.visibleBefore
        isolatedDesktop = $window.isolatedDesktop
        minimizedBefore = $window.minimizedBefore
        minimizedAfter = $minimizedAfter
        isForegroundBefore = $wasForeground
        isForegroundAfter = $isForeground
        normalBounds = $bounds
        secondaryScreen = if ($secondaryScreen) { $secondaryScreen.DeviceName } else { "" }
    }
}

$foregroundBeforeOwner = Get-WindowOwner -Handle $foregroundBefore
$foregroundAfterOwner = Get-WindowOwner -Handle $foregroundAfter
$failureResults = @()
foreach ($failure in $failures) {
    $failureResults += $failure
}

$result = [pscustomobject]@{
    ok = $failures.Count -eq 0
    checkedAt = [DateTime]::UtcNow.ToString("o")
    batchId = $BatchId
    ports = @($windowResults | ForEach-Object { $_.port } | Sort-Object -Unique)
    foregroundBefore = $foregroundBeforeOwner
    foregroundAfter = $foregroundAfterOwner
    laneWindows = $windowResults
    failures = $failureResults
}

$json = $result | ConvertTo-Json -Depth 6
if ($Output) {
    $parent = Split-Path -Parent $Output
    if ($parent) {
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }
    Set-Content -LiteralPath $Output -Value $json -Encoding UTF8
}
$json

if (-not $result.ok) {
    throw "Hunt p Chrome window safety verification failed."
}
