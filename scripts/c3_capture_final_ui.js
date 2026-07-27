#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { CdpClient, httpJson } = require("./lib/c3_cdp");

function parseArgs(argv) {
  const args = { ports: [], outDir: "", targetIds: new Map(), suffix: "" };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--ports" && next) {
      args.ports = next.split(",").map((port) => Number(port.trim())).filter(Boolean);
      i += 1;
    } else if (arg === "--out-dir" && next) {
      args.outDir = path.resolve(process.cwd(), next);
      i += 1;
    } else if (arg === "--target" && next) {
      const match = next.match(/^(\d+)=(.+)$/);
      if (!match) throw new Error("--target must use <port>=<target-id>");
      args.targetIds.set(Number(match[1]), match[2]);
      i += 1;
    } else if (arg === "--suffix" && next) {
      if (!/^[a-zA-Z0-9._-]+$/.test(next)) {
        throw new Error("--suffix may contain only letters, numbers, dot, underscore, and dash");
      }
      args.suffix = next;
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!args.ports.length) throw new Error("--ports is required");
  if (!args.outDir) throw new Error("--out-dir is required");
  return args;
}

class CaptureVerificationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CaptureVerificationError";
    this.code = code;
  }
}

function slugForTarget(target, port) {
  const text = `${target.title || ""} ${target.url || ""}`.toLowerCase();
  if (text.includes("bristolmyerssquibb")) return "bristol_myers_squibb";
  if (text.includes("amgen")) return "amgen";
  if (text.includes("thermofisher")) return "thermo_fisher";
  if (text.includes("cox_")) return "cox";
  if (text.includes("nrf") || text.includes("national retail")) return "nrf";
  return `port_${port}`;
}

function targetIdentityScript() {
  return `(() => ({
    href: location.href,
    title: document.title,
    visibilityState: document.visibilityState
  }))()`;
}

function assertStableTargetIdentity(identity, target, phase) {
  if (!identity || identity.href !== target.url) {
    throw new CaptureVerificationError(
      "screenshot_target_identity_changed",
      `${phase} document URL does not match selected target ${target.id}`,
    );
  }
  if (identity.visibilityState !== "visible") {
    throw new CaptureVerificationError(
      "selected_target_not_visible",
      `Selected target ${target.id} is not the currently composited tab; refusing an unprovable screenshot`,
    );
  }
}

function assertTargetIdentity(identity, target, phase) {
  if (!identity || identity.href !== target.url) {
    throw new CaptureVerificationError(
      "screenshot_target_identity_changed",
      `${phase} document URL does not match selected target ${target.id}`,
    );
  }
}

function parsePngDimensions(bytes) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length < 24 ||
    !bytes.subarray(0, signature.length).equals(signature) ||
    bytes.toString("ascii", 12, 16) !== "IHDR"
  ) {
    throw new CaptureVerificationError(
      "invalid_screenshot_png",
      "CDP screenshot response was not a valid PNG with an IHDR header",
    );
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (!width || !height) {
    throw new CaptureVerificationError(
      "invalid_screenshot_dimensions",
      "CDP screenshot PNG has invalid dimensions",
    );
  }
  return { width, height };
}

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}

function pngTextChunk(keyword, value) {
  const type = Buffer.from("tEXt", "ascii");
  const data = Buffer.from(`${keyword}\0${value}`, "latin1");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([length, type, data, checksum]);
}

function embedPngTargetIdentity(bytes, target) {
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const dataLength = bytes.readUInt32BE(offset);
    const chunkEnd = offset + 12 + dataLength;
    if (chunkEnd > bytes.length) break;
    const chunkType = bytes.toString("ascii", offset + 4, offset + 8);
    if (chunkType === "IEND") {
      return Buffer.concat([
        bytes.subarray(0, offset),
        pngTextChunk("C3TargetId", target.id),
        pngTextChunk("C3TargetUrl", target.url),
        bytes.subarray(offset),
      ]);
    }
    offset = chunkEnd;
  }
  throw new CaptureVerificationError(
    "invalid_screenshot_png",
    "CDP screenshot PNG has no valid IEND chunk for target metadata",
  );
}

