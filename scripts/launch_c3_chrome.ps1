$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$extension = Join-Path $repoRoot "executioner"
$browserKind = "override"
$chrome = $env:HUNT_C3_CHROME
$debugPort = 9222
if ($env:HUNT_C3_CHROME_REMOTE_DEBUGGING_PORT) {
    $debugPort = [int]$env:HUNT_C3_CHROME_REMOTE_DEBUGGING_PORT
}

if (-not $chrome) {
    $playwrightRoot = Join-Path $env:LOCALAPPDATA "ms-playwright"
    $playwrightChrome = Get-ChildItem -Path $playwrightRoot -Recurse -Filter chrome.exe -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match "chromium" } |
        Sort-Object FullName -Descending |
        Select-Object -First 1
    if ($playwrightChrome) {
        $chrome = $playwrightChrome.FullName
        $browserKind = "playwright_chromium"
    }
}

if (-not $chrome) {
    $chromeForTesting = Get-ChildItem -Path "C:\Program Files", "$env:LOCALAPPDATA" -Recurse -Filter chrome.exe -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match "Chrome for Testing" } |
        Select-Object -First 1
    if ($chromeForTesting) {
        $chrome = $chromeForTesting.FullName
        $browserKind = "chrome_for_testing"
    }
}

if (-not $chrome) {
    $chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
    $browserKind = "regular_chrome"
    Write-Warning "Regular Chrome may ignore --load-extension in recent versions. Install Chrome for Testing or Playwright Chromium if the Hunt extension does not load."
}

$profile = $env:HUNT_C3_CHROME_PROFILE
if (-not $profile) {
    if ($browserKind -eq "playwright_chromium") {
        $profile = Join-Path $env:LOCALAPPDATA "Hunt\ChromeC3PlaywrightProfile"
    } else {
        $profile = Join-Path $env:LOCALAPPDATA "Hunt\ChromeC3Profile"
    }
}

if (-not (Test-Path -LiteralPath $chrome)) {
    throw "Chrome executable not found: $chrome"
}

if (-not (Test-Path -LiteralPath (Join-Path $extension "manifest.json"))) {
    throw "Hunt extension manifest not found: $extension"
}

