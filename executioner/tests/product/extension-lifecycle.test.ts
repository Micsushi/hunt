import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const timers = { setTimeout, clearTimeout, setInterval, clearInterval };

test("naturally discarded tabs wake before attachment and completed tabs stay loaded", async () => {
  let reloads = 0;
  const url = "https://fixture.wd1.myworkdayjobs.com/en-US/Test/job/City/Job_R1/apply";
  const tab = { id: 1, url, active: false, discarded: false, status: "complete" };
  const event = { addListener() {} };
  const chrome = { storage: { local: { get: async () => ({}) } }, runtime: { onMessage: event, onStartup: event },
    tabs: {
      get: async () => ({ ...tab }), create: async () => ({ ...tab }),
      discard: async () => { assert.fail("C3 must leave completed tabs loaded"); },
      reload: async () => { reloads++; tab.discarded = false; tab.status = "complete"; } },
    debugger: { onEvent: event, onDetach: event, detach: async () => {},
      attach: async () => { assert.equal(tab.discarded, false); assert.equal(tab.status, "complete"); }, getTargets: async () => [{ tabId: 1, id: "target" }] } };
  const command = runInNewContext(readFileSync("extension/background.js", "utf8") + "\nsocket={readyState:1}; command", { chrome, URL, WebSocket: { OPEN: 1 }, ...timers });
  await command('attach', { url });
  await command('detach', { tabId: 1 });
  assert.equal(reloads, 0);
  assert.equal(tab.discarded, false);
  tab.discarded = true;
  tab.status = "unloaded";
  await command('attach', { tabId: 1, url, existingOnly: true });
  assert.equal(reloads, 1);
  await command('detach', { tabId: 1 });
});

test("extension cleans interrupted attachments and recreates missing tabs", async () => {
  for (const scenario of ["disconnect", "missing-target", "closed-tab"]) {
    let detached = 0, created = 0;
    const connection = { readyState: 1 };
    const url = "https://fixture.wd1.myworkdayjobs.com/en-US/Test/job/City/Job_R1";
    const event = { addListener() {} };
    const chrome = {
      storage: { local: { get: async () => ({}) } },
      runtime: { onMessage: event, onStartup: event },
      tabs: {
        get: async () => { if (scenario === "closed-tab") throw new Error("No tab with id: 99."); return { id: 1, url, status: "complete" }; },
        create: async () => { created++; return { id: 1, url, status: "complete" }; },
      },
      debugger: {
        onEvent: event, onDetach: event,
        attach: async () => { if (scenario === "disconnect") connection.readyState = 3; },
        detach: async () => { detached++; },
        getTargets: async () => scenario === "missing-target" ? [] : [{ tabId: 1, id: "target" }],
      },
    };
    const run = runInNewContext(readFileSync("extension/background.js", "utf8") + "\n(value) => { socket = value; return command('attach', {url:'" + url + "',tabId:99}, value); }", { chrome, URL, WebSocket: { OPEN: 1 }, ...timers });
    if (scenario === "closed-tab") { assert.equal((await run(connection)).tabId, 1); assert.equal(created, 1); }
    else { await assert.rejects(run(connection), /connection closed/); assert.equal(detached, 1); }
  }
});

test("reconnection waits for the old socket cleanup", async () => {
  let finishClose: () => void = () => {}, opened = 0;
  const old = { readyState: 2, addEventListener: (_: string, callback: () => void) => { finishClose = callback; } };
  class Socket {
    static OPEN = 1; static CONNECTING = 0; static CLOSING = 2;
    constructor() { opened++; }
  }
  const event = { addListener() {} };
  const chrome = { storage: { local: { get: async () => ({}) } }, tabs: {}, runtime: { onMessage: event, onStartup: event }, debugger: { onEvent: event, onDetach: event } };
  const connectOld = runInNewContext(readFileSync("extension/background.js", "utf8") + "\nold => { socket = old; chrome.storage.local.get = async () => ({token:'fixture'}); return connect(); }", { chrome, WebSocket: Socket, URL, ...timers });
  const pending = connectOld(old);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(opened, 0);
  old.readyState = 3; finishClose();
  await pending;
  assert.equal(opened, 1);
});

