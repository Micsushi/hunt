#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { CdpClient, httpJson, sleep } = require("../lib/c3_cdp");

function parseArgs(argv) {
  const args = {
    cdpPort: 0,
    out: "",
    queries: [
      "Sales",
      "Leadership",
      "Management",
      "Communication",
      "Customer",
      "Retail",
      "Team",
      "Accounting",
    ],
    save: false,
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
    } else if (arg === "--query" && next) {
      args.queries = [next];
      i += 1;
    } else if (arg === "--queries" && next) {
      args.queries = next
        .split("|")
        .map((item) => item.trim())
        .filter(Boolean);
      i += 1;
    } else if (arg === "--save") {
      args.save = true;
    } else if (arg === "--help") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (args.help) {
    console.log(
      "Usage: node scripts/proofs/workday_target_skills_commit_probe.js --cdp-port 9703 --out logs/target.json [--queries Sales|Leadership] [--save]",
    );
    process.exit(0);
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
        /myworkdayjobs\.com/i.test(String(item.url || "")),
    ) ||
    targets.find(
      (item) =>
        item.type === "page" &&
        /workday/i.test(String(item.url || item.title || "")),
    ) ||
    targets.find((item) => item.type === "page");
  if (!target?.webSocketDebuggerUrl) {
    throw new Error(`No usable page target on ${port}`);
  }
  return {
    target,
    client: await new CdpClient(target.webSocketDebuggerUrl).connect(),
  };
}

function js(value) {
  return JSON.stringify(value);
}

async function evalPage(client, fn, arg = null, timeoutMs = 60000) {
  return client.evaluate(`(${fn.toString()})(${js(arg)})`, timeoutMs);
}

async function clickPoint(client, point) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new Error(`Bad click point: ${JSON.stringify(point)}`);
  }
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: point.x,
    y: point.y,
  });
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

async function key(client, keyName) {
  const codes = {
    ArrowDown: ["ArrowDown", 40],
    Backspace: ["Backspace", 8],
    End: ["End", 35],
    Enter: ["Enter", 13],
    Escape: ["Escape", 27],
    Tab: ["Tab", 9],
  };
  const [code, windowsVirtualKeyCode] = codes[keyName] || [keyName, 0];
  await client.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: keyName,
    code,
    windowsVirtualKeyCode,
    nativeVirtualKeyCode: windowsVirtualKeyCode,
  });
  await client.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: keyName,
    code,
    windowsVirtualKeyCode,
    nativeVirtualKeyCode: windowsVirtualKeyCode,
  });
}

async function ctrlABackspace(client) {
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
  await key(client, "Backspace");
}

async function text(client, value) {
  for (const char of String(value || "")) {
    await client.send("Input.dispatchKeyEvent", {
      type: "char",
      text: char,
      unmodifiedText: char,
    });
    await sleep(20);
  }
}

function pageState() {
  const norm = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const rect = (el) => {
    const r = el?.getBoundingClientRect?.();
    return r
      ? {
          x: Math.round(r.left),
          y: Math.round(r.top),
          w: Math.round(r.width),
          h: Math.round(r.height),
        }
      : null;
  };
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return (
      r.width > 0 &&
      r.height > 0 &&
      r.bottom > 0 &&
      r.top < innerHeight &&
      r.right > 0 &&
      r.left < innerWidth &&
      style.visibility !== "hidden" &&
      style.display !== "none"
    );
  };
  const label = (el) =>
    norm(
      [
        el?.innerText,
        el?.textContent,
        el?.getAttribute?.("aria-label"),
        el?.getAttribute?.("title"),
        el?.value,
      ]
        .filter(Boolean)
        .join(" "),
    );
  const body = document.body?.innerText || "";
  const stepMatch = body.match(
    /current\s+s?tep\s+(\d+)\s+of\s+(\d+)\s*\n([^\n]+)/i,
  );
  const skillsInput = document.querySelector("#skills--skills");
  const skillsContainer =
    skillsInput?.closest?.('[data-automation-id="formField-skills"]') ||
    skillsInput?.closest?.("[data-fkit-id]") ||
    null;
  const selected = Array.from(
    skillsContainer?.querySelectorAll?.(
      [
        '[data-automation-id="selectedItem"]',
        '[data-automation-id="selectedItemList"] [role="listitem"]',
        '[data-automation-id="selectedItemList"] button',
        '[data-automation-id="promptSelectionLabel"]',
        '[id^="pill-"]',
      ].join(","),
    ) || [],
  )
    .filter(visible)
    .map(label)
    .filter(Boolean);
  const alerts = Array.from(
    skillsContainer?.querySelectorAll?.(
      [
        '[role="alert"]',
        '[data-automation-id="inputAlert"]',
        '[data-automation-id="errorMessage"]',
        '[id*="error"]',
      ].join(","),
    ) || [],
  )
    .filter(visible)
    .map(label)
    .filter(Boolean);
  const footer = Array.from(document.querySelectorAll("button"))
    .filter(visible)
    .filter((button) => /save and continue|next|continue|submit/i.test(label(button)))
    .sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0];
  return {
    href: location.href,
    title: document.title,
    scrollY: Math.round(scrollY),
    step: stepMatch
      ? {
          current: Number(stepMatch[1]),
          total: Number(stepMatch[2]),
          title: norm(stepMatch[3]),
        }
      : null,
    skills: {
      input: skillsInput
        ? {
            value: skillsInput.value || "",
            ariaInvalid: skillsInput.getAttribute("aria-invalid") || "",
            ariaExpanded: skillsInput.getAttribute("aria-expanded") || "",
            ariaControls: skillsInput.getAttribute("aria-controls") || "",
            rect: rect(skillsInput),
            visible: visible(skillsInput),
          }
        : null,
      containerText: label(skillsContainer).slice(0, 600),
      selected,
      alerts,
    },
    footer: footer
      ? {
          text: label(footer),
          disabled:
            footer.disabled || footer.getAttribute("aria-disabled") === "true",
          rect: rect(footer),
        }
      : null,
    bodyTail: norm(body).slice(-1400),
  };
}