async function captureVerifiedScreenshot({
  client,
  target,
  listTargets,
  timeoutMs = 60000,
}) {
  const preCaptureIdentity = await client.evaluate(targetIdentityScript());
  assertStableTargetIdentity(preCaptureIdentity, target, "Pre-capture");

  const screenshot = await client.send(
    "Page.captureScreenshot",
    {
      format: "png",
      fromSurface: false,
      captureBeyondViewport: false,
    },
    timeoutMs,
    "verified independent final UI screenshot",
  );
  const screenshotBytes = Buffer.from(screenshot?.data || "", "base64");
  const png = parsePngDimensions(screenshotBytes);

  const postCaptureIdentity = await client.evaluate(targetIdentityScript());
  assertStableTargetIdentity(postCaptureIdentity, target, "Post-capture");
  if (postCaptureIdentity.title !== preCaptureIdentity.title) {
    throw new CaptureVerificationError(
      "screenshot_target_identity_changed",
      `Selected target ${target.id} changed title during screenshot capture`,
    );
  }

  const currentTargets = await listTargets();
  const currentTarget = currentTargets.find((item) => item.id === target.id);
  if (!currentTarget || currentTarget.url !== target.url) {
    throw new CaptureVerificationError(
      "screenshot_target_identity_changed",
      `Selected target ${target.id} changed or disappeared during screenshot capture`,
    );
  }
  const bytes = embedPngTargetIdentity(screenshotBytes, target);

  return {
    bytes,
    proof: {
      verified: true,
      method: "visible_target_identity_stable_non_surface_capture",
      selectedTargetId: target.id,
      selectedTargetUrl: target.url,
      preCaptureIdentity,
      postCaptureIdentity,
      png: {
        ...png,
        embeddedTargetId: target.id,
        embeddedTargetUrl: target.url,
      },
    },
  };
}

