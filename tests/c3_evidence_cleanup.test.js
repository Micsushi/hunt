"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const BACKGROUND_PATH = path.join(
  __dirname,
  "..",
  "executioner",
  "src",
  "background",
  "index.js",
);
const BACKGROUND_SOURCE = fs.readFileSync(BACKGROUND_PATH, "utf8");

function extractBetween(startMarker, endMarker, fromIndex = 0) {
  const start = BACKGROUND_SOURCE.indexOf(startMarker, fromIndex);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  const end = BACKGROUND_SOURCE.indexOf(endMarker, start);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return BACKGROUND_SOURCE.slice(start, end);
}

function makeElement({
  tagName = "input",
  type = "text",
  value = "",
  attributes = {},
  auth = false,
  honeypot = false,
  required = false,
  text = "",
} = {}) {
  const normalizedAttributes = new Map(
    Object.entries(attributes).map(([key, attributeValue]) => [
      key.toLowerCase(),
      String(attributeValue),
    ]),
  );
  if (type) {
    normalizedAttributes.set("type", type);
  }
  const authForm = auth
    ? {
        getAttribute(name) {
          return name === "data-automation-id" ? "signInFormo" : null;
        },
      }
    : null;
  return {
    tagName: tagName.toUpperCase(),
    type,
    value,
    required,
    disabled: false,
    readOnly: false,
    checked: false,
    options: tagName.toLowerCase() === "select" ? [] : undefined,
    id: normalizedAttributes.get("id") || "",
    name: normalizedAttributes.get("name") || "",
    className: normalizedAttributes.get("class") || "",
    innerText: text,
    textContent: text,
    getAttribute(name) {
      return normalizedAttributes.get(String(name).toLowerCase()) ?? null;
    },
    getBoundingClientRect() {
      return { width: 240, height: 36 };
    },
    closest(selector) {
      if (selector === "label") {
        return null;
      }
      if (
        auth &&
        /signInFormo|signIn|createAccount/.test(String(selector))
      ) {
        return authForm;
      }
      if (honeypot && /noCaptchaWrapper/.test(String(selector))) {
        return this;
      }
      return null;
    },
  };
}

function makeDom({
  controls,
  href,
  bodyText,
  title,
  activeStepTitle = "",
}) {
  const url = new URL(href);
  const root = { childElementCount: 1 };
  const activeStep = activeStepTitle
    ? {
        innerText: activeStepTitle,
        textContent: activeStepTitle,
        querySelectorAll(selector) {
          return selector === "label"
            ? [{ innerText: activeStepTitle, textContent: activeStepTitle }]
            : [];
        },
      }
    : null;
  const document = {
    body: { innerText: bodyText },
    title,
    readyState: "complete",
    querySelector(selector) {
      if (selector === "#root") {
        return root;
      }
      if (selector === '[data-automation-id="progressBarActiveStep"]') {
        return activeStep;
      }
      if (/signInFormo|signInSubmitButton/.test(selector)) {
        return controls.some((control) => control.closest(selector))
          ? {}
          : null;
      }
      return null;
    },
    querySelectorAll(selector) {
      if (
        selector.includes("input") &&
        (selector.includes("textarea") || selector.includes("[role='combobox']"))
      ) {
        return controls;
      }
      if (selector === '[data-automation-id^="progressBar"]') {
        return activeStep ? [activeStep] : [];
      }
      return [];
    },
    getElementById() {
      return null;
    },
  };
  const getComputedStyle = () => ({
    display: "block",
    visibility: "visible",
    pointerEvents: "auto",
    opacity: "1",
  });
  return {
    document,
    location: {
      href,
      hostname: url.hostname,
      pathname: url.pathname,
    },
    window: { getComputedStyle },
    getComputedStyle,
    CSS: { escape: (value) => value },
  };
}

function runReadinessProbe(dom) {
  const ownerStart = BACKGROUND_SOURCE.indexOf(
    "async function inspectApplicationFieldReadiness",
  );
  const marker = "func: () => {";
  const functionStart =
    BACKGROUND_SOURCE.indexOf(marker, ownerStart) + "func: ".length;
  assert.ok(functionStart >= "func: ".length, "missing readiness probe");
  const functionEndMarker = "\n        },\n      }),";
  const functionEnd = BACKGROUND_SOURCE.indexOf(
    functionEndMarker,
    functionStart,
  );
  assert.notEqual(functionEnd, -1, "missing readiness probe terminator");
  const functionSource = BACKGROUND_SOURCE.slice(
    functionStart,
    functionEnd + "\n        }".length,
  );
  return vm.runInNewContext(`(${functionSource})()`, dom);
}

