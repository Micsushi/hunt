import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";

import {
  createStage2ExternalMonitorObserverAuthority,
} from "./external-monitor-authority.ts";
import { reviewedMonitorStructureId } from "./monitor-structures.ts";
import {
  canonicalMonitorIdentityTitle,
  writeStage2ExternalMonitorAcknowledgement,
} from "./external-monitor-runtime.ts";

const DESKTOP_BINDING_FILE = "isolated-desktop.json";
const OWNER_LIVE_FILE = "external-monitor-live.json";
const STOP_FILE = "external-monitor-observer-stop";
const observedFlagCatalog = [
  "Apply", "Apply Now", "Apply Manually", "Sign in with email", "Create Account", "Sign In",
  "Email Address", "Password", "Forgot Password", "Forgot your password?", "Reset Password",
  "Send Verification Email", "My Information", "My Experience", "Application Questions",
  "Voluntary Disclosures", "Self Identify", "Review", "Submit", "Submit application", "Next",
  "Save and Continue", "Upload a resume", "Upload Resume", "Resume, Cover Letter and References",
  "Upload a file (5MB max)",
] as const;
const observedFlagSet = new Set<string>(observedFlagCatalog);

interface DesktopBinding {
  readonly schemaVersion: 1;
  readonly bindingRevision: "s2-isolated-desktop-binding-v2";
  readonly runKey: string;
  readonly journeyId: string;
  readonly targetHandleId: string;
  readonly desktopName: string;
  readonly host: string;
  readonly tenant: string;
  readonly posting: string;
  readonly browserProfilePath: string;
  readonly observerAuthorityTokenSha256: string;
}

export async function runStage2ExternalMonitorObserver(
  values: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const { runtimeRoot, evidenceRoot } = parseArgs(values);
  const token = environment.HUNT_C3_MONITOR_OBSERVER_TOKEN;
  environment.HUNT_C3_MONITOR_OBSERVER_TOKEN = undefined;
  if (token === undefined || !/^[A-Za-z0-9+/]{43}=$/u.test(token)) denied();
  const binding = await waitForDesktopBinding(runtimeRoot, token);
  const authority = createStage2ExternalMonitorObserverAuthority({
    runtimeRoot,
    journeyId: binding.journeyId,
    targetHandleId: binding.targetHandleId,
    authorityToken: token,
  });
  const stopPath = join(runtimeRoot, STOP_FILE);
  let ownerSeen = false;
  try {
    while (!existsSync(stopPath)) {
      const ownerLive = existsSync(join(runtimeRoot, OWNER_LIVE_FILE));
      ownerSeen ||= ownerLive;
      if (ownerSeen && !ownerLive) return;
      for (const requestPath of pendingRequests(evidenceRoot)) {
        await acknowledge(runtimeRoot, evidenceRoot, requestPath, binding, authority);
      }
      await delay(50);
    }
  } catch (error) {
    retainObserverFailure(evidenceRoot, error);
    throw error;
  } finally {
    authority.close();
    rmSync(stopPath, { force: true });
  }
}

function retainObserverFailure(evidenceRoot: string, error: unknown): void {
  const failureCode = externalMonitorObserverFailureCode(error);
  if (failureCode === undefined) return;
  const diagnostic = externalMonitorObserverFailureDiagnostic(error);
  try {
    writeFileSync(join(evidenceRoot, "external-monitor-observer-failure.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        evidenceRevision: "s2-external-monitor-observer-failure-v1",
        status: "failed",
        failureCode,
        ...(diagnostic ?? {}),
        submitActivated: false,
      })}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch {
    // Diagnostic retention must never replace the causal observer failure.
  }
}