function scrollSkillsIntoView() {
  const input = document.querySelector("#skills--skills");
  if (!input) return null;
  input.scrollIntoView({ block: "center", inline: "center" });
  const rect = input.getBoundingClientRect();
  return {
    x: Math.round(rect.left + rect.width / 2),
    y: Math.round(rect.top + rect.height / 2),
    rect: {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
    },
  };
}

function setSkillsSearchValue(arg) {
  const input = document.querySelector("#skills--skills");
  if (!input) return { ok: false, reason: "skills_input_not_found" };
  const value = String(arg?.value || "");
  input.scrollIntoView({ block: "center", inline: "center" });
  try {
    input.focus({ preventScroll: true });
  } catch (_error) {
    input.focus();
  }
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  const assign = (nextValue) => {
    if (setter) {
      setter.call(input, nextValue);
    } else {
      input.value = nextValue;
    }
  };
  assign("");
  input.dispatchEvent(new Event("input", { bubbles: true }));
  let current = "";
  for (const char of value) {
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: char,
        code: "Key" + char.toUpperCase(),
      }),
    );
    input.dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        data: char,
      }),
    );
    current += char;
    assign(current);
    input.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        data: char,
      }),
    );
    input.dispatchEvent(
      new KeyboardEvent("keyup", {
        bubbles: true,
        cancelable: true,
        key: char,
        code: "Key" + char.toUpperCase(),
      }),
    );
  }
  const rect = input.getBoundingClientRect();
  return {
    ok: input.value === value,
    value: input.value || "",
    rect: {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
    },
  };
}

