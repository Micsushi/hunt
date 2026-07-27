param(
    [Parameter(Mandatory=$true)][string]$EvidenceRoot,
    [int]$Port = 8000
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$python = Join-Path $repoRoot ".venv\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $python)) {
    throw "Hunt virtualenv Python not found: $python"
}

$resolvedRoot = [System.IO.Path]::GetFullPath($EvidenceRoot)
$repoPath = [System.IO.Path]::GetFullPath($repoRoot).TrimEnd('\')
if ($resolvedRoot.StartsWith($repoPath + "\", [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Audit evidence root must stay outside the Hunt repository."
}

$existing = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($existing) {
    $owners = ($existing | Select-Object -ExpandProperty OwningProcess -Unique) -join ", "
    throw "Port $Port is already in use by process id(s): $owners"
}

New-Item -ItemType Directory -Force -Path $resolvedRoot | Out-Null
$ledgerRoot = Join-Path $resolvedRoot "ledger"
New-Item -ItemType Directory -Force -Path $ledgerRoot | Out-Null

$stdoutPath = Join-Path $resolvedRoot "backend.stdout.log"
$stderrPath = Join-Path $resolvedRoot "backend.stderr.log"
$pidPath = Join-Path $resolvedRoot "backend.pid"

$oldLedgerRoot = $env:HUNT_LEDGER_ROOT
$oldReviewPort = $env:REVIEW_APP_PORT
try {
    $env:HUNT_LEDGER_ROOT = $ledgerRoot
    $env:REVIEW_APP_PORT = [string]$Port
    $process = Start-Process `
        -FilePath $python `
        -ArgumentList "-m", "backend.app" `
        -WorkingDirectory $repoRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput $stdoutPath `
        -RedirectStandardError $stderrPath `
        -PassThru
} finally {
    if ($null -eq $oldLedgerRoot) {
        Remove-Item Env:\HUNT_LEDGER_ROOT -ErrorAction SilentlyContinue
    } else {
        $env:HUNT_LEDGER_ROOT = $oldLedgerRoot
    }
    if ($null -eq $oldReviewPort) {
        Remove-Item Env:\REVIEW_APP_PORT -ErrorAction SilentlyContinue
    } else {
        $env:REVIEW_APP_PORT = $oldReviewPort
    }
}

Set-Content -LiteralPath $pidPath -Value $process.Id -Encoding ascii
$deadline = (Get-Date).AddSeconds(30)
$health = $null
do {
    Start-Sleep -Milliseconds 500
    try {
        $health = Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 2
    } catch {
        $health = $null
    }
} while (-not $health -and (Get-Date) -lt $deadline)

if (-not $health) {
    if (-not $process.HasExited) {
        Stop-Process -Id $process.Id -Force
    }
    $stderr = if (Test-Path -LiteralPath $stderrPath) {
        (Get-Content -LiteralPath $stderrPath -Tail 80) -join [Environment]::NewLine
    } else {
        ""
    }
    throw "C3 audit backend failed to start.`n$stderr"
}

$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop |
    Select-Object -First 1
$serverProcessId = [int]$listener.OwningProcess
Set-Content -LiteralPath $pidPath -Value $serverProcessId -Encoding ascii

[pscustomobject]@{
    ok = $true
    processId = $serverProcessId
    launcherProcessId = $process.Id
    port = $Port
    evidenceRoot = $resolvedRoot
    ledgerRoot = $ledgerRoot
    stdout = $stdoutPath
    stderr = $stderrPath
} | ConvertTo-Json -Depth 4
