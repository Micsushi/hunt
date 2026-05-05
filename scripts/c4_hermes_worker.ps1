param(
    [string]$Runtime = "hermes_local",
    [string]$BaseUrl = $(if ($env:HUNT_COORDINATOR_BASE_URL) { $env:HUNT_COORDINATOR_BASE_URL } else { "http://127.0.0.1:8003" }),
    [string]$BrowserLane = "",
    [int]$LeaseSeconds = 900,
    [switch]$ExecuteAgent,
    [switch]$MockResult
)

$ErrorActionPreference = "Stop"
$argsList = @(
    "-m", "coordinator.agent_worker",
    "--runtime", $Runtime,
    "--base-url", $BaseUrl,
    "--lease-seconds", "$LeaseSeconds"
)
if ($BrowserLane) {
    $argsList += @("--browser-lane", $BrowserLane)
}
if ($ExecuteAgent) {
    $argsList += "--execute-agent"
}
if ($MockResult) {
    $argsList += "--mock-result"
}

python @argsList