async function acknowledge(
  runtimeRoot: string,
  evidenceRoot: string,
  requestPath: string,
  binding: DesktopBinding,
  observer: ReturnType<typeof createStage2ExternalMonitorObserverAuthority>,
): Promise<void> {
  const request = observerStage("request_admission", () =>
    JSON.parse(stableFile(requestPath, 16 * 1024).toString("utf8"))) as {
    readonly page?: unknown;
    readonly moment?: unknown;
    readonly screenshotFile?: unknown;
    readonly capturedIdentityDigests?: unknown;
  };
  if (typeof request.page !== "string" || typeof request.moment !== "string" ||
      typeof request.screenshotFile !== "string") denied();
  const structure = reviewedMonitorStructureId(request.page);
  if (structure === undefined) denied();
  const screenshotPath = join(dirname(requestPath), request.screenshotFile);
  const screenshot = observerStage("screenshot_admission", () =>
    stableFile(screenshotPath, 12 * 1024 * 1024));
  const expectedTitleSha256 = typeof request.capturedIdentityDigests === "object" &&
      request.capturedIdentityDigests !== null &&
      "titleSha256" in request.capturedIdentityDigests &&
      typeof request.capturedIdentityDigests.titleSha256 === "string"
    ? request.capturedIdentityDigests.titleSha256
    : undefined;
  const visual = await waitForReconciledMonitorSurface(request, () =>
    observerStage("owned_browser_observation", () =>
      ownedBrowserObservation(runtimeRoot, binding, expectedTitleSha256)));
  observerStage("acknowledgement_admission", () =>
    writeStage2ExternalMonitorAcknowledgement({
    runtimeRoot,
    evidenceRoot,
    requestPath,
    classification: request.page === "review" && request.moment === "review_readback"
      ? "review_verified"
      : request.page === "application_ready" && request.moment === "state_observed"
        ? "account_verified"
        : "safe_to_continue",
    observedScreenshotSha256: createHash("sha256").update(screenshot).digest("hex"),
    observedIdentity: {
      host: binding.host,
      tenant: binding.tenant,
      posting: binding.posting,
      title: visual.title,
    },
    structuralDescriptionIds: [structure],
    observedStructurePage: visual.page,
    observedSubmitPresent: visual.submitPresent,
    privacyScan: "separate_evidence_required",
      observer,
    }));
}

interface ObservedMonitorSurface {
  readonly title: string;
  readonly titleCandidateSha256s?: readonly string[];
  readonly page: string;
  readonly submitPresent: boolean;
}

export async function waitForReconciledMonitorSurface(
  request: { readonly page?: unknown; readonly capturedIdentityDigests?: unknown },
  observe: () => ObservedMonitorSurface | Promise<ObservedMonitorSurface>,
  options: {
    readonly attempts?: number;
    readonly pause?: () => Promise<void>;
  } = {},
): Promise<ObservedMonitorSurface> {
  const attempts = options.attempts ?? 4;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 10) denied();
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const observed = await observe();
      if (typeof request.page !== "string" || !compatibleObservedPage(request.page, observed.page)) {
        const expectedTitleSha256 = typeof request.capturedIdentityDigests === "object" &&
            request.capturedIdentityDigests !== null &&
            "titleSha256" in request.capturedIdentityDigests &&
            typeof request.capturedIdentityDigests.titleSha256 === "string"
          ? request.capturedIdentityDigests.titleSha256
          : undefined;
        observerFailure("structure_classification", {
          ...(/^[0-9a-f]{64}$/u.test(expectedTitleSha256 ?? "") ? { expectedTitleSha256 } : {}),
          observedTitleSha256: createHash("sha256")
            .update(canonicalMonitorIdentityTitle(observed.title), "utf8").digest("hex"),
          ...(observed.titleCandidateSha256s === undefined
            ? {}
            : { observedTitleCandidateSha256s: observed.titleCandidateSha256s }),
          observedStructurePage: observed.page,
        });
      }
      reconcileObservedMonitorSurface(request, observed);
      return observed;
    } catch (error) {
      const code = externalMonitorObserverFailureCode(error);
      if ((code !== "title_identity_reconciliation" && code !== "structure_classification") ||
          attempt === attempts) throw error;
      await (options.pause ?? (() => delay(100)))();
    }
  }
  return observerFailure("title_identity_reconciliation");
}

