import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { productApplicationTarget } from './target.ts';
import { ExtensionBridge } from "./extension-bridge.ts";
import { ApplicationQueue } from "./queue.ts";
import { currentPageOwner, inspectHandoffBundle } from './handoff.ts';
import { saveAccount, loadAccount, accountStorageFile } from "./account-storage.ts";
import { applicantFields, effectiveProfileFacts, productSources } from './sources.ts';
import { disposeResumeArtifact } from '../contracts/index.ts';
import { GmailImapClient } from "../mailbox/providers/gmail/private/imap-client.ts";
import { writePrivateFileAtomic } from "../composition/private/s2-application-source-preparation.ts";
import { ProductAccountState, prepareAccountUpdate, type ProductAccount } from './account-state.ts';
import { fillWorkdayAccountCurrentPage } from './workday-sign-in.ts';
import { fillMatchedPage, pageMatchingRoot, type MatchedPageResult } from './page-matching.ts';
import { readMatchingBacklog } from './matching-backlog.ts';
import { matchingDictionary } from '../form/questions/catalog.ts';
import { answerDictionary } from '../deterministic/answer-equivalence.ts';

export async function startProductServer(options: { root?: string; port?: number } = {}) {
  const root = resolve(options.root ?? process.env.HUNT_C3_PRODUCT_ROOT ?? join(process.env.LOCALAPPDATA ?? homedir(), "Hunt", "c3-product"));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const tokenPath = join(root, "service-token");
  if (!existsSync(tokenPath)) writePrivateFileAtomic(tokenPath, Buffer.from(randomBytes(32).toString("hex")));
  const token = readFileSync(tokenPath, "utf8").trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("C3 pairing key is invalid.");
  const port = options.port ?? 47831;
  let origin = `http://127.0.0.1:${port}`;
  const uiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../product-ui");
  const authenticate = (value: string | undefined) => {
    const candidate = Buffer.from(value?.replace(/^Bearer /, "") ?? "");
    return candidate.length === Buffer.byteLength(token) && timingSafeEqual(candidate, Buffer.from(token));
  };
  let accountSaved = existsSync(accountStorageFile(root));
  let accountRestoreError: string | undefined;
  let accountBusy = false;
  const pageActions=new Set<number>();
  const activeHandoffs = new Set<string>();
  const pageBindings = new Map<number, {jobId: string; url: string; documentId: string}>();

  const accountState = new ProductAccountState(root);
  let currentAccount: ProductAccount | undefined;
  async function configureAccount(value: unknown, persist: boolean) {
    const body = prepareAccountUpdate(value);
    let verifyEmail: typeof queue.verifyEmail;
    if (typeof body.gmailAppPassword === "string" && body.gmailAppPassword.trim()) {
      const email = body.email.toLowerCase(), appPassword = body.gmailAppPassword.replace(/\s/g, "");
      const mailbox = new GmailImapClient(process.env.HUNT_C3_PYTHON ?? (process.platform === "win32" ? "python.exe" : "python3"));
      await mailbox.checkConnection(email, appPassword, AbortSignal.timeout(30_000));
      const ledgerPath = join(root, "verification-consumed.json");
      const used = new Set<string>(existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, "utf8")) : []);
      verifyEmail = async (page, since, signal) => {
        signal = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
        const host = new URL(page.url()).hostname;
        const end = Date.now() + 120_000;
        while (Date.now() < end) {
          signal.throwIfAborted();
          const messages = await mailbox.query({ accountPassword: appPassword, recipientAddress: email,
            companyName: host.split(".")[0]!, verificationHost: host },
          { notBefore: new Date(since).toISOString(), notAfter: new Date().toISOString() }, signal);
          try {
            const candidates = messages.filter(m => !used.has(Buffer.from(m.replayCoordinate).toString("hex")));
            if (candidates.length > 1) throw new Error("More than one verification email matched. Verify this account in the tab.");
            const candidate = candidates[0];
            if (candidate) {
              signal.throwIfAborted();
              used.add(Buffer.from(candidate.replayCoordinate).toString("hex"));
              writePrivateFileAtomic(ledgerPath, Buffer.from(JSON.stringify([...used])));
              const url = new TextDecoder().decode(candidate.verificationTarget);
              if (new URL(url).hostname !== host || new URL(url).protocol !== "https:") throw new Error("Verification target mismatch.");
              await page.goto(url, { waitUntil: "domcontentloaded", timeout: Math.max(1, Math.min(30_000, end - Date.now())) }); return;
            }
          } finally { for (const m of messages) { m.verificationTarget.fill(0); m.replayCoordinate.fill(0); } }
          await delay(5000, undefined, { signal });
        }
        throw new Error("Verification email did not arrive. Verify the account in the tab and retry.");
      };
    }
    if (persist) accountSaved = await saveAccount(root, { email: body.email, password: body.password, gmailAppPassword: body.gmailAppPassword });
    queue.credentials = { email: body.email, password: body.password };
    queue.verifyEmail = verifyEmail;
    currentAccount = body;
    accountState.accepted(body,accountSaved,!!verifyEmail);
    accountRestoreError = undefined;
    return { ok: true, gmailVerified: !!verifyEmail, accountSaved };
  }
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    if (request.headers.host !== new URL(origin).host) { response.writeHead(403).end(); return; }
    const requestOrigin = request.headers.origin;
    const allowedOrigin = requestOrigin === origin || /^chrome-extension:\/\/[a-p]{32}$/.test(requestOrigin ?? "");
    if (requestOrigin && !allowedOrigin) { response.writeHead(403).end(); return; }
    if (allowedOrigin) response.setHeader("Access-Control-Allow-Origin", requestOrigin!);
    if (request.method === "OPTIONS") {
      response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
      response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      response.writeHead(204).end(); return;
    }
    const path = new URL(request.url ?? "/", origin).pathname;
    const asset = ({ "/": "index.html", "/app.js": "app.js", "/style.css": "style.css" } as Record<string, string>)[path];
    if (asset && request.method === "GET") {
      response.setHeader("Content-Type", asset.endsWith("html") ? "text/html; charset=utf-8" : asset.endsWith("js") ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8");
      response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'");
      response.end(readFileSync(join(uiRoot, asset))); return;
    }
    if (!authenticate(request.headers.authorization)) { response.writeHead(401).end(JSON.stringify({ error: "Connect with your C3 pairing key." })); return; }
    response.setHeader("Content-Type", "application/json");
    try {
      if (request.method==='GET' && path==='/matching/dictionary') {response.end(JSON.stringify({questions:matchingDictionary(),answers:answerDictionary()}));return;}
      if (request.method==='GET' && path==='/matching/backlog') {
        const params=new URL(request.url!,origin).searchParams;
        const offset=Number(params.get('offset')??0),limit=Number(params.get('limit')??50);
        if (!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>100) throw new Error('Invalid backlog page');
        response.end(JSON.stringify(readMatchingBacklog(root,offset,limit)));return;
      }
      if (request.method === "GET" && path === "/state") { response.end(JSON.stringify({ ...queue.snapshot(), accountSaved, accountRestoreError })); return; }
      if (request.method === 'GET' && path === '/account/status') { response.end(JSON.stringify(accountState.snapshot(queue.snapshot()))); return; }
      if (request.method === 'GET' && path === '/agent/status') {
        const {connected,configured,accountConfigured,emailConfigured} = queue.snapshot();
        let extension = null, extensionError;
        if (connected) try { extension = await bridge.call('agentStatus'); } catch { extensionError = 'Update and reload the C3 extension to enable agent page actions.'; }
        const {email: _email,...account} = accountState.snapshot(queue.snapshot());
        response.end(JSON.stringify({serviceVersion:'3.0.0',connected,configured,accountConfigured,emailConfigured,accountSaved,accountRestoreError,account,extension,extensionError})); return;
      }
      if (request.method === 'GET' && path === '/browser/tabs') { response.end(JSON.stringify(await bridge.call('pageTabs'))); return; }
      if (request.method === 'GET' && path === '/browser/diagnostics') { response.end(JSON.stringify(await bridge.call('browserDiagnostics'))); return; }
      if (request.method === "GET" && path === "/settings") {
        const settings=queue.getSettings();
        response.end(JSON.stringify(settings ? {...settings,effectiveFacts:effectiveProfileFacts(settings.profile)} : settings));
        return;
      }
      if (request.method === 'GET' && path === '/profile-fields') { response.end(JSON.stringify({fields:applicantFields, storage:root})); return; }
      if (request.method !== "POST") { response.writeHead(404).end(); return; }
      let size = 0; const chunks: Buffer[] = [];
      for await (const chunk of request) { size += chunk.length; if (size > 32 * 1024 * 1024) throw new Error("Request is too large."); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      let result: unknown = { ok: true };
      if (path === '/browser/extension/reload') {
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) throw new Error('Extension reload accepts no arguments.');
        if (queue.snapshot().jobs.some(job => ['queued','running','submitting'].includes(job.status) || job.actionPending)) throw new Error('Pause active applications before reloading Hunt.');
        result = await bridge.reloadExtension();
      } else if (path === '/browser/page') {
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key=>!['operation','tabId','expectedUrl','documentId','expiresAt'].includes(key)) ||
          !['inspect','fill','undo','redo'].includes(body.operation) || !Number.isSafeInteger(body.tabId) || body.tabId < 1 || typeof body.expectedUrl !== 'string') throw new Error('Choose an HTTPS tab and a supported page action.');
        const url = new URL(body.expectedUrl);
        if (url.protocol !== 'https:' || url.username || url.password || url.port || body.operation !== 'inspect' && (typeof body.documentId !== 'string' || !body.documentId)) throw new Error('Inspect the selected HTTPS page before changing fields.');
        if (body.expiresAt !== undefined && (!Number.isSafeInteger(body.expiresAt) || body.expiresAt <= Date.now())) throw new Error('This page action expired. Inspect the page again before changing it.');
        const expiresAt = Math.min(Date.now()+15000, body.expiresAt ?? Infinity);
        if(pageActions.has(body.tabId))throw new Error('C3 is already operating this page. Wait for it to finish.');
        pageActions.add(body.tabId);
        let lockedHandoff: string | undefined;
        try {
        const prior = pageBindings.get(body.tabId);
        if (prior && body.operation !== 'inspect' && (prior.url !== url.href || prior.documentId !== body.documentId ||
            !queue.jobs.some(job => job.id === prior.jobId && job.status === 'paused'))) {
          throw new Error('This selected application changed. Inspect its current page again.');
        }
        if (queue.snapshot().jobs.some(job=>job.tabId===body.tabId && (job.actionPending || ['queued','running','submitting'].includes(job.status)))) throw new Error('C3 is already operating this page. Wait for it to finish.');
        const writesProfile = body.operation === 'fill' || body.operation === 'redo';
        const owner = await currentPageOwner(queue.jobs, body.tabId, url);
        const selected = owner?.pageHandoff === true && owner.status === 'paused' ? owner : undefined;
        if (writesProfile && owner && !selected) {
          throw new Error(productApplicationTarget(owner.url).ats === 'generic'
            ? 'This saved draft uses an unfamiliar site. Finish it on the employer page to preserve its selected resume.'
            : 'This page belongs to a queued application. Continue from Applications to preserve its selected resume.');
        }
        if (prior && !selected && prior.url !== url.href &&
            queue.jobs.some(job => job.id === prior.jobId && job.status === 'paused')) {
          throw new Error('This page no longer identifies the selected job. Open its posting from Applications.');
        }
        if (selected) {
          if (activeHandoffs.has(selected.id)) throw new Error('C3 is operating this application in another tab.');
          lockedHandoff = selected.id;
          activeHandoffs.add(selected.id);
          if (body.operation !== 'inspect' && prior?.jobId !== selected.id) throw new Error('Inspect the selected application before changing it.');
          const other = [...pageBindings].find(([id, binding]) => id !== body.tabId && binding.jobId === selected.id);
          if (other) {
            const tabs = await bridge.call('pageTabs');
            if (!Array.isArray(tabs) || tabs.some(tab => tab.tabId === other[0])) {
              throw new Error('This job is already open in another selected tab. Continue there or close that tab first.');
            }
            pageBindings.delete(other[0]);
          }
        }
        const accountProfile = queue.getSettings()?.profile as {profilePlan?:{mode?:string}} | undefined;
        const accountPage = selected ? undefined : await fillWorkdayAccountCurrentPage(bridge.call.bind(bridge), {...body,expiresAt},
          accountProfile?.profilePlan?.mode === 'synthetic_test_non_submittable' ? undefined : queue.credentials,
          accountProfile !== undefined && effectiveProfileFacts(accountProfile).some(fact=>fact.factId==='terms_consent' && fact.value===true));
        const priorWorkdayPage = accountPage?.priorWorkdayPage;
        if (accountPage !== undefined && !priorWorkdayPage) {response.end(JSON.stringify(accountPage));return;}
        const settings = selected ? queue.currentPageInput(selected) : queue.getSettings();
        const profile = settings?.profile as {profile?:{facts?:unknown[]}} | undefined;
        if (writesProfile && !Array.isArray(profile?.profile?.facts)) throw new Error('Save your profile before filling.');
        const resume = body.operation === 'fill' ? settings?.resume : undefined;
        if (writesProfile) {
          const admitted = productSources(profile, Buffer.from(settings?.resume ?? '', 'base64'));
          disposeResumeArtifact(admitted.resumeIntent.artifact);
          if (admitted.profilePlan.mode !== 'live') throw new Error('Choose your saved personal profile before filling a real application.');
        }
        if (writesProfile || selected) {
          let status:{capabilities?:unknown};
          try { status=await bridge.call('agentStatus'); }
          catch { throw new Error('Reconnect and reload Hunt C3 0.1.9 or newer before filling or redoing fields.'); }
          if (!Array.isArray(status?.capabilities) || !status.capabilities.includes('pageAction-v2')) throw new Error('Reload Hunt C3 0.1.9 or newer before filling or redoing fields.');
          if (selected && !status.capabilities.includes('selected-page-handoff-v1')) throw new Error('Reload Hunt C3 to fill this application with its selected resume.');
          if (body.operation==='fill' && !status.capabilities.includes('question-matching-v1')) throw new Error('Reload Hunt C3 before filling so this page uses shared question matching.');
        }
        if (Date.now() >= expiresAt) throw new Error('This page action expired. Inspect the page again before changing it.');
        if (body.operation==='fill') result = await fillMatchedPage({profile,resume:Buffer.from(resume??'','base64'),url:body.expectedUrl,
          root:pageMatchingRoot(root,body.expectedUrl),workflow:'C3.2',signal:AbortSignal.timeout(Math.max(1,expiresAt-Date.now())),
          call:async(action,matchingPlans,matchingRunId)=> {
            const observed=await bridge.call('pageAction',{...body,...(selected && {pageHandoff:selected.id}),operation:action==='status'?'inspect':'fill',expiresAt,
              facts:effectiveProfileFacts(profile),matchingPlans,matchingRunId,...(action==='fill'&&resume?{resume:{name:'Resume.pdf',base64:resume}}:{})}) as MatchedPageResult;
            if(observed.documentId!==body.documentId)throw new Error('The page changed. Inspect it again before filling.');
            return observed;
          }});
        else {
          try { result = await bridge.call('pageAction',{...body,expiresAt,...(selected && {pageHandoff:selected.id}),...(priorWorkdayPage && {reportProtectedAttachment:true})}); }
          catch (error) {
            if (!priorWorkdayPage || !(error instanceof Error) || error.message !== 'debugger_protected_extension') throw error;
            response.writeHead(400).end(JSON.stringify({
              error:`Workday showed the ${priorWorkdayPage === 'review' ? 'Review page' : 'application'} before Chrome blocked detailed inspection to protect another extension.`,
              partialObservation:{kind:priorWorkdayPage,incomplete:true,reason:'debugger_protected_extension'},
            }));
            return;
          }
        }
        if (body.operation === 'inspect') {
          if (selected) {
            const inspected = result as {tabId?:number; url?:string; documentId?:string} | null;
            if (!inspected || inspected.tabId !== body.tabId || inspected.url !== body.expectedUrl || !inspected.documentId || typeof inspected.documentId !== 'string') {
              throw new Error('The selected application could not be confirmed. Inspect it again.');
            }
            pageBindings.set(body.tabId, {jobId:selected.id, url:url.href, documentId:inspected.documentId});
          } else pageBindings.delete(body.tabId);
        }
        } finally {
          pageActions.delete(body.tabId);
          if (lockedHandoff) activeHandoffs.delete(lockedHandoff);
        }
      } else if (path === "/settings") {
        const revision = (queue.getSettings()?.profile as {profile?:{revision?:number}} | undefined)?.profile?.revision ?? null;
        if (Object.hasOwn(body,'expectedRevision') && body.expectedRevision !== revision) {
          response.writeHead(409).end(JSON.stringify({error:'Profile changed in another workspace. Refresh saved profile and review your edits.'})); return;
        }
        if (body.applicant) queue.configureApplicant(body.applicant, body.resumeBase64);
        else queue.configure(body.profile, body.resumeBase64);
        const settings=queue.getSettings();
        result = settings ? {...settings,effectiveFacts:effectiveProfileFacts(settings.profile)} : settings;
      } else if (path === "/account") {
        if (accountBusy) throw new Error("Account connection is already in progress.");
        accountBusy = true;
        try {
          let saved = currentAccount;
          if (!saved && accountSaved) try { saved = prepareAccountUpdate(await loadAccount(root)); } catch { /* Explicit replacement credentials can repair an unreadable saved account. */ }
          result = await configureAccount(prepareAccountUpdate(body,saved), true);
        }
        finally { accountBusy = false; }
      } else if (path === '/account/check') {
        if (accountBusy) throw new Error('Account connection is already in progress.');
        accountBusy = true;
        try {
          const account = currentAccount ?? (accountSaved ? prepareAccountUpdate(await loadAccount(root)) : undefined);
          if (!account?.gmailAppPassword) throw new Error('Save a Gmail app password before rechecking the mailbox.');
          if (accountSaved) accountState.observeSaved(account);
          await configureAccount(account,false);
          result = accountState.snapshot(queue.snapshot());
        } catch (error) { accountState.failed(error); throw error; }
        finally { accountBusy = false; }
      } else if (path === '/handoff/preview' || path === '/handoff/import' || path === '/handoff/import-paused') {
        const allowCurrentPage = path !== '/handoff/import';
        const bundle = inspectHandoffBundle(body, queue.jobs, allowCurrentPage);
        if (path === '/handoff/import-paused' && bundle.preview.some(job=>job.currentPageOnly) && pageActions.size) {
          throw new Error('Wait for the current page operation to finish before importing its selected resume.');
        }
        result = path === '/handoff/preview' ? {jobs:bundle.preview} : queue.add(bundle.jobs, {paused:path === "/handoff/import-paused",currentPageHandoff:allowCurrentPage});
      } else if (path === "/jobs" && Object.hasOwn(body,'documentId')) {
        throw new Error('This Prepare request is from an older extension. Reload Hunt and choose Fill current page on this application.');
      } else if (path === "/jobs") result = queue.add(body.jobs);
      else if (path === "/recover-storage") queue.recoverStorage();
      else if (path === "/concurrency") queue.setConcurrency(body.value);
      else if (/^\/jobs\/[a-f0-9-]+\/action$/.test(path) && activeHandoffs.has(path.split('/')[2]!)) throw new Error('Wait for the current page operation to finish before changing this application.');
      else if (/^\/jobs\/[a-f0-9-]+\/action$/.test(path)) result = await queue.action(path.split("/")[2]!, body.action, body.reviewDigest, body.confirmed === true, {expectedProfileRevision:body.expectedProfileRevision,expectedProfileDigest:body.expectedProfileDigest,inputDigest:body.inputDigest,refreshToken:body.refreshToken}) ?? result;
      else { response.writeHead(404).end(); return; }
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(400).end(JSON.stringify({ error: error instanceof Error && error.message.length < 200 ? error.message : "This action could not be completed." }));
    }
  });
  // Acquire the local endpoint before loading or recovering persisted queue state.
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  if (port === 0) origin = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  const bridge = new ExtensionBridge(server, token, origin);
  let queue: ApplicationQueue;
  try {
    queue = new ApplicationQueue(root, bridge);
    if (!queue.snapshot().configured && process.env.HUNT_C3_PROFILE_PATH && process.env.HUNT_C3_RESUME_PATH) {
      queue.configure(JSON.parse(readFileSync(process.env.HUNT_C3_PROFILE_PATH, "utf8")), readFileSync(process.env.HUNT_C3_RESUME_PATH).toString("base64"));
    }
  } catch (error) { bridge.close(); server.closeAllConnections(); server.close(); throw error; }
  accountBusy = true;
  try {
    const saved = await loadAccount(root);
    if (saved !== undefined) {
      currentAccount = prepareAccountUpdate(saved);
      accountState.observeSaved(currentAccount);
      queue.credentials = {email:currentAccount.email,password:currentAccount.password};
      await configureAccount(currentAccount, false);
    }
  } catch (error) { accountState.failed(error); accountRestoreError = 'Could not reconnect the saved account. Recheck the saved connection in Settings; replace credentials only if needed.'; }
  finally { accountBusy = false; }
  return { server, queue, origin, tokenPath, close: async () => { await queue.close(); bridge.close(); server.closeAllConnections(); server.close(); } };
}
