import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { ExtensionBridge } from "./extension-bridge.ts";
import { ApplicationQueue } from "./queue.ts";
import { applicantFields } from './sources.ts';
import { GmailImapClient } from "../mailbox/providers/gmail/private/imap-client.ts";
import { writePrivateFileAtomic } from "../composition/private/s2-application-source-preparation.ts";

export async function startProductServer(options: { root?: string; port?: number } = {}) {
  const root = resolve(options.root ?? process.env.HUNT_C3_PRODUCT_ROOT ?? join(process.env.LOCALAPPDATA ?? homedir(), "Hunt", "c3-product"));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const tokenPath = join(root, "service-token");
  if (!existsSync(tokenPath)) writePrivateFileAtomic(tokenPath, Buffer.from(randomBytes(32).toString("hex")));
  const token = readFileSync(tokenPath, "utf8").trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("C3 pairing key is invalid.");
  const port = options.port ?? 47831;
  const origin = `http://127.0.0.1:${port}`;
  const uiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../product-ui");
  const authenticate = (value: string | undefined) => {
    const candidate = Buffer.from(value?.replace(/^Bearer /, "") ?? "");
    return candidate.length === Buffer.byteLength(token) && timingSafeEqual(candidate, Buffer.from(token));
  };
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
      if (request.method === "GET" && path === "/state") { response.end(JSON.stringify(queue.snapshot())); return; }
      if (request.method === "GET" && path === "/settings") { response.end(JSON.stringify(queue.getSettings())); return; }
      if (request.method === 'GET' && path === '/profile-fields') { response.end(JSON.stringify({fields:applicantFields, storage:root})); return; }
      if (request.method !== "POST") { response.writeHead(404).end(); return; }
      let size = 0; const chunks: Buffer[] = [];
      for await (const chunk of request) { size += chunk.length; if (size > 32 * 1024 * 1024) throw new Error("Request is too large."); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      let result: unknown = { ok: true };
      if (path === "/settings") {
        if (body.applicant) queue.configureApplicant(body.applicant, body.resumeBase64);
        else queue.configure(body.profile, body.resumeBase64);
      } else if (path === "/account") {
        if (typeof body.email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email) || typeof body.password !== "string" || !body.password || body.password.length > 1024) throw new Error("Enter an account email and password.");
        queue.credentials = { email: body.email, password: body.password };
        queue.verifyEmail = undefined;
        if (typeof body.gmailAppPassword === "string" && body.gmailAppPassword.trim()) {
          const email = body.email.toLowerCase(), appPassword = body.gmailAppPassword.replace(/\s/g, "");
          const mailbox = new GmailImapClient(process.env.HUNT_C3_PYTHON ?? (process.platform === "win32" ? "python.exe" : "python3"));
          const ledgerPath = join(root, "verification-consumed.json");
          const used = new Set<string>(existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, "utf8")) : []);
          queue.verifyEmail = async (page, since, signal) => {
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
      } else if (path === "/jobs") result = queue.add(body.jobs);
      else if (path === "/recover-storage") queue.recoverStorage();
      else if (path === "/concurrency") queue.setConcurrency(body.value);
      else if (/^\/jobs\/[a-f0-9-]+\/action$/.test(path)) await queue.action(path.split("/")[2]!, body.action, body.reviewDigest, body.confirmed === true);
      else { response.writeHead(404).end(); return; }
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(400).end(JSON.stringify({ error: error instanceof Error && error.message.length < 200 ? error.message : "This action could not be completed." }));
    }
  });
  // Acquire the local endpoint before loading or recovering persisted queue state.
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  const bridge = new ExtensionBridge(server, token, origin);
  let queue: ApplicationQueue;
  try {
    queue = new ApplicationQueue(root, bridge);
    if (!queue.snapshot().configured && process.env.HUNT_C3_PROFILE_PATH && process.env.HUNT_C3_RESUME_PATH) {
      queue.configure(JSON.parse(readFileSync(process.env.HUNT_C3_PROFILE_PATH, "utf8")), readFileSync(process.env.HUNT_C3_RESUME_PATH).toString("base64"));
    }
  } catch (error) { bridge.close(); server.closeAllConnections(); server.close(); throw error; }
  return { server, queue, origin, tokenPath, close: async () => { await queue.close(); bridge.close(); server.closeAllConnections(); server.close(); } };
}
