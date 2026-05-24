#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { CdpClient, httpJson, sleep } = require("../lib/c3_cdp");

const ANSWERS = [
  {
    question: "Do you have the required years of relevant experience needed for this job?",
    option: "Yes, I have the required years of relevant experience needed for this job",
  },
  {
    question: "Do you have the required software language/or network technologies needed for this job?",
    option: "Yes, I have the required software language/or network technologies needed for this job",
  },
  {
    question: "award or administration of any contracts on behalf of the U.S. Department of Defense",
    option: "No",
  },
];

function parseArgs(argv) {
  const args = { cdpPort: 0, out: "", clickNext: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--cdp-port" && next) {
      args.cdpPort = Number(next);
      i += 1;
    } else if (arg === "--out" && next) {
      args.out = path.resolve(process.cwd(), next);
      i += 1;
    } else if (arg === "--click-next") {
      args.clickNext = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!args.cdpPort || !args.out) {
    throw new Error("--cdp-port and --out are required");
  }
  return args;
}

async function connectPage(port) {
  const targets = await httpJson(port, "/json/list");
  const target =
    targets.find(
      (item) =>
        item.type === "page" &&
        /comcast\.wd5\.myworkdayjobs\.com/i.test(String(item.url || "")),
    ) ||
    targets.find((item) => item.type === "page" && /myworkdayjobs\.com/i.test(String(item.url || "")));
  if (!target?.webSocketDebuggerUrl) {
    throw new Error(`No Comcast Workday page target for ${port}`);
  }
  const client = await new CdpClient(target.webSocketDebuggerUrl).connect();
  return { target, client };
}

async function trustedClick(client, point) {
  await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
  await client.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x,
    y: point.y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
}

async function pressEscape(client) {
  await client.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
}

async function snapshot(client, label) {
  return client.evaluate(`(() => {
    const norm = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const visible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0
        && style.visibility !== "hidden" && style.display !== "none";
    };
    const bodyText = document.body?.innerText || "";
    const stepMatch = bodyText.match(/current\\s+s?tep\\s+(\\d+)\\s+of\\s+(\\d+)\\s*\\n([^\\n]+)/i);
    return {
      label: ${JSON.stringify(label)},
      href: location.href,
      title: document.title,
      step: stepMatch ? {
        current: Number(stepMatch[1]),
        total: Number(stepMatch[2]),
        title: norm(stepMatch[3])
      } : null,
      errors: Array.from(document.querySelectorAll('[role="alert"], [data-automation-id*="error"], [id*="error"]'))
        .filter(visible)
        .map((el) => norm(el.innerText || el.textContent))
        .filter(Boolean)
        .filter((text) => !/successfully uploaded/i.test(text))
        .slice(0, 30),
      selectOneButtons: Array.from(document.querySelectorAll("button"))
        .filter(visible)
        .map((button) => norm(button.innerText || button.textContent || button.getAttribute("aria-label")))
        .filter((text) => /Select One/i.test(text))
        .slice(0, 20),
      bodyTail: norm(bodyText).slice(-2500),
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
    const matches = Array.from(document.querySelectorAll("label, div, span, p"))
      .filter(visible)
      .map((el) => ({ el, text: norm(el.innerText || el.textContent || "") }))
      .filter((item) => {
        const lower = item.text.toLowerCase();
        return item.text.length < 700
          && lower.includes(question.toLowerCase())
          && !/^yes[, ]/i.test(item.text)
          && !/^no[, ]/i.test(item.text)
          && !/^select one/i.test(item.text);
      })
      .sort((a, b) => a.text.length - b.text.length);
    const match = matches[0]?.el;
    if (!match) return { ok: false, reason: "question_not_found", question };
    const buttonQuery = 'button, [role="button"], [role="combobox"]';
    let root = match;
    for (let i = 0; root && i < 10; i += 1, root = root.parentElement) {
      const button = Array.from(root.querySelectorAll(buttonQuery))
        .filter(visible)
        .find((el) => /Select One/i.test(norm(el.innerText || el.textContent || el.getAttribute("aria-label"))));
      if (button) {
        button.scrollIntoView({ block: "center", inline: "center" });
        const rect = button.getBoundingClientRect();
        return {
          ok: true,
          question,
          text: norm(button.innerText || button.textContent || button.getAttribute("aria-label")),
          matchText: norm(match.innerText || match.textContent).slice(0, 500),
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
        };
      }
    }
    return { ok: false, reason: "button_not_found", question, matchText: norm(match.innerText || match.textContent).slice(0, 500) };
  })()`);
}

