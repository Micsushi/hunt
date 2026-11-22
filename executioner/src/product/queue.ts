import { randomUUID, createHash } from "node:crypto";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Browser, Page } from "playwright";
import { writePrivateFileAtomic } from "../composition/private/s2-application-source-preparation.ts";
import { applicationTarget, canonicalPostingKey, possiblePostingAlias, productApplicationTarget } from "./target.ts";
import { ApplicationPause, fillApplication, restoreSavedReview, reviewDigest, reviewSnapshot, submitReviewedApplication, type ProductInput } from "./engine.ts";
import { accountJournal, employerAccountPolicy } from "./account-journal.ts";
import { applicantProfile, productSources, effectiveProfileFacts } from "./sources.ts";
import { disposeResumeArtifact } from "../contracts/index.ts";
import { AttachmentFailure } from './extension-bridge.ts';
import { viewportCleanupPending } from '../../extension/page-viewport.js';

import { smartRecruitersPublication, verifySmartRecruitersApplication } from './smartrecruiters-target.ts';
import { componentFailure, recordComponentFailure, type ComponentFailure } from "./component-diagnostics.ts";

export type JobStatus = "queued" | "running" | "paused" | "review" | "submitting" | "submitted" | "submission_uncertain" | "removed";

const workdayApplicationConnection = "Connecting to the Workday application";
const safeFailureStages = new Set(["Opening application", "Opening employer account", workdayApplicationConnection, "Opening existing account sign-in", "Signing in",
  "Waiting for account page", "Continuing opened application", "Filling application", "Verifying application",
  "Checking application page", "Moving to the next page", "Checking application review",
  "Filling profile", "Uploading resume", "Answering questions"]);
const safeFailureFiles = new Set(["engine.ts", "queue.ts", "hosted-application.ts", "generic-application.ts",
  "extension-bridge.ts", "playwright-account-page.ts", "playwright-posting-navigation.ts",
  "application-authentication.ts", "application-review.ts", "current-page-workflow.ts",
  "workday-workflow.ts", "workday-application-runtime.ts", "workday-walk-diagnostics.ts", "page-answer-planner.ts",
  "page-matching.ts", "workable-resume.ts", "greenhouse-resume.ts"]);

