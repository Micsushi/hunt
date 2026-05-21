param(
    [Parameter(Mandatory=$true)][string]$BatchId,
    [string]$Ports = "9401,9402,9403,9404,9405",
    [string]$LogsRoot = "logs",
    [switch]$NoResetProfiles,
    [int]$WindowX = 2200,
    [int]$WindowY = 80,
    [int]$WindowWidth = 1400,
    [int]$WindowHeight = 1000,
    [int]$WindowGap = 40,
    [switch]$ReloadExtension
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$launchScript = Join-Path $repoRoot "scripts\launch_c3_chrome.ps1"
$reloadScript = Join-Path $repoRoot "scripts\reload_c3_extension.py"
$closeBlockedScript = Join-Path $repoRoot "scripts\c3_close_blocked_extension_tabs.js"
$configureScript = Join-Path $repoRoot "scripts\configure_c3_debug_sink.js"
$batchLogDir = Join-Path $repoRoot (Join-Path $LogsRoot $BatchId)
$currentDebug = Join-Path $batchLogDir "current_debug.md"
$lanePorts = $Ports -split "," | ForEach-Object { [int]$_.Trim() } | Where-Object { $_ -gt 0 }

if (-not $lanePorts) {
    throw "No lane ports were provided."
}

New-Item -ItemType Directory -Force -Path $batchLogDir | Out-Null
if (-not (Test-Path -LiteralPath $currentDebug)) {
    Set-Content -LiteralPath $currentDebug -Value "# C3 batch debug: $BatchId`n" -Encoding UTF8
}

function Invoke-LoggedCommand {
    param(
        [Parameter(Mandatory=$true)][string]$LogPath,
        [Parameter(Mandatory=$true)][scriptblock]$Command
    )
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $LogPath) | Out-Null
    try {
        & $Command *> $LogPath
        $exitCode = if ($null -ne $global:LASTEXITCODE) { $global:LASTEXITCODE } else { 0 }
        if ($exitCode -ne 0) {
            throw "Command failed with exit code $exitCode. See $LogPath"
        }
    } catch {
        if (Test-Path -LiteralPath $LogPath) {
            Get-Content -LiteralPath $LogPath -Tail 40 | ForEach-Object { Write-Warning $_ }
        }
        throw
    }
}

