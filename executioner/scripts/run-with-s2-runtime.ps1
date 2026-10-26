[CmdletBinding()]
param(
    [Parameter(Mandatory, Position = 0)]
    [string]$Runner,
    [Parameter(ValueFromRemainingArguments)]
    [string[]]$RunnerArguments
)

$ErrorActionPreference = 'Stop'
$executionerRoot = Split-Path -Parent $PSScriptRoot
$runtimeScript = Join-Path $PSScriptRoot 'prepare-s2-runtime.ps1'
& $runtimeScript -Quiet
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$nodeHome = Join-Path $env:LOCALAPPDATA 'Hunt\runtimes\node-v22.23.2-win-x64'
$nodeExe = Join-Path $nodeHome 'node.exe'
$npmCli = Join-Path $nodeHome 'node_modules\npm\bin\npm-cli.js'
$runnerPath = [IO.Path]::GetFullPath((Join-Path $executionerRoot $Runner))
if (-not $runnerPath.StartsWith([IO.Path]::GetFullPath($executionerRoot) + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'runner path invalid'
}
if (-not (Test-Path -LiteralPath $runnerPath -PathType Leaf)) { throw 'runner unavailable' }

$env:npm_execpath = $npmCli
$env:npm_node_execpath = $nodeExe
$env:HUNT_C3_NPM_NODE_EXE = $nodeExe
$env:HUNT_C3_NPM_VERSION = (& $nodeExe $npmCli --version).Trim()
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $env:LOCALAPPDATA 'Hunt\runtimes\playwright-1.62.1'

$readinessRequired = @(
    'scripts\prepare-s2-run.ts',
    'scripts\run-s2-acceptance.ts',
    'scripts\run-s2-isolated.ts',
    'scripts\run-s2-mcp.ts'
) -contains $Runner.Replace('/', '\')
if ($readinessRequired) {
    $certificatePath = $env:HUNT_C3_READINESS_CERTIFICATE
    if ([string]::IsNullOrWhiteSpace($certificatePath)) {
        $retainedRoot = Join-Path $env:LOCALAPPDATA 'Hunt\c3-readiness\retained'
        $certificatePath = Get-ChildItem -LiteralPath $retainedRoot -Filter 'readiness-certificate.json' -File -Recurse -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTimeUtc -Descending |
            Select-Object -First 1 -ExpandProperty FullName
    }
    if ([string]::IsNullOrWhiteSpace($certificatePath) -or -not (Test-Path -LiteralPath $certificatePath -PathType Leaf)) {
        [Console]::Error.WriteLine('{"status":"not_ready","failureClass":"certificate_missing","submitActivated":false}')
        exit 1
    }
    & $nodeExe (Join-Path $PSScriptRoot 'verify-s2-readiness.ts') --certificate ([IO.Path]::GetFullPath($certificatePath))
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

& $nodeExe $runnerPath @RunnerArguments
exit $LASTEXITCODE