$resetProfile = $env:HUNT_C3_CHROME_RESET_PROFILE -in @("1", "true", "TRUE", "yes", "YES")
if ($resetProfile -and (Test-Path -LiteralPath $profile)) {
    $huntRoot = Join-Path $env:LOCALAPPDATA "Hunt"
    $resolvedHuntRoot = [System.IO.Path]::GetFullPath($huntRoot).TrimEnd('\')
    $resolvedProfile = [System.IO.Path]::GetFullPath($profile).TrimEnd('\')
    $profileName = Split-Path -Leaf $resolvedProfile
    $isSafeParallelProfile =
        $resolvedProfile.StartsWith($resolvedHuntRoot + "\", [System.StringComparison]::OrdinalIgnoreCase) -and
        $profileName.StartsWith("ChromeC3PlaywrightParallel", [System.StringComparison]::OrdinalIgnoreCase)
    if (-not $isSafeParallelProfile) {
        throw "Refusing to reset non-parallel C3 profile: $resolvedProfile"
    }
    $profileUsers = Get-CimInstance Win32_Process |
        Where-Object { $_.CommandLine -like "*$resolvedProfile*" }
    if ($profileUsers) {
        $owners = ($profileUsers | Select-Object -ExpandProperty ProcessId) -join ", "
        throw "Refusing to reset profile because it is still in use by process id(s): $owners"
    }
    Remove-Item -LiteralPath $resolvedProfile -Recurse -Force
    Write-Host "Reset C3 parallel profile: $resolvedProfile"
}

New-Item -ItemType Directory -Force -Path $profile | Out-Null

function Merge-JsonObject {
    param(
        [Parameter(Mandatory=$true)] $Target,
        [Parameter(Mandatory=$true)] $Patch
    )
    foreach ($property in $Patch.PSObject.Properties) {
        $name = $property.Name
        $value = $property.Value
        $existing = $Target.PSObject.Properties[$name]
        if ($existing -and $value -is [pscustomobject] -and $existing.Value -is [pscustomobject]) {
            Merge-JsonObject -Target $existing.Value -Patch $value
        } else {
            if ($existing) {
                $existing.Value = $value
            } else {
                $Target | Add-Member -NotePropertyName $name -NotePropertyValue $value
            }
        }
    }
}

function Disable-PasswordManagerForProfile {
    param(
        [Parameter(Mandatory=$true)][string]$ProfilePath
    )
    $defaultProfile = Join-Path $ProfilePath "Default"
    New-Item -ItemType Directory -Force -Path $defaultProfile | Out-Null
    $preferencesPath = Join-Path $defaultProfile "Preferences"
    if (Test-Path -LiteralPath $preferencesPath) {
        try {
            $preferences = Get-Content -LiteralPath $preferencesPath -Raw | ConvertFrom-Json
        } catch {
            Write-Warning "Could not parse Chrome Preferences for password-manager disablement: $($_.Exception.Message)"
            $preferences = [pscustomobject]@{}
        }
    } else {
        $preferences = [pscustomobject]@{}
    }
    $patch = [pscustomobject]@{
        credentials_enable_service = $false
        profile = [pscustomobject]@{
            password_manager_enabled = $false
        }
        password_manager = [pscustomobject]@{
            account_storage_per_account_settings = [pscustomobject]@{}
        }
    }
    Merge-JsonObject -Target $preferences -Patch $patch
    $preferences |
        ConvertTo-Json -Depth 20 |
        Set-Content -LiteralPath $preferencesPath -Encoding UTF8
}

Disable-PasswordManagerForProfile -ProfilePath $profile

$windowPosition = $env:HUNT_C3_CHROME_WINDOW_POSITION
$windowSize = $env:HUNT_C3_CHROME_WINDOW_SIZE
if (-not $windowSize) {
    $windowSize = "1400,1000"
}
if (-not $windowPosition) {
    try {
        Add-Type -AssemblyName System.Windows.Forms
        $secondaryScreen = [System.Windows.Forms.Screen]::AllScreens |
            Where-Object { -not $_.Primary } |
            Sort-Object { $_.Bounds.X }, { $_.Bounds.Y } |
            Select-Object -First 1
        if ($secondaryScreen) {
            $x = $secondaryScreen.WorkingArea.X + 40
            $y = $secondaryScreen.WorkingArea.Y + 40
            $windowPosition = "$x,$y"
        }
    } catch {
        Write-Warning "Could not detect secondary monitors for C3 Chrome window placement: $($_.Exception.Message)"
    }
}

$existingEndpoint = Get-NetTCPConnection -LocalPort $debugPort -State Listen -ErrorAction SilentlyContinue
if ($existingEndpoint) {
    $owners = $existingEndpoint |
        Select-Object -ExpandProperty OwningProcess -Unique |
        ForEach-Object { Get-CimInstance Win32_Process -Filter "ProcessId = $_" }
    $expectedOwner = $owners |
        Where-Object {
            $_.CommandLine -like "*$profile*" -and
            $_.CommandLine -like "*--load-extension*"
    } |
        Select-Object -First 1
    if ($expectedOwner) {
        Write-Host "Chrome DevTools endpoint already active: http://127.0.0.1:$debugPort"
        Write-Host "Owner: $($expectedOwner.ProcessId)"
        return
    }
    throw "Port $debugPort is already in use by another process. Close the old debug browser or free port $debugPort before launching C3 Chrome."
}

$arguments = @(
    "--remote-debugging-port=$debugPort",
    "--user-data-dir=$profile",
    "--disable-extensions-except=$extension",
    "--load-extension=$extension",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-save-password-bubble",
    "--window-size=$windowSize"
)
if ($windowPosition) {
    $arguments += "--window-position=$windowPosition"
}
$startMinimized = $env:HUNT_C3_CHROME_START_MINIMIZED -in @("1", "true", "TRUE", "yes", "YES")
$isolatedDesktop = $env:HUNT_C3_CHROME_ISOLATED_DESKTOP -in @("1", "true", "TRUE", "yes", "YES")
if ($startMinimized) {
    $arguments += "--start-minimized"
}

$foregroundBeforeLaunch = [IntPtr]::Zero
if ($startMinimized -and -not $isolatedDesktop) {
    if (-not ("C3LaunchWindowSafety" -as [type])) {
        Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class C3LaunchWindowSafety {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    public static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder lpClassName, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(
        IntPtr hWnd,
        IntPtr hWndInsertAfter,
        int X,
        int Y,
        int cx,
        int cy,
        uint uFlags
    );

    [DllImport("user32.dll")]
    public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
}
"@
    }
    $foregroundBeforeLaunch = [C3LaunchWindowSafety]::GetForegroundWindow()
}

if ($isolatedDesktop) {
    if (-not ("C3IsolatedDesktopLaunch" -as [type])) {
        Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class C3IsolatedDesktopLaunch {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct STARTUPINFO {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr CreateDesktop(
        string lpszDesktop,
        IntPtr lpszDevice,
        IntPtr pDevmode,
        int dwFlags,
        uint dwDesiredAccess,
        IntPtr lpsa
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
    public static extern bool EnumDesktopWindows(
        IntPtr hDesktop,
        EnumWindowsProc lpfn,
        IntPtr lParam
    );

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    public static extern int GetClassName(
        IntPtr hWnd,
        StringBuilder lpClassName,
        int nMaxCount
    );

    [DllImport("user32.dll")]
    public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CreateProcess(
        string lpApplicationName,
        StringBuilder lpCommandLine,
        IntPtr lpProcessAttributes,
        IntPtr lpThreadAttributes,
        bool bInheritHandles,
        uint dwCreationFlags,
        IntPtr lpEnvironment,
        string lpCurrentDirectory,
        ref STARTUPINFO lpStartupInfo,
        out PROCESS_INFORMATION lpProcessInformation
    );

    [DllImport("kernel32.dll")]
    public static extern bool CloseHandle(IntPtr hObject);
}
"@
    }
    $desktopName = "HuntC3_$debugPort"
    # DESKTOP_CREATEWINDOW | DESKTOP_ENUMERATE | DESKTOP_READOBJECTS |
    # DESKTOP_WRITEOBJECTS. Deliberately omit the switch-desktop right.
    $desktopAccess = [uint32]0x00C3
    $desktopHandle = [C3IsolatedDesktopLaunch]::CreateDesktop(
        $desktopName,
        [IntPtr]::Zero,
        [IntPtr]::Zero,
        0,
        $desktopAccess,
        [IntPtr]::Zero
    )
    if ($desktopHandle -eq [IntPtr]::Zero) {
        $desktopHandle = [C3IsolatedDesktopLaunch]::OpenDesktop(
            $desktopName,
            0,
            $false,
            $desktopAccess
        )
    }
    if ($desktopHandle -eq [IntPtr]::Zero) {
        throw "Could not create or open isolated Windows desktop $desktopName."
    }
    try {
        $startupInfo = New-Object C3IsolatedDesktopLaunch+STARTUPINFO
        $startupInfo.cb = [Runtime.InteropServices.Marshal]::SizeOf(
            [type]"C3IsolatedDesktopLaunch+STARTUPINFO"
        )
        $startupInfo.lpDesktop = "winsta0\$desktopName"
        # STARTF_USESHOWWINDOW / SW_SHOWMINNOACTIVE.
        $startupInfo.dwFlags = 0x00000001
        $startupInfo.wShowWindow = 7
        $processInfo = New-Object C3IsolatedDesktopLaunch+PROCESS_INFORMATION
        $commandLine = New-Object System.Text.StringBuilder
        [void]$commandLine.Append('"').Append($chrome).Append('"')
        foreach ($argument in $arguments) {
            [void]$commandLine.Append(' "').Append(
                ([string]$argument).Replace('"', '\"')
            ).Append('"')
        }
        $created = [C3IsolatedDesktopLaunch]::CreateProcess(
            $chrome,
            $commandLine,
            [IntPtr]::Zero,
            [IntPtr]::Zero,
            $false,
            0x00000200,
            [IntPtr]::Zero,
            $repoRoot,
            [ref]$startupInfo,
            [ref]$processInfo
        )
        if (-not $created) {
            $win32Error = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
            throw "Could not start C3 Chrome on isolated desktop $desktopName (Win32 $win32Error)."
        }
        [C3IsolatedDesktopLaunch]::CloseHandle($processInfo.hThread) | Out-Null
        [C3IsolatedDesktopLaunch]::CloseHandle($processInfo.hProcess) | Out-Null
        $launchedProcess = Get-Process -Id $processInfo.dwProcessId -ErrorAction Stop
        $endpointReady = $false
        $endpointDeadline = (Get-Date).AddSeconds(12)
        do {
            if ($launchedProcess.HasExited) {
                break
            }
            try {
                Invoke-RestMethod "http://127.0.0.1:$debugPort/json/version" -TimeoutSec 1 |
                    Out-Null
                $endpointReady = $true
                break
            } catch {
                Start-Sleep -Milliseconds 100
            }
        } while ((Get-Date) -lt $endpointDeadline)
        if (-not $endpointReady) {
            throw "C3 Chrome DevTools endpoint did not become reachable on isolated desktop $desktopName."
        }
        $isolatedWindows = New-Object System.Collections.Generic.List[System.IntPtr]
        $isolatedCallback = [C3IsolatedDesktopLaunch+EnumWindowsProc]{
            param([IntPtr]$hWnd, [IntPtr]$lParam)
            [uint32]$windowProcessId = 0
            [C3IsolatedDesktopLaunch]::GetWindowThreadProcessId(
                $hWnd,
                [ref]$windowProcessId
            ) | Out-Null
            if ($windowProcessId -ne [uint32]$launchedProcess.Id) {
                return $true
            }
            $className = New-Object System.Text.StringBuilder 256
            [C3IsolatedDesktopLaunch]::GetClassName(
                $hWnd,
                $className,
                $className.Capacity
            ) | Out-Null
            if ($className.ToString() -eq "Chrome_WidgetWin_1") {
                $isolatedWindows.Add($hWnd) | Out-Null
            }
            $true
        }
        [C3IsolatedDesktopLaunch]::EnumDesktopWindows(
            $desktopHandle,
            $isolatedCallback,
            [IntPtr]::Zero
        ) | Out-Null
        if ($isolatedWindows.Count -eq 0) {
            throw "C3 Chrome created no top-level window on isolated desktop $desktopName."
        }
        foreach ($isolatedWindow in $isolatedWindows) {
            [C3IsolatedDesktopLaunch]::ShowWindowAsync($isolatedWindow, 7) | Out-Null
        }
        Start-Sleep -Milliseconds 300
        foreach ($isolatedWindow in $isolatedWindows) {
            if (-not [C3IsolatedDesktopLaunch]::IsIconic($isolatedWindow)) {
                [C3IsolatedDesktopLaunch]::ShowWindow($isolatedWindow, 6) | Out-Null
            }
        }
        $isolatedSettleDeadline = (Get-Date).AddSeconds(4)
        do {
            foreach ($isolatedWindow in $isolatedWindows) {
                [C3IsolatedDesktopLaunch]::ShowWindowAsync(
                    $isolatedWindow,
                    7
                ) | Out-Null
            }
            Start-Sleep -Milliseconds 50
        } while ((Get-Date) -lt $isolatedSettleDeadline)
    } finally {
        [C3IsolatedDesktopLaunch]::CloseDesktop($desktopHandle) | Out-Null
    }
} elseif ($startMinimized) {
    # Chrome can briefly activate a normal window before honoring
    # --start-minimized. Create the process hidden, position its hidden
    # top-level window, and only then expose it as minimized/no-activate.
    $launchedProcess = Start-Process -FilePath $chrome -ArgumentList $arguments -WindowStyle Hidden -PassThru
} else {
    Start-Process -FilePath $chrome -ArgumentList $arguments
}

if ($startMinimized -and -not $isolatedDesktop) {
    if (-not $windowPosition) {
        throw "A minimized C3 Chrome launch requires an explicit non-primary window position."
    }
    $positionParts = $windowPosition -split ","
    $sizeParts = $windowSize -split ","
    if ($positionParts.Count -ne 2 -or $sizeParts.Count -ne 2) {
        throw "Invalid C3 Chrome window position or size."
    }
    $targetX = [int]$positionParts[0]
    $targetY = [int]$positionParts[1]
    $targetWidth = [int]$sizeParts[0]
    $targetHeight = [int]$sizeParts[1]

    $laneWindow = [IntPtr]::Zero
    $laneEverForeground = $false
    $windowDeadline = (Get-Date).AddSeconds(10)
    do {
        $foregroundNow = [C3LaunchWindowSafety]::GetForegroundWindow()
        [uint32]$foregroundProcessId = 0
        [C3LaunchWindowSafety]::GetWindowThreadProcessId(
            $foregroundNow,
            [ref]$foregroundProcessId
        ) | Out-Null
        $foregroundProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $foregroundProcessId" -ErrorAction SilentlyContinue
        $laneTookForeground =
            $foregroundProcess -and
            $foregroundProcess.Name -eq "chrome.exe" -and
            (
                $foregroundProcess.CommandLine -like "*--remote-debugging-port=$debugPort*" -or
                $foregroundProcess.CommandLine -like "*$profile*"
            )
        if ($laneTookForeground) {
            $laneEverForeground = $true
            [C3LaunchWindowSafety]::ShowWindowAsync($foregroundNow, 7) | Out-Null
            if ($foregroundBeforeLaunch -ne [IntPtr]::Zero) {
                [C3LaunchWindowSafety]::SetForegroundWindow($foregroundBeforeLaunch) | Out-Null
            }
        }

        $candidateWindows = New-Object System.Collections.Generic.List[System.IntPtr]
        $windowCallback = [C3LaunchWindowSafety+EnumWindowsProc]{
            param([IntPtr]$hWnd, [IntPtr]$lParam)
            [uint32]$windowProcessId = 0
            [C3LaunchWindowSafety]::GetWindowThreadProcessId($hWnd, [ref]$windowProcessId) | Out-Null
            if ($windowProcessId -ne [uint32]$launchedProcess.Id) {
                return $true
            }
            $className = New-Object System.Text.StringBuilder 256
            [C3LaunchWindowSafety]::GetClassName($hWnd, $className, $className.Capacity) | Out-Null
            if ($className.ToString() -eq "Chrome_WidgetWin_1") {
                $candidateWindows.Add($hWnd) | Out-Null
            }
            $true
        }
        [C3LaunchWindowSafety]::EnumWindows($windowCallback, [IntPtr]::Zero) | Out-Null
        if ($candidateWindows.Count -gt 0) {
            $laneWindow = $candidateWindows[0]
            break
        }
        Start-Sleep -Milliseconds 25
    } while ((Get-Date) -lt $windowDeadline)

    if ($laneWindow -eq [IntPtr]::Zero) {
        throw "C3 Chrome did not create a hidden top-level window on port $debugPort."
    }
    if ([C3LaunchWindowSafety]::IsWindowVisible($laneWindow)) {
        throw "C3 Chrome became visible before safe placement on port $debugPort."
    }

    # SWP_NOZORDER | SWP_NOACTIVATE. The window is still hidden here.
    $placed = [C3LaunchWindowSafety]::SetWindowPos(
        $laneWindow,
        [IntPtr]::Zero,
        $targetX,
        $targetY,
        $targetWidth,
        $targetHeight,
        0x0014
    )
    if (-not $placed) {
        throw "Could not place hidden C3 Chrome window on port $debugPort."
    }

    # SW_SHOWMINNOACTIVE: minimized and never activated.
    [C3LaunchWindowSafety]::ShowWindowAsync($laneWindow, 7) | Out-Null
    $settleDeadline = (Get-Date).AddSeconds(4)
    do {
        $foregroundNow = [C3LaunchWindowSafety]::GetForegroundWindow()
        [uint32]$foregroundProcessId = 0
        [C3LaunchWindowSafety]::GetWindowThreadProcessId(
            $foregroundNow,
            [ref]$foregroundProcessId
        ) | Out-Null
        if ($foregroundProcessId -eq [uint32]$launchedProcess.Id) {
            $laneEverForeground = $true
            [C3LaunchWindowSafety]::ShowWindowAsync($laneWindow, 7) | Out-Null
            if ($foregroundBeforeLaunch -ne [IntPtr]::Zero) {
                [C3LaunchWindowSafety]::SetForegroundWindow($foregroundBeforeLaunch) | Out-Null
            }
        }
        Start-Sleep -Milliseconds 25
    } while ((Get-Date) -lt $settleDeadline)

    $foregroundAfterLaunch = [C3LaunchWindowSafety]::GetForegroundWindow()
    [uint32]$foregroundAfterProcessId = 0
    [C3LaunchWindowSafety]::GetWindowThreadProcessId(
        $foregroundAfterLaunch,
        [ref]$foregroundAfterProcessId
    ) | Out-Null
    $foregroundAfterProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $foregroundAfterProcessId" -ErrorAction SilentlyContinue
    $laneStillForeground =
        $foregroundAfterProcess -and
        $foregroundAfterProcess.Name -eq "chrome.exe" -and
        (
            $foregroundAfterProcess.CommandLine -like "*--remote-debugging-port=$debugPort*" -or
            $foregroundAfterProcess.CommandLine -like "*$profile*"
        )
    if ($laneStillForeground) {
        throw "C3 Chrome launch failed no-focus verification on port $debugPort."
    }
    if ($laneEverForeground) {
        throw "C3 Chrome took foreground at least once during launch on port $debugPort."
    }
    if (-not [C3LaunchWindowSafety]::IsIconic($laneWindow)) {
        throw "C3 Chrome launch did not remain minimized on port $debugPort."
    }
}

Write-Host "Started C3 Chrome DevTools endpoint: http://127.0.0.1:$debugPort"
Write-Host "Browser kind: $browserKind"
Write-Host "Browser: $chrome"
Write-Host "Profile: $profile"
if ($windowPosition) {
    Write-Host "Window position: $windowPosition"
} else {
    Write-Host "Window position: default"
}
Write-Host "Window size: $windowSize"
Write-Host "Extension: $extension"
if ($isolatedDesktop) {
    Write-Host "Windows desktop: HuntC3_$debugPort (isolated, not switched)"
}