function resolvePdftoppmExecutable() {
  const candidates = [
    process.env.C3_PDFTOPPM,
    path.join(
      os.homedir(),
      ".cache",
      "codex-runtimes",
      "codex-primary-runtime",
      "dependencies",
      "native",
      "poppler",
      "Library",
      "bin",
      "pdftoppm.exe",
    ),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || "pdftoppm";
}

async function renderPdfToPngWithPoppler(pdfBytes) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "c3-print-render-"));
  const pdfPath = path.join(tempDir, "target.pdf");
  const outputPrefix = path.join(tempDir, "target");
  const pngPath = `${outputPrefix}.png`;
  try {
    fs.writeFileSync(pdfPath, pdfBytes);
    const result = spawnSync(
      resolvePdftoppmExecutable(),
      ["-png", "-singlefile", "-r", "150", pdfPath, outputPrefix],
      {
        encoding: "utf8",
        timeout: 60000,
        windowsHide: true,
      },
    );
    if (result.error || result.status !== 0 || !fs.existsSync(pngPath)) {
      throw new CaptureVerificationError(
        "print_render_failed",
        `Poppler failed to render target PDF: ${
          result.error?.message || result.stderr?.trim() || `exit ${result.status}`
        }`,
      );
    }
    return fs.readFileSync(pngPath);
  } finally {
    for (const filePath of [pngPath, pdfPath]) {
      try {
        fs.unlinkSync(filePath);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    try {
      fs.rmdirSync(tempDir);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

async function captureTargetPrintRender({
  client,
  target,
  listTargets,
  renderPdfToPng = renderPdfToPngWithPoppler,
  timeoutMs = 60000,
}) {
  const preCaptureIdentity = await client.evaluate(targetIdentityScript());
  assertTargetIdentity(preCaptureIdentity, target, "Pre-print");

  const printed = await client.send(
    "Page.printToPDF",
    {
      printBackground: true,
      preferCSSPageSize: true,
      transferMode: "ReturnAsBase64",
    },
    timeoutMs,
    "target-scoped independent final UI print render",
  );
  const pdfBytes = Buffer.from(printed?.data || "", "base64");
  if (!pdfBytes.subarray(0, 5).equals(Buffer.from("%PDF-", "ascii"))) {
    throw new CaptureVerificationError(
      "invalid_print_pdf",
      "CDP print response was not a valid PDF",
    );
  }

  const postCaptureIdentity = await client.evaluate(targetIdentityScript());
  assertTargetIdentity(postCaptureIdentity, target, "Post-print");
  if (postCaptureIdentity.title !== preCaptureIdentity.title) {
    throw new CaptureVerificationError(
      "screenshot_target_identity_changed",
      `Selected target ${target.id} changed title during print capture`,
    );
  }
  const currentTargets = await listTargets();
  const currentTarget = currentTargets.find((item) => item.id === target.id);
  if (!currentTarget || currentTarget.url !== target.url) {
    throw new CaptureVerificationError(
      "screenshot_target_identity_changed",
      `Selected target ${target.id} changed or disappeared during print capture`,
    );
  }

  const renderedBytes = await renderPdfToPng(pdfBytes);
  const png = parsePngDimensions(renderedBytes);
  const bytes = embedPngTargetIdentity(renderedBytes, target);
  return {
    bytes,
    pdfBytes,
    proof: {
      verified: true,
      method: "target_scoped_print_render",
      renderingSemantics: "print_layout_not_viewport_screenshot",
      selectedTargetId: target.id,
      selectedTargetUrl: target.url,
      preCaptureIdentity,
      postCaptureIdentity,
      png: {
        ...png,
        embeddedTargetId: target.id,
        embeddedTargetUrl: target.url,
      },
    },
  };
}

async function captureTargetVisual({
  client,
  target,
  listTargets,
  renderPdfToPng = renderPdfToPngWithPoppler,
}) {
  try {
    return await captureVerifiedScreenshot({
      client,
      target,
      listTargets,
      timeoutMs: 15000,
    });
  } catch (error) {
    if (error.code === "screenshot_target_identity_changed") throw error;
    return captureTargetPrintRender({
      client,
      target,
      listTargets,
      renderPdfToPng,
    });
  }
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function buildCaptureManifest({
  port,
  target,
  selectionPolicy,
  outputs,
  screenshotProof = null,
  rejection = null,
}) {
  const manifestOutputs = {};
  for (const [kind, output] of Object.entries(outputs || {})) {
    if (!output?.bytes) continue;
    manifestOutputs[kind] = {
      path: output.path,
      bytes: output.bytes.length,
      sha256: sha256(output.bytes),
      target_id: target.id,
      target_url: target.url,
    };
  }
  return {
    version: 1,
    captured_at: new Date().toISOString(),
    port,
    target: {
      id: target.id,
      url: target.url,
      title: target.title || "",
    },
    selection_policy: selectionPolicy,
    status: rejection ? "rejected" : "verified",
    screenshot: rejection
      ? {
          verified: false,
          rejection,
        }
      : screenshotProof,
    outputs: manifestOutputs,
  };
}

function writeJson(filePath, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.writeFileSync(filePath, bytes);
  return bytes;
}

function isCaptureErrorCandidate({
  text = "",
  role = "",
  liveRegion = false,
  linkedFileControl = false,
  ariaInvalid = false,
  automationId = "",
  id = "",
} = {}) {
  const message = String(text || "").replace(/\s+/g, " ").trim();
  if (!message) return false;
  const positiveUpload =
    /\b(successfully uploaded|uploaded successfully|upload complete(?:d)?|upload succeeded)\b/i.test(
      message,
    ) &&
    !/\b(error|failed|failure|invalid|could not|unable|unsuccessful|not\s+(?:successfully\s+)?uploaded)\b/i.test(
      message,
    );
  if (positiveUpload) return false;

  const failureLanguage =
    /\b(error|required|failed|failure|invalid|incorrect|wrong|locked|could not|unable|not\s+(?:successfully\s+)?uploaded|unsupported|too large|exceeds|corrupt|rejected|must (?:enter|select|provide|have)|please (?:enter|select|provide|correct)|not valid|cannot be blank|can't be blank)\b/i.test(
      message,
    );
  const normalizedRole = String(role || "").toLowerCase();
  const errorNamed = /error/i.test(`${automationId || ""} ${id || ""}`);
  return Boolean(
    ariaInvalid ||
      errorNamed ||
      failureLanguage ||
      normalizedRole === "alert",
  );
}

async function capturePort(
  port,
  outDir,
  {
    targetId = "",
    suffix = "",
    listTargets = () => httpJson(port, "/json/list"),
    connectClient = (target) => new CdpClient(target.webSocketDebuggerUrl).connect(),
  } = {},
) {
  const targets = await listTargets();
  const target = targetId
    ? targets.find((item) => item.type === "page" && item.id === targetId)
    : targets.find((item) => item.type === "page" && /myworkdayjobs\.com/i.test(item.url || "")) ||
      targets.find((item) => item.type === "page");
  if (!target?.webSocketDebuggerUrl) {
    throw new CaptureVerificationError(
      targetId ? "pinned_target_not_found" : "page_target_not_found",
      targetId
        ? `Pinned page target ${targetId} was not found on port ${port}`
        : `No page target found for port ${port}`,
    );
  }
  const selectionPolicy = targetId ? "explicit_target_id" : "workday_page_fallback";

  const client = await connectClient(target);
  try {
    const snapshot = await client.evaluate(`(() => {
      const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const isCaptureErrorCandidate = ${isCaptureErrorCandidate.toString()};
      const normalizeSubmitText = (value) => {
        const parts = normalize(value).split(" ").filter(Boolean);
        return parts.filter((part, index) => index === 0 || part.toLowerCase() !== parts[index - 1].toLowerCase()).join(" ");
      };
      const stepNode = document.querySelector('[data-automation-id="progressBarActiveStep"]');
      const bodyText = document.body?.innerText || "";
      const stepMatch = bodyText.match(/current\\s+step\\s+(\\d+)\\s+of\\s+(\\d+)\\s*\\n([^\\n]+)/i);
      const errors = Array.from(document.querySelectorAll(
        '[role="alert"], [role="status"], [aria-live], [aria-invalid="true"], [data-automation-id*="error"], [id*="error"]'
      ))
        .map((node) => {
          const text = normalize(node.innerText || node.textContent);
          const linkedFileControl = Boolean(
            node.id &&
            Array.from(document.querySelectorAll('input[type="file"][aria-describedby]'))
              .some((control) => String(control.getAttribute("aria-describedby") || "")
                .split(/\\s+/)
                .includes(node.id))
          );
          return {
            text,
            role: node.getAttribute("role") || "",
            liveRegion: Boolean(node.getAttribute("aria-live")),
            linkedFileControl,
            ariaInvalid: node.getAttribute("aria-invalid") === "true",
            automationId: node.getAttribute("data-automation-id") || "",
            id: node.id || ""
          };
        })
        .filter((candidate) => isCaptureErrorCandidate(candidate))
        .map((candidate) => candidate.text);
      const buttons = Array.from(document.querySelectorAll('button'))
        .map((button) => normalize([button.innerText, button.textContent, button.getAttribute('aria-label')].filter(Boolean).join(' ')))
        .filter(Boolean)
        .slice(0, 80);
      const labels = Array.from(document.querySelectorAll('label, [data-automation-id="formLabel"], [data-automation-id="promptOption"], [data-automation-id="selectedItem"]'))
        .map((node) => normalize([node.innerText, node.textContent, node.getAttribute('aria-label')].filter(Boolean).join(' ')))
        .filter(Boolean)
        .slice(0, 220);
      return {
        href: location.href,
        title: document.title,
        visibilityState: document.visibilityState,
        step: stepMatch ? {
          current: Number(stepMatch[1]),
          total: Number(stepMatch[2]),
          title: normalize(stepMatch[3])
        } : {
          text: normalize(stepNode?.innerText || stepNode?.textContent || "")
        },
        hasSubmit: buttons.some((text) => /^submit$/i.test(normalizeSubmitText(text))),
        hasNext: buttons.some((text) => /^next$/i.test(text)),
        errors,
        buttons,
        labels,
        bodyText
      };
    })()`);
    const slug = slugForTarget(target, port);
    const stem = `${slug}${suffix ? `.${suffix}` : ""}.final_ui`;
    const jsonPath = path.join(outDir, `${stem}.json`);
    const textPath = path.join(outDir, `${stem}.txt`);
    const screenshotPath = path.join(outDir, `${stem}.png`);
    const pdfPath = path.join(outDir, `${stem}.pdf`);
    const manifestPath = path.join(outDir, `${stem}.manifest.json`);
    const jsonBytes = writeJson(jsonPath, {
      port,
      target,
      target_identity: {
        id: target.id,
        url: target.url,
        selection_policy: selectionPolicy,
      },
      snapshot,
    });
    const textBytes = Buffer.from(
      [
        `C3_CAPTURE_TARGET_ID: ${target.id}`,
        `C3_CAPTURE_TARGET_URL: ${target.url}`,
        `C3_CAPTURE_SELECTION_POLICY: ${selectionPolicy}`,
        "",
        snapshot.bodyText || "",
      ].join("\n"),
      "utf8",
    );
    fs.writeFileSync(textPath, textBytes);

    let screenshotResult;
    try {
      screenshotResult = await captureTargetVisual({
        client,
        target,
        listTargets,
      });
    } catch (error) {
      const rejection = {
        code: error.code || "screenshot_verification_failed",
        message: error.message,
      };
      writeJson(
        manifestPath,
        buildCaptureManifest({
          port,
          target,
          selectionPolicy,
          outputs: {
            json: { path: jsonPath, bytes: jsonBytes },
            text: { path: textPath, bytes: textBytes },
          },
          rejection,
        }),
      );
      throw error;
    }
    fs.writeFileSync(screenshotPath, screenshotResult.bytes);
    if (screenshotResult.pdfBytes) {
      fs.writeFileSync(pdfPath, screenshotResult.pdfBytes);
    }
    const manifest = buildCaptureManifest({
      port,
      target,
      selectionPolicy,
      outputs: {
        json: { path: jsonPath, bytes: jsonBytes },
        text: { path: textPath, bytes: textBytes },
        png: { path: screenshotPath, bytes: screenshotResult.bytes },
        ...(screenshotResult.pdfBytes
          ? { pdf: { path: pdfPath, bytes: screenshotResult.pdfBytes } }
          : {}),
      },
      screenshotProof: screenshotResult.proof,
    });
    writeJson(manifestPath, manifest);
    return {
      slug,
      port,
      targetId: target.id,
      targetUrl: target.url,
      href: snapshot.href,
      title: snapshot.title,
      step: snapshot.step,
      hasSubmit: snapshot.hasSubmit,
      hasNext: snapshot.hasNext,
      errorCount: snapshot.errors.length,
      screenshot: screenshotPath,
      printPdf: screenshotResult.pdfBytes ? pdfPath : "",
      screenshotVerified: true,
      manifest: manifestPath,
    };
  } finally {
    client.close();
  }
}

async function main() {
  const args = parseArgs(process.argv);
  fs.mkdirSync(args.outDir, { recursive: true });
  const results = [];
  for (const port of args.ports) {
    results.push(
      await capturePort(port, args.outDir, {
        targetId: args.targetIds.get(port) || "",
        suffix: args.suffix,
      }),
    );
  }
  console.log(JSON.stringify(results, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}

module.exports = {
  CaptureVerificationError,
  buildCaptureManifest,
  capturePort,
  captureTargetPrintRender,
  captureTargetVisual,
  captureVerifiedScreenshot,
  isCaptureErrorCandidate,
  main,
  parseArgs,
  parsePngDimensions,
  embedPngTargetIdentity,
  renderPdfToPngWithPoppler,
};
