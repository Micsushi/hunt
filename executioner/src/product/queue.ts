import { randomUUID, createHash } from "node:crypto";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Browser, Page } from "playwright";
import { writePrivateFileAtomic } from "../composition/private/s2-application-source-preparation.ts";
import { applicationTarget } from "./target.ts";
import { ApplicationPause, fillApplication, restoreSavedReview, reviewDigest, submitReviewedApplication, type ProductInput } from "./engine.ts";
import { applicantProfile, productSources } from "./sources.ts";
import { disposeResumeArtifact } from "../contracts/index.ts";

export type JobStatus = "queued" | "running" | "paused" | "review" | "submitting" | "submitted" | "submission_uncertain" | "removed";
export interface ProductJob {
  id: string; url: string; key: string; title: string; status: JobStatus; stage: string;
  tabId?: number; sourceJobId?: number; error?: string; reviewDigest?: string; reviewUrl?: string; submissionAllowed?: boolean;
  createdAt: string; updatedAt: string;
  resumeName?: string; resumeVersion?: string; resumeSha256?: string;
}
export interface BrowserConnection {
  connected: boolean;
  open(url: string, tabId?: number, existingOnly?: boolean): Promise<{ tabId: number; page: Page; browser: Browser }>;
  release(tabId: number): Promise<void>;
  focus?(tabId: number): Promise<void>;
}
export class ApplicationQueue {
  jobs: ProductJob[] = [];
  concurrency = 6;
  credentials?: ProductInput["credentials"];
  verifyEmail?: ProductInput["verifyEmail"];
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
          saved.jobs.some((job: ProductJob) => !job || !/^[a-f0-9-]{36}$/.test(job.id) || !["queued", "running", "paused", "review", "submitting", "submitted", "submission_uncertain", "removed"].includes(job.status) || applicationTarget(job.url).key !== job.key) ||
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
  snapshot() { return { jobs: this.jobs.filter(j => j.status !== "removed").map(job => ({ ...job, actionPending: this.running.has(job.id) || this.reviewActions.has(job.id) })), connected: this.bridge.connected,
    configured: !!this.settings, accountConfigured: !!this.credentials, emailConfigured: !!this.verifyEmail, concurrency: this.concurrency, storageError: this.storageError }; }
  getSettings() { return this.settings ?? null; }
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
  add(inputs: { url: string; title?: string; tabId?: number; sourceJobId?: number; resumeBase64?: string; resumeName?: string; resumeVersion?: string }[]) {
    if (!this.settings) throw new Error("Choose a profile and resume first.");
    if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 100) throw new Error("Add between 1 and 100 job links.");
    const prepared = inputs.map(input => {
      const target = applicationTarget(input.url);
      if (input.sourceJobId !== undefined && (!Number.isSafeInteger(input.sourceJobId) || input.sourceJobId < 1)) throw new Error("Invalid Hunt job.");
      for (const value of [input.title, input.resumeName, input.resumeVersion]) if (value !== undefined && (typeof value !== "string" || value.length > 500)) throw new Error("Invalid job or resume label.");
      if (input.tabId !== undefined && (!Number.isSafeInteger(input.tabId) || input.tabId < 1)) throw new Error("Invalid browser tab.");
      const resume = input.resumeBase64 ?? this.settings!.resume;
      const sources = productSources(this.settings!.profile, Buffer.from(resume, "base64"));
      disposeResumeArtifact(sources.resumeIntent.artifact);
      return { input, target, resume, submissionAllowed: target.ats === "workday" && sources.profilePlan.mode === "live" && sources.executionPolicy.browserTransport === "live_browser" };
    });
    const added: ProductJob[] = [];
    const next = this.jobs.map(job => ({ ...job }));
    for (const { input, target, resume, submissionAllowed } of prepared) {
      const existing = next.find(j => j.key === target.key && j.status !== "removed");
      if (existing) {
        if (input.tabId !== undefined && input.tabId !== existing.tabId) {
          if (existing.status !== "paused" || this.running.has(existing.id) || this.reviewActions.has(existing.id)) throw new Error("Pause this job before connecting another tab.");
          existing.tabId = input.tabId;
        }
        if (input.resumeBase64 !== undefined && JSON.parse(readFileSync(join(this.root, `${existing.id}.input.json`), "utf8")).resume !== resume) throw new Error("This job already has a different resume. Pause and remove it before adding the new selection.");
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
      this.persist(join(this.root, `${id}.input.json`), { profile: this.settings.profile, resume });
      const job: ProductJob = { id, ...target, title: input.title?.slice(0, 200) || target.posting,
        status: "queued", stage: "Queued", tabId: input.tabId, sourceJobId: input.sourceJobId, submissionAllowed,
        resumeName: input.resumeName ?? "Default resume", resumeVersion: input.resumeVersion,
        resumeSha256: createHash("sha256").update(Buffer.from(resume, "base64")).digest("hex"),
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      next.push(job); added.push(job);
    }
    this.persist(join(this.root, "jobs.json"), { jobs: next, concurrency: this.concurrency });
    // Preserve active runner references when publishing metadata on existing jobs.
    this.jobs = next.map(job => { const current = this.jobs.find(item => item.id === job.id); return current ? Object.assign(current, job) : job; });
    this.safePump(); return added;
  }
  async action(id: string, action: string, digest?: string, confirmed?: boolean) {
    if (this.closed) throw new Error("The application service is stopping.");
    if (this.storageError && action === "retry") this.recoverStorage();
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
      if (!job.tabId || !this.bridge.focus) throw new Error("The original tab is unavailable. Retry this job to open its saved draft.");
      await this.bridge.focus(job.tabId); return;
    }
    if (action === "refresh_review") {
      if (job.status !== "review" && !(job.status === "paused" && job.reviewUrl) || this.running.has(id)) throw new Error("Wait for this job to pause before refreshing its review.");
      try {
        const session = await this.reviewSession(job);
        await restoreSavedReview(session.page, job.reviewUrl ?? job.url);
        const digest = await reviewDigest(session.page);
        if (this.closed) throw new Error("The application service is stopping.");
        if (job.status === "paused") job.stage = "Owner review needed: Check every answer and the attached resume.";
        job.status = "review"; job.reviewDigest = digest; delete job.error; this.changed(job); return;
      } catch (error) {
        if (!this.closed) {
          job.status = "paused"; job.stage = "Review needs attention"; delete job.reviewDigest;
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
      job.status = "queued"; job.stage = "Queued"; delete job.error; delete job.reviewDigest; this.changed(job); this.safePump(); return;
    }
    if (action === "remove" || action === "restore") {
      if (action === "restore" && this.jobs.some(other => other.id !== id && other.key === job.key && other.status !== "removed")) throw new Error("This job has already been added again. Remove the newer entry before restoring this one.");
      if (action === "remove" && !["paused", "queued"].includes(job.status) || action === "restore" && job.status !== "removed" || this.running.has(id) || this.reviewActions.has(id)) throw new Error("Wait for the job to pause and its review to finish before removing it.");
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
      if (this.jobs.some(j => this.running.has(j.id) && applicationTarget(j.url).host === applicationTarget(job.url).host && (applicationTarget(job.url).ats === "workday" || applicationTarget(j.url).posting.split("/")[0] === applicationTarget(job.url).posting.split("/")[0]))) continue;
      const controller = new AbortController();
      this.running.set(job.id, controller);
      job.status = "running"; job.stage = "Opening application";
      try { this.changed(job); } catch (error) { this.running.delete(job.id); job.status = "paused"; throw error; }
      void this.track(this.run(job, controller)).catch(() => { /* Persistence failure already stops the queue. */ });
    }
  }
  private async run(job: ProductJob, controller: AbortController) {
    const deadline = setTimeout(() => {
      controller.abort(new ApplicationPause("This job exceeded 30 minutes. The draft is preserved; inspect the tab before retrying."));
      void this.release(job.id).catch(() => {});
    }, 30 * 60_000);
    deadline.unref();
    try {
      await this.release(job.id);
      const session = await this.bridge.open(job.url, job.tabId);
      this.sessions.set(job.id, session); job.tabId = session.tabId;
      controller.signal.throwIfAborted();
      this.changed(job);
      const input = JSON.parse(readFileSync(join(this.root, `${job.id}.input.json`), "utf8"));
      const result = await this.fill(session.page, { url: job.url, profile: input.profile, learningRoot: join(this.root, "learning", job.id, randomUUID()),
        resume: Buffer.from(input.resume, "base64"), credentials: this.credentials, verifyEmail: this.verifyEmail }, controller.signal,
      stage => { if (job.status === "running" && job.stage !== stage) { job.stage = stage; job.updatedAt = new Date().toISOString(); } });
      controller.signal.throwIfAborted();
      const reviewUrl = session.page.url();
      await this.release(job.id);
      controller.signal.throwIfAborted();
      job.status = "review";
      job.stage = result.needsOwnerReview ? "Owner review needed: suggested or unverified answers. Check every answer in the draft." : "Ready to review";
      job.reviewDigest = result.reviewDigest; job.reviewUrl = reviewUrl; delete job.error;
      this.changed(job);
    } catch (error) {
      job.status = "paused"; job.stage = controller.signal.aborted ? "Paused" : "Needs attention";
      // Never retain Playwright errors containing DOM snippets or typed values.
      job.error = controller.signal.aborted
        ? controller.signal.reason instanceof ApplicationPause ? controller.signal.reason.message : "Paused. Your draft is preserved."
        : error instanceof ApplicationPause ? error.message : "C3 could not finish this page. Inspect the tab, then retry.";
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
      if (detached.status === "rejected") throw detached.reason;
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
