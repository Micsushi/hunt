param(
  [ValidateSet("ui", "c0", "c1", "c2", "full")]
  [string]$Mode = "ui"
)

$ErrorActionPreference = "Stop"

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$FrontendDir = Join-Path $RepoRoot "frontend"
$ComposeFile = Join-Path $RepoRoot "docker-compose.pipeline.yml"

function Start-ComposeProfile([string]$Profile) {
  docker compose -f $ComposeFile --profile $Profile up -d --build
}

function Start-Vite() {
  Set-Location $FrontendDir
  npm run vite:raw
}

if ($Mode -eq "ui") {
  $env:VITE_MOCK_BACKEND = "true"
  Start-Vite
  exit
}

if ($Mode -eq "c0") {
  Start-ComposeProfile "c0"
} elseif ($Mode -eq "c1") {
  Start-ComposeProfile "c1"
} elseif ($Mode -eq "c2") {
  Start-ComposeProfile "c2"
} elseif ($Mode -eq "full") {
  Start-ComposeProfile "all"
  Write-Host "C3 is manual: load unpacked extension from executioner/. C4 is not started."
}

$env:VITE_BACKEND_URL = "http://127.0.0.1:18080"
Start-Vite
