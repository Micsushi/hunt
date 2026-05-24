param(
    [string]$Ports = "",
    [string]$BatchId = "",
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$portSet = @{}
if ($Ports.Trim()) {
    $Ports -split "," |
        ForEach-Object { $_.Trim() } |
        Where-Object { $_ } |
        ForEach-Object { $portSet[[int]$_] = $true }
}

if (-not $BatchId -and $portSet.Count -eq 0) {
    throw "Specify -BatchId or -Ports so cleanup cannot accidentally close every p Chrome lane."
}

$lanes = Get-CimInstance Win32_Process |
    Where-Object {
        $_.Name -eq "chrome.exe" -and
        $_.CommandLine -match "ChromeC3PlaywrightParallel" -and
        $_.CommandLine -match "--remote-debugging-port=9\d\d\d" -and
        $_.CommandLine -notmatch " --type="
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
    } |
    ForEach-Object {
        $port = $null
        if ($_.CommandLine -match "--remote-debugging-port=(\d+)") {
            $port = [int]$Matches[1]
        }
        [pscustomobject]@{
            processId = $_.ProcessId
            port = $port
            commandLine = $_.CommandLine
        }
    } |
    Sort-Object port, processId

if (-not $lanes) {
    Write-Host "No matching p Chrome lanes found."
    return
}

if ($DryRun) {
    $lanes | ConvertTo-Json -Depth 4
    return
}

foreach ($lane in $lanes) {
    Stop-Process -Id $lane.processId -Force -ErrorAction SilentlyContinue
}

Start-Sleep -Milliseconds 500
$lanes |
    Select-Object processId, port |
    ConvertTo-Json -Depth 4