export function reconcileObservedMonitorSurface(
  request: { readonly page?: unknown; readonly capturedIdentityDigests?: unknown },
  observed: {
    readonly title: string;
    readonly titleCandidateSha256s?: readonly string[];
    readonly submitPresent: boolean;
  },
): void {
  const titleSha256 = typeof request.capturedIdentityDigests === "object" &&
      request.capturedIdentityDigests !== null &&
      "titleSha256" in request.capturedIdentityDigests
    ? request.capturedIdentityDigests.titleSha256
    : undefined;
  const observedTitleSha256 = createHash("sha256")
    .update(canonicalMonitorIdentityTitle(observed.title), "utf8")
    .digest("hex");
  if (typeof titleSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(titleSha256) ||
      observedTitleSha256 !== titleSha256) {
    observerFailure("title_identity_reconciliation",
      typeof titleSha256 === "string" && /^[0-9a-f]{64}$/u.test(titleSha256)
        ? {
            expectedTitleSha256: titleSha256,
            observedTitleSha256,
            ...(observed.titleCandidateSha256s === undefined
              ? {}
              : { observedTitleCandidateSha256s: observed.titleCandidateSha256s }),
          }
        : undefined);
  }
  if (observed.submitPresent !== (request.page === "review")) {
    observerFailure("submit_state_reconciliation");
  }
}

const OBSERVER_FAILURE_CODES = [
  "request_admission",
  "screenshot_admission",
  "owned_browser_observation",
  "browser_process_binding",
  "browser_window_missing",
  "browser_window_ambiguous",
  "browser_process_ambiguous",
  "process_inventory",
  "accessibility_tree",
  "browser_observation_command",
  "accessibility_payload",
  "address_identity",
  "structure_classification",
  "title_identity",
  "title_identity_reconciliation",
  "submit_state_reconciliation",
  "acknowledgement_admission",
] as const;

type ObserverFailureCode = typeof OBSERVER_FAILURE_CODES[number];

export interface ExternalMonitorObserverFailureDiagnostic {
  readonly expectedTitleSha256?: string;
  readonly observedTitleSha256?: string;
  readonly observedTitleCandidateSha256s?: readonly string[];
  readonly observedStructureFlags?: readonly string[];
  readonly observedStageCounts?: ObservedStageCounts;
  readonly activeStageTitles?: readonly string[];
  readonly observedStructurePage?: string;
}

const observerFailureDiagnostics = new WeakMap<Error, ExternalMonitorObserverFailureDiagnostic>();

function observerStage<T>(code: ObserverFailureCode, run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (externalMonitorObserverFailureCode(error) !== undefined) throw error;
    throw new Error(`external monitor observer failed: ${code}`);
  }
}

function observerFailure(
  code: ObserverFailureCode,
  diagnostic?: ExternalMonitorObserverFailureDiagnostic,
): never {
  const error = new Error(`external monitor observer failed: ${code}`);
  if (diagnostic !== undefined) observerFailureDiagnostics.set(error, diagnostic);
  throw error;
}

export function externalMonitorObserverFailureDiagnostic(
  error: unknown,
): ExternalMonitorObserverFailureDiagnostic | undefined {
  return error instanceof Error ? observerFailureDiagnostics.get(error) : undefined;
}

export function externalMonitorObserverFailureCode(error: unknown): ObserverFailureCode | undefined {
  if (!(error instanceof Error)) return undefined;
  const prefix = "external monitor observer failed: ";
  if (!error.message.startsWith(prefix)) return undefined;
  const code = error.message.slice(prefix.length);
  return OBSERVER_FAILURE_CODES.find((candidate) => candidate === code);
}

function pendingRequests(evidenceRoot: string): string[] {
  const requests: string[] = [];
  for (const directoryName of ["auth-monitor", "monitor"] as const) {
    const root = join(evidenceRoot, directoryName);
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root).sort()) {
      if (!name.endsWith(".request.json")) continue;
      const ack = join(root, name.replace(/\.request\.json$/u, ".ack.json"));
      if (!existsSync(ack)) requests.push(join(root, name));
    }
  }
  return requests;
}

