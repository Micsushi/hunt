#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { CdpClient, httpJson, sleep } = require("../lib/c3_cdp");

const DEFAULT_ANSWERS = [
  { question: "Would you consider relocating", option: "Yes, I would consider relocating" },
  { question: "non-compete or non-solicitation", option: "No" },
  { question: "do you use or work on the Workday system", option: "No" },
  { question: "authorized to work in the country", option: "Yes" },
  { question: "require any immigration filing or visa sponsorship", option: "No" },
  { question: "current or former employee of the United States government", option: "No" },
  { question: "current citizen, national or resident", option: "No" },
  { question: "related to a current Workday employee", option: "No" },
  { question: "related to an employee of a customer", option: "No" },
  { question: "Ernst & Young", option: "No" },
  { question: "Please enter \"yes\" if you acknowledge", option: "Yes" },
];

const REMAINING_WORKDAY_AGENT_ANSWERS = [
  { question: "Would you consider relocating", option: "Yes, I would consider relocating" },
  { question: "do you use or work on the Workday system", option: "No" },
];

function parseArgs(argv) {
  const args = {
    cdpPort: 0,
    out: "",
    target: "",
    clickNext: false,
    remainingWorkdayAgent: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--cdp-port" && next) {
      args.cdpPort = Number(next);
      i += 1;
    } else if (arg === "--out" && next) {
      args.out = path.resolve(process.cwd(), next);
      i += 1;
    } else if (arg === "--target" && next) {
      args.target = next;
      i += 1;
    } else if (arg === "--click-next") {
      args.clickNext = true;
    } else if (arg === "--remaining-workday-agent") {
      args.remainingWorkdayAgent = true;
    } else if (arg === "--help") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function usage() {
  return [
    "Usage: node scripts/proofs/workday_application_dropdown_batch_proof.js --cdp-port <port> --out <file> [--click-next] [--remaining-workday-agent]",
    "",
    "Purpose: prove Workday application-question dropdowns can be filled from",
    "visible question text by opening the nearest Select One control, choosing",
    "from the active popup option, and verifying the committed button value.",
  ].join("\n");
}

async function connectPage(port, targetPattern = "") {
  const targets = await httpJson(port, "/json/list");
  const regex = targetPattern ? new RegExp(targetPattern, "i") : null;
  const target =
    targets.find(
      (item) =>
        item.type === "page" &&
        /myworkdayjobs\.com|workday/i.test(String(item.url || "")) &&
        (!regex || regex.test(item.url || "") || regex.test(item.title || "")),
    ) ||
    targets.find((item) => item.type === "page" && /workday/i.test(item.url || "")) ||
    targets.find((item) => item.type === "page");
  if (!target?.webSocketDebuggerUrl) {
    throw new Error(`No page target for ${port}`);
  }
  const client = await new CdpClient(target.webSocketDebuggerUrl).connect();
  return { target, client };
}

async function trustedClick(client, rect) {
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: rect.x,
    y: rect.y,
  });
  await client.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: rect.x,
    y: rect.y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: rect.x,
    y: rect.y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
}

async function snapshot(client, label) {
  return client.evaluate(`(() => {
    const norm = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const bodyText = document.body?.innerText || "";
    const stepMatch = bodyText.match(/current\\s+s?tep\\s+(\\d+)\\s+of\\s+(\\d+)\\s*\\n([^\\n]+)/i);
    const visible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0
        && style.visibility !== "hidden" && style.display !== "none";
    };
    return {
      label: ${JSON.stringify(label)},
      href: location.href,
      title: document.title,
      step: stepMatch ? {
        current: Number(stepMatch[1]),
        total: Number(stepMatch[2]),
        title: norm(stepMatch[3])
      } : null,
      selectOneCount: Array.from(document.querySelectorAll("button"))
        .filter(visible)
        .filter((button) => /Select One/i.test(norm(button.innerText || button.textContent)))
        .length,
      errors: Array.from(document.querySelectorAll('[role="alert"], [data-automation-id*="error"], [id*="error"]'))
        .filter(visible)
        .map((el) => norm(el.innerText || el.textContent))
        .filter(Boolean)
        .filter((text) => !/successfully uploaded/i.test(text))
        .slice(0, 30),
      bodyText: bodyText.slice(0, 6000),
    };
  })()`);
}