function activeSkillRows() {
  const norm = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const rect = (el) => {
    const r = el?.getBoundingClientRect?.();
    return r
      ? {
          x: Math.round(r.left),
          y: Math.round(r.top),
          w: Math.round(r.width),
          h: Math.round(r.height),
        }
      : null;
  };
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return (
      r.width > 0 &&
      r.height > 0 &&
      r.bottom > 0 &&
      r.top < innerHeight &&
      r.right > 0 &&
      r.left < innerWidth &&
      style.visibility !== "hidden" &&
      style.display !== "none"
    );
  };
  const label = (el) =>
    norm(
      [
        el?.innerText,
        el?.textContent,
        el?.getAttribute?.("aria-label"),
        el?.getAttribute?.("data-automation-label"),
        el?.getAttribute?.("title"),
      ]
        .filter(Boolean)
        .join(" "),
    );
  const input = document.querySelector("#skills--skills");
  const controlsId = input?.getAttribute("aria-controls");
  const controlled = controlsId ? document.getElementById(controlsId) : null;
  const boxes = Array.from(
    new Set(
      [
        controlled,
        ...Array.from(
          document.querySelectorAll(
            [
              '[data-automation-id="activeListContainer"]',
              '[data-automation-id="promptSearchResultList"]',
              '[data-uxi-widget-type="multiselectlist"]',
              '[role="listbox"]',
            ].join(","),
          ),
        ),
      ].filter(Boolean),
    ),
  )
    .filter(visible)
    .filter((box) => !box.closest('[data-automation-id="selectedItemList"]'))
    .sort((a, b) => {
      if (controlled && a === controlled) return -1;
      if (controlled && b === controlled) return 1;
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return Math.abs(ar.left - (input?.getBoundingClientRect?.().left || 0)) -
        Math.abs(br.left - (input?.getBoundingClientRect?.().left || 0));
    });
  const scope = boxes[0] || null;
  const rows = Array.from(
    scope?.querySelectorAll?.(
      [
        '[role="option"]',
        '[role="treeitem"]',
        '[data-automation-id="menuItem"]',
        '[data-automation-id="promptLeafNode"]',
        '[data-automation-id="promptOption"]',
        '[data-automation-id="checkboxPanel"]',
        "li",
      ].join(","),
    ) || [],
  )
    .filter(visible)
    .filter((el) => !el.closest('[data-automation-id="selectedItemList"]'))
    .map((el) => {
      const r = rect(el);
      const checkbox =
        el.matches?.(
          'input[type="checkbox"], [role="checkbox"], [data-automation-id="checkboxPanel"]',
        )
          ? el
          : el.querySelector?.(
              'input[type="checkbox"], [role="checkbox"], [data-automation-id="checkboxPanel"]',
            );
      const cr = rect(checkbox);
      return {
        tag: el.tagName,
        id: el.id || "",
        role: el.getAttribute("role") || "",
        auto: el.getAttribute("data-automation-id") || "",
        aria: el.getAttribute("aria-label") || "",
        text: label(el),
        rect: r,
        points: {
          left: r ? { x: Math.round(r.x + 20), y: Math.round(r.y + r.h / 2) } : null,
          center: r
            ? { x: Math.round(r.x + r.w / 2), y: Math.round(r.y + r.h / 2) }
            : null,
          checkbox: cr
            ? { x: Math.round(cr.x + cr.w / 2), y: Math.round(cr.y + cr.h / 2) }
            : null,
        },
      };
    });
  return {
    input: input
      ? {
          value: input.value || "",
          ariaExpanded: input.getAttribute("aria-expanded") || "",
          ariaControls: controlsId || "",
          rect: rect(input),
        }
      : null,
    listbox: scope
      ? {
          tag: scope.tagName,
          id: scope.id || "",
          role: scope.getAttribute("role") || "",
          auto: scope.getAttribute("data-automation-id") || "",
          rect: rect(scope),
          text: label(scope).slice(0, 900),
        }
      : null,
    rows,
  };
}

function firstSelectableSkillRowFromRows(rows) {
  return rows
    .filter((row) => row.rect)
    .filter((row) => !/no items|error-|errors found|required/i.test(row.text))
    .filter((row) => row.text.length > 0)
    .sort((a, b) => {
      const aMenu = /menuItem|promptLeafNode|promptOption/.test(a.auto) ? 0 : 1;
      const bMenu = /menuItem|promptLeafNode|promptOption/.test(b.auto) ? 0 : 1;
      return aMenu - bMenu || a.text.length - b.text.length || a.rect.y - b.rect.y;
    })[0] || null;
}

function clickRowWithDomEvents(arg) {
  const norm = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return (
      r.width > 0 &&
      r.height > 0 &&
      r.bottom > 0 &&
      r.top < innerHeight &&
      r.right > 0 &&
      r.left < innerWidth &&
      style.visibility !== "hidden" &&
      style.display !== "none"
    );
  };
  const label = (el) =>
    norm(
      [
        el?.innerText,
        el?.textContent,
        el?.getAttribute?.("aria-label"),
        el?.getAttribute?.("data-automation-label"),
        el?.getAttribute?.("title"),
      ]
        .filter(Boolean)
        .join(" "),
    );
  const wanted = new RegExp(arg?.text || ".", "i");
  const rows = Array.from(
    document.querySelectorAll(
      [
        '[role="option"]',
        '[role="treeitem"]',
        '[data-automation-id="menuItem"]',
        '[data-automation-id="promptLeafNode"]',
        '[data-automation-id="promptOption"]',
        "li",
      ].join(","),
    ),
  )
    .filter(visible)
    .filter((row) => wanted.test(label(row)))
    .filter((row) => !/no items|error-|errors found|required/i.test(label(row)))
    .sort((a, b) => label(a).length - label(b).length);
  const row = rows[0] || null;
  if (!row) return { ok: false, reason: "row_not_found" };
  const target =
    row.querySelector?.(
      'input[type="checkbox"], [role="checkbox"], [data-automation-id="checkboxPanel"]',
    ) || row;
  ["mouseover", "mousedown", "mouseup", "click"].forEach((type) => {
    target.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        view: window,
        button: 0,
      }),
    );
  });
  if (typeof target.click === "function") target.click();
  return { ok: true, text: label(row).slice(0, 300) };
}