function ownedBrowserObservation(
  runtimeRoot: string,
  binding: DesktopBinding,
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
  'Upload a file (5MB max)'
)
$seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
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
    if ($visible -and $allow -contains $name) { [void]$seen.Add($name) }
    switch ($name) {
      'My Information' { $stageCounts.myInformation = 1 + [int]$stageCounts.myInformation }
      'My Experience' { $stageCounts.myExperience = 1 + [int]$stageCounts.myExperience }
      'Application Questions' { $stageCounts.applicationQuestions = 1 + [int]$stageCounts.applicationQuestions }
      'Voluntary Disclosures' { $stageCounts.voluntaryDisclosures = 1 + [int]$stageCounts.voluntaryDisclosures }
      'Self Identify' { $stageCounts.selfIdentify = 1 + [int]$stageCounts.selfIdentify }
      'Review' { $stageCounts.review = 1 + [int]$stageCounts.review }
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
      observed.flags.some((value) => typeof value !== "string")) {
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
  const activeStageTitles = observedActiveStageTitles(stageCounts);
  let title: string;
  let identityTitles = [
    ...(observed.selectedTabTitles as string[]),
    ...(observed.documentTitles as string[]),
    ...activeStageTitles,
  ];
  try {
    title = selectObservedChromeIdentityTitle(
      expectedTitleSha256,
      observed.title,
      identityTitles,
    );
  }
  catch { return observerFailure("title_identity"); }
  let page: string;
  try {
    page = observedStructurePageWithIdentity(
      flags,
      activeStageTitles,
      title,
      expectedTitleSha256,
    );
  }
  catch {
    return observerFailure("structure_classification", structureFailureDiagnostic(
      expectedTitleSha256,
      observed.title,
      identityTitles,
      flags,
      stageCounts,
      activeStageTitles,
    ));
  }
  identityTitles = [
    ...identityTitles,
    ...observedStructureIdentityTitles(page, flags, activeStageTitles),
  ];
  try {
    title = selectObservedChromeIdentityTitle(
      expectedTitleSha256,
      observed.title,
      identityTitles,
    );
  }
  catch { return observerFailure("title_identity"); }
  return Object.freeze({
    title,
    titleCandidateSha256s: observedChromeIdentityTitleSha256s(
      observed.title,
      identityTitles,
    ),
    page,
    submitPresent: flags.has("Submit") || flags.has("Submit application"),
  });
}

export function normalizeObservedAddressHost(address: string): string {
  const normalized = address.normalize("NFC").trim();
  if (normalized.length < 1 || normalized.length > 2_048 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    denied();
  }
  const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//iu.test(normalized)
    ? normalized
    : `https://${normalized}`);
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") denied();
  return url.hostname.toLowerCase();
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

export function observedStructurePage(
  flags: ReadonlySet<string>,
  activeStageTitles: readonly string[] = [],
): string {
  if (flags.has("Review") && (flags.has("Submit") || flags.has("Submit application"))) return "review";
  const activeApplicationPage = observedActiveApplicationPage(flags, activeStageTitles);
  if (activeApplicationPage !== undefined &&
      (flags.has("Next") || flags.has("Save and Continue"))) return activeApplicationPage;
  if (flags.has("Sign In") && flags.has("Forgot your password?")) return "sign_in";
  if (flags.has("Create Account") ||
      (flags.has("Sign In") && flags.has("Email Address") && flags.has("Password"))) {
    return "account_entry";
  }
  if (flags.has("Reset Password")) return "password_reset_set";
  if (flags.has("Send Verification Email")) return "verification_required";
  if (flags.has("Forgot Password")) return "password_reset_request";
  if (flags.has("Sign in with email")) return "email_sign_in_choice";
  if (activeApplicationPage !== undefined) return activeApplicationPage;
  if (flags.has("Application Questions") || flags.has("Voluntary Disclosures") || flags.has("Self Identify")) return "questionnaire";
  if (flags.has("Upload a resume") || flags.has("Upload Resume") ||
      flags.has("Resume, Cover Letter and References") ||
      flags.has("Upload a file (5MB max)")) return "resume";
  if (flags.has("My Information") || flags.has("My Experience")) return "profile";
  if (flags.has("Apply Manually")) return "apply_choice";
  if (flags.has("Apply") || flags.has("Apply Now")) return "job_posting";
  if (flags.has("Sign In")) return "account_entry";
  denied();
}

function observedActiveApplicationPage(
  flags: ReadonlySet<string>,
  activeStageTitles: readonly string[],
): string | undefined {
  if (activeStageTitles.length !== 1) return undefined;
  const active = activeStageTitles[0]!;
  if (["Application Questions", "Voluntary Disclosures", "Self Identify"].includes(active)) {
    return "questionnaire";
  }
  if (active === "My Experience" &&
      (flags.has("Upload a resume") || flags.has("Upload Resume") ||
        flags.has("Resume, Cover Letter and References") ||
        flags.has("Upload a file (5MB max)"))) return "resume";
  if (active === "My Information" || active === "My Experience") return "profile";
  return undefined;
}

