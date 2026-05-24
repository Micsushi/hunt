param(
    [string]$Ports = "",
    [string]$BatchId = "",
    [ValidateSet("right", "left")][string]$Monitor = "right",
    [int]$WindowWidth = 1280,
    [int]$WindowHeight = 760,
    [int]$CascadeStep = 28
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Win32WindowTools {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@

function Get-WindowTitle {
    param([Parameter(Mandatory=$true)][IntPtr]$Handle)
    $builder = New-Object System.Text.StringBuilder 512
    [Win32WindowTools]::GetWindowText($Handle, $builder, $builder.Capacity) | Out-Null
    $builder.ToString()
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
        $_.CommandLine -match "--remote-debugging-port=9\d\d\d"
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
    Write-Host "No matching p Chrome lane processes found."
    return
}

$pidSet = @{}
foreach ($process in $laneProcesses) {
    $pidSet[[uint32]$process.ProcessId] = $process
}

$windows = New-Object System.Collections.Generic.List[object]
$callback = [Win32WindowTools+EnumWindowsProc]{
    param([IntPtr]$hWnd, [IntPtr]$lParam)
    if (-not [Win32WindowTools]::IsWindowVisible($hWnd)) {
        return $true
    }
    [uint32]$windowProcessId = 0
    [Win32WindowTools]::GetWindowThreadProcessId($hWnd, [ref]$windowProcessId) | Out-Null
    if (-not $pidSet.ContainsKey($windowProcessId)) {
        return $true
    }
    $title = Get-WindowTitle -Handle $hWnd
    if (-not $title) {
        return $true
    }
    $commandLine = [string]$pidSet[$windowProcessId].CommandLine
    $port = $null
    if ($commandLine -match "--remote-debugging-port=(\d+)") {
        $port = [int]$Matches[1]
    }
    $windows.Add([pscustomobject]@{
        Handle = $hWnd
        ProcessId = [int]$windowProcessId
        Port = $port
        Title = $title
    }) | Out-Null
    $true
}
[Win32WindowTools]::EnumWindows($callback, [IntPtr]::Zero) | Out-Null

if ($windows.Count -eq 0) {
    Write-Host "No visible p Chrome windows found for matching lane processes."
    return
}

$screens = [System.Windows.Forms.Screen]::AllScreens |
    Where-Object { -not $_.Primary } |
    Sort-Object @{ Expression = { $_.Bounds.X }; Descending = ($Monitor -eq "right") }
$screen = $screens | Select-Object -First 1
if (-not $screen) {
    throw "No secondary monitor found. Refusing to move p Chrome windows onto the primary monitor."
}

$area = $screen.WorkingArea
$width = [Math]::Min($WindowWidth, [Math]::Max(640, $area.Width - 80))
$height = [Math]::Min($WindowHeight, [Math]::Max(480, $area.Height - 80))
$maxX = $area.X + $area.Width - $width
$maxY = $area.Y + $area.Height - $height
$baseX = $area.X + 40
$baseY = $area.Y + 40

$ordered = $windows | Sort-Object Port, ProcessId
$moved = @()
for ($index = 0; $index -lt $ordered.Count; $index += 1) {
    $window = $ordered[$index]
    $offset = $index * $CascadeStep
    $x = [Math]::Min($baseX + $offset, $maxX)
    $y = [Math]::Min($baseY + $offset, $maxY)
    [Win32WindowTools]::ShowWindow($window.Handle, 4) | Out-Null
    [Win32WindowTools]::SetWindowPos($window.Handle, [IntPtr]::Zero, $x, $y, $width, $height, 0x0050) | Out-Null
    $moved += [pscustomobject]@{
        port = $window.Port
        processId = $window.ProcessId
        title = $window.Title
        position = "$x,$y"
        size = "$width,$height"
        screen = $screen.DeviceName
    }
}

$moved | ConvertTo-Json -Depth 4
