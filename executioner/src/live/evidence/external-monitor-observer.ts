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
} from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";

import {
  createStage2ExternalMonitorObserverAuthority,
} from "./external-monitor-authority.ts";
import { reviewedMonitorStructureId } from "./monitor-structures.ts";
import { writeStage2ExternalMonitorAcknowledgement } from
  "./external-monitor-runtime.ts";

const DESKTOP_BINDING_FILE = "isolated-desktop.json";
const OWNER_LIVE_FILE = "external-monitor-live.json";
const STOP_FILE = "external-monitor-observer-stop";

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
        acknowledge(runtimeRoot, evidenceRoot, requestPath, binding, authority);
      }
      await delay(50);
    }
  } finally {
    authority.close();
    rmSync(stopPath, { force: true });
  }
}

function acknowledge(
  runtimeRoot: string,
  evidenceRoot: string,
  requestPath: string,
  binding: DesktopBinding,
  observer: ReturnType<typeof createStage2ExternalMonitorObserverAuthority>,
): void {
  const request = observerStage("request_admission", () =>
    JSON.parse(stableFile(requestPath, 16 * 1024).toString("utf8"))) as {
    readonly page?: unknown;
    readonly moment?: unknown;
    readonly screenshotFile?: unknown;
  };
  if (typeof request.page !== "string" || typeof request.moment !== "string" ||
      typeof request.screenshotFile !== "string") denied();
  const structure = reviewedMonitorStructureId(request.page);
  if (structure === undefined) denied();
  const screenshotPath = join(dirname(requestPath), request.screenshotFile);
  const screenshot = observerStage("screenshot_admission", () =>
    stableFile(screenshotPath, 12 * 1024 * 1024));
  const visual = observerStage("owned_browser_observation", () =>
    ownedBrowserObservation(runtimeRoot, binding));
  if (!compatibleObservedPage(request.page, visual.page)) denied();
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

const OBSERVER_FAILURE_CODES = [
  "request_admission",
  "screenshot_admission",
  "owned_browser_observation",
  "browser_process_binding",
  "browser_window_missing",
  "browser_window_ambiguous",
  "process_inventory",
  "accessibility_tree",
  "browser_observation_command",
  "accessibility_payload",
  "address_identity",
  "structure_classification",
  "title_identity",
  "acknowledgement_admission",
] as const;

type ObserverFailureCode = typeof OBSERVER_FAILURE_CODES[number];

function observerStage<T>(code: ObserverFailureCode, run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (externalMonitorObserverFailureCode(error) !== undefined) throw error;
    throw new Error(`external monitor observer failed: ${code}`);
  }
}

function observerFailure(code: ObserverFailureCode): never {
  throw new Error(`external monitor observer failed: ${code}`);
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
): { readonly title: string; readonly page: string; readonly submitPresent: boolean } {
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
  (Test-OwnedAncestor ([int]$_.ProcessId) ([int]$owner.processOwnerPid))
} | ForEach-Object {
  [pscustomobject]@{ Pid = [int]$_.ProcessId }
}) } catch { exit 45 }
if ($browsers.Count -eq 0) { exit 47 }
if ($browsers.Count -ne 1) { exit 48 }
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
  'Email Address', 'Password', 'Forgot Password', 'Reset Password', 'Send Verification Email',
  'My Information', 'My Experience', 'Application Questions', 'Voluntary Disclosures',
  'Self Identify', 'Review', 'Submit', 'Submit application', 'Next', 'Save and Continue',
  'Upload a resume', 'Upload Resume'
)
$seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$address = $null
foreach ($element in $elements) {
  try {
    if ($element.Current.IsOffscreen) { continue }
    $name = [string]$element.Current.Name
    if ($allow -contains $name) { [void]$seen.Add($name) }
    if ($address -eq $null -and $element.Current.ControlType.Id -eq 50004 -and
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
    if (status === 40) observerFailure("process_inventory");
    if (status === 42 || status === 43 || status === 44) observerFailure("accessibility_tree");
    if (status === 45) observerFailure("browser_process_binding");
    if (status === 46) observerFailure("accessibility_payload");
    observerFailure("browser_observation_command");
  }
  let observed: { readonly title?: unknown; readonly address?: unknown; readonly flags?: unknown };
  try {
    observed = JSON.parse(Buffer.from(output, "base64").toString("utf8"));
  } catch { return observerFailure("accessibility_payload"); }
  if (typeof observed.title !== "string" || !Array.isArray(observed.flags) ||
      observed.flags.some((value) => typeof value !== "string")) {
    observerFailure("accessibility_payload");
  }
  if (typeof observed.address === "string" && observed.address.length > 0) {
    let host: string;
    try { host = normalizeObservedAddressHost(observed.address); }
    catch { return observerFailure("address_identity"); }
    if (host !== binding.host) observerFailure("address_identity");
  }
  const flags = new Set(observed.flags.map(canonicalObservedFlag));
  let page: string;
  try { page = observedStructurePage(flags); }
  catch { return observerFailure("structure_classification"); }
  let title: string;
  try { title = normalizeObservedChromeTitle(observed.title); }
  catch { return observerFailure("title_identity"); }
  return Object.freeze({
    title,
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
  const canonical = [
    "Apply", "Apply Now", "Apply Manually", "Sign in with email", "Create Account", "Sign In",
    "Email Address", "Password", "Forgot Password", "Reset Password", "Send Verification Email",
    "My Information", "My Experience", "Application Questions", "Voluntary Disclosures",
    "Self Identify", "Review", "Submit", "Submit application", "Next", "Save and Continue",
    "Upload a resume", "Upload Resume",
  ].find((candidate) => candidate.toLowerCase() === value.toLowerCase());
  return canonical ?? value;
}

export function observedStructurePage(flags: ReadonlySet<string>): string {
  if (flags.has("Review") && (flags.has("Submit") || flags.has("Submit application"))) return "review";
  if (flags.has("Application Questions") || flags.has("Voluntary Disclosures") || flags.has("Self Identify")) return "questionnaire";
  if (flags.has("Upload a resume") || flags.has("Upload Resume")) return "resume";
  if (flags.has("My Information") || flags.has("My Experience")) return "profile";
  if (flags.has("Reset Password")) return "password_reset_set";
  if (flags.has("Send Verification Email")) return "verification_required";
  if (flags.has("Forgot Password")) return "password_reset_request";
  if (flags.has("Sign in with email")) return "email_sign_in_choice";
  if (flags.has("Apply Manually")) return "apply_choice";
  if (flags.has("Apply") || flags.has("Apply Now")) return "job_posting";
  if (flags.has("Create Account") || flags.has("Sign In")) return "account_entry";
  denied();
}

function compatibleObservedPage(requestPage: string, observedPage: string): boolean {
  if (requestPage === observedPage) return true;
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
