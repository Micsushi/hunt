import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  componentBoundaries,
  type ComponentBoundary,
} from "../../src/contracts/ownership.ts";
import {
  contractDeltaDecisions,
  requiredControlFlowCases,
  requiredExecutionFlowCases,
  requiredFieldFlowCases,
} from "../../src/testing/contracts/field-flow-cases.ts";

function documentedDeltaDecisions(markdown: string) {
  const normalized = markdown.replace(/\r\n?/g, "\n");
  const section = normalized
    .split("## Contract delta classification\n", 2)[1]
    ?.split("\n## ", 1)[0];
  assert.ok(section, "missing contract delta classification section");

  return [...section.matchAll(/^\| `([^`]+)` \| `([^`]+)` \| (.+) \|$/gm)].map(
    ([, id, classification, decision]) => ({ id, classification, decision }),
  );
}

test("T5 classifications agree with the accepted R2.n port surface", () => {
  const ports = (componentBoundaries as readonly ComponentBoundary[]).flatMap(
    (component) => component.ports,
  );
  const requests = ports.flatMap((port) => port.requests);

  assert.equal(ports.some((port) => port.name === "ModelController"), false);
  assert.equal(requests.includes("FixtureTransitionRequest"), false);
});

test("canonical fields publish exact visible labels and structured options", () => {
  assert.deepEqual(
    requiredFieldFlowCases.map(
      ({ fieldId, fieldLabel, questionId, questionLabel, options }) => ({
        fieldId,
        fieldLabel,
        questionId,
        questionLabel,
        options,
      }),
    ),
    [
      {
        fieldId: "s1-field-given-name",
        fieldLabel: "Given name",
        questionId: "s1-question-given-name",
        questionLabel: "Given name",
        options: [],
      },
      {
        fieldId: "s1-field-family-name",
        fieldLabel: "Family name",
        questionId: "s1-question-family-name",
        questionLabel: "Family name",
        options: [],
      },
      {
        fieldId: "s1-field-phone-number",
        fieldLabel: "Phone number",
        questionId: "s1-question-phone-number",
        questionLabel: "Phone number",
        options: [],
      },
      {
        fieldId: "s1-field-interest",
        fieldLabel: "Brief interest statement",
        questionId: "s1-question-configured-narrative",
        questionLabel: "Why are you interested in this role?",
        options: [],
      },
      {
        fieldId: "s1-field-work-authorization",
        fieldLabel: "Are you authorized to work in this location?",
        questionId: "s1-question-work-authorization",
        questionLabel: "Are you authorized to work in this location?",
        options: [
          {
            id: "s1-option-work-authorization-yes",
            label: "Yes",
            value: "yes",
          },
          {
            id: "s1-option-work-authorization-no",
            label: "No",
            value: "no",
          },
        ],
      },
      {
        fieldId: "s1-field-age-requirement",
        fieldLabel: "I am at least 18 years of age.",
        questionId: "s1-question-age-requirement-met",
        questionLabel: "Are you at least 18 years of age?",
        options: [],
      },
      {
        fieldId: "s1-field-sponsorship",
        fieldLabel: "Will you require sponsorship?",
        questionId: "s1-question-sponsorship-required",
        questionLabel: "Will you require sponsorship?",
        options: [
          { id: "s1-option-sponsorship-yes", label: "Yes", value: "yes" },
          { id: "s1-option-sponsorship-no", label: "No", value: "no" },
        ],
      },
      {
        fieldId: "s1-field-country",
        fieldLabel: "Country",
        questionId: "s1-question-country",
        questionLabel: "Country",
        options: [
          {
            id: "s1-option-country-us",
            label: "United States",
            value: "US",
          },
          {
            id: "s1-option-country-ca",
            label: "Canada",
            value: "CA",
          },
        ],
      },
      {
        fieldId: "s1-field-start-date",
        fieldLabel: "Available start date",
        questionId: "s1-question-earliest-start-date",
        questionLabel: "Available start date",
        options: [],
      },
      {
        fieldId: "s1-field-resume",
        fieldLabel: "Resume",
        questionId: "s1-question-resume",
        questionLabel: "Resume",
        options: [],
      },
    ],
  );
});