function Stop-StaleLaneProcesses {
    param(
        [Parameter(Mandatory=$true)][int]$Port,
        [Parameter(Mandatory=$true)][string]$Profile
    )
    $escapedProfile = [regex]::Escape($Profile)
    $escapedPort = [regex]::Escape("--remote-debugging-port=$Port")
    $stale = Get-CimInstance Win32_Process |
        Where-Object {
            $_.Name -eq "chrome.exe" -and (
                $_.CommandLine -match $escapedProfile -or
                $_.CommandLine -match $escapedPort
            )
        }
    foreach ($process in $stale) {
        Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Milliseconds 500
}

function Wait-DevToolsEndpoint {
    param([Parameter(Mandatory=$true)][int]$Port)
    $lastError = $null
    for ($attempt = 0; $attempt -lt 40; $attempt += 1) {
        try {
            return Invoke-RestMethod "http://127.0.0.1:$Port/json/list" -TimeoutSec 2
        } catch {
            $lastError = $_.Exception.Message
            Start-Sleep -Milliseconds 500
        }
    }
    throw "DevTools endpoint did not become reachable on port $Port. Last error: $lastError"
}

function Test-LanePreflight {
    param(
        [Parameter(Mandatory=$true)][int]$Port,
        [Parameter(Mandatory=$true)][string]$Profile,
        [Parameter(Mandatory=$true)]$Inspect
    )
    $targets = Invoke-RestMethod "http://127.0.0.1:$Port/json/list" -TimeoutSec 5
    $extensionTarget = $targets | Where-Object {
        [string]$_.url -match "chrome-extension://" -and (
            [string]$_.url -match "/src/background/index.js" -or
            [string]$_.url -match "/src/options/options.html" -or
            [string]$_.url -match "/src/popup/popup.html"
        )
    } | Select-Object -First 1
    if (-not $extensionTarget) {
        throw "Lane $Port has no reachable Hunt extension target."
    }
    $blockedTarget = $targets | Where-Object {
        [string]$_.title -match "is blocked|ERR_BLOCKED_BY_CLIENT" -or
        ([string]$_.url -match "^chrome-error://" -and [string]$_.title -match "blocked")
    } | Select-Object -First 1
    if ($blockedTarget) {
        throw "Lane $Port still has a blocked extension tab: $($blockedTarget.title)"
    }
    if (-not ([string]$Inspect.browserContext -eq "p_chrome")) {
        throw "Lane $Port browserContext was not p_chrome."
    }
    if (-not $Inspect.profileCounts) {
        throw "Lane $Port did not report seeded profile counts."
    }
    $profileCounts = $Inspect.profileCounts
    foreach ($name in @("workExperience", "education", "skills", "websites")) {
        if ([int]$profileCounts.$name -le 0) {
            throw "Lane $Port profile count $name is empty."
        }
    }
    $owner = Get-CimInstance Win32_Process |
        Where-Object {
            $_.Name -eq "chrome.exe" -and
            $_.CommandLine -match [regex]::Escape("--remote-debugging-port=$Port")
        } |
        Select-Object -First 1
    if (-not $owner) {
        throw "Lane $Port has no root chrome process."
    }
    if ($owner.CommandLine -notmatch "ms-playwright") {
        throw "Lane $Port is not using Playwright Chromium."
    }
    if ($owner.CommandLine -notmatch [regex]::Escape($Profile)) {
        throw "Lane $Port is not using expected profile $Profile."
    }
}

$summary = @()

for ($index = 0; $index -lt $lanePorts.Count; $index += 1) {
    $port = $lanePorts[$index]
    $profile = Join-Path $env:LOCALAPPDATA "Hunt\ChromeC3PlaywrightParallel_${BatchId}_$port"
    $laneLogPrefix = Join-Path $batchLogDir "lane_$port"
    $position = "{0},{1}" -f ($WindowX + (($index % 2) * ($WindowWidth + $WindowGap))), ($WindowY + ([math]::Floor($index / 2) * ($WindowHeight + $WindowGap)))
    $size = "$WindowWidth,$WindowHeight"

    Stop-StaleLaneProcesses -Port $port -Profile $profile

    $oldEnv = @{
        Port = $env:HUNT_C3_CHROME_REMOTE_DEBUGGING_PORT
        Profile = $env:HUNT_C3_CHROME_PROFILE
        Position = $env:HUNT_C3_CHROME_WINDOW_POSITION
        Size = $env:HUNT_C3_CHROME_WINDOW_SIZE
        Reset = $env:HUNT_C3_CHROME_RESET_PROFILE
    }
    try {
        $env:HUNT_C3_CHROME_REMOTE_DEBUGGING_PORT = [string]$port
        $env:HUNT_C3_CHROME_PROFILE = $profile
        $env:HUNT_C3_CHROME_WINDOW_POSITION = $position
        $env:HUNT_C3_CHROME_WINDOW_SIZE = $size
        if ($NoResetProfiles) {
            Remove-Item Env:\HUNT_C3_CHROME_RESET_PROFILE -ErrorAction SilentlyContinue
        } else {
            $env:HUNT_C3_CHROME_RESET_PROFILE = "1"
        }

        Invoke-LoggedCommand -LogPath "$laneLogPrefix.launch.log" -Command {
            powershell -NoProfile -ExecutionPolicy Bypass -File $launchScript
        }
    } finally {
        if ($null -eq $oldEnv.Port) { Remove-Item Env:\HUNT_C3_CHROME_REMOTE_DEBUGGING_PORT -ErrorAction SilentlyContinue } else { $env:HUNT_C3_CHROME_REMOTE_DEBUGGING_PORT = $oldEnv.Port }
        if ($null -eq $oldEnv.Profile) { Remove-Item Env:\HUNT_C3_CHROME_PROFILE -ErrorAction SilentlyContinue } else { $env:HUNT_C3_CHROME_PROFILE = $oldEnv.Profile }
        if ($null -eq $oldEnv.Position) { Remove-Item Env:\HUNT_C3_CHROME_WINDOW_POSITION -ErrorAction SilentlyContinue } else { $env:HUNT_C3_CHROME_WINDOW_POSITION = $oldEnv.Position }
        if ($null -eq $oldEnv.Size) { Remove-Item Env:\HUNT_C3_CHROME_WINDOW_SIZE -ErrorAction SilentlyContinue } else { $env:HUNT_C3_CHROME_WINDOW_SIZE = $oldEnv.Size }
        if ($null -eq $oldEnv.Reset) { Remove-Item Env:\HUNT_C3_CHROME_RESET_PROFILE -ErrorAction SilentlyContinue } else { $env:HUNT_C3_CHROME_RESET_PROFILE = $oldEnv.Reset }
    }

    Wait-DevToolsEndpoint -Port $port | Out-Null

    Invoke-LoggedCommand -LogPath "$laneLogPrefix.close_blocked_tabs.log" -Command {
        node $closeBlockedScript --port $port
    }
    Invoke-LoggedCommand -LogPath "$laneLogPrefix.seed.log" -Command {
        node $configureScript --port $port --seed-workday-profile
    }
    Start-Sleep -Seconds 1
    Invoke-LoggedCommand -LogPath "$laneLogPrefix.seed_confirm.log" -Command {
        node $configureScript --port $port --seed-workday-profile
    }
    if ($ReloadExtension) {
        Invoke-LoggedCommand -LogPath "$laneLogPrefix.reload.log" -Command {
            python $reloadScript --port $port
        }
        Invoke-LoggedCommand -LogPath "$laneLogPrefix.post_reload_close_blocked_tabs.log" -Command {
            node $closeBlockedScript --port $port
        }
        Invoke-LoggedCommand -LogPath "$laneLogPrefix.post_reload_seed.log" -Command {
            node $configureScript --port $port --seed-workday-profile
        }
    }
    Invoke-LoggedCommand -LogPath "$laneLogPrefix.inspect.log" -Command {
        node $configureScript --port $port --inspect-only
    }
    $inspect = Get-Content -LiteralPath "$laneLogPrefix.inspect.log" -Raw | ConvertFrom-Json
    Test-LanePreflight -Port $port -Profile $profile -Inspect $inspect

    $summary += [pscustomobject]@{
        port = $port
        profile = $profile
        position = $position
        size = $size
        browserContext = $inspect.browserContext
        profileCounts = $inspect.profileCounts
    }
}

$summaryPath = Join-Path $batchLogDir "lane_setup_summary.json"
$summary | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $summaryPath -Encoding UTF8
Write-Host "Prepared C3 parallel lanes for batch $BatchId"
Write-Host "Summary: $summaryPath"
Write-Host "Current debug: $currentDebug"