async function findOption(client, option) {
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
    const candidates = Array.from(document.querySelectorAll('[role="option"], [data-automation-id="menuItem"], button, div, span'))
      .filter(visible)
      .map((el) => ({ el, rect: el.getBoundingClientRect(), text: norm(el.innerText || el.textContent || el.getAttribute("aria-label")) }))
      .filter((item) => item.text === wanted || item.text.includes(wanted))
      .sort((a, b) => a.text.length - b.text.length);
    const found = candidates[0];
    if (!found) {
      return {
        ok: false,
        reason: "option_not_found",
        wanted,
        visibleOptions: Array.from(document.querySelectorAll('[role="option"], [data-automation-id="menuItem"], button, div, span'))
          .filter(visible)
          .map((el) => norm(el.innerText || el.textContent || el.getAttribute("aria-label")))
          .filter(Boolean)
          .slice(0, 80),
      };
    }
    return {
      ok: true,
      wanted,
      text: found.text,
      x: Math.round(found.rect.left + found.rect.width / 2),
      y: Math.round(found.rect.top + found.rect.height / 2),
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
    const match = Array.from(document.querySelectorAll("label, div, span, p"))
      .filter(visible)
      .map((el) => ({ el, text: norm(el.innerText || el.textContent || "") }))
      .filter((item) => {
        const lower = item.text.toLowerCase();
        return item.text.length < 700
          && lower.includes(question.toLowerCase())
          && !/^yes[, ]/i.test(item.text)
          && !/^no[, ]/i.test(item.text)
          && !/^select one/i.test(item.text);
      })
      .sort((a, b) => a.text.length - b.text.length)[0]?.el;
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
    const button = Array.from(document.querySelectorAll("button"))
      .find((el) => /^(Save and Continue|Next)$/i.test(norm(el.innerText || el.textContent)));
    if (!button) return null;
    button.scrollIntoView({ block: "center", inline: "center" });
    const rect = button.getBoundingClientRect();
    return { text: norm(button.innerText || button.textContent), x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  })()`);
}

async function run() {
  const args = parseArgs(process.argv);
  const { target, client } = await connectPage(args.cdpPort);
  try {
    const before = await snapshot(client, "before");
    const results = [];
    for (const answer of ANSWERS) {
      await pressEscape(client);
      await sleep(200);
      const button = await findQuestionButton(client, answer.question);
      if (!button.ok) {
        results.push({ answer, button });
        continue;
      }
      await trustedClick(client, button);
      await sleep(500);
      const option = await findOption(client, answer.option);
      if (!option.ok) {
        results.push({ answer, button, option });
        continue;
      }
      await trustedClick(client, option);
      await sleep(500);
      results.push({ answer, button, option, committed: await committedValue(client, answer.question) });
    }
    let nextClick = null;
    if (args.clickNext) {
      nextClick = await findNextButton(client);
      if (nextClick) {
        await trustedClick(client, nextClick);
        await sleep(2500);
      }
    }
    const after = await snapshot(client, "after");
    const payload = {
      ok: true,
      proof: "workday_comcast_application_questions",
      port: args.cdpPort,
      target: { id: target.id, title: target.title, url: target.url },
      answers: ANSWERS,
      before,
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