async function findQuestionButton(client, question) {
  return client.evaluate(`(() => {
    const question = ${JSON.stringify(question)};
    const norm = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const visible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0
        && style.visibility !== "hidden" && style.display !== "none";
    };
    const textNodes = Array.from(document.querySelectorAll("label, div, span, p"))
      .filter(visible)
      .map((el) => ({ el, text: norm(el.innerText || el.textContent || "") }))
      .filter((item) => item.text && item.text.toLowerCase().includes(question.toLowerCase()))
      .sort((a, b) => a.text.length - b.text.length);
    const match = textNodes[0]?.el;
    if (!match) return { ok: false, reason: "question_not_found", question };
    const buttonQuery = 'button, [role="button"], [role="combobox"]';
    const byDistance = (button) => {
      const rect = button.getBoundingClientRect();
      const matchRect = match.getBoundingClientRect();
      const vertical = Math.max(0, rect.top - matchRect.top);
      return vertical * 10000 + Math.abs(rect.left - matchRect.left);
    };
    let root = match;
    for (let i = 0; root && i < 10; i += 1, root = root.parentElement) {
      const scoped = Array.from(root.querySelectorAll(buttonQuery))
        .filter(visible)
        .filter((button) => /Select One/i.test(norm(button.innerText || button.textContent || button.getAttribute("aria-label"))))
        .sort((a, b) => byDistance(a) - byDistance(b))[0];
      if (scoped) {
        scoped.scrollIntoView({ block: "center", inline: "center" });
        const rect = scoped.getBoundingClientRect();
        return {
          ok: true,
          question,
          text: norm(scoped.innerText || scoped.textContent || scoped.getAttribute("aria-label")),
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
          tag: scoped.tagName,
          automationId: scoped.getAttribute("data-automation-id") || "",
          matchText: norm(match.innerText || match.textContent).slice(0, 500),
        };
      }
    }
    const matchRect = match.getBoundingClientRect();
    const following = Array.from(document.querySelectorAll(buttonQuery))
      .filter(visible)
      .map((button) => ({ button, rect: button.getBoundingClientRect(), text: norm(button.innerText || button.textContent || button.getAttribute("aria-label")) }))
      .filter((item) => /Select One/i.test(item.text) && item.rect.top >= matchRect.top - 5)
      .sort((a, b) => (a.rect.top - b.rect.top) || (a.rect.left - b.rect.left));
    const fallback = following[0]?.button;
    if (!fallback) return { ok: false, reason: "button_not_found", question, matchText: norm(match.innerText || match.textContent).slice(0, 500) };
    fallback.scrollIntoView({ block: "center", inline: "center" });
    const rect = fallback.getBoundingClientRect();
    return {
      ok: true,
      question,
      text: norm(fallback.innerText || fallback.textContent || fallback.getAttribute("aria-label")),
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
      tag: fallback.tagName,
      automationId: fallback.getAttribute("data-automation-id") || "",
      matchText: norm(match.innerText || match.textContent).slice(0, 500),
    };
  })()`);
}

async function findVisibleOption(client, option) {
  return client.evaluate(`(() => {
    const wanted = ${JSON.stringify(option)};
    const norm = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const visible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0
        && rect.bottom > 0 && rect.top < window.innerHeight
        && rect.right > 0 && rect.left < window.innerWidth
        && style.visibility !== "hidden" && style.display !== "none";
    };
    const strongNodes = Array.from(document.querySelectorAll('[role="option"], [data-automation-id="menuItem"], [data-automation-id="promptOption"], [data-automation-id="promptLeafNode"]'))
      .filter(visible)
      .map((el) => ({ el, rect: el.getBoundingClientRect(), text: norm(el.innerText || el.textContent || el.getAttribute("aria-label")) }))
      .filter((item) => item.text === wanted || item.text.includes(wanted))
      .sort((a, b) => {
        return a.text.length - b.text.length;
      });
    const fallbackNodes = strongNodes.length ? [] : Array.from(document.querySelectorAll('button, div, span'))
      .filter(visible)
      .map((el) => ({ el, rect: el.getBoundingClientRect(), text: norm(el.innerText || el.textContent || el.getAttribute("aria-label")) }))
      .filter((item) => item.text === wanted || item.text.includes(wanted))
      .sort((a, b) => a.text.length - b.text.length);
    const found = strongNodes[0] || fallbackNodes[0];
    if (!found) {
      return {
        ok: false,
        reason: "option_not_found",
        option: wanted,
        visibleOptions: Array.from(document.querySelectorAll('[role="option"], [data-automation-id="menuItem"], button, div, span'))
          .filter(visible)
          .map((el) => norm(el.innerText || el.textContent || el.getAttribute("aria-label")))
          .filter(Boolean)
          .slice(0, 80),
      };
    }
    return {
      ok: true,
      option: wanted,
      text: found.text,
      x: Math.round(found.rect.left + found.rect.width / 2),
      y: Math.round(found.rect.top + found.rect.height / 2),
      tag: found.el.tagName,
      role: found.el.getAttribute("role") || "",
      automationId: found.el.getAttribute("data-automation-id") || "",
    };
  })()`);
}