export function observedStructurePageFromIdentityTitle(title: string): string {
  const normalized = normalizeObservedChromeTitle(title);
  if (normalized === "My Information" || normalized === "My Experience") return "profile";
  if (["Application Questions", "Voluntary Disclosures", "Self Identify"].includes(normalized)) {
    return "questionnaire";
  }
  if (normalized === "Review") return "review";
  denied();
}

export function observedStructurePageWithIdentity(
  flags: ReadonlySet<string>,
  activeStageTitles: readonly string[],
  title: string,
  expectedTitleSha256: string | undefined,
): string {
  const observedTitleSha256 = createHash("sha256")
    .update(canonicalMonitorIdentityTitle(title), "utf8").digest("hex");
  if (/^[0-9a-f]{64}$/u.test(expectedTitleSha256 ?? "") &&
      observedTitleSha256 === expectedTitleSha256) {
    try { return observedStructurePageFromIdentityTitle(title); }
    catch { /* Non-stage titles still require structural classification. */ }
  }
  return observedStructurePage(flags, activeStageTitles);
}

export function observedStructureIdentityTitles(
  page: string,
  flags: ReadonlySet<string>,
  activeStageTitles: readonly string[] = [],
): readonly string[] {
  const titles = page === "profile"
    ? ["My Information", "My Experience"]
    : page === "questionnaire"
      ? ["Application Questions", "Voluntary Disclosures", "Self Identify"]
      : page === "review"
        ? ["Review"]
        : [];
  const active = new Set(activeStageTitles);
  return Object.freeze(titles.filter((title) => active.has(title)));
}

interface ObservedStageCounts {
  readonly myInformation: number;
  readonly myExperience: number;
  readonly applicationQuestions: number;
  readonly voluntaryDisclosures: number;
  readonly selfIdentify: number;
  readonly review: number;
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

export function observedActiveStageTitles(counts: ObservedStageCounts): readonly string[] {
  const entries = [
    ["My Information", counts.myInformation],
    ["My Experience", counts.myExperience],
    ["Application Questions", counts.applicationQuestions],
    ["Voluntary Disclosures", counts.voluntaryDisclosures],
    ["Self Identify", counts.selfIdentify],
    ["Review", counts.review],
  ] as const;
  const maximum = Math.max(...entries.map(([, count]) => count));
  if (maximum < 2) return Object.freeze([]);
  const titles = entries.filter(([, count]) => count === maximum).map(([title]) => title);
  return Object.freeze(titles.length === 1 ? titles : []);
}

function compatibleObservedPage(requestPage: string, observedPage: string): boolean {
  if (requestPage === observedPage) return true;
  if (requestPage === "resume" && observedPage === "profile") return true;
  return requestPage === "application_ready" &&
    ["resume", "profile", "questionnaire", "review"].includes(observedPage);
}

export function normalizeObservedChromeTitle(windowTitle: string): string {
  const suffix = " - Google Chrome for Testing";
  const title = windowTitle.endsWith(suffix)
    ? windowTitle.slice(0, -suffix.length)
    : windowTitle;
  const normalized = title.normalize("NFC").replace(/\s+/gu, " ").trim();
  if (normalized.length < 1 || normalized.length > 256 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    denied();
  }
  return normalized;
}

export function selectObservedChromeIdentityTitle(
  expectedTitleSha256: string | undefined,
  windowTitle: string,
  selectedTabTitles: readonly string[],
): string {
  const windowIdentity = normalizeObservedChromeTitle(windowTitle);
  if (expectedTitleSha256 === undefined || !/^[0-9a-f]{64}$/u.test(expectedTitleSha256)) {
    return windowIdentity;
  }
  if (selectedTabTitles.length > 8) denied();
  const candidates = new Set([windowIdentity]);
  for (const candidate of selectedTabTitles) {
    candidates.add(normalizeObservedChromeTitle(candidate));
  }
  const matches = [...candidates].filter((candidate) =>
    createHash("sha256").update(canonicalMonitorIdentityTitle(candidate), "utf8")
      .digest("hex") === expectedTitleSha256);
  return matches.length === 1 ? matches[0]! : windowIdentity;
}

export function observedChromeIdentityTitleSha256s(
  windowTitle: string,
  selectedTabTitles: readonly string[],
): readonly string[] {
  if (selectedTabTitles.length > 8) denied();
  const candidates = new Set([normalizeObservedChromeTitle(windowTitle)]);
  for (const candidate of selectedTabTitles) {
    candidates.add(normalizeObservedChromeTitle(candidate));
  }
  return Object.freeze([...candidates].map((candidate) =>
    createHash("sha256").update(canonicalMonitorIdentityTitle(candidate), "utf8")
      .digest("hex")));
}

async function waitForDesktopBinding(runtimeRoot: string, token: string): Promise<DesktopBinding> {
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      const value = JSON.parse(stableFile(join(runtimeRoot, DESKTOP_BINDING_FILE), 16 * 1024).toString("utf8"));
      return exactDesktopBinding(value, token);
    } catch {
      if (Date.now() >= deadline) denied();
      await delay(25);
    }
  }
}