function runFailure(error: unknown, stage: string) {
  const message = error instanceof Error ? error.message : "";
  const operation = error instanceof AttachmentFailure ? 'browser.attach' : message.match(/^(locator\.(?:count|isVisible|isEditable|isEnabled|inputValue|fill|click|evaluate|waitFor|press|blur)|page\.(?:evaluate|goto|waitForFunction)): /)?.[1];
  const category = error instanceof AttachmentFailure ? error.code : /strict mode violation/i.test(message) ? "ambiguous_control"
    : /intercepts pointer events/i.test(message) ? "click_intercepted"
    : /not attached|detached/i.test(message) ? "control_detached"
    : /(?:page|context|browser|target).{0,30}closed/i.test(message) ? "browser_closed"
    : error instanceof Error && error.name === "TimeoutError" ? "browser_timeout"
    : error instanceof TypeError ? "type_error" : "unexpected_error";
  const sourceFrames = error instanceof Error ? (error.stack ?? "").split("\n").flatMap(line=>{
    if (!/^\s+at\s/.test(line)) return [];
    const match = line.match(/(?:\/|\\)([a-z-]+\.ts):(\d+):(\d+)\)?$/);
    return match && safeFailureFiles.has(match[1]!) ? [`${match[1]}:${match[2]}:${match[3]}`] : [];
  }).slice(0,6) : [];
  return {stage:safeFailureStages.has(stage)?stage:"Other",category,operation,sourceFrames};
}
export interface ProductJob {
  id: string; url: string; key: string; title: string; status: JobStatus; stage: string;
  pageHandoff?: true; selectedDocument?: string; selectedApplicationUrl?: string; tabId?: number; sourceJobId?: number; error?: string; reviewDigest?: string; reviewUrl?: string; submissionAllowed?: boolean;
  componentFailure?: ComponentFailure;
  createdAt: string; updatedAt: string;
  resumeName?: string; resumeVersion?: string; resumeSha256?: string; resumeExpected?: boolean; resumeUpload?: ProductInput['resumeUpload'];
}
export interface BrowserConnection {
  connected: boolean;
  open(url: string, tabId?: number, existingOnly?: boolean): Promise<{ tabId: number; page: Page; browser: Browser }>;
  release(tabId: number): Promise<void>;
  focus?(tabId: number, url?: string): Promise<void>;
  prepareAccount?(options: import('./workday-sign-in.ts').WorkdayAccountOptions): Promise<void>;
}
export class ApplicationQueue {
  jobs: ProductJob[] = [];
  concurrency = 6;
  credentials?: ProductInput["credentials"];
  verifyEmail?: import('./workday-sign-in.ts').WorkdayAccountOptions['verifyEmail'];
  private running = new Map<string, AbortController>();
  private sessions = new Map<string, { tabId: number; page: Page; browser: Browser }>();
  private settings?: { profile: unknown; resume: string };
  private timer: NodeJS.Timeout;
  private closed = false;
  private reviewActions = new Set<string>();
  private active = new Set<Promise<unknown>>();
  private closing?: Promise<void>;
  private storageError?: string;
  readonly root: string;
  private bridge: BrowserConnection;
  private fill: typeof fillApplication;
  private submit: typeof submitReviewedApplication;
  constructor(root: string, bridge: BrowserConnection,
    fill = fillApplication, submit = submitReviewedApplication) {
    this.root = root; this.bridge = bridge; this.fill = fill; this.submit = submit;
    mkdirSync(root, { recursive: true, mode: 0o700 });
    if (existsSync(join(root, "jobs.json"))) {
      const saved = JSON.parse(readFileSync(join(root, "jobs.json"), "utf8"));
      if (!Array.isArray(saved.jobs) || !Number.isInteger(saved.concurrency) || saved.concurrency < 1 || saved.concurrency > 30 ||
          saved.jobs.some((job: ProductJob) => !job || (job.resumeExpected !== undefined && typeof job.resumeExpected !== "boolean") || !/^[a-f0-9-]{36}$/.test(job.id) || !["queued", "running", "paused", "review", "submitting", "submitted", "submission_uncertain", "removed"].includes(job.status) || productApplicationTarget(job.url).key !== job.key) ||
          new Set(saved.jobs.map((job: ProductJob) => job.id)).size !== saved.jobs.length) throw new Error("Saved C3 queue is invalid. Preserve its data before restoring a backup.");
      this.jobs = saved.jobs;
      this.concurrency = saved.concurrency;
      for (const job of this.jobs) {
        delete job.tabId;
        if (job.status === "submitting") { job.status = "submission_uncertain"; job.stage = "Check the employer site before doing anything else"; }
        else if (["running", "queued", "review"].includes(job.status)) { job.status = "paused"; job.stage = "Service restarted. Retry to inspect the saved application"; }
      }
      this.save();
    }
    if (existsSync(join(root, "settings.json"))) this.settings = JSON.parse(readFileSync(join(root, "settings.json"), "utf8"));
    this.timer = setInterval(() => this.safePump(), 1000);
    this.timer.unref();
  }
  private persist(path: string, value: unknown) {
    try {
      writePrivateFileAtomic(path, Buffer.from(JSON.stringify(value)));
    } catch {
      this.storageError = "C3 could not save progress. Work is paused. Check available disk space and access, then retry.";
      for (const controller of this.running.values()) controller.abort(new ApplicationPause(this.storageError));
      throw new ApplicationPause(this.storageError);
    }
  }
  private save() { this.persist(join(this.root, "jobs.json"), { jobs: this.jobs, concurrency: this.concurrency }); }
  private safePump() { try { this.pump(); } catch { /* save() exposes the failure and pauses active work. */ } }
  private changed(job: ProductJob) { job.updatedAt = new Date().toISOString(); this.save(); }
  snapshot() {
    const profileDigest=this.settings?createHash('sha256').update(JSON.stringify(this.settings.profile)).digest('hex'):undefined;
    return { jobs: this.jobs.filter(j => j.status !== "removed").map(job => {
      let profileUpdateAvailable=false;
      if (job.status==='paused' && profileDigest) try {
        const input=JSON.parse(readFileSync(join(this.root,`${job.id}.input.json`),'utf8'));
        profileUpdateAvailable=createHash('sha256').update(JSON.stringify(input.profile)).digest('hex')!==profileDigest;
      } catch { /* A damaged saved input is reported by the explicit job action. */ }
      const currentPageOnly = productApplicationTarget(job.url).ats === 'generic';
      return {...job,currentPageOnly,profileUpdateAvailable,actionPending:this.running.has(job.id)||this.reviewActions.has(job.id)};
    }), connected: this.bridge.connected,
    configured: !!this.settings, accountConfigured: !!this.credentials, emailConfigured: !!this.verifyEmail, concurrency: this.concurrency, storageError: this.storageError }; }
  getSettings() { return this.settings ?? null; }
  currentPageInput(job: ProductJob): {profile: unknown; resume: string} {
    if (!job.pageHandoff || job.status !== 'paused' || !job.sourceJobId || !job.resumeVersion || !job.resumeSha256) {
      throw new Error('This application has no selected current-page handoff.');
    }
    const input = JSON.parse(readFileSync(join(this.root, job.id + '.input.json'), 'utf8'));
    if (typeof input.resume !== 'string' || createHash('sha256').update(Buffer.from(input.resume, 'base64')).digest('hex') !== job.resumeSha256) {
      throw new Error('The saved PDF differs from the selected Hunt resume. Check the application in Hunt.');
    }
    return input;
  }
  recoverStorage() { this.save(); this.storageError = undefined; this.safePump(); }
  configureApplicant(values: unknown, resumeBase64?: string) {
    this.configure(applicantProfile(values, this.settings?.profile), resumeBase64 ?? this.settings?.resume ?? "");
  }
  configure(profile: unknown, resumeBase64: string) {
    const resume = Buffer.from(resumeBase64, "base64");
    const sources = productSources(profile, resume);
    disposeResumeArtifact(sources.resumeIntent.artifact);
    const settings = { profile, resume: resume.toString("base64") };
    if (this.settings) this.persist(join(this.root, 'settings.previous.json'), this.settings);
    this.persist(join(this.root, "settings.json"), settings);
    this.settings = settings;
  }
  setConcurrency(value: number) {
    if (!Number.isInteger(value) || value < 1 || value > 30) throw new Error("Choose between 1 and 30 simultaneous jobs.");
    this.concurrency = value; this.save(); this.safePump();
  }
  add(inputs: { url: string; title?: string; tabId?: number; sourceJobId?: number; resumeBase64?: string; resumeName?: string; resumeVersion?: string }[], options: { paused?: boolean; currentPageHandoff?: boolean } = {}) {
    if (!this.settings) throw new Error("Choose a profile and resume first.");
    if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 100) throw new Error("Add between 1 and 100 job links.");
    const prepared = inputs.map(input => {
      const target = options.paused && options.currentPageHandoff ? productApplicationTarget(input.url) : applicationTarget(input.url);
      if (target.ats === 'generic' && (!input.resumeBase64 || !input.sourceJobId || !input.resumeVersion || input.tabId !== undefined)) {
        throw new Error('Import the complete selected Hunt job and resume for current-page filling.');
      }
      if (input.sourceJobId !== undefined && (!Number.isSafeInteger(input.sourceJobId) || input.sourceJobId < 1)) throw new Error("Invalid Hunt job.");
      for (const value of [input.title, input.resumeName, input.resumeVersion]) if (value !== undefined && (typeof value !== "string" || value.length > 500)) throw new Error("Invalid job or resume label.");
      if (input.tabId !== undefined && (!Number.isSafeInteger(input.tabId) || input.tabId < 1)) throw new Error("Invalid browser tab.");
      const resume = Buffer.from(input.resumeBase64 ?? this.settings!.resume, 'base64').toString('base64');
      const sources = productSources(this.settings!.profile, Buffer.from(resume, "base64"));
      disposeResumeArtifact(sources.resumeIntent.artifact);
      return { input, target, resume, submissionAllowed: target.ats === "workday" && sources.profilePlan.mode === "live" && sources.executionPolicy.browserTransport === "live_browser" };
    });
    const added: ProductJob[] = [];
    const pendingInputs = new Map<string, {profile: unknown; resume: string}>();
    const next = this.jobs.map(job => ({ ...job }));
    for (const { input, target, resume, submissionAllowed } of prepared) {
      const existing = next.find(j => canonicalPostingKey(j.key) === target.key && j.status !== "removed");
      if (existing) {
        if (options.paused && (existing.status !== "paused" || this.running.has(existing.id) || this.reviewActions.has(existing.id))) throw new Error("This application is already active. Pause it before importing a resume.");
        if (input.tabId !== undefined && input.tabId !== existing.tabId) {
          if (existing.status !== "paused" || this.running.has(existing.id) || this.reviewActions.has(existing.id)) throw new Error("Pause this job before connecting another tab.");
          existing.tabId = input.tabId;
        }
        if (input.resumeBase64 !== undefined && Buffer.from((pendingInputs.get(existing.id) ?? JSON.parse(readFileSync(join(this.root, `${existing.id}.input.json`), "utf8"))).resume, 'base64').toString('base64') !== resume) throw new Error("This job already has a different resume. Remove its existing entry before adding the new selection; pause it first if it is running.");
        if (input.sourceJobId !== undefined) {
          if (existing.sourceJobId !== undefined && existing.sourceJobId !== input.sourceJobId) throw new Error("This application is already linked to another Hunt job.");
          if (existing.sourceJobId === undefined) existing.resumeName = input.resumeName ?? existing.resumeName;
          existing.sourceJobId = input.sourceJobId;
          existing.resumeName ??= input.resumeName;
          existing.resumeVersion ??= input.resumeVersion;
        }
        added.push(existing); continue;
      }
      const id = randomUUID();
      pendingInputs.set(id, { profile: this.settings.profile, resume });
      const job: ProductJob = { id, ...target, title: input.title?.slice(0, 200) || target.posting,
        ...(target.ats === 'generic' && {pageHandoff:true}),
        status: options.paused ? "paused" : "queued", stage: options.paused ? "Imported paused. Review the resume and choose Run when ready" : "Queued", tabId: input.tabId, sourceJobId: input.sourceJobId, submissionAllowed,
        resumeName: input.resumeName ?? "Default resume", resumeVersion: input.resumeVersion,
        resumeSha256: createHash("sha256").update(Buffer.from(resume, "base64")).digest("hex"),
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      next.push(job); added.push(job);
    }
    for (const [id, value] of pendingInputs) this.persist(join(this.root, `${id}.input.json`), value);
    this.persist(join(this.root, "jobs.json"), { jobs: next, concurrency: this.concurrency });
    // Preserve active runner references when publishing metadata on existing jobs.
    this.jobs = next.map(job => { const current = this.jobs.find(item => item.id === job.id); return current ? Object.assign(current, job) : job; });
    this.safePump(); return added;
  }
  async action(id: string, action: string, digest?: string, confirmed?: boolean, options: {expectedProfileRevision?:unknown;expectedProfileDigest?:unknown;inputDigest?:unknown;refreshToken?:unknown} = {}) {
    if (this.closed) throw new Error("The application service is stopping.");
    if (this.storageError && action === "retry") this.recoverStorage();
    if (action === 'refresh_profile' || action === 'undo_profile_refresh') {
      const job=this.jobs.find(job=>job.id===id);
      if (!job || job.status!=='paused' || this.running.has(id) || this.reviewActions.has(id)) throw new Error('Wait for this application to pause before refreshing its profile.');
      if (action === 'refresh_profile' && productApplicationTarget(job.url).ats === 'generic') {
        throw new Error('Finish this saved draft on the employer page to preserve its selected resume.');
      }
      if (this.storageError) throw new Error(this.storageError);
      const inputPath=join(this.root,`${id}.input.json`),backupPath=join(this.root,`${id}.profile-refresh.json`);
      const before=readFileSync(inputPath,'utf8');
      const history: {token:string;profile:unknown;afterDigest:string}[]=existsSync(backupPath)?JSON.parse(readFileSync(backupPath,'utf8')).entries:[];
      if (action === 'undo_profile_refresh') {
        const saved=history.find(entry=>entry.token===options.refreshToken);
        if (!saved || typeof options.inputDigest!=='string' || saved.afterDigest!==options.inputDigest ||
            createHash('sha256').update(before).digest('hex')!==options.inputDigest) throw new Error('This application profile changed after the refresh. Its newer details were kept.');
        this.persist(inputPath,{...JSON.parse(before),profile:saved.profile});
        return {undone:true};
      }
      const revision=(this.settings?.profile as {profile?:{revision?:number}}|undefined)?.profile?.revision;
      if (!Number.isSafeInteger(options.expectedProfileRevision) || options.expectedProfileRevision!==revision ||
          options.expectedProfileDigest!==createHash('sha256').update(JSON.stringify(this.settings?.profile)).digest('hex')) throw new Error('Saved profile changed. Refresh the profile view and review its details first.');
      const input=JSON.parse(before);
      const sources=productSources(this.settings!.profile,Buffer.from(input.resume,'base64'));
      disposeResumeArtifact(sources.resumeIntent.artifact);
      const after=JSON.stringify({...input,profile:this.settings!.profile});
      if (after===before) return {unchanged:true};
      const inputDigest=createHash('sha256').update(after).digest('hex');
      const refreshToken=createHash('sha256').update(before).update(inputDigest).digest('hex');
      this.persist(backupPath,{entries:[...history.filter(entry=>entry.token!==refreshToken).slice(-19),{token:refreshToken,profile:input.profile,afterDigest:inputDigest}]});
      this.persist(inputPath,JSON.parse(after));
      return {inputDigest,refreshToken,profileRevision:revision};
    }
    if (!["refresh_review", "submit"].includes(action)) return this.performAction(id, action, digest, confirmed);
    if (this.reviewActions.has(id)) throw new Error("A review action is already in progress for this job.");
    this.reviewActions.add(id);
    return await this.track((async () => {
      try { return await this.performAction(id, action, digest, confirmed); }
      finally {
        try { await this.release(id); }
        finally { this.reviewActions.delete(id); }
      }
    })());
  }
  private async reviewSession(job: ProductJob) {
    if (!job.tabId) throw new Error("Retry this job to reopen and inspect its saved draft.");
    const session = await this.bridge.open(job.url, job.tabId, true);
    this.sessions.set(job.id, session);
    if (this.closed) {
      await this.release(job.id);
      throw new Error("The application service is stopping.");
    }
    const current = new URL(session.page.url()), reviewed = new URL(job.reviewUrl ?? job.url);
    if (current.origin !== reviewed.origin || current.pathname !== reviewed.pathname) throw new Error("The tab moved away from this application's review. Return to the original draft.");
    return session;
  }
  private async performAction(id: string, action: string, digest?: string, confirmed?: boolean) {
    const job = this.jobs.find(j => j.id === id);
    if (!job) throw new Error("Job not found.");
    if (action === "open") {
      if (!job.tabId && job.status === 'paused' && job.selectedDocument && job.selectedApplicationUrl && productApplicationTarget(job.url).ats === 'generic') {
        const selected = URL.parse(job.selectedApplicationUrl);
        const publication = selected && smartRecruitersPublication(selected);
        if (selected && publication && job.selectedApplicationUrl === selected.origin + selected.pathname + selected.search &&
            (!selected.search || selected.search === '?dcr_ci=' + publication.company) &&
            await verifySmartRecruitersApplication(job.url, selected.href)) return {url:selected.href};
        throw new Error('The saved application link could not be verified. Open the posting using its title.');
      }
      if (!job.tabId || !this.bridge.focus) {
        if (productApplicationTarget(job.url).ats === 'generic') throw new Error("The original tab is unavailable. Open the saved employer posting using its title.");
        throw new Error("The original tab is unavailable. Retry this job to open its saved draft.");
      }
      await this.bridge.focus(job.tabId, job.url); return;
    }
    if (["retry", "refresh_review", "submit"].includes(action) && productApplicationTarget(job.url).ats === "generic") {
      throw new Error("This saved draft uses an unfamiliar site. Finish it on the employer page to preserve its selected resume.");
    }
    if (action === "refresh_review") {
      if (job.status !== "review" && !(job.status === "paused" && job.reviewUrl) || this.running.has(id)) throw new Error("Wait for this job to pause before refreshing its review.");
      try {
        const session = await this.reviewSession(job).catch(error => {
          recordComponentFailure(error, "browser_interaction", "open_review_tab");
          throw error;
        });
        await restoreSavedReview(session.page, job.reviewUrl ?? job.url).catch(error => {
          recordComponentFailure(error, "review", "restore_saved_review");
          throw error;
        });
        const resumeSha256 = job.resumeSha256 ?? createHash("sha256").update(Buffer.from(
          JSON.parse(readFileSync(join(this.root, `${job.id}.input.json`), "utf8")).resume, "base64")).digest("hex");
        const verified = await reviewSnapshot(session.page, resumeSha256, job.resumeExpected, job.resumeUpload).catch(error => {
          recordComponentFailure(error, "review", "inspect_saved_review");
          throw error;
        });
        const digest = verified.digest;
        if (this.closed) throw new Error("The application service is stopping.");
        if (job.status === "paused") job.stage = "Owner review needed: Check every answer and the attached resume.";
        job.resumeExpected = job.resumeExpected === true || verified.resumeExpected;
        job.status = "review"; job.reviewDigest = digest; delete job.error; delete job.componentFailure; this.changed(job); return;
      } catch (error) {
        if (!this.closed) {
          job.status = "paused"; job.stage = "Review needs attention"; delete job.reviewDigest;
          job.componentFailure = componentFailure(error);
          job.error = error instanceof ApplicationPause ? error.message : "C3 could not verify this review. Inspect the tab, then refresh its review or retry.";
          this.changed(job);
        }
        throw error;
      }
    }
    if (action === "pause") {
      if (!["queued", "running"].includes(job.status)) throw new Error("This job is not running.");
      this.running.get(id)?.abort(new Error("Paused by you"));
      job.status = "paused"; job.stage = "Paused"; this.changed(job);
      await this.release(id); return;
    }
    if (action === "retry") {
      if (!["paused", "review"].includes(job.status) || this.running.has(id) || this.reviewActions.has(id)) throw new Error("Wait for this job to pause before retrying.");
      job.status = "queued"; job.stage = "Queued"; delete job.error; delete job.componentFailure; delete job.reviewDigest; this.changed(job); this.safePump(); return;
    }
    if (action === "remove" || action === "restore") {
      if (action === "restore" && this.jobs.some(other => other.id !== id && possiblePostingAlias(other.key) === possiblePostingAlias(job.key) && other.status !== "removed")) throw new Error("This job has already been added again. Remove the newer entry before restoring this one.");
      if (action === "remove" && !["paused", "queued", "review"].includes(job.status) || action === "restore" && job.status !== "removed" || this.running.has(id) || this.reviewActions.has(id)) throw new Error("Wait for the job to pause and its review to finish before removing it.");
      job.status = action === "remove" ? "removed" : "paused"; job.stage = action === "remove" ? "Removed" : "Restored. Retry when ready"; this.changed(job); return;
    }
    if (action === "submit") {
      if (job.status !== "review" || !job.submissionAllowed || !confirmed || !digest || digest !== job.reviewDigest) throw new Error("Review and confirm this application before submitting.");
      const session = await this.reviewSession(job);
      if (await reviewDigest(session.page) !== digest) throw new Error("The application changed. Open the tab, review it, then refresh its review before submitting.");
      // Another request may have submitted while this request read the page.
      if (this.closed || job.status !== "review" || this.sessions.get(id) !== session || job.reviewDigest !== digest) throw new Error("This application is already being submitted or its review changed.");
      // Persist before the external effect. A crash must never silently retry Submit.
      const reviewStage = job.stage;
      job.status = "submitting"; job.stage = "Submitting";
      try { this.changed(job); } catch (error) { job.status = "review"; job.stage = reviewStage; throw error; }
      try { job.status = await this.submit(session.page, digest); }
      catch { job.status = "submission_uncertain"; }
      job.stage = job.status === "submitted" ? "Submitted" : "Check the employer site. C3 will not submit again automatically";
      delete job.reviewDigest; this.changed(job);
      await this.release(id); return;
    }
    throw new Error("Unknown application action.");
  }
  private pump() {
    if (this.closed || this.storageError || !this.bridge.connected) return;
    for (const job of this.jobs) {
      if (this.running.size >= this.concurrency) break;
      if (job.status !== "queued" || this.running.has(job.id)) continue;
      // Workday tabs share account cookies. Serialize jobs for the same employer.
      if (this.jobs.some(j => this.running.has(j.id) && productApplicationTarget(j.url).host === productApplicationTarget(job.url).host && (productApplicationTarget(job.url).ats === "workday" || productApplicationTarget(j.url).posting.split("/")[0] === productApplicationTarget(job.url).posting.split("/")[0]))) continue;
      const controller = new AbortController();
      this.running.set(job.id, controller);
      job.status = "running"; job.stage = "Opening application";
      try { this.changed(job); } catch (error) { this.running.delete(job.id); job.status = "paused"; throw error; }
      void this.track(this.run(job, controller)).catch(() => { /* Persistence failure already stops the queue. */ });
    }
  }
  private async run(job: ProductJob, controller: AbortController) {
    const runId = randomUUID();
    const deadline = setTimeout(() => {
      controller.abort(new ApplicationPause("This job exceeded 30 minutes. The draft is preserved; inspect the tab before retrying."));
      void this.release(job.id).catch(() => {});
    }, 30 * 60_000);
    deadline.unref();
    try {
      const target = applicationTarget(job.url);
      await this.release(job.id);
      const input = JSON.parse(readFileSync(join(this.root, `${job.id}.input.json`), "utf8"));
      const journal = accountJournal(this.root, job.id, runId);
      if (target.ats === 'workday' && this.bridge.prepareAccount) {
        if (input.profile?.profilePlan?.mode === 'synthetic_test_non_submittable') throw new ApplicationPause('This is a synthetic test profile. Choose your saved personal profile before running a real application.');
        job.stage = 'Opening employer account';
        const policy = this.credentials ? employerAccountPolicy(this.root,job.url,this.credentials.email) : undefined;
        await this.bridge.prepareAccount({ url: job.url, tabId: job.tabId, credentials: this.credentials,
          preferCreate:policy?.preferCreate,verificationSince:policy?.verificationSince,verifyEmail:this.verifyEmail,
          acceptCreationTerms:effectiveProfileFacts(input.profile).some(f=>f.factId==='terms_consent' && f.value===true),
          signal: controller.signal, record:(event,trace,observation)=>{journal(event,trace,observation);policy?.record(event);}, onTab: tabId => { job.tabId = tabId; this.changed(job); } }).catch(error => {
          recordComponentFailure(error, "authentication", "prepare_account");
          throw error;
        });
        job.stage = workdayApplicationConnection;
      }
      const session = await this.bridge.open(job.url, job.tabId, target.ats === 'workday' && !!this.bridge.prepareAccount).catch(error => {
        recordComponentFailure(error, "browser_interaction", "open_tab");
        throw error;
      });
      this.sessions.set(job.id, session); job.tabId = session.tabId;
      controller.signal.throwIfAborted();
      this.changed(job);
      const result = await this.fill(session.page, { url: job.url, profile: input.profile, learningRoot: join(this.root, "learning", job.id, runId),
        resume: Buffer.from(input.resume, "base64"), resumeExpected: job.resumeExpected,
        onResumeObserved: () => { job.resumeExpected = true; this.changed(job); },
        resumeUpload: job.resumeUpload, onResumeUpload: receipt => { job.resumeUpload = receipt; this.changed(job); },
        credentials: this.credentials, requireScriptSignIn: !!this.bridge.prepareAccount, recordAccountAction: journal }, controller.signal,
      stage => { if (job.status === "running" && job.stage !== stage) { job.stage = stage; job.updatedAt = new Date().toISOString(); } });
      controller.signal.throwIfAborted();
      const reviewUrl = session.page.url();
      await this.release(job.id);
      controller.signal.throwIfAborted();
      job.status = "review";
      job.stage = result.needsOwnerReview ? "Owner review needed: suggested or unverified answers. Check every answer in the draft." : "Ready to review";
      job.resumeExpected = job.resumeExpected === true || result.resumeExpected;
      job.reviewDigest = result.reviewDigest; job.reviewUrl = reviewUrl; delete job.error; delete job.componentFailure;
      this.changed(job);
    } catch (error) {
      job.componentFailure = controller.signal.aborted ? undefined : componentFailure(error);
      if (!controller.signal.aborted && (job.componentFailure || !(error instanceof ApplicationPause))) {
        try {
          const directory = join(this.root, "learning", job.id, runId);
          mkdirSync(directory, {recursive:true,mode:0o700});
          writePrivateFileAtomic(join(directory,"run-failure.json"),
            Buffer.from(JSON.stringify({schemaVersion:1,...runFailure(error,job.stage),componentFailure:job.componentFailure})));
        } catch { /* Diagnostics do not affect the paused job or release its tab. */ }
      }
      const reachedWorkdayApplication = job.stage === workdayApplicationConnection;
      job.status = "paused"; job.stage = controller.signal.aborted ? "Paused" : "Needs attention";
      // Never retain Playwright errors containing DOM snippets or typed values.
      job.error = controller.signal.aborted
        ? controller.signal.reason instanceof ApplicationPause ? controller.signal.reason.message : "Paused. Your draft is preserved."
        : error instanceof ApplicationPause ? error.message
        : error instanceof AttachmentFailure && error.code==='debugger_protected_extension' ? (reachedWorkdayApplication ? 'Workday opened the application. ' : '') + 'Chrome is protecting another extension on this tab. If an extension popup is open, dismiss it and retry. If Chrome still blocks access, continue in the employer tab. Your draft is preserved.'
        : error instanceof AttachmentFailure && error.code==='attachment_viewport_unavailable' ? 'This tab has no usable page area. Resize or restore its browser window, then retry.'
        : error instanceof AttachmentFailure && error.code==='attachment_viewport_cleanup_pending' || error instanceof Error && error.message===viewportCleanupPending ? viewportCleanupPending
        : "C3 could not finish this page. Inspect the tab, then retry.";
      await this.release(job.id);
    } finally { clearTimeout(deadline); this.running.delete(job.id); this.changed(job); this.safePump(); }
  }
  private track<T>(promise: Promise<T>): Promise<T> {
    this.active.add(promise);
    void promise.then(() => this.active.delete(promise), () => this.active.delete(promise));
    return promise;
  }
  private release(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return Promise.resolve();
    this.sessions.delete(id);
    return this.track((async () => {
      // Detach even if closing the automation connection never resolves.
      const [, detached] = await Promise.allSettled([
        session.browser.close(), this.bridge.release(session.tabId),
      ]);
      if (detached.status === "rejected") {
        if(detached.reason instanceof Error && detached.reason.message===viewportCleanupPending){const job=this.jobs.find(job=>job.id===id);if(job){job.error=viewportCleanupPending;this.changed(job);}}
        throw detached.reason;
      }
    })());
  }
  close(timeoutMs = 5_000): Promise<void> {
    return this.closing ??= this.drain(timeoutMs);
  }
  private async drain(timeoutMs: number) {
    this.closed = true;
    clearInterval(this.timer);
    for (const controller of this.running.values()) controller.abort(new Error("Service stopped"));
    for (const id of this.sessions.keys()) void this.release(id).catch(() => {});
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        (async () => { while (this.active.size > 0) await Promise.allSettled([...this.active]); })(),
        new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs); }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    // A transport may never settle. Persist a safe restart state before the
    // service tears down the bridge; late opens still unwind through their owner.
    for (const job of this.jobs) {
      if (job.status === "running" || job.status === "queued") {
        job.status = "paused"; job.stage = "Paused";
        job.error = "Paused. Your draft is preserved.";
      } else if (job.status === "submitting") {
        job.status = "submission_uncertain";
        job.stage = "Check the employer site. C3 will not submit again automatically";
        delete job.reviewDigest;
      }
    }
    try { this.save(); } catch { /* Preserve storageError while allowing bridge shutdown. */ }
  }
}