test("failed created tabs and failed CDP setup reuse the same tab without closing user drafts", async () => {
  for (const failure of ["load", "attach", "target", "cdp"]) {
    let created = 0, shouldFail = true, removedListener = (_: number) => {};
    const url = "https://fixture.wd1.myworkdayjobs.com/en-US/Test/job/City/Job_R1";
    const event = { addListener() {} };
    const tabs = new Map<number, { id: number; url: string; status: string }>();
    const chrome = { storage: { local: { get: async () => ({}) } }, runtime: { onMessage: event, onStartup: event },
      tabs: {
        create: async () => { const tab = { id: ++created, url, status: failure === "load" ? "loading" : "complete" }; tabs.set(created, tab); return tab; },
        get: async (id: number) => { if (!tabs.has(id)) throw new Error(`No tab with id: ${id}`); return tabs.get(id); },
        remove: async () => { assert.fail("Failed opening must preserve a draft the user may have inspected"); },
        onRemoved: { addListener(listener: typeof removedListener) { removedListener = listener; } },
      },
      debugger: { onEvent: event, onDetach: event, detach: async () => {},
        attach: async () => { if (failure === "attach" && shouldFail) throw new Error("debugger unavailable"); },
        getTargets: async () => failure === "target" && shouldFail ? [] : [...tabs.keys()].map(tabId => ({ tabId, id: `target-${tabId}` })),
      } };
    let clock = 0;
    const command = runInNewContext(readFileSync("extension/background.js", "utf8") + "\nsocket={readyState:1}; command", { chrome, URL, Date: { now: () => clock += 31_000 }, WebSocket: { OPEN: 1 }, ...timers });
    for (let attempt = 0; attempt < 2; attempt++) {
      if (failure === "cdp") {
        const result = await command("attach", { url });
        // The service detaches when connectOverCDP fails before queue registration.
        await command("detach", { tabId: result.tabId });
      } else if (failure === "load" && attempt === 1) {
        // Existing tabs can be attached while loading; later CDP failures still reuse them.
        const result = await command("attach", { url });
        await command("detach", { tabId: result.tabId });
      } else await assert.rejects(command("attach", { url }));
      assert.equal(created, 1);
    }
    shouldFail = false;
    tabs.get(1)!.status = "complete";
    assert.equal((await command("attach", { url })).tabId, 1);
    await command("detach", { tabId: 1 });
    tabs.delete(1); removedListener(1);
    if (failure === "load") await assert.rejects(command("attach", { url }), /did not load/);
    else assert.equal((await command("attach", { url })).tabId, 2);
    assert.equal(created, 2);
  }
});

test("reconnection drains pending attachment and detach before a new socket opens", async () => {
  let releaseAttach = () => {}, releaseDetach = () => {}, attachStarted = false, detachStarted = false;
  let token: string | undefined;
  const sockets: Socket[] = [];
  class Socket {
    static OPEN = 1; static CONNECTING = 0; static CLOSING = 2;
    readyState = 1; onclose = () => {};
    constructor() { sockets.push(this); }
    close() { this.readyState = 3; this.onclose(); }
  }
  const url = "https://fixture.wd1.myworkdayjobs.com/en-US/Test/job/City/Job_R1";
  const event = { addListener() {} };
  const chrome = { storage: { local: { get: async () => ({ token }) } }, runtime: { onMessage: event, onStartup: event },
    tabs: { get: async () => ({ id: 1, url, status: "complete" }) },
    debugger: { onEvent: event, onDetach: event,
      attach: () => { attachStarted = true; return new Promise<void>(resolve => { releaseAttach = resolve; }); },
      detach: () => { detachStarted = true; return new Promise<void>(resolve => { releaseDetach = resolve; }); },
      getTargets: async () => [{ tabId: 1, id: "target" }],
    } };
  const api = runInNewContext(readFileSync("extension/background.js", "utf8") + "\n({connect,command})", { chrome, URL, WebSocket: Socket, ...timers });
  token = "fixture"; await api.connect();
  const opening = assert.rejects(api.command("attach", { url, tabId: 1 }), /connection closed/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(attachStarted, true);
  sockets[0]!.close();
  const reconnecting = api.connect();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sockets.length, 1);
  releaseAttach();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(detachStarted, true);
  assert.equal(sockets.length, 1);
  releaseDetach();
  await Promise.all([opening, reconnecting]);
  assert.equal(sockets.length, 2);
});

test("a stale detach event cannot remove the replacement attachment", async () => {
  let detachedListener = async (_: { tabId: number }) => {}, targetAttached = true;
  const url = "https://fixture.wd1.myworkdayjobs.com/en-US/Test/job/City/Job_R1";
  const event = { addListener() {} };
  const chrome = { storage: { local: { get: async () => ({}) } }, runtime: { onMessage: event, onStartup: event },
    tabs: { get: async () => ({ id: 1, url, status: "complete" }) },
    debugger: { onEvent: event, onDetach: { addListener(listener: typeof detachedListener) { detachedListener = listener; } },
      attach: async () => {}, detach: async () => {},
      getTargets: async () => [{ tabId: 1, id: "target", attached: targetAttached }],
    } };
  const command = runInNewContext(readFileSync("extension/background.js", "utf8") + "\nsocket={readyState:1,send(){}}; command", { chrome, URL, WebSocket: { OPEN: 1 }, ...timers });
  await command("attach", { url, tabId: 1 });
  await command("detach", { tabId: 1 });
  await command("attach", { url, tabId: 1 });
  await detachedListener({ tabId: 1 });
  assert.equal((await command("info", { tabId: 1 })).targetId, "target");
  targetAttached = false;
  await detachedListener({ tabId: 1 });
  await assert.rejects(command("info", { tabId: 1 }), /not attached/);
});