test("every required fixture control has one complete owner chain", () => {
  const cases = requiredFieldFlowCases;
  assert.deepEqual(
    [...new Set(cases.map(({ behavior }) => behavior))].sort(),
    [
      "checkbox",
      "date",
      "file_upload",
      "listbox",
      "radio",
      "select",
      "text",
      "textarea",
    ],
  );
  assert.deepEqual(
    cases.map(({ fieldId }) => fieldId).sort(),
    [
      "s1-field-age-requirement",
      "s1-field-country",
      "s1-field-family-name",
      "s1-field-given-name",
      "s1-field-interest",
      "s1-field-phone-number",
      "s1-field-resume",
      "s1-field-sponsorship",
      "s1-field-start-date",
      "s1-field-work-authorization",
    ],
  );

  const exactOwnerColumns = [
    "producer",
    "consumer",
    "sideEffectOwner",
    "verifier",
    "eventOwner",
    "failureOwner",
  ] as const;
  for (const flowCase of cases) {
    for (const column of exactOwnerColumns) {
      assert.match(String(flowCase[column] ?? ""), /^F(?:[2-9]|10|11)$/);
    }
    assert.match(String(flowCase.fieldId ?? ""), /^s1-field-/);
    assert.match(String(flowCase.questionId ?? ""), /^s1-question-/);
    assert.notEqual(flowCase.htmlControl, "unsupported");
    assert.notEqual(flowCase.browserObservation, "unsupported");
    assert.notEqual(flowCase.mutation, "unsupported");
    assert.notEqual(flowCase.readback, "unsupported");
  }

  assert.equal(new Set(cases.map(({ fieldId }) => fieldId)).size, cases.length);
  assert.equal(
    new Set(cases.map(({ questionId }) => questionId)).size,
    cases.length,
  );
  assert.deepEqual(
    cases.map(
      ({
        fieldId,
        behavior,
        htmlControl,
        browserObservation,
        answerSource,
        mutation,
        readback,
        producer,
        consumer,
        semanticOwner,
        answerOwner,
        dispatcher,
        sideEffectOwner,
        verifier,
        eventOwner,
        failureOwner,
      }) => ({
        fieldId,
        behavior,
        htmlControl,
        browserObservation,
        answerSource,
        mutation,
        readback,
        producer,
        consumer,
        semanticOwner,
        answerOwner,
        dispatcher,
        sideEffectOwner,
        verifier,
        eventOwner,
        failureOwner,
      }),
    ),
    [
      ["s1-field-given-name", "text", "input[type=text]", "textbox value", "profile.given_name", "type text", "textbox value"],
      ["s1-field-family-name", "text", "input[type=text]", "textbox value", "profile.family_name", "type text", "textbox value"],
      ["s1-field-phone-number", "text", "input[type=tel]", "textbox value", "profile.phone_number", "type text", "textbox value"],
      ["s1-field-interest", "textarea", "textarea", "textarea value", "profile.configured_narrative", "type textarea", "textarea value"],
      ["s1-field-work-authorization", "radio", "fieldset input[type=radio]", "radio group options and selected option", "profile.work_authorization", "select one grouped radio option", "selected radio option"],
      ["s1-field-age-requirement", "checkbox", "input[type=checkbox]", "checkbox checked state", "profile.age_requirement_met", "set checked state", "checkbox checked state"],
      ["s1-field-sponsorship", "select", "select", "select options and selected option", "profile.sponsorship_required", "select native option", "selected native option"],
      ["s1-field-country", "listbox", "[role=listbox]", "listbox options and selected option", "profile.country", "select listbox option", "selected listbox option"],
      ["s1-field-start-date", "date", "input[type=date]", "date value", "profile.earliest_start_date", "set ISO date", "date value"],
      ["s1-field-resume", "file_upload", "input[type=file]", "file input state", "resolved resume artifact", "upload verified artifact copy", "uploaded artifact digest"],
    ].map(
      ([fieldId, behavior, htmlControl, browserObservation, answerSource, mutation, readback]) => ({
        fieldId,
        behavior,
        htmlControl,
        browserObservation,
        answerSource,
        mutation,
        readback,
        producer: "F2",
        consumer: "F9",
        semanticOwner: "F5",
        answerOwner: "F6",
        dispatcher: "F7",
        sideEffectOwner: "F3",
        verifier: "F8",
        eventOwner: "F9",
        failureOwner: "F10",
      }),
    ),
  );
});

