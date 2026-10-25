import { randomBytes } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import type { Server } from "node:http";
import { chromium, type Browser, type Page } from "playwright";

type Message = { id?: number; method?: string; params?: Record<string, unknown>; sessionId?: string; result?: unknown; error?: { message: string } };

export function boundedNetworkBuffers(params: Record<string, unknown>): Record<string, unknown> {
  // C3 needs Network events, not retained response bodies in every renderer.
  const limits = { maxTotalBufferSize: 4 * 1024 * 1024, maxResourceBufferSize: 1024 * 1024 };
  return { ...params, ...Object.fromEntries(Object.entries(limits).map(([key, limit]) =>
    [key, typeof params[key] === "number" ? Math.min(params[key], limit) : limit])) };
}

/** Each connection exposes exactly one user-selected tab to the existing Playwright engine. */
export class ExtensionBridge {
  private extension?: WebSocket;
  private sequence = 0;
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private tabs = new Map<number, { socket?: WebSocket; secret: string; targetId: string; sessionId: string; frameReady: Promise<void>; resolveFrame(): void }>();
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
            void this.cdp(tabId, message).then(result => {
              ws.send(JSON.stringify({ id: message.id, sessionId: message.sessionId, result }));
              if (message.method === "Page.getFrameTree" && message.sessionId === tab.sessionId) tab.resolveFrame();
            })
              .catch(error => {
                if (message.method === "Page.getFrameTree") tab.resolveFrame();
                ws.send(JSON.stringify({ id: message.id, sessionId: message.sessionId, error: { message: String(error.message), code: -32000 } }));
              });
          });
          ws.on("close", () => { tab.socket = undefined; });
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
  async focus(tabId: number) { await this.call("focus", { tabId }); }
  private connect(ws: WebSocket) {
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
        if (!tab?.socket) return;
        tab.socket.send(JSON.stringify({ method: params.method, params: params.params, sessionId: params.sessionId ?? tab.sessionId }));
      } else if (message.method === "detached") {
        const tab = this.tabs.get(Number(message.params?.tabId));
        tab?.socket?.close();
      }
    });
    ws.on("close", () => {
      if (this.extension !== ws) return;
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
  async open(url: string, existingTabId?: number, existingOnly = false): Promise<{ tabId: number; page: Page; browser: Browser }> {
    const result = await this.call("attach", { url, tabId: existingTabId, existingOnly });
    const tabId = Number(result.tabId);
    if (this.tabs.has(tabId)) throw new Error("This tab already has an application running.");
    let resolveFrame!: () => void;
    const frameReady = new Promise<void>(resolve => { resolveFrame = resolve; });
    const tab = { secret: randomBytes(32).toString("hex"), targetId: String(result.targetId), sessionId: `c3-${tabId}`, frameReady, resolveFrame };
    this.tabs.set(tabId, tab);
    try {
      const browser = await chromium.connectOverCDP(`${this.origin.replace("http:", "ws:")}/cdp/${tabId}?token=${tab.secret}`, { timeout: 45_000 });
      const page = browser.contexts()[0]?.pages()[0];
      if (!page) { await browser.close(); throw new Error("The selected job tab is unavailable."); }
      return { tabId, page, browser };
    } catch (error) { tab.resolveFrame(); this.tabs.delete(tabId); await this.call("detach", { tabId }).catch(() => {}); throw error; }
  }
  async release(tabId: number): Promise<void> {
    this.tabs.get(tabId)?.resolveFrame(); this.tabs.get(tabId)?.socket?.close(); this.tabs.delete(tabId);
    await this.call("detach", { tabId }).catch(() => {});
  }
  private async cdp(tabId: number, message: Message): Promise<unknown> {
    const tab = this.tabs.get(tabId)!;
    const method = message.method!;
    const params = message.params ?? {};
    if (message.sessionId) {
      // chrome.debugger callbacks can arrive after subsequent domain events.
      // Playwright installs its renderer listeners after the frame-tree reply;
      // enabling Runtime earlier loses the main execution context under load.
      if (method === "Runtime.enable" && message.sessionId === tab.sessionId) await tab.frameReady;
      return this.call("cdp", { tabId, method, params: method === "Network.enable" ? boundedNetworkBuffers(params) : params,
        sessionId: message.sessionId === tab.sessionId ? undefined : message.sessionId });
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