function exactDesktopBinding(value: DesktopBinding, token: string): DesktopBinding {
  const keys = [
    "schemaVersion", "bindingRevision", "runKey", "journeyId", "targetHandleId",
    "desktopName", "host", "tenant", "posting", "browserProfilePath", "observerAuthorityTokenSha256",
  ];
  const actual = Object.keys(value);
  const tokenBytes = Buffer.from(token, "base64");
  try {
    if (actual.length !== keys.length || keys.some((key, index) => actual[index] !== key) ||
        value.schemaVersion !== 1 || value.bindingRevision !== "s2-isolated-desktop-binding-v2" ||
        !/^run_\d{8}_[a-z0-9]{16}$/u.test(value.runKey) ||
        !/^journey_[A-Za-z0-9_-]{16,64}$/u.test(value.journeyId) ||
        !/^target_ref_[A-Za-z0-9_-]{16,64}$/u.test(value.targetHandleId) ||
        !/^HuntC3_[0-9a-f]{32}$/u.test(value.desktopName) ||
        !/^[a-z0-9.-]{4,253}$/u.test(value.host) ||
        !/^[a-z0-9-]{2,64}$/u.test(value.tenant) || value.host.split(".")[0] !== value.tenant ||
        !/^[A-Za-z0-9-]{2,64}$/u.test(value.posting) || tokenBytes.byteLength !== 32 ||
        !isAbsolute(value.browserProfilePath) || normalize(value.browserProfilePath) !== value.browserProfilePath ||
        createHash("sha256").update(tokenBytes).digest("hex") !==
          value.observerAuthorityTokenSha256) denied();
    return Object.freeze({ ...value });
  } finally {
    tokenBytes.fill(0);
  }
}

function parseArgs(values: readonly string[]) {
  if (values.length !== 4 || values[0] !== "--runtime-root" || values[2] !== "--evidence-root") {
    denied();
  }
  return Object.freeze({
    runtimeRoot: directory(values[1]!),
    evidenceRoot: directory(values[3]!),
  });
}

function stableFile(path: string, maximum: number): Buffer {
  if (!isAbsolute(path) || normalize(path) !== path || !existsSync(path) ||
      lstatSync(path).isSymbolicLink() || !statSync(path).isFile() || statSync(path).size < 2 ||
      statSync(path).size > maximum ||
      comparable(realpathSync.native(path)) !== comparable(resolve(path))) denied();
  const before = statSync(path);
  const bytes = readFileSync(path);
  const after = statSync(path);
  if (before.size !== bytes.byteLength || before.ctimeMs !== after.ctimeMs ||
      before.mtimeMs !== after.mtimeMs) denied();
  return bytes;
}

function directory(value: string): string {
  if (!isAbsolute(value) || normalize(value) !== value || lstatSync(value).isSymbolicLink() ||
      !statSync(value).isDirectory() ||
      comparable(realpathSync.native(value)) !== comparable(resolve(value))) denied();
  return realpathSync.native(value);
}

function comparable(value: string): string {
  const normalized = normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function denied(): never {
  throw new Error("external monitor observer denied");
}