test("the control slice lists each retained R2.n F9/F4/F10/F11 port once", () => {
  const cases = requiredControlFlowCases;
  const names = cases.map(({ port }) => port);
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual(names.sort(), [
    "EventSink",
    "EvidenceStore",
    "FailureReporter",
    "JourneyControl",
    "JourneyIntake",
    "JourneyStateStore",
    "McpJourneyApi",
    "PrivacyGuard",
    "ProfileQuery",
    "ProgressReader",
    "SafetyGuard",
  ]);
  const livePorts = componentBoundaries
    .filter(({ feature }) => ["F4", "F9", "F10", "F11"].includes(feature))
    .flatMap(({ ports }) => ports.map(({ name }) => name))
    .sort();
  assert.deepEqual(names, livePorts);
  assert.deepEqual(cases, [
    { port: "McpJourneyApi", provider: "F9 MCP Facade", consumers: ["External MCP Client"], sideEffectOwner: "F9", verifier: "F9", eventOwner: "F9", failureOwner: "F10" },
    { port: "JourneyControl", provider: "F9 Orchestrator", consumers: ["F9 MCP Facade"], sideEffectOwner: "F9", verifier: "F9", eventOwner: "F9", failureOwner: "F10" },
    { port: "JourneyIntake", provider: "F4 Intake", consumers: ["F9 Orchestrator"], sideEffectOwner: "F4", verifier: "F4", eventOwner: "F9", failureOwner: "F10" },
    { port: "JourneyStateStore", provider: "F4 Journey State", consumers: ["F9 Orchestrator"], sideEffectOwner: "F4", verifier: "F4", eventOwner: "F9", failureOwner: "F10" },
    { port: "ProfileQuery", provider: "F4 Profile", consumers: ["F6 Answer Resolver"], sideEffectOwner: "F4", verifier: "F4", eventOwner: "F9", failureOwner: "F10" },
    { port: "EventSink", provider: "F10 Observability", consumers: ["F9 Orchestrator"], sideEffectOwner: "F10", verifier: "F10", eventOwner: "F9", failureOwner: "F10" },
    { port: "ProgressReader", provider: "F10 Observability", consumers: ["F9 MCP Facade"], sideEffectOwner: "F10", verifier: "F10", eventOwner: "F9", failureOwner: "F10" },
    { port: "FailureReporter", provider: "F10 Failure Reporter", consumers: ["F9 Orchestrator"], sideEffectOwner: "F10", verifier: "F10", eventOwner: "F9", failureOwner: "F10" },
    { port: "PrivacyGuard", provider: "F11 Privacy Guard", consumers: ["F9 MCP Facade"], sideEffectOwner: "F11", verifier: "F11", eventOwner: "F9", failureOwner: "F10" },
    { port: "SafetyGuard", provider: "F11 Safety Guard", consumers: ["F9 Orchestrator"], sideEffectOwner: "F11", verifier: "F11", eventOwner: "F9", failureOwner: "F10" },
    { port: "EvidenceStore", provider: "F11 Evidence Store", consumers: ["F9 Orchestrator", "F10 Failure Reporter"], sideEffectOwner: "F11", verifier: "F11", eventOwner: "F9", failureOwner: "F10" },
  ]);
  for (const { consumers } of cases) {
    assert.ok(Array.isArray(consumers) && consumers.length > 0);
  }
});

