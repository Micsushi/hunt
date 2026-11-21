import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { WebSocket, WebSocketServer } from "ws";
import type { Server } from "node:http";
import { chromium, type Browser, type Page } from "playwright";
import { productApplicationTarget } from './target.ts';
import { verifySmartRecruitersApplication } from './smartrecruiters-target.ts';
import { viewportCleanupPending } from '../../extension/page-viewport.js';

type Message = { id?: number; method?: string; params?: Record<string, unknown>; sessionId?: string; result?: unknown; error?: { message: string } };

/** Bounded local transport evidence. Never record arbitrary CDP arguments. */
function transportEvent(event: string, tabId?: number, details: Record<string,boolean|number|string> = {}) {
  const root=process.env.HUNT_C3_PRODUCT_ROOT;
  if (!root || !isAbsolute(root)) return;
  try {
    const path=join(root,'browser-transport.private.json');
    let events: unknown[]=[];
    try { const saved=JSON.parse(readFileSync(path,'utf8'));if(Array.isArray(saved))events=saved.slice(-63); } catch {}
    events.push({at:new Date().toISOString(),event,...(Number.isSafeInteger(tabId)?{tabId}:{}),...details});
    writeFileSync(path,JSON.stringify(events),{mode:0o600});
  } catch { /* Evidence cannot change browser control. */ }
}

/** Only attach failures are classified here; arbitrary CDP errors may contain entered values. */
const legacyViewportCleanupPending = "Hunt could not restore this tab's page size. Retry the job or page action to finish cleanup before filling.";

export class AttachmentFailure extends Error {
  readonly code: string;
  constructor(error: unknown) {
    const message = error instanceof Error ? error.message : '';
    const known: Record<string,string> = {
      'C3 is already operating this tab.':'c3_page_action_busy',
      'This tab is already running.':'c3_attachment_busy',
      'Browser connection closed during attachment. Retry this job.':'attachment_connection_closed',
      'Use a supported job posting link.':'attachment_target_unsupported',
      'The review tab is closed. Retry this job to inspect its saved draft.':'attachment_tab_closed',
      'The selected tab does not match this job.':'attachment_target_mismatch',
      'The job page did not load. Retry when the site is available.':'attachment_page_not_ready',
      'The application document could not be verified.':'attachment_document_unverified',
      'Connect the C3 extension first.':'attachment_extension_disconnected',
      'Extension disconnected. Reconnect and retry.':'attachment_extension_disconnected',
      'Browser connection replaced. Retry the saved draft.':'attachment_connection_replaced',
      'The browser did not respond.':'attachment_response_timeout',
      'Cannot attach to this target.':'debugger_access_denied',
      'Cannot access a chrome-extension:// URL of different extension':'debugger_protected_extension',
      'This tab has no usable page area. Resize or restore its browser window, then retry.':'attachment_viewport_unavailable',
      [legacyViewportCleanupPending]:'attachment_viewport_cleanup_pending',
      [viewportCleanupPending]:'attachment_viewport_cleanup_pending',
    };
    const code = Object.hasOwn(known,message) ? known[message]!
      : /^Another debugger is already attached to (?:the )?tab with id: \d+\.?$/.test(message) ? 'debugger_already_attached'
      : /^No tab with id: \d+\.?$/.test(message) ? 'attachment_tab_closed'
      : 'attachment_unknown';
    // Unknown attach errors occur before any form commands. Keep their bounded
    // text locally for diagnosis, never in the API error or shared run receipt.
    const diagnosticRoot=process.env.HUNT_C3_PRODUCT_ROOT;
    if (code === 'attachment_unknown' && diagnosticRoot && isAbsolute(diagnosticRoot)) {
      try { writeFileSync(join(diagnosticRoot,'attachment-error.private.json'), JSON.stringify({
        operation:'browser.attach',recordedAt:new Date().toISOString(),message:message.slice(0,8192),
      }), {mode:0o600}); } catch { /* Diagnostics must not alter the attachment outcome. */ }
    }
    super(`C3 attachment stopped: ${code}`);
    this.name='AttachmentFailure';this.code=code;
  }
}