async function committedValue(client, question) {
  return client.evaluate(`(() => {
    const question = ${JSON.stringify(question)};
    const norm = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const visible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0
        && style.visibility !== "hidden" && style.display !== "none";
    };
    const matches = Array.from(document.querySelectorAll("label, div, span, p"))
      .filter(visible)
      .map((el) => ({ el, text: norm(el.innerText || el.textContent || "") }))
      .filter((item) => item.text && item.text.toLowerCase().includes(question.toLowerCase()))
      .sort((a, b) => a.text.length - b.text.length);
    const match = matches[0]?.el;
    if (!match) return "";
    let root = match;
    for (let i = 0; root && i < 10; i += 1, root = root.parentElement) {
      const button = Array.from(root.querySelectorAll('button, [role="button"], [role="combobox"]'))
        .filter(visible)
        .find((el) => !/Select One/i.test(norm(el.innerText || el.textContent || el.getAttribute("aria-label"))));
      if (button) return norm(button.innerText || button.textContent || button.getAttribute("aria-label"));
    }
    return "";
  })()`);
}

async function findNextButton(client) {
  return client.evaluate(`(() => {
    const norm = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const visible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0
        && style.visibility !== "hidden" && style.display !== "none";
    };
    const button = Array.from(document.querySelectorAll("button"))
      .filter(visible)
      .find((el) => /^(Save and Continue|Next)$/i.test(norm(el.innerText || el.textContent)));
    if (!button) return null;
    button.scrollIntoView({ block: "center", inline: "center" });
    const rect = button.getBoundingClientRect();
    return {
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
      text: norm(button.innerText || button.textContent),
    };
  })()`);
}

async function run() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(usage());
    return;
  }
  if (!args.cdpPort || !args.out) {
    throw new Error("--cdp-port and --out are required");
  }
  const { target, client } = await connectPage(args.cdpPort, args.target);
  try {
    const startedAt = new Date().toISOString();
    const before = await snapshot(client, "before");
    const results = [];
    const answers = args.remainingWorkdayAgent
      ? REMAINING_WORKDAY_AGENT_ANSWERS
      : DEFAULT_ANSWERS;
    for (const answer of answers) {
      const button = await findQuestionButton(client, answer.question);
      if (!button.ok) {
        results.push({ answer, button });
        continue;
      }
      await trustedClick(client, button);
      await sleep(500);
      const option = await findVisibleOption(client, answer.option);
      if (!option.ok) {
        results.push({ answer, button, option });
        continue;
      }
      await trustedClick(client, option);
      await sleep(500);
      const committed = await committedValue(client, answer.question);
      results.push({ answer, button, option, committed });
    }
    let nextClick = null;
    if (args.clickNext) {
      nextClick = await findNextButton(client);
      if (nextClick) {
        await trustedClick(client, nextClick);
        await sleep(1500);
      }
    }
    const after = await snapshot(client, "after");
    const payload = {
      ok: true,
      proof: "workday_application_dropdown_batch",
      port: args.cdpPort,
      target: { id: target.id, title: target.title, url: target.url },
      startedAt,
      finishedAt: new Date().toISOString(),
      before,
      answers,
      results,
      nextClick,
      after,
    };
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ ok: true, out: args.out }, null, 2));
  } finally {
    client.close();
  }
}

run().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
