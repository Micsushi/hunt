[CmdletBinding()]
param(
    [switch]$VerifyOnly,
    [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
$nodeVersion = '22.23.2'
$npmVersion = '10.9.8'
$nodeArchiveSha256 = '1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97'
$executionerRoot = Split-Path -Parent $PSScriptRoot
$runtimeRoot = Join-Path $env:LOCALAPPDATA 'Hunt\runtimes'
$nodeHome = Join-Path $runtimeRoot "node-v$nodeVersion-win-x64"
$nodeExe = Join-Path $nodeHome 'node.exe'
$npmCli = Join-Path $nodeHome 'node_modules\npm\bin\npm-cli.js'
$playwrightVersion = '1.62.1'
$browserRoot = Join-Path $runtimeRoot "playwright-$playwrightVersion"
$lockPath = Join-Path $executionerRoot 'package-lock.json'
$dependencyMarker = Join-Path $executionerRoot 'node_modules\.hunt-c3-runtime.json'
$profilePath = Join-Path ([IO.Path]::GetTempPath()) ("hunt-c3-readiness-" + [guid]::NewGuid().ToString('N'))
$installRoot = Join-Path $runtimeRoot ('.install-' + [guid]::NewGuid().ToString('N'))
$stage = 'runtime_mismatch'
$report = $null
$ownedProcessesStopped = 0

function Get-HuntHeadroom {
    try {
        $samples = (Get-Counter '\Memory\Available Bytes','\Memory\Commit Limit','\Memory\Committed Bytes').CounterSamples
        $values = @{}
        foreach ($sample in $samples) { $values[$sample.Path.Split('\')[-1]] = [double]$sample.CookedValue }
        return [pscustomobject]@{
            AvailablePhysicalBytes = [long]$values['available bytes']
            CommitHeadroomBytes = [long]($values['commit limit'] - $values['committed bytes'])
        }
    } catch {
        return [pscustomobject]@{ AvailablePhysicalBytes = 0; CommitHeadroomBytes = 0 }
    }
}

function New-HuntFailure([string]$code, $headroom, [string]$detail = 'stage_failed') {
    $physical = [math]::Max(0, [long]$headroom.AvailablePhysicalBytes)
    $commit = [math]::Max(0, [long]$headroom.CommitHeadroomBytes)
    $effective = [math]::Min($physical, $commit)
    $installedNodeVersion = 'unavailable'
    $installedNpmVersion = 'unavailable'
    try {
        if (Test-Path -LiteralPath $nodeExe) {
            $installedNodeVersion = (& $nodeExe --version).TrimStart('v')
            if (Test-Path -LiteralPath $npmCli) {
                $installedNpmVersion = (& $nodeExe $npmCli --version).Trim()
            }
        }
    } catch {}
    return [ordered]@{
        schemaVersion = 1
        kind = 's2_runtime_readiness'
        status = 'failed'
        code = $code
        detail = $detail
        nodeVersion = $installedNodeVersion
        npmVersion = $installedNpmVersion
        headroom = [ordered]@{
            availablePhysicalGiB = [math]::Round($physical / 1GB, 2)
            commitHeadroomGiB = [math]::Round($commit / 1GB, 2)
            effectiveGiB = [math]::Round($effective / 1GB, 2)
            low = $effective -lt 8GB
        }
        cleanup = [ordered]@{
            profileRemoved = -not (Test-Path -LiteralPath $profilePath)
            browserProcessExited = $false
            taskOwnedProcessesStopped = $ownedProcessesStopped
        }
    }
}

function Test-HuntChildPath([string]$parent, [string]$child) {
    $parentPath = [IO.Path]::GetFullPath($parent).TrimEnd('\')
    $childPath = [IO.Path]::GetFullPath($child)
    return $childPath.StartsWith($parentPath + '\', [StringComparison]::OrdinalIgnoreCase)
}

function Get-HuntFileSha256([string]$path) {
    $stream = $null
    $sha = $null
    try {
        $stream = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        $sha = [Security.Cryptography.SHA256]::Create()
        return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
    } finally {
        if ($null -ne $sha) { $sha.Dispose() }
        if ($null -ne $stream) { $stream.Dispose() }
    }
}

function Get-HuntToolingIdentity {
    $canonicalGit = Join-Path $env:ProgramFiles 'Git\cmd\git.exe'
    if (Test-Path -LiteralPath $canonicalGit -PathType Leaf) {
        $gitExe = $canonicalGit
    } else { try {
        $gitExe = Get-Command git.exe -All -ErrorAction Stop |
            Select-Object -First 1 -ExpandProperty Source
    } catch { throw 'git_lookup' } }
    $powerShellExe = Join-Path $PSHOME 'powershell.exe'
    if (-not (Test-Path -LiteralPath $gitExe -PathType Leaf) -or
        -not (Test-Path -LiteralPath $powerShellExe -PathType Leaf)) {
        throw 'tool_path'
    }
    try { $gitVersion = (& $gitExe --version).Trim() }
    catch { throw 'git_execute' }
    $powerShellVersion = $PSVersionTable.PSVersion.ToString()
    if ($LASTEXITCODE -ne 0 -or $gitVersion -notmatch '^git version ' -or
        $powerShellVersion -notmatch '^\d+\.\d+') { throw 'tool_identity' }
    try { $gitPath = [IO.Path]::GetFullPath($gitExe) } catch { throw 'git_path' }
    try { $gitSha256 = Get-HuntFileSha256 $gitExe }
    catch { throw 'git_hash' }
    try { $powerShellPath = [IO.Path]::GetFullPath($powerShellExe) } catch { throw 'powershell_path' }
    try { $powerShellSha256 = Get-HuntFileSha256 $powerShellExe }
    catch { throw 'powershell_hash' }
    return [ordered]@{
        gitPath = $gitPath
        gitSha256 = $gitSha256
        gitVersion = $gitVersion
        powerShellPath = $powerShellPath
        powerShellSha256 = $powerShellSha256
        powerShellVersion = $powerShellVersion
    }
}

function Install-HuntNodeRuntime {
    New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
    New-Item -ItemType Directory -Path $installRoot -Force | Out-Null
    $archive = Join-Path $installRoot "node-v$nodeVersion-win-x64.zip"
    Invoke-WebRequest -Uri "https://nodejs.org/dist/v$nodeVersion/node-v$nodeVersion-win-x64.zip" -OutFile $archive
    $actualSha = Get-HuntFileSha256 $archive
    if ($actualSha -ne $nodeArchiveSha256) { throw 'Node archive digest mismatch' }
    Expand-Archive -LiteralPath $archive -DestinationPath $installRoot
    $expanded = Join-Path $installRoot "node-v$nodeVersion-win-x64"
    if ((& (Join-Path $expanded 'node.exe') --version) -ne "v$nodeVersion") {
        throw 'Node runtime version mismatch'
    }
    $expandedNpmCli = Join-Path $expanded 'node_modules\npm\bin\npm-cli.js'
    if ((& (Join-Path $expanded 'node.exe') $expandedNpmCli --version) -ne $npmVersion) {
        throw 'npm runtime version mismatch'
    }
    if (Test-Path -LiteralPath $nodeHome) {
        if (-not (Test-HuntChildPath $runtimeRoot $nodeHome)) { throw 'runtime target invalid' }
        Remove-Item -LiteralPath $nodeHome -Recurse -Force
    }
    Move-Item -LiteralPath $expanded -Destination $nodeHome
}

function Test-HuntDependencies {
    if (-not (Test-Path -LiteralPath (Join-Path $executionerRoot 'node_modules\.package-lock.json'))) { return $false }
    if (-not (Test-Path -LiteralPath (Join-Path $executionerRoot 'node_modules\playwright\package.json'))) { return $false }
    if (-not (Test-Path -LiteralPath $dependencyMarker -PathType Leaf)) { return $false }
    try {
        $marker = Get-Content -Raw -LiteralPath $dependencyMarker | ConvertFrom-Json
        $lockSha = Get-HuntFileSha256 $lockPath
        if ($marker.schemaVersion -ne 1 -or $marker.lockSha256 -ne $lockSha -or
            $marker.nodeVersion -ne $nodeVersion -or $marker.npmVersion -ne $npmVersion) { return $false }
    } catch { return $false }
    & $nodeExe $npmCli ls --prefix $executionerRoot --depth=0 --silent *> $null
    return $LASTEXITCODE -eq 0
}

function Install-HuntDependencies {
    $previousSkip = $env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD
    $env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1'
    try {
        $installOutput = & $nodeExe $npmCli ci --prefix $executionerRoot --no-audit --no-fund 2>&1
        $installExit = $LASTEXITCODE
        foreach ($line in $installOutput) { [Console]::Error.WriteLine([string]$line) }
        if ($installExit -ne 0) { throw 'dependency installation failed' }
        $marker = [ordered]@{
            schemaVersion = 1
            lockSha256 = Get-HuntFileSha256 $lockPath
            nodeVersion = $nodeVersion
            npmVersion = $npmVersion
        }
        $markerJson = ($marker | ConvertTo-Json -Compress) + "`n"
        [IO.File]::WriteAllText($dependencyMarker, $markerJson, (New-Object Text.UTF8Encoding($false)))
    } finally {
        $env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = $previousSkip
    }
}

function Invoke-HuntProbe($headroom) {
    $env:HUNT_C3_NPM_NODE_EXE = $nodeExe
    $env:HUNT_C3_NPM_VERSION = (& $nodeExe $npmCli --version).Trim()
    $env:HUNT_C3_AVAILABLE_PHYSICAL_BYTES = [string]$headroom.AvailablePhysicalBytes
    $env:HUNT_C3_COMMIT_HEADROOM_BYTES = [string]$headroom.CommitHeadroomBytes
    $env:PLAYWRIGHT_BROWSERS_PATH = $browserRoot
    $output = & $nodeExe (Join-Path $PSScriptRoot 'verify-s2-runtime.ts') --profile-path $profilePath
    try { return ($output | Out-String | ConvertFrom-Json) }
    catch { throw 'runtime evidence unavailable' }
}

function Stop-HuntProfileProcesses {
    $escaped = [regex]::Escape($profilePath)
    $owned = @(Get-CimInstance Win32_Process | Where-Object {
        $_.CommandLine -and $_.CommandLine -match $escaped
    })
    foreach ($process in $owned) {
        Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
        $script:ownedProcessesStopped += 1
    }
    return $owned.Count
}

$headroom = Get-HuntHeadroom
$tooling = $null
try {
    $runtimeReady = (Test-Path -LiteralPath $nodeExe) -and
        (Test-Path -LiteralPath $npmCli) -and
        ((& $nodeExe --version) -eq "v$nodeVersion") -and
        ((& $nodeExe $npmCli --version) -eq $npmVersion)
    if (-not $runtimeReady) {
        if ($VerifyOnly) { $report = New-HuntFailure 'runtime_mismatch' $headroom }
        else { Install-HuntNodeRuntime }
    }

    if ($null -eq $report) {
        $stage = 'runtime_mismatch'
        $tooling = Get-HuntToolingIdentity
        $stage = 'missing_dependency'
        if (-not (Test-HuntDependencies)) {
            if ($VerifyOnly) { $report = New-HuntFailure 'missing_dependency' $headroom }
            else { Install-HuntDependencies }
        }
    }

    if ($null -eq $report) {
        $stage = 'missing_browser'
        $report = Invoke-HuntProbe $headroom
        if ($report.code -eq 'missing_browser' -and -not $VerifyOnly) {
            $env:PLAYWRIGHT_BROWSERS_PATH = $browserRoot
            $browserOutput = & $nodeExe (Join-Path $executionerRoot 'node_modules\playwright\cli.js') install chromium 2>&1
            $browserExit = $LASTEXITCODE
            foreach ($line in $browserOutput) { [Console]::Error.WriteLine([string]$line) }
            if ($browserExit -ne 0) { throw 'browser installation failed' }
            $report = Invoke-HuntProbe $headroom
        }
    }
} catch {
    $knownDetails = @('git_lookup','tool_path','git_execute','tool_identity','git_path','git_hash','powershell_path','powershell_hash')
    $detail = if ($knownDetails -contains $_.Exception.Message) { $_.Exception.Message } else { 'stage_failed' }
    $report = New-HuntFailure $stage $headroom $detail
} finally {
    try {
        $residue = Stop-HuntProfileProcesses
        if ($residue -gt 0) { $report = New-HuntFailure 'evidence_failure' $headroom }
        if (Test-Path -LiteralPath $profilePath) {
            $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
            if (-not (Test-HuntChildPath $tempRoot $profilePath)) { throw 'profile cleanup target invalid' }
            Remove-Item -LiteralPath $profilePath -Recurse -Force
        }
        if (Test-Path -LiteralPath $installRoot) {
            if (-not (Test-HuntChildPath $runtimeRoot $installRoot)) { throw 'install cleanup target invalid' }
            Remove-Item -LiteralPath $installRoot -Recurse -Force
        }
    } catch {
        $report = New-HuntFailure 'evidence_failure' $headroom
    }
}

if ($null -eq $report) { $report = New-HuntFailure 'evidence_failure' $headroom }
$report | Add-Member -NotePropertyName tooling -NotePropertyValue $tooling -Force
$report.cleanup | Add-Member -NotePropertyName taskOwnedProcessesStopped -NotePropertyValue $ownedProcessesStopped -Force
if (-not $Quiet -or $report.status -ne 'ready') {
    $json = $report | ConvertTo-Json -Depth 8 -Compress
    if ($Quiet) { [Console]::Error.WriteLine($json) } else { [Console]::Out.WriteLine($json) }
}
if ($report.status -ne 'ready') { exit 1 }
