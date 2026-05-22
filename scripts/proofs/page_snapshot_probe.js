#!/usr/bin/env node
"use strict";

const {
  parseCommonArgs,
  runProof,
} = require("./lib/workday_proof_common");

function usage() {
  return [
    "Usage: node scripts/proofs/page_snapshot_probe.js --cdp-port <port> --target <regex> --out <file>",
    "",
    "Purpose: snapshot a current page target for lane failure classification.",
  ].join("\n");
}

async function proof(client) {
  const dom = await client.evaluate(`(() => {
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
    const controls = Array.from(document.querySelectorAll('button, a, input, textarea, select, [role="button"], [role="link"], [role="checkbox"], [role="radio"]'))
      .filter(visible)
      .map((el) => ({
        tag: el.tagName,
        role: el.getAttribute("role") || "",
        type: el.getAttribute("type") || "",
        text: norm([el.innerText, el.textContent, el.getAttribute("aria-label"), el.value, el.placeholder].filter(Boolean).join(" ")).slice(0, 240),
        href: el.href || "",
        id: el.id || "",
        name: el.getAttribute("name") || "",
      }))
      .slice(0, 120);
    return {
      href: location.href,
      title: document.title,
      bodyHead: norm(document.body?.innerText || "").slice(0, 4000),
      controls,
    };
  })()`);
  return {
    behavior: "page_snapshot",
    dom,
  };
}

const args = parseCommonArgs(process.argv);
if (args.help) {
  console.log(usage());
} else {
  runProof(args, "page_snapshot", proof).catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
