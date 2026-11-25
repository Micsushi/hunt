param(
  [Parameter(Mandatory=$true)]
  [ValidateNotNullOrEmpty()]
  [string[]]$Stages,
  [switch]$Check,
  [switch]$PrintOnly,
  [string]$AnsibleRepo = "",
  [string]$ReleaseRef = ""
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$NormalizedStages = @($Stages -split "," | ForEach-Object { $_.Trim() } | Sort-Object -Unique)
if ($NormalizedStages.Count -eq 0 -or @($NormalizedStages | Where-Object { $_ -notin @("6", "7") }).Count) {
  throw "Unsupported Hunt stage. Active stages are 6 and 7 only."
}

if (-not $AnsibleRepo) {
  $AnsibleRepo = Join-Path $RepoRoot "..\server_ansible_setup"
}
$AnsibleScript = Join-Path $AnsibleRepo "ansible.ps1"
$Playbook = "playbooks/apps/hunt.yml"
if (-not (Test-Path $AnsibleScript -PathType Leaf) -or -not (Test-Path (Join-Path $AnsibleRepo $Playbook) -PathType Leaf)) {
  throw "Missing Hunt application playbook or ansible.ps1 in '$AnsibleRepo'. Pass -AnsibleRepo with its location."
}
if (-not $ReleaseRef) {
  $ReleaseRef = git -C $RepoRoot rev-parse HEAD
  if ($LASTEXITCODE -ne 0) { throw "Cannot identify the Hunt release." }
}
if ($ReleaseRef -cnotmatch '^[0-9a-f]{40}$') { throw "Pass a full Hunt commit SHA." }

# The qualified application-only playbook accepts only the combined c1c2 target.
$Target = if ($NormalizedStages.Count -eq 2) { "c1c2" } elseif ($NormalizedStages[0] -eq "6") { "c1" } else { "c2" }
$AppOnly = if ($Target -eq "c1c2") { "true" } else { "false" }
$PlayArgs = @("--limit", "server2", "-e", "hunt_release_ref=$ReleaseRef",
              "-e", "hunt_deploy_target=$Target", "-e", "hunt_app_only=$AppOnly")
if ($NormalizedStages -contains "6") {
  $PlayArgs += @("-e", "scraper_interval_minutes=60")
}
if ($Check) { $PlayArgs += "--check" }
Write-Host "Hunt server2 deploy: $Playbook $($PlayArgs -join ' ')"
if ($PrintOnly) { return }

if (-not $Check) {
  & python (Join-Path $PSScriptRoot "verify_release_ci.py") $ReleaseRef
  if ($LASTEXITCODE -ne 0) { throw "The Hunt release has not passed hosted CI." }
}
& $AnsibleScript -Playbook $Playbook -ExtraArgs $PlayArgs
exit $LASTEXITCODE
