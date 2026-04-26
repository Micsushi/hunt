# Start backend (auto-reload) + frontend (HMR) for development.
# Opens two new terminal windows; close either or run this script's process to stop.
param()
$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..\..")

$python = if (Test-Path "$root\.venv\Scripts\python.exe") { "$root\.venv\Scripts\python.exe" }
          elseif (Test-Path "$root\venv\Scripts\python.exe") { "$root\venv\Scripts\python.exe" }
          else { "python" }

Write-Host "[dev] Starting backend (--reload) on :8000..."
$backend = Start-Process -FilePath "cmd.exe" `
    -ArgumentList "/c", "set HUNT_DEV_MODE=1 && `"$python`" -m backend.app --reload" `
    -WorkingDirectory $root `
    -PassThru -NoNewWindow

Write-Host "[dev] Starting frontend (HMR) on :5173..."
$frontend = Start-Process -FilePath "cmd.exe" `
    -ArgumentList "/c", "npm run dev" `
    -WorkingDirectory (Join-Path $root "frontend") `
    -PassThru -NoNewWindow

Write-Host ""
Write-Host "[dev] Both running. Press Ctrl+C to stop." -ForegroundColor Cyan
Write-Host ""
Write-Host "  --> Open the app here:  http://localhost:5173  <--" -ForegroundColor Green
Write-Host "      (API / legacy UI):  http://localhost:8000" -ForegroundColor DarkGray
Write-Host ""

try {
    Wait-Process -Id $backend.Id, $frontend.Id
} finally {
    Write-Host "[dev] Stopping..."
    if (!$backend.HasExited)  { Stop-Process -Id $backend.Id  -Force -ErrorAction SilentlyContinue }
    if (!$frontend.HasExited) { Stop-Process -Id $frontend.Id -Force -ErrorAction SilentlyContinue }
    Write-Host "[dev] Done."
}
