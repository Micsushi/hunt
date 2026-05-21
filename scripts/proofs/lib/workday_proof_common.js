"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { CdpClient, httpJson, sleep } = require("../../lib/c3_cdp");

function parseCommonArgs(argv, defaults = {}) {
  const args = {
    cdpPort: 0,
    out: "",
    target: "",
    ...defaults,
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
    } else if (arg === "--question-regex" && next) {
      args.questionRegex = next;
      i += 1;
    } else if (arg === "--option-regex" && next) {
      args.optionRegex = next;
      i += 1;
    } else if (arg === "--label-regex" && next) {
      args.labelRegex = next;
      i += 1;
    } else if (arg === "--field-regex" && next) {
      args.fieldRegex = next;
      i += 1;
    } else if (arg === "--search-text" && next) {
      args.searchText = next;
      i += 1;
    } else if (arg === "--month" && next) {
      args.month = next;
      i += 1;
    } else if (arg === "--day" && next) {
      args.day = next;
      i += 1;
    } else if (arg === "--year" && next) {
      args.year = next;
      i += 1;
    } else if (arg === "--first-name" && next) {
      args.firstName = next;
      i += 1;
    } else if (arg === "--last-name" && next) {
      args.lastName = next;
      i += 1;
    } else if (arg === "--help") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!args.help && !args.cdpPort) {
    throw new Error("--cdp-port is required");
  }
  if (!args.help && !args.out) {
    throw new Error("--out is required");
  }
  return args;
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

async function snapshot(client, label) {
  return client.evaluate(`(() => {
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
    const bodyText = document.body?.innerText || "";
    const stepMatch = bodyText.match(/current\\s+s?tep\\s+(\\d+)\\s+of\\s+(\\d+)\\s*\\n([^\\n]+)/i);
    const optionText = Array.from(document.querySelectorAll('[role="option"], [data-automation-id="menuItem"], [data-automation-id="promptOption"], [data-automation-id="selectedItem"], button, label'))
      .filter(visible)
      .map((el) => norm([el.innerText, el.textContent, el.getAttribute("aria-label")].filter(Boolean).join(" ")))
      .filter(Boolean)
      .slice(0, 120);
    const errors = Array.from(document.querySelectorAll('[role="alert"], [data-automation-id*="error"], [id*="error"]'))
      .filter(visible)
      .map((el) => norm(el.innerText || el.textContent))
      .filter(Boolean)
      .filter((text) => !/successfully uploaded/i.test(text))
      .slice(0, 30);
    return {
      label: ${JSON.stringify(label)},
      href: location.href,
      title: document.title,
      step: stepMatch ? { current: Number(stepMatch[1]), total: Number(stepMatch[2]), title: norm(stepMatch[3]) } : null,
      errors,
      optionText,
      activeElement: document.activeElement ? {
        tag: document.activeElement.tagName,
        id: document.activeElement.id || "",
        name: document.activeElement.getAttribute("name") || "",
        ariaLabel: document.activeElement.getAttribute("aria-label") || "",
        text: norm(document.activeElement.innerText || document.activeElement.textContent).slice(0, 200)
      } : null,
      bodyHead: norm(bodyText).slice(0, 1200),
      bodyTail: norm(bodyText).slice(-1200)
    };
  })()`);
}

async function rectFor(client, finderSource) {
  const result = await client.evaluate(`(() => {
    const norm = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const visible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0
        && style.visibility !== "hidden" && style.display !== "none";
    };
    const finder = ${finderSource};
    const el = finder({ norm, visible });
    if (!el) return null;
    if (!visible(el)) {
      el.scrollIntoView({ block: "center", inline: "center" });
    }
    const rect = el.getBoundingClientRect();
    return {
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
      text: norm([el.innerText, el.textContent, el.getAttribute("aria-label"), el.value].filter(Boolean).join(" ")),
      tag: el.tagName,
      id: el.id || "",
      name: el.getAttribute("name") || "",
      automationId: el.getAttribute("data-automation-id") || "",
      role: el.getAttribute("role") || ""
    };
  })()`);
  if (!result) {
    throw new Error("Target element not found");
  }
  return result;
}

async function trustedClick(client, rect) {
  await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x, y: rect.y });
  await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", buttons: 1, clickCount: 1 });
  await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y, button: "left", buttons: 0, clickCount: 1 });
}

async function trustedKey(client, key) {
  await client.send("Input.dispatchKeyEvent", { type: "keyDown", key });
  await client.send("Input.dispatchKeyEvent", { type: "keyUp", key });
}

async function trustedSelectAllBackspace(client) {
  await client.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Control",
    code: "ControlLeft",
    windowsVirtualKeyCode: 17,
    nativeVirtualKeyCode: 17,
    modifiers: 2,
  });
  await client.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
    modifiers: 2,
  });
  await client.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
    modifiers: 2,
  });
  await client.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Control",
    code: "ControlLeft",
    windowsVirtualKeyCode: 17,
    nativeVirtualKeyCode: 17,
  });
  await trustedKey(client, "Backspace");
}

async function trustedText(client, text) {
  for (const char of String(text || "")) {
    await client.send("Input.dispatchKeyEvent", {
      type: "char",
      text: char,
      unmodifiedText: char,
    });
  }
}