test("every executable control step has one exact owner chain", () => {
  const cases = requiredExecutionFlowCases;
  assert.deepEqual(cases, [
    { step: "mcp_start", producer: "External MCP Client", consumer: "F9", sideEffectOwner: "F9", verifier: "F9", eventOwner: "F9", failureOwner: "F10" },
    { step: "fixture_start", producer: "F13", consumer: "F2", sideEffectOwner: "F2", verifier: "F2", eventOwner: "F9", failureOwner: "F10" },
    { step: "fixture_reset", producer: "F13", consumer: "F2", sideEffectOwner: "F2", verifier: "F2", eventOwner: "F9", failureOwner: "F10" },
    { step: "fixture_close", producer: "F13", consumer: "F2", sideEffectOwner: "F2", verifier: "F2", eventOwner: "F9", failureOwner: "F10" },
    { step: "intake", producer: "F4", consumer: "F9", sideEffectOwner: "F4", verifier: "F4", eventOwner: "F9", failureOwner: "F10" },
    { step: "resume", producer: "F4", consumer: "F9", sideEffectOwner: "F4", verifier: "F4", eventOwner: "F9", failureOwner: "F10" },
    { step: "profile", producer: "F4", consumer: "F6", sideEffectOwner: "F4", verifier: "F4", eventOwner: "F9", failureOwner: "F10" },
    { step: "observation", producer: "F3", consumer: "F5", sideEffectOwner: "F3", verifier: "F5", eventOwner: "F9", failureOwner: "F10" },
    { step: "semantic_meaning", producer: "F5", consumer: "F9", sideEffectOwner: "F5", verifier: "F5", eventOwner: "F9", failureOwner: "F10" },
    { step: "answer", producer: "F6", consumer: "F9", sideEffectOwner: "F6", verifier: "F6", eventOwner: "F9", failureOwner: "F10" },
    { step: "mutation", producer: "F7", consumer: "F3", sideEffectOwner: "F3", verifier: "F8", eventOwner: "F9", failureOwner: "F10" },
    { step: "readback", producer: "F3", consumer: "F8", sideEffectOwner: "F3", verifier: "F8", eventOwner: "F9", failureOwner: "F10" },
    { step: "navigation", producer: "F8", consumer: "F3", sideEffectOwner: "F3", verifier: "F8", eventOwner: "F9", failureOwner: "F10" },
    { step: "journey_state", producer: "F9", consumer: "F4", sideEffectOwner: "F4", verifier: "F4", eventOwner: "F9", failureOwner: "F10" },
    { step: "events", producer: "F9", consumer: "F10", sideEffectOwner: "F10", verifier: "F10", eventOwner: "F9", failureOwner: "F10" },
    { step: "failure", producer: "F9", consumer: "F10", sideEffectOwner: "F10", verifier: "F10", eventOwner: "F9", failureOwner: "F10" },
    { step: "privacy", producer: "F9", consumer: "F11", sideEffectOwner: "F11", verifier: "F11", eventOwner: "F9", failureOwner: "F10" },
    { step: "evidence", producer: "F9", consumer: "F11", sideEffectOwner: "F11", verifier: "F11", eventOwner: "F9", failureOwner: "F10" },
    { step: "terminal_result", producer: "F9", consumer: "External MCP Client", sideEffectOwner: "F9", verifier: "F9", eventOwner: "F9", failureOwner: "F10" },
  ]);

  const steps = cases.map(({ step }) => step);
  assert.equal(new Set(steps).size, steps.length);
});

test("every proposed delta is classified under the approved authority rule", () => {
  const decisions = contractDeltaDecisions;
  assert.deepEqual(
    [...new Set(decisions.map(({ classification }) => classification))].sort(),
    ["owner_decision", "rejected_prototype_invention", "requirement"],
  );
  assert.equal(
    new Set(decisions.map(({ id }) => id)).size,
    decisions.length,
  );
  assert.deepEqual(
    decisions.map(({ id, classification }) => ({ id, classification })),
    [
      { id: "structural-browser-controls", classification: "requirement" },
      { id: "verified-resume-artifact", classification: "requirement" },
      { id: "closed-provider-failures", classification: "requirement" },
      { id: "immutable-admission", classification: "requirement" },
      { id: "stateful-conformance", classification: "requirement" },
      { id: "bounded-identity-classes", classification: "owner_decision" },
      { id: "request-lifecycle", classification: "owner_decision" },
      { id: "event-ownership", classification: "owner_decision" },
      { id: "model-controller-deferred", classification: "owner_decision" },
      { id: "fixture-browser-navigation", classification: "owner_decision" },
      { id: "acceptance-provider-fault-wrapper", classification: "owner_decision" },
      { id: "same-process-state-reload", classification: "owner_decision" },
      { id: "fixture-transition-port", classification: "rejected_prototype_invention" },
      { id: "fixture-provider-fault-wrapper", classification: "rejected_prototype_invention" },
      { id: "derived-personal-identifiers", classification: "rejected_prototype_invention" },
    ],
  );
  for (const { decision } of decisions) {
    assert.match(String(decision ?? ""), /\S/);
  }
});

test("the human delta table exactly mirrors executable classifications", () => {
  const markdown = readFileSync(
    new URL("../../docs/s1-field-flow.md", import.meta.url),
    "utf8",
  );
  for (const content of [markdown, markdown.replace(/\r?\n/g, "\r\n")]) {
    assert.deepEqual(documentedDeltaDecisions(content), contractDeltaDecisions);
  }
});
