import { execFileSync } from "node:child_process";

import {
  normalizeObservedAddressHost,
  observedChromeIdentityTitleSha256s,
  observedStructurePageWithIdentity,
  selectObservedChromeIdentityTitle,
} from "./external-monitor-browser-identity.ts";
import type { ExternalMonitorDesktopBinding } from "./external-monitor-desktop-binding.ts";
import {
  observerFailure,
  type ExternalMonitorObserverFailureDiagnostic,
} from "./external-monitor-observer-failure.ts";
import {
  observedActiveStageTitles,
  observedStructureIdentityTitles,
  observedSubmitPresent,
  type ObservedOwnedControlStructure,
  type ObservedStageCounts,
} from "./external-monitor-page-identity.ts";
import type { ObservedMonitorSurface } from "./external-monitor-surface-reconciliation.ts";

const observedFlagCatalog = [
  "Apply", "Apply Now", "Apply Manually", "Sign in with email", "Create Account", "Sign In",
  "Email Address", "Password", "Forgot Password", "Forgot your password?", "Reset Password",
  "Send Verification Email", "My Information", "My Experience", "Application Questions",
  "Voluntary Disclosures", "Self Identify", "Review", "Submit", "Submit application", "Next",
  "Save and Continue", "Upload a resume", "Upload Resume", "Resume, Cover Letter and References",
  "Upload a file (5MB max)", "Phone", "Phone Device Type", "Country Phone Code", "Phone Number",
] as const;
const observedFlagSet = new Set<string>(observedFlagCatalog);

