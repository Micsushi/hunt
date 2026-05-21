$ErrorActionPreference = "Stop"

$extension = "C:\Users\sushi\Documents\Github\hunt\executioner"
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

Start-Process -FilePath $chrome -ArgumentList $arguments
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
