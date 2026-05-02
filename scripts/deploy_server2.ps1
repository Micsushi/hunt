param(
  [Parameter(Mandatory=$true)]
  [ValidateNotNullOrEmpty()]
  [string[]]$Stages,

  [switch]$Check,
  [switch]$PrintOnly,
  [string]$AnsibleRepo = ""
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot

if (-not $AnsibleRepo) {
  $AnsibleRepo = Join-Path $RepoRoot "..\ansible_homelab"
}

try {
  $AnsibleRepo = (Resolve-Path $AnsibleRepo).Path
} catch {
  throw "Ansible repo not found at '$AnsibleRepo'. Clone ansible_homelab next to hunt or pass -AnsibleRepo."
}

$DeployScript = Join-Path $AnsibleRepo "deploy.ps1"
if (-not (Test-Path $DeployScript)) {
  throw "Expected deploy helper at '$DeployScript'."
}

$NormalizedStages = @($Stages | ForEach-Object { "$_".Trim() } | Where-Object { $_ })
if ($NormalizedStages.Count -eq 0) {
  throw "Pass at least one Hunt stage, for example -Stages 6 or -Stages 6,7."
}

$DeployParams = @{
  Target = "job_agent"
}
if ($NormalizedStages.Count -eq 1) {
  $DeployParams.Stage = $NormalizedStages[0]
} else {
  $DeployParams.Tags = (($NormalizedStages | ForEach-Object { "stage$_" }) -join ",")
}
if ($Check) {
  $DeployParams.DryRun = $true
}

$RenderedArgs = @(
  "-Target",
  $DeployParams.Target
)
if ($DeployParams.ContainsKey("Stage")) {
  $RenderedArgs += @("-Stage", $DeployParams.Stage)
}
if ($DeployParams.ContainsKey("Tags")) {
  $RenderedArgs += @("-Tags", $DeployParams.Tags)
}
if ($DeployParams.ContainsKey("DryRun")) {
  $RenderedArgs += "-DryRun"
}

$RenderedCommand = @(
  "powershell",
  "-ExecutionPolicy",
  "Bypass",
  "-File",
  ('"{0}"' -f $DeployScript)
) + $RenderedArgs

Write-Host "Hunt server2 deploy"
Write-Host "Ansible repo: $AnsibleRepo"
Write-Host "Stages     : $($NormalizedStages -join ', ')"
Write-Host "Command    : $($RenderedCommand -join ' ')"

if ($PrintOnly) {
  return
}

& $DeployScript @DeployParams
