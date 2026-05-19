"use strict";

const { CdpClient, httpJson, sleep } = require("./lib/c3_cdp");

function parseArgs(argv) {
  const args = {
    port: 9222,
    action: "inspect",
    urlPattern: "myworkdayjobs.com",
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--port") args.port = Number(argv[++index] || args.port);
    else if (arg === "--action") args.action = argv[++index] || args.action;
    else if (arg === "--url-pattern")
      args.urlPattern = argv[++index] || args.urlPattern;
  }
  return args;
}

async function pageClient(args) {
  const tabs = await httpJson(args.port, "/json/list");
  const tab = tabs.find(
    (item) =>
      item.type === "page" &&
      new RegExp(args.urlPattern, "i").test(String(item.url || "")),
  );
  if (!tab) {
    throw new Error(`No page tab matched ${args.urlPattern}`);
  }
  const client = await new CdpClient(tab.webSocketDebuggerUrl).connect();
  return { client, tab };
}

const inspectExpression = `(() => {
  function normalize(value) {
    return String(value || "").replace(/\\s+/g, " ").trim();
  }
  function visible(el) {
    if (!el || typeof el.getBoundingClientRect !== "function") return false;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  }
  const activeStep = document.querySelector('[data-automation-id="progressBarActiveStep"]');
  const buttons = Array.from(document.querySelectorAll("a, button, [role='button']"))
    .filter(visible)
    .map((el) => {
      const rect = el.getBoundingClientRect();
      return {
        tag: el.tagName,
        role: el.getAttribute("role") || "",
        automationId: el.getAttribute("data-automation-id") || "",
        text: normalize([
          el.getAttribute("aria-label"),
          el.getAttribute("title"),
          el.innerText,
          el.textContent,
          el.href,
        ].filter(Boolean).join(" ")),
        href: el.href || "",
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      };
    });
  return {
    href: location.href,
    title: document.title,
    bodyHead: normalize(document.body?.innerText || "").slice(0, 800),
    currentStep: activeStep ? normalize(activeStep.innerText || activeStep.textContent) : "",
    buttons,
  };
})()`;

const clickExpression = `(() => {
  function normalize(value) {
    return String(value || "").replace(/\\s+/g, " ").trim();
  }
  function visible(el) {
    if (!el || typeof el.getBoundingClientRect !== "function") return false;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  }
  const candidates = Array.from(document.querySelectorAll("a, button, [role='button']"))
    .filter(visible)
    .map((el) => ({
      el,
      text: normalize([
        el.getAttribute("aria-label"),
        el.getAttribute("title"),
        el.innerText,
        el.textContent,
        el.href,
      ].filter(Boolean).join(" ")),
      href: el.href || "",
    }));
  const candidate = candidates.find((item) =>
    /continue application|apply manually|start application|apply now|apply for this job|apply to this job/i.test(item.text)
  );
  if (!candidate) {
    return {
      clicked: false,
      reason: "candidate_not_found",
      candidates: candidates.map((item) => item.text || item.href).filter(Boolean).slice(0, 30),
      href: location.href,
    };
  }
  candidate.el.scrollIntoView({ block: "center", inline: "center" });
  const rect = candidate.el.getBoundingClientRect();
  candidate.el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }));
  candidate.el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }));
  candidate.el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }));
  candidate.el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }));
  candidate.el.click();
  return {
    clicked: true,
    label: candidate.text,
    href: location.href,
  };
})()`;

async function main() {
  const args = parseArgs(process.argv);
  const { client, tab } = await pageClient(args);
  try {
    if (args.action === "click") {
      const before = await client.evaluate(inspectExpression);
      const click = await client.evaluate(clickExpression);
      await sleep(2500);
      const after = await client.evaluate(inspectExpression);
      console.log(JSON.stringify({ tab, before, click, after }, null, 2));
      return;
    }
    const inspect = await client.evaluate(inspectExpression);
    console.log(JSON.stringify({ tab, inspect }, null, 2));
  } finally {
    client.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