function rxSource(source, flags = "i") {
  return `new RegExp(${JSON.stringify(source)}, ${JSON.stringify(flags)})`;
}

function buttonByQuestion(questionRegex) {
  return `({ norm }) => {
    const question = ${rxSource(questionRegex)};
    const direct = Array.from(document.querySelectorAll('button, [role="button"], [role="combobox"], input[role="combobox"]'))
      .find((el) => {
        const text = norm([el.innerText, el.textContent, el.getAttribute("aria-label"), el.id, el.getAttribute("name")].filter(Boolean).join(" "));
        return !/^Error-/i.test(text) && question.test(text);
      });
    if (direct) return direct;
    const labels = Array.from(document.querySelectorAll('label, div, span, p'))
      .map((el) => ({ el, text: norm([el.innerText, el.textContent, el.getAttribute("aria-label")].filter(Boolean).join(" ")) }))
      .filter((item) => item.text && question.test(item.text))
      .filter((item) => !/^Error-/i.test(item.text))
      .sort((a, b) => a.text.length - b.text.length);
    for (const item of labels) {
      let root = item.el;
      for (let i = 0; root && i < 8; i += 1, root = root.parentElement) {
        const control = root.querySelector?.('button, [role="button"], [role="combobox"], input[role="combobox"], input[type="checkbox"], input[type="radio"]');
        if (control) return control;
      }
    }
    return null;
  }`;
}

function visibleText(textRegex) {
  return `({ norm, visible }) => {
    const wanted = ${rxSource(textRegex)};
    const nodes = Array.from(document.querySelectorAll('[role="option"], [data-automation-id="menuItem"], [data-automation-id="promptOption"], [data-automation-id="promptLeafNode"], [data-automation-id="selectedItem"], button, label, a, div, span, input[type="checkbox"], input[type="radio"]'))
      .map((el) => ({ el, text: norm([el.innerText, el.textContent, el.getAttribute("aria-label"), el.value].filter(Boolean).join(" ")) }))
      .filter((item) => item.text && wanted.test(item.text))
      .sort((a, b) => a.text.length - b.text.length);
    return nodes.find((item) => visible(item.el))?.el || nodes[0]?.el || null;
  }`;
}

function checkboxByLabel(labelRegex) {
  return `({ norm }) => {
    const wanted = ${rxSource(labelRegex)};
    const labels = Array.from(document.querySelectorAll('label, div, span'))
      .map((el) => ({ el, text: norm([el.innerText, el.textContent, el.getAttribute("aria-label")].filter(Boolean).join(" ")) }))
      .filter((item) => item.text && wanted.test(item.text))
      .sort((a, b) => a.text.length - b.text.length);
    for (const item of labels) {
      const forId = item.el.getAttribute?.("for");
      if (forId) {
        const byFor = document.getElementById(forId);
        if (byFor) return byFor;
      }
      let root = item.el;
      for (let i = 0; root && i < 8; i += 1, root = root.parentElement) {
        const input = root.querySelector?.('input[type="checkbox"], input[type="radio"], [role="checkbox"], [role="radio"]');
        if (input) return input;
      }
    }
    return null;
  }`;
}

function inputByField(fieldRegex) {
  return `({ norm, visible }) => {
    const wanted = ${rxSource(fieldRegex)};
    const candidates = Array.from(document.querySelectorAll('input:not([type="hidden"]), textarea, [role="combobox"]'))
      .filter(visible)
      .map((el) => {
        const container = el.closest('[data-automation-id^="formField"], [role="group"], [data-fkit-id]') || el.parentElement;
        const text = norm([el.id, el.name, el.getAttribute("aria-label"), el.getAttribute("placeholder"), container?.innerText, container?.textContent].filter(Boolean).join(" "));
        return { el, text };
      })
      .filter((item) => wanted.test(item.text))
      .sort((a, b) => a.text.length - b.text.length);
    return candidates[0]?.el || null;
  }`;
}

async function clickStep(client, label, finder, waitMs = 800) {
  const rect = await rectFor(client, finder);
  await trustedClick(client, rect);
  await sleep(waitMs);
  return { label, clicked: rect, after: await snapshot(client, `after:${label}`) };
}

async function writeProof(out, payload) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function runProof(args, proofName, proofFn) {
  const { target, client } = await connectPage(args.cdpPort, args.target);
  try {
    const startedAt = new Date().toISOString();
    const before = await snapshot(client, "before");
    const result = await proofFn(client, args);
    const after = await snapshot(client, "after");
    const payload = {
      ok: true,
      proof: proofName,
      port: args.cdpPort,
      target: { id: target.id, title: target.title, url: target.url },
      startedAt,
      finishedAt: new Date().toISOString(),
      before,
      result,
      after,
    };
    await writeProof(args.out, payload);
    console.log(JSON.stringify({ ok: true, proof: proofName, out: args.out }, null, 2));
  } finally {
    client.close();
  }
}

module.exports = {
  buttonByQuestion,
  checkboxByLabel,
  clickStep,
  inputByField,
  parseCommonArgs,
  rectFor,
  runProof,
  sleep,
  snapshot,
  trustedClick,
  trustedKey,
  trustedSelectAllBackspace,
  trustedText,
  visibleText,
};