function runFieldInspection(dom) {
  const declaration = extractBetween(
    "function createFieldInspectionFunction()",
    "\nfunction chooseBestFieldInspection",
  );
  const inspect = vm.runInNewContext(
    `${declaration}\ncreateFieldInspectionFunction()`,
    dom,
  );
  return inspect();
}

test("auth controls and honeypots do not inflate applicationFieldCount", () => {
  const controls = [
    makeElement({
      type: "email",
      value: "candidate@example.com",
      attributes: { "aria-label": "Email Address" },
      auth: true,
    }),
    makeElement({
      type: "password",
      value: "secret",
      attributes: { "aria-label": "Password" },
      auth: true,
    }),
    makeElement({
      type: "checkbox",
      attributes: { "aria-label": "Remember me" },
      auth: true,
    }),
    makeElement({
      attributes: {
        name: "website",
        "data-automation-id": "beecatcher",
        "aria-label": "This input is for robots only",
      },
      honeypot: true,
    }),
  ];

  const readiness = runReadinessProbe(
    makeDom({
      controls,
      href: "https://tenant.wd5.myworkdayjobs.com/en-US/Tenant/login",
      bodyText:
        "Sign In Email Address Password This input is for robots only",
      title: "Sign In",
    }),
  );

  assert.equal(readiness.visibleControlCount, 4);
  assert.equal(readiness.applicationFieldCount, 0);
  assert.equal(readiness.meaningfulControlCount, 0);
  assert.equal(readiness.authFieldCount, 3);
});

test("actual application controls remain positive evidence", () => {
  const controls = [
    makeElement({
      value: "Avery",
      required: true,
      attributes: { "aria-label": "First Name" },
    }),
    makeElement({
      value: "Candidate",
      required: true,
      attributes: { "aria-label": "Last Name" },
    }),
    makeElement({
      type: "tel",
      attributes: { "aria-label": "Phone Number" },
    }),
  ];

  const readiness = runReadinessProbe(
    makeDom({
      controls,
      href:
        "https://tenant.wd5.myworkdayjobs.com/en-US/Tenant/job/123/apply/applyManually",
      bodyText: "Current Step 2 of 4 My Information",
      title: "My Information",
      activeStepTitle: "My Information",
    }),
  );

  assert.equal(readiness.applicationFieldCount, 3);
  assert.equal(readiness.requiredApplicationFieldCount, 2);
  assert.equal(readiness.authFieldCount, 0);
});

test("password inventory reports presence without inventing a zero length", () => {
  const controls = [
    makeElement({
      type: "password",
      value: "secret",
      attributes: { "aria-label": "Password" },
    }),
    makeElement({
      type: "email",
      value: "candidate@example.com",
      attributes: { "aria-label": "Email" },
    }),
  ];
  const inspection = runFieldInspection(
    makeDom({
      controls,
      href: "https://tenant.wd5.myworkdayjobs.com/en-US/Tenant/login",
      bodyText: "Sign In",
      title: "Sign In",
    }),
  );
  const password = inspection.fields.find((field) => field.type === "password");
  const email = inspection.fields.find((field) => field.type === "email");

  assert.equal(password.valuePresent, true);
  assert.equal(
    Object.prototype.hasOwnProperty.call(password, "valueLength"),
    false,
  );
  assert.equal(password.valueLengthState, "redacted");
  assert.equal(email.valueLength, "candidate@example.com".length);
  assert.equal(email.valueLengthState, "observed");
});

test("snapshot and compact runtime evidence preserve authFieldCount", () => {
  const compactProbe = extractBetween(
    "function compactWorkdayRuntimeProbe",
    "\nasync function waitForWorkdayRuntimeSurface",
  );
  const snapshotCase = extractBetween(
    'case "hunt.apply.snapshot_page":',
    '\n    case "hunt.apply.inspect_fields":',
  );

  assert.match(compactProbe, /authFieldCount/);
  assert.match(snapshotCase, /authFieldCount/);
});