function saveButtonPoint() {
  const norm = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return (
      r.width > 0 &&
      r.height > 0 &&
      r.bottom > 0 &&
      r.top < innerHeight &&
      style.visibility !== "hidden" &&
      style.display !== "none"
    );
  };
  const label = (el) =>
    norm([el?.innerText, el?.textContent, el?.getAttribute?.("aria-label")].join(" "));
  const button = Array.from(document.querySelectorAll("button"))
    .filter(visible)
    .filter((el) => /save and continue|next|continue|submit/i.test(label(el)))
    .sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0];
  if (!button) return null;
  const r = button.getBoundingClientRect();
  return {
    x: Math.round(r.left + r.width / 2),
    y: Math.round(r.top + r.height / 2),
    text: label(button),
    disabled: button.disabled || button.getAttribute("aria-disabled") === "true",
  };
}

async function runProbe(client, args) {
  const attempts = [];
  attempts.push({ action: "initial", state: await evalPage(client, pageState) });
  await key(client, "Escape");
  await sleep(200);
  for (const query of args.queries) {
    const inputPoint = await evalPage(client, scrollSkillsIntoView);
    attempts.push({ action: "skills_input", query, inputPoint });
    if (!inputPoint) {
      return { ok: false, reason: "skills_input_not_found", attempts };
    }
    await clickPoint(client, inputPoint);
    await sleep(250);
    const setResult = await evalPage(client, setSkillsSearchValue, {
      value: query,
    });
    attempts.push({ action: "set_query", query, setResult });
    await sleep(1800);
    let rows = await evalPage(client, activeSkillRows);
    attempts.push({
      action: "rows_after_search",
      query,
      rows: {
        input: rows.input,
        listbox: rows.listbox,
        rows: rows.rows.slice(0, 25),
      },
    });
    let row = firstSelectableSkillRowFromRows(rows.rows);
    if (!row) {
      await key(client, "ArrowDown");
      await sleep(300);
      rows = await evalPage(client, activeSkillRows);
      attempts.push({
        action: "rows_after_arrow_down",
        query,
        rows: {
          input: rows.input,
          listbox: rows.listbox,
          rows: rows.rows.slice(0, 25),
        },
      });
      row = firstSelectableSkillRowFromRows(rows.rows);
    }
    attempts.push({ action: "chosen_row", query, row });
    if (!row) {
      await key(client, "Escape");
      await sleep(200);
      continue;
    }
    const points = [
      ["checkbox", row.points.checkbox],
      ["left", row.points.left],
      ["center", row.points.center],
    ].filter(([, point]) => point);
    for (const [label, point] of points) {
      await clickPoint(client, point);
      await sleep(1000);
      const state = await evalPage(client, pageState);
      attempts.push({
        action: "click_variant",
        query,
        label,
        point,
        selected: state.skills.selected,
        inputValue: state.skills.input?.value || "",
        invalid: state.skills.input?.ariaInvalid || "",
        footer: state.footer,
      });
      if (state.skills.selected.length) {
        if (args.save) {
          const save = await evalPage(client, saveButtonPoint);
          attempts.push({ action: "save_button_before_click", save });
          if (save && !save.disabled) {
            await clickPoint(client, save);
            await sleep(2500);
            attempts.push({
              action: "after_save",
              state: await evalPage(client, pageState),
            });
          }
        }
        return {
          ok: true,
          query,
          committedBy: label,
          selected: state.skills.selected,
          attempts,
        };
      }
    }
    const domClick = await evalPage(client, clickRowWithDomEvents, {
      text: row.text.slice(0, 80).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    });
    await sleep(1000);
    const state = await evalPage(client, pageState);
    attempts.push({
      action: "dom_click",
      query,
      domClick,
      selected: state.skills.selected,
      inputValue: state.skills.input?.value || "",
      invalid: state.skills.input?.ariaInvalid || "",
      footer: state.footer,
    });
    if (state.skills.selected.length) {
      if (args.save) {
        const save = await evalPage(client, saveButtonPoint);
        attempts.push({ action: "save_button_before_click", save });
        if (save && !save.disabled) {
          await clickPoint(client, save);
          await sleep(2500);
          attempts.push({
            action: "after_save",
            state: await evalPage(client, pageState),
          });
        }
      }
      return {
        ok: true,
        query,
        committedBy: "dom_click",
        selected: state.skills.selected,
        attempts,
      };
    }
    await key(client, "Escape");
    await sleep(200);
  }
  return {
    ok: false,
    reason: "no_skill_committed",
    attempts,
    final: await evalPage(client, pageState),
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const { target, client } = await connectPage(args.cdpPort);
  try {
    const result = {
      proof: "workday_target_skills_commit_probe",
      port: args.cdpPort,
      target: {
        id: target.id,
        title: target.title,
        url: target.url,
      },
      startedAt: new Date().toISOString(),
      result: await runProbe(client, args),
      finishedAt: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify({ ok: result.result.ok, out: args.out }, null, 2));
  } finally {
    client.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
