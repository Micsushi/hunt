param(
    [string]$Runtime = "openclaw_isolated",
    [string]$BaseUrl = "http://127.0.0.1:8003",
    [string]$BrowserLane = "",
    [string]$LlmProvider = "",
    [string]$LlmModel = "",
    [int]$LeaseSeconds = 900,
    [switch]$ExecuteAgent,
    [switch]$MockResult
)

Write-Error "C4 is on hold. OpenClaw worker was not started."
exit 2