export function boundedNetworkBuffers(params: Record<string, unknown>): Record<string, unknown> {
  // C3 needs Network events, not retained response bodies in every renderer.
  const limits = { maxTotalBufferSize: 4 * 1024 * 1024, maxResourceBufferSize: 1024 * 1024 };
  return { ...params, ...Object.fromEntries(Object.entries(limits).map(([key, limit]) =>
    [key, typeof params[key] === "number" ? Math.min(params[key], limit) : limit])) };
}

/** Each connection exposes exactly one user-selected tab to the existing Playwright engine. */
export class ExtensionBridge {
  async reloadExtension() {
    const before = await this.call('agentStatus');
    if (!before.capabilities?.includes('self-reload-v1')) throw new Error('Reload Hunt once manually to activate self-reload support.');
    await this.call('reloadExtension');
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 250));
      if (!this.connected) continue;
      try {
        const after = await this.call('agentStatus');
        if (after.extensionId !== before.extensionId) throw new Error('A different extension connected after reload.');
        if (after.instanceId && after.instanceId !== before.instanceId) return {reloaded:true,version:after.version,extensionId:after.extensionId,connectionPreserved:true};
      } catch { /* A reconnect can replace an outstanding status request. */ }
    }
    throw new Error('Reload was requested, but reconnection was not confirmed. Check Hunt status before trying again.');
  }
  prepareAccount(options: import('./workday-sign-in.ts').WorkdayAccountOptions) {
    return import('./workday-sign-in.ts').then(({ prepareWorkdayAccount }) => prepareWorkdayAccount(this.call.bind(this), options));
  }
  private extension?: WebSocket;
  private sequence = 0;
  private viewportCleanup = new Set<number>();
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private tabs = new Map<number, { socket?: WebSocket; secret: string; targetId: string; sessionId: string; commands: string[]; frameReady: Promise<void>; resolveFrame(): void }>();
  private sockets = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });

  private origin: string;
  constructor(server: Server, token: string, origin: string) {
    this.origin = origin;
    server.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url ?? "/", origin);
      if (request.headers.host !== new URL(origin).host) { socket.destroy(); return; }
      if (url.pathname === "/extension" && url.searchParams.get("token") === token &&
          /^chrome-extension:\/\/[a-p]{32}$/.test(request.headers.origin ?? "")) {
        this.sockets.handleUpgrade(request, socket, head, ws => this.connect(ws));
        return;
      }
      const tabId = Number(url.pathname.slice(5));
      const tab = this.tabs.get(tabId);
      if (url.pathname.startsWith("/cdp/") && tab && url.searchParams.get("token") === tab.secret && !request.headers.origin && !tab.socket) {
        this.sockets.handleUpgrade(request, socket, head, ws => {
          tab.socket = ws;
          ws.on("message", raw => {
            let message: Message;
            try { message = JSON.parse(raw.toString()); } catch { ws.close(); return; }
            void this.cdp(tabId, message, ws).then(result => {
              ws.send(JSON.stringify({ id: message.id, sessionId: message.sessionId, result }));
              if (message.method === "Page.getFrameTree" && message.sessionId === tab.sessionId) tab.resolveFrame();
            })
              .catch(error => {
                if (message.method === "Page.getFrameTree") tab.resolveFrame();
                ws.send(JSON.stringify({ id: message.id, sessionId: message.sessionId, error: { message: String(error.message), code: -32000 } }));
              });
          });
          ws.on("close", code => { transportEvent('playwright_transport_closed',tabId,{code});tab.socket = undefined; });
        });
        return;
      }
      socket.destroy();
    });
  }
  get connected(): boolean { return this.extension?.readyState === WebSocket.OPEN; }
  close() {
    for (const tab of this.tabs.values()) tab.resolveFrame();
    for (const socket of this.sockets.clients) socket.terminate();
    this.sockets.close();
  }
  async focus(tabId: number, url?: string) {
    const target = url === undefined ? undefined : await this.existingTarget(productApplicationTarget(url), tabId);
    await this.call("focus", { tabId, ...(target ? {url:target.url, generic:target.ats === 'generic'} : {}) });
  }
  private async existingTarget(target: ReturnType<typeof productApplicationTarget>, tabId?: number, requirePublication = false) {
    if (target.ats !== 'generic' || tabId === undefined) return target;
    const tabs = await this.call('pageTabs');
    const tab = Array.isArray(tabs) ? tabs.find(tab => tab.tabId === tabId) : undefined;
    if (!tab || tab.discarded || typeof tab.url !== 'string') throw new Error('Open the loaded application form for this posting, then retry.');
    let current: ReturnType<typeof productApplicationTarget>;
    try { current = productApplicationTarget(tab.url); }
    catch { throw new Error('The selected tab cannot be verified as this posting. Open its recognized application form before retrying.'); }
    if ((requirePublication || current.key !== target.key) && !await verifySmartRecruitersApplication(target.url,current.url)) throw new Error('The selected tab cannot be verified as this exact posting. Its application address has a different identity.');
    return current;
  }
  private connect(ws: WebSocket) {
    if (this.extension) transportEvent('extension_connection_replaced');
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("Browser connection replaced. Retry the saved draft.")); }
    this.pending.clear();
    for (const tab of this.tabs.values()) { tab.resolveFrame(); tab.socket?.close(); }
    this.tabs.clear();
    this.extension?.close();
    this.extension = ws;
    ws.on("message", raw => {
      if (this.extension !== ws) return;
      let message: Message;
      try { message = JSON.parse(raw.toString()); } catch { ws.close(); return; }
      if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer); this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result);
      } else if (message.method === "event") {
        const params = message.params!;
        const tab = this.tabs.get(Number(params.tabId));
        if (tab && params.method === 'Page.frameNavigated') {
          const frame = (params.params as {frame?:{url?:unknown}} | undefined)?.frame;
          let scheme = 'other';
          try { const protocol = new URL(String(frame?.url)).protocol; if (['https:','http:','chrome-extension:','about:'].includes(protocol)) scheme = protocol; } catch {}
          transportEvent('frame_navigated',Number(params.tabId),{scheme});
        }
        if (['Inspector.detached','Inspector.targetCrashed','Target.detachedFromTarget','Target.targetDestroyed','Target.targetCrashed'].includes(String(params.method))) {
          const payload=params.params as Record<string,unknown>|undefined;
          const reason=['target_closed','canceled_by_user','Render process gone.','replaced_with_devtools','target_crashed','inspected_target_closed'].includes(String(payload?.reason)) ? String(payload!.reason) : 'unspecified_or_other';
          const id=(value:unknown)=>typeof value==='string' && /^(?:[a-f0-9]{32}|c3-\d{1,16})$/i.test(value)?value:undefined;
          const detachedSessionId=params.method==='Target.detachedFromTarget'?id(payload?.sessionId):undefined;
          const detachedTargetId=params.method==='Target.detachedFromTarget'?id(payload?.targetId):undefined;
          transportEvent(String(params.method),Number(params.tabId),{reason,childSession:typeof params.sessionId==='string',
            ...(detachedSessionId?{detachedSessionId,detachedSessionIsRoot:detachedSessionId===tab?.sessionId}:{}),
            ...(detachedTargetId?{detachedTargetId,detachedTargetIsRoot:detachedTargetId===tab?.targetId}:{})});
        }
        if (!tab?.socket) return;
        tab.socket.send(JSON.stringify({ method: params.method, params: params.params, sessionId: params.sessionId ?? tab.sessionId }));
      } else if (message.method === "detached") {
        const tabId=Number(message.params?.tabId);
        const reason=['target_closed','canceled_by_user'].includes(String(message.params?.reason))?String(message.params!.reason):'unspecified_or_other';
        if(message.params?.viewportCleanupPending===true)this.viewportCleanup.add(tabId);
        const tab = this.tabs.get(Number(message.params?.tabId));
        transportEvent('extension_reported_detach',tabId,{reason,viewportCleanupPending:message.params?.viewportCleanupPending===true,
          recentCommands:tab?.commands.join(',') ?? '', attachmentPresent:!!tab});
        tab?.socket?.close();
      }
    });
    ws.on("close", code => {
      if (this.extension !== ws) return;
      transportEvent('extension_connection_closed',undefined,{code});
      this.extension = undefined;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("Extension disconnected. Reconnect and retry.")); }
      this.pending.clear();
      for (const tab of this.tabs.values()) { tab.resolveFrame(); tab.socket?.close(); }
      this.tabs.clear();
    });
  }
  call(method: string, params: Record<string, unknown> = {}): Promise<any> {
    if (!this.connected) return Promise.reject(new Error("Connect the C3 extension first."));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("The browser did not respond.")); }, 60_000);
      this.pending.set(id, { resolve, reject, timer });
      this.extension!.send(JSON.stringify({ id, method, params }));
    });
  }
  async open(url: string, existingTabId?: number, existingOnly = false, selectedDocument?: string): Promise<{ tabId: number; page: Page; browser: Browser; applicationUrl?: string }> {
    let target = await this.existingTarget(productApplicationTarget(url), existingTabId);
    if (selectedDocument && target.url!==url) throw new Error('The selected application address changed. Inspect the draft again.');
    const reportRedirect = existingTabId === undefined && !existingOnly && target.ats === 'generic' &&
      target.host === 'jobs.smartrecruiters.com' && !target.posting.startsWith('/oneclick-ui/');
    let result;
    transportEvent('attachment_requested',existingTabId);
    try {
      result = await this.call("attach", { url: target.url, tabId: existingTabId, existingOnly, generic: target.ats === 'generic',
        ...(selectedDocument && {selectedDocument}), ...(reportRedirect && {reportRedirect:true}) });
      if (result.redirectedTabId !== undefined) {
        const redirected = result.redirectedTabId;
        if (!reportRedirect || !Number.isSafeInteger(redirected) || redirected < 1) throw new Error('The selected tab does not match this job.');
        target = await this.existingTarget(target,redirected,true);
        result = await this.call('attach',{url:target.url,tabId:redirected,existingOnly:true,generic:true});
      }
    }
    catch (error) { transportEvent('attachment_failed',existingTabId);throw new AttachmentFailure(error); }
    const tabId = Number(result.tabId);
    this.viewportCleanup.delete(tabId);
    transportEvent('attachment_completed',tabId);
    if (this.tabs.has(tabId)) throw new Error("This tab already has an application running.");
    let resolveFrame!: () => void;
    const frameReady = new Promise<void>(resolve => { resolveFrame = resolve; });
    const tab = { secret: randomBytes(32).toString("hex"), targetId: String(result.targetId), sessionId: `c3-${tabId}`, commands:[] as string[], frameReady, resolveFrame };
    this.tabs.set(tabId, tab);
    try {
      if (selectedDocument && (tabId!==existingTabId || result.selectedDocument!==selectedDocument)) throw new Error('The extension could not confirm the selected application document. Inspect the draft again.');
      const browser = await chromium.connectOverCDP(`${this.origin.replace("http:", "ws:")}/cdp/${tabId}?token=${tab.secret}`, { timeout: 45_000 });
      if (this.tabs.get(tabId) !== tab) {
        await browser.close();
        throw new Error("Browser connection replaced during attachment. Retry the saved draft.");
      }
      const page = browser.contexts()[0]?.pages()[0];
      if (!page) { await browser.close(); throw new Error("The selected job tab is unavailable."); }
      return { tabId, page, browser, ...(target.ats==='generic'?{applicationUrl:target.url}:{}) };
    } catch (error) {
      tab.resolveFrame();
      // An older attempt must never detach a replacement attachment to this tab.
      if (this.tabs.get(tabId) === tab) {
        this.tabs.delete(tabId);
        await this.call("detach", { tabId }).catch(() => {});
      }
      throw error;
    }
  }
  async release(tabId: number): Promise<void> {
    transportEvent('release_requested',tabId,{recentCommands:this.tabs.get(tabId)?.commands.join(',') ?? ''});
    this.tabs.get(tabId)?.resolveFrame(); this.tabs.get(tabId)?.socket?.close(); this.tabs.delete(tabId);
    await this.call("detach", { tabId }).catch(error => {if(error instanceof Error && [viewportCleanupPending,legacyViewportCleanupPending].includes(error.message))throw new Error(viewportCleanupPending);});
    if(this.viewportCleanup.has(tabId))throw new Error(viewportCleanupPending);
  }
  private async cdp(tabId: number, message: Message, socket: WebSocket): Promise<unknown> {
    const tab = this.tabs.get(tabId);
    if (!tab || tab.socket !== socket) throw new Error("This browser attachment is no longer active.");
    const method = message.method!;
    const params = message.params ?? {};
    if (message.sessionId) {
      // chrome.debugger callbacks can arrive after subsequent domain events.
      // Playwright installs its renderer listeners after the frame-tree reply;
      // enabling Runtime earlier loses the main execution context under load.
      if (method === "Runtime.enable" && message.sessionId === tab.sessionId) await tab.frameReady;
      if (this.tabs.get(tabId) !== tab || tab.socket !== socket) throw new Error("This browser attachment is no longer active.");
      // Retain command names and outcomes only, never arguments or raw errors.
      const trace = (phase: string) => {
        if (!/^[A-Za-z]{1,40}\.[A-Za-z]{1,60}$/.test(method)) return;
        tab.commands.push(`${method}:${phase}`);
        tab.commands.splice(0, Math.max(0, tab.commands.length - 32));
      };
      trace('started');
      try {
        const result = await this.call("cdp", { tabId, method, params: method === "Network.enable" ? boundedNetworkBuffers(params) : params,
          sessionId: message.sessionId === tab.sessionId ? undefined : message.sessionId });
        trace('completed');
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        const category = /Cannot access a chrome-extension:\/\/ URL of different extension/.test(message) ? 'protected_extension'
          : /[Ee]xecution context was destroyed/.test(message) ? 'context_destroyed'
          : /Cannot find context|Cannot find object|No frame with given id/.test(message) ? 'stale_context'
          : /not attached|not active|[Dd]etached|[Tt]arget closed/.test(message) ? 'detached'
          : 'other';
        trace(`failed_${category}`);
        if (/^[A-Za-z]{1,40}\.[A-Za-z]{1,60}$/.test(method)) transportEvent('command_failed',tabId,{command:method,category});
        throw error;
      }
    }
    const info = () => this.call("info", { tabId });
    if (method === "Browser.getVersion") return this.call("version");
    if (method === "Target.getBrowserContexts") return { browserContextIds: [] };
    if (method === "Target.getTargetInfo") return { targetInfo: await info() };
    if (method === "Target.getTargets") return { targetInfos: [await info()] };
    if (method === "Target.setAutoAttach") {
      if (params.autoAttach) tab.socket?.send(JSON.stringify({ method: "Target.attachedToTarget", params: { sessionId: tab.sessionId, targetInfo: await info(), waitingForDebugger: false } }));
      return {};
    }
    if (["Target.setDiscoverTargets", "Browser.setDownloadBehavior", "Browser.setWindowBounds"].includes(method)) return {};
    if (method === "Browser.getWindowForTarget") return { windowId: tabId, bounds: { left: 0, top: 0, width: 1280, height: 900, windowState: "normal" } };
    throw new Error(`Browser-wide command is unavailable: ${method}`);
  }
}
