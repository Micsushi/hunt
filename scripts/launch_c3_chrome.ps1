$ErrorActionPreference = "Stop"

$extension = "C:\Users\sushi\Documents\Github\hunt\executioner"
$browserKind = "override"
$chrome = $env:HUNT_C3_CHROME

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

New-Item -ItemType Directory -Force -Path $profile | Out-Null

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

$existingEndpoint = Get-NetTCPConnection -LocalPort 9222 -State Listen -ErrorAction SilentlyContinue
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
        Write-Host "Chrome DevTools endpoint already active: http://127.0.0.1:9222"
        Write-Host "Owner: $($expectedOwner.ProcessId)"
        return
    }
    throw "Port 9222 is already in use by another process. Close the old debug browser or free port 9222 before launching C3 Chrome."
}

$arguments = @(
    "--remote-debugging-port=9222",
    "--user-data-dir=$profile",
    "--disable-extensions-except=$extension",
    "--load-extension=$extension",
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=$windowSize"
)
if ($windowPosition) {
    $arguments += "--window-position=$windowPosition"
}

Start-Process -FilePath $chrome -ArgumentList $arguments
Write-Host "Started C3 Chrome DevTools endpoint: http://127.0.0.1:9222"
Write-Host "Browser kind: $browserKind"
Write-Host "Browser: $chrome"
Write-Host "Profile: $profile"
Write-Host "Window position: $($windowPosition -or 'default')"
Write-Host "Window size: $windowSize"
Write-Host "Extension: $extension"