export function ownedBrowserObservation(
  runtimeRoot: string,
  binding: ExternalMonitorDesktopBinding,
  expectedTitleSha256: string | undefined,
): ObservedMonitorSurface {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$root = $env:HUNT_C3_OBSERVER_RUNTIME_ROOT
$binding = Get-Content -LiteralPath ([IO.Path]::Combine($root, 'isolated-desktop.json')) -Raw | ConvertFrom-Json
$owner = Get-Content -LiteralPath ([IO.Path]::Combine($root, 'external-monitor-live.json')) -Raw | ConvertFrom-Json
$profile = [string]$binding.browserProfilePath
try { $all = @(Get-CimInstance Win32_Process) } catch { exit 40 }
$byPid = @{}; foreach ($item in $all) { $byPid[[int]$item.ProcessId] = $item }
function Test-OwnedAncestor([int]$candidatePid, [int]$ownerPid) {
  for ($depth = 0; $depth -lt 32; $depth++) {
    if ($candidatePid -eq $ownerPid) { return $true }
    if (-not $byPid.ContainsKey($candidatePid)) { return $false }
    $candidatePid = [int]$byPid[$candidatePid].ParentProcessId
    if ($candidatePid -le 0) { return $false }
  }
  return $false
}
$escaped = [regex]::Escape($profile)
$profileArgument = '(?i)(?:^|\s)--user-data-dir=(?:"' + $escaped + '"|' + $escaped + ')(?=\s|$)'
try { $browsers = @($all | Where-Object {
  $_.Name -eq 'chrome.exe' -and $_.CommandLine -match $profileArgument -and
  $_.CommandLine -notmatch '(?i)(?:^|\s)--type=' -and
  (Test-OwnedAncestor ([int]$_.ProcessId) ([int]$owner.processOwnerPid))
} | ForEach-Object {
  [pscustomobject]@{ Pid = [int]$_.ProcessId }
}) } catch { exit 45 }
if ($browsers.Count -eq 0) { exit 47 }
if ($browsers.Count -ne 1) { exit 49 }
try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
} catch { exit 44 }
try {
  $processCondition = [Windows.Automation.PropertyCondition]::new(
    [Windows.Automation.AutomationElement]::ProcessIdProperty,
    $browsers[0].Pid
  )
  $ownedWindows = [Windows.Automation.AutomationElement]::RootElement.FindAll(
    [Windows.Automation.TreeScope]::Children,
    $processCondition
  )
  $windows = @($ownedWindows | Where-Object {
    -not $_.Current.IsOffscreen -and -not [string]::IsNullOrWhiteSpace([string]$_.Current.Name)
  })
} catch { exit 42 }
if ($windows.Count -eq 0) { exit 47 }
if ($windows.Count -ne 1) { exit 48 }
$window = $windows[0]
try {
  $elements = $window.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition)
} catch { exit 43 }
$allow = @(
  'Apply', 'Apply Now', 'Apply Manually', 'Sign in with email', 'Create Account', 'Sign In',
  'Email Address', 'Password', 'Forgot Password', 'Forgot your password?', 'Reset Password', 'Send Verification Email',
  'My Information', 'My Experience', 'Application Questions', 'Voluntary Disclosures',
  'Self Identify', 'Review', 'Submit', 'Submit application', 'Next', 'Save and Continue',
  'Upload a resume', 'Upload Resume', 'Resume, Cover Letter and References',
  'Upload a file (5MB max)', 'Phone', 'Phone Device Type', 'Country Phone Code', 'Phone Number'
)
$seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$actionSeen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$editSeen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$selectedTabTitles = [Collections.Generic.List[string]]::new()
$documentTitles = [Collections.Generic.List[string]]::new()
$stageCounts = [ordered]@{
  myInformation = 0
  myExperience = 0
  applicationQuestions = 0
  voluntaryDisclosures = 0
  selfIdentify = 0
  review = 0
}
$address = $null
foreach ($element in $elements) {
  try {
    $name = [string]$element.Current.Name
    $visible = -not $element.Current.IsOffscreen
    $controlType = [int]$element.Current.ControlType.Id
    if ($visible -and $allow -contains $name) {
      [void]$seen.Add($name)
      if ($controlType -eq 50000 -or $controlType -eq 50005 -or $controlType -eq 50031) {
        [void]$actionSeen.Add($name)
      }
      if ($controlType -eq 50004) { [void]$editSeen.Add($name) }
    }
    switch ($name) {
      'My Information' { if ($visible) { $stageCounts.myInformation = 1 + [int]$stageCounts.myInformation } }
      'My Experience' { if ($visible) { $stageCounts.myExperience = 1 + [int]$stageCounts.myExperience } }
      'Application Questions' { if ($visible) { $stageCounts.applicationQuestions = 1 + [int]$stageCounts.applicationQuestions } }
      'Voluntary Disclosures' { if ($visible) { $stageCounts.voluntaryDisclosures = 1 + [int]$stageCounts.voluntaryDisclosures } }
      'Self Identify' { if ($visible) { $stageCounts.selfIdentify = 1 + [int]$stageCounts.selfIdentify } }
      'Review' { if ($visible) { $stageCounts.review = 1 + [int]$stageCounts.review } }
    }
    if ($visible -and -not [string]::IsNullOrWhiteSpace($name) -and
        $element.Current.ControlType.Id -eq 50019) {
      $selection = $null
      if ($element.TryGetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern, [ref]$selection) -and
          ([Windows.Automation.SelectionItemPattern]$selection).Current.IsSelected) {
        [void]$selectedTabTitles.Add($name)
      }
    }
    if ($visible -and -not [string]::IsNullOrWhiteSpace($name) -and
        $element.Current.ControlType.Id -eq 50030 -and $documentTitles.Count -lt 8) {
      [void]$documentTitles.Add($name)
    }
    if ($visible -and $address -eq $null -and $element.Current.ControlType.Id -eq 50004 -and
        ([string]$element.Current.AutomationId -eq 'view_1021' -or $name -eq 'Address and search bar')) {
      $pattern = $null
      if ($element.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
        $address = ([Windows.Automation.ValuePattern]$pattern).Current.Value
      }
    }
  } catch {}
}
$payload = [ordered]@{
  pid = $browsers[0].Pid
  title = [string]$window.Current.Name
  selectedTabTitles = @($selectedTabTitles)
  documentTitles = @($documentTitles)
  stageCounts = $stageCounts
  address = $address
  flags = @($seen | Sort-Object)
  actionFlags = @($actionSeen | Sort-Object)
  editFlags = @($editSeen | Sort-Object)
}
try {
  [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($payload | ConvertTo-Json -Compress)))
} catch { exit 46 }
`.trim();
  let output: string;
  try {
    output = execFileSync("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script,
    ], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
      env: { ...process.env, HUNT_C3_OBSERVER_RUNTIME_ROOT: runtimeRoot },
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch (error) {
    const status = typeof error === "object" && error !== null && "status" in error
      ? error.status
      : undefined;
    if (status === 47) observerFailure("browser_window_missing");
    if (status === 48) observerFailure("browser_window_ambiguous");
    if (status === 49) observerFailure("browser_process_ambiguous");
    if (status === 40) observerFailure("process_inventory");
    if (status === 42 || status === 43 || status === 44) observerFailure("accessibility_tree");
    if (status === 45) observerFailure("browser_process_binding");
    if (status === 46) observerFailure("accessibility_payload");
    observerFailure("browser_observation_command");
  }
  let observed: {
    readonly title?: unknown;
    readonly selectedTabTitles?: unknown;
    readonly documentTitles?: unknown;
    readonly stageCounts?: unknown;
    readonly address?: unknown;
    readonly flags?: unknown;
    readonly actionFlags?: unknown;
    readonly editFlags?: unknown;
  };
  try {
    observed = JSON.parse(Buffer.from(output, "base64").toString("utf8"));
  } catch { return observerFailure("accessibility_payload"); }
  if (typeof observed.title !== "string" || !Array.isArray(observed.selectedTabTitles) ||
      observed.selectedTabTitles.length > 8 ||
      observed.selectedTabTitles.some((value) => typeof value !== "string") ||
      !Array.isArray(observed.documentTitles) || observed.documentTitles.length > 8 ||
      observed.documentTitles.some((value) => typeof value !== "string") ||
      !Array.isArray(observed.flags) ||
      observed.flags.some((value) => typeof value !== "string") ||
      !Array.isArray(observed.actionFlags) ||
      observed.actionFlags.some((value) => typeof value !== "string") ||
      !Array.isArray(observed.editFlags) ||
      observed.editFlags.some((value) => typeof value !== "string")) {
    observerFailure("accessibility_payload");
  }
  const stageCounts = admitObservedStageCounts(observed.stageCounts);
  if (typeof observed.address === "string" && observed.address.length > 0) {
    let host: string;
    try { host = normalizeObservedAddressHost(observed.address); }
    catch { return observerFailure("address_identity"); }
    if (host !== binding.host) observerFailure("address_identity");
  }
  const flags = new Set(observed.flags.map(canonicalObservedFlag));
  const owned: ObservedOwnedControlStructure = Object.freeze({
    actionFlags: new Set(observed.actionFlags.map(canonicalObservedFlag)),
    editFlags: new Set(observed.editFlags.map(canonicalObservedFlag)),
  });
  const activeStageTitles = observedActiveStageTitles(stageCounts);
  let page: string;
  try {
    page = observedStructurePageWithIdentity(
      flags,
      activeStageTitles,
      observed.title,
      expectedTitleSha256,
      owned,
    );
  }
  catch {
    return observerFailure("structure_classification", structureFailureDiagnostic(
      expectedTitleSha256,
      observed.title,
      [...observed.selectedTabTitles, ...observed.documentTitles, ...activeStageTitles],
      flags,
      stageCounts,
      activeStageTitles,
    ));
  }
  let title: string;
  const identityTitles = [
    ...(observed.selectedTabTitles as string[]),
    ...(observed.documentTitles as string[]),
    ...activeStageTitles,
    ...observedStructureIdentityTitles(page, flags, activeStageTitles),
  ];
  try {
    title = selectObservedChromeIdentityTitle(expectedTitleSha256, observed.title, identityTitles);
  } catch { return observerFailure("title_identity"); }
  return Object.freeze({
    title,
    titleCandidateSha256s: observedChromeIdentityTitleSha256s(observed.title, identityTitles),
    page,
    submitPresent: observedSubmitPresent(owned),
  });
}

function canonicalObservedFlag(value: string): string {
  const canonical = observedFlagCatalog.find((candidate) =>
    candidate.toLowerCase() === value.toLowerCase());
  return canonical ?? value;
}

function structureFailureDiagnostic(
  expectedTitleSha256: string | undefined,
  windowTitle: string,
  identityTitles: readonly string[],
  flags: ReadonlySet<string>,
  stageCounts: ObservedStageCounts,
  activeStageTitles: readonly string[],
): ExternalMonitorObserverFailureDiagnostic {
  const titleHashes = observedChromeIdentityTitleSha256s(windowTitle, identityTitles);
  return Object.freeze({
    ...(/^[0-9a-f]{64}$/u.test(expectedTitleSha256 ?? "") ? { expectedTitleSha256 } : {}),
    observedTitleSha256: titleHashes[0],
    observedTitleCandidateSha256s: titleHashes,
    observedStructureFlags: [...flags].filter((value) => observedFlagSet.has(value)).sort(),
    observedStageCounts: Object.freeze({ ...stageCounts }),
    activeStageTitles: Object.freeze([...activeStageTitles]),
  });
}

function admitObservedStageCounts(value: unknown): ObservedStageCounts {
  if (typeof value !== "object" || value === null || Array.isArray(value)) denied();
  const candidate = value as Record<string, unknown>;
  const keys = [
    "myInformation", "myExperience", "applicationQuestions",
    "voluntaryDisclosures", "selfIdentify", "review",
  ] as const;
  if (Object.keys(candidate).length !== keys.length ||
      keys.some((key) => !Number.isInteger(candidate[key]) ||
        (candidate[key] as number) < 0 || (candidate[key] as number) > 16)) denied();
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, candidate[key]]))) as unknown as
    ObservedStageCounts;
}

function denied(): never {
  throw new Error("external monitor observer denied");
}
