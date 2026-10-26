import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  boundedText,
  browserTargetToken,
  providerError,
  type BrowserObservation,
  type BrowserTargetObservation,
  type PageUnderstandingRequest,
} from "../../../../src/contracts/index.ts";
import { createWorkdayPageUnderstanding } from "../../../../src/ats/workday/page-understanding.ts";
import {
  assertProviderConformance,
  contractFixtures,
} from "../../../../src/testing/contracts/index.ts";
import { canonicalObservation } from "../../../golden/s1/understanding/canonical-observation.ts";

const provider = createWorkdayPageUnderstanding();

async function assertAmbiguousTarget(
  token: string,
  transform: (target: BrowserTargetObservation) => BrowserTargetObservation,
): Promise<void> {
  const input = canonicalObservation();
  let transformed = false;
  const targets = input.targets.map((target) => {
    if (target.token !== token) return target;
    transformed = true;
    return transform(target);
  });
  assert.equal(transformed, true);
  assert.deepEqual(await provider.understand({
    observation: { ...input, targets },
  }, new AbortController().signal), {
    ok: true,
    value: { kind: "ambiguous" },
  });
}

function observation(
  path: string,
  targets: BrowserObservation["targets"] = [],
): BrowserObservation {
  return {
    ...contractFixtures.browserObservation,
    origin: "https://fixture.invalid",
    path,
    targets,
  };
}

test("the real F5 provider conforms to the frozen R2 port", async () => {
  await assertProviderConformance("PageUnderstanding", provider);
});

test("unknown and ambiguous remain exact context-free success results", async () => {
  for (const [path, kind] of [
    ["/candidate-home", "unknown"],
    ["/profile/application-questions", "ambiguous"],
  ] as const) {
    const result = await provider.understand({
      observation: observation(path),
    }, new AbortController().signal);

    assert.deepEqual(result, { ok: true, value: { kind } });
    if (!result.ok) throw new Error("factual result must use the success channel");
    assert.deepEqual(Object.keys(result.value), ["kind"]);
  }
});

test("unsupported target evidence remains an explicit ambiguous success", async () => {
  assert.deepEqual(await provider.understand({
    observation: observation("/profile", [{
      ...contractFixtures.browserObservation.targets[0]!,
      token: browserTargetToken("target-private-applicant"),
    }]),
  }, new AbortController().signal), {
    ok: true,
    value: { kind: "ambiguous" },
  });
});

test("a selected value outside declared select options is ambiguous", async () => {
  await assertAmbiguousTarget("target-s1-field-sponsorship", (target) => ({
    ...target,
    readback: { kind: "selected", option: boundedText("Maybe") },
  }));
});

test("a selected value outside canonical radio options is ambiguous", async () => {
  await assertAmbiguousTarget("target-s1-field-work-authorization", (target) => ({
    ...target,
    readback: { kind: "selected", option: boundedText("Maybe") },
  }));
});

test("contradictory declared options and choice readbacks are ambiguous", async () => {
  const radio = "target-s1-field-work-authorization";
  await assertAmbiguousTarget("target-s1-field-country", (target) => ({
    ...target,
    readback: { kind: "selected", option: boundedText("Mexico") },
  }));
  await assertAmbiguousTarget("target-s1-field-sponsorship", (target) => {
    if (target.control.kind !== "select") throw new TypeError("expected select");
    return {
      ...target,
      control: {
        ...target.control,
        options: [boundedText("Yes"), boundedText("Maybe")],
      },
      readback: { kind: "selected", option: boundedText("Maybe") },
    };
  });
  await assertAmbiguousTarget("target-s1-field-age-requirement", (target) => ({
    ...target,
    readback: { kind: "checked", checked: false },
  }));
  await assertAmbiguousTarget(radio, (target) => ({
    ...target,
    readback: { kind: "checked", checked: false },
  }));
  await assertAmbiguousTarget(radio, (target) => ({
    ...target,
    readback: { kind: "selected", option: null },
  }));
  await assertAmbiguousTarget(radio, (target) => {
    if (target.control.kind !== "choice") throw new TypeError("expected choice");
    return {
      ...target,
      control: { ...target.control, checked: false },
      readback: { kind: "selected", option: boundedText("Yes") },
    };
  });
});

test("malformed observations fail closed without executing accessors", async () => {
  const invalid = {
    ok: false,
    error: providerError("page_observation_invalid"),
  } as const;
  let getterReads = 0;
  const accessor = Object.defineProperty({}, "observation", {
    enumerable: true,
    get() {
      getterReads += 1;
      return contractFixtures.browserObservation;
    },
  });
  const duplicate = observation("/profile", [
    contractFixtures.browserObservation.targets[0]!,
    contractFixtures.browserObservation.targets[0]!,
  ]);

  assert.deepEqual(await provider.understand(
    accessor as PageUnderstandingRequest,
    new AbortController().signal,
  ), invalid);
  assert.deepEqual(await provider.understand(
    { observation: duplicate },
    new AbortController().signal,
  ), invalid);
  assert.deepEqual(await provider.understand(
    null as unknown as PageUnderstandingRequest,
    new AbortController().signal,
  ), invalid);
  assert.equal(getterReads, 0);
});

test("semantic output retains source page and omits raw labels, values, and coordinates", async () => {
  const input = observation("/profile", [{
    ...contractFixtures.browserObservation.targets[0]!,
    token: browserTargetToken("target-s1-field-given-name"),
    name: boundedText("alice@example.invalid"),
    readback: { kind: "text", value: boundedText("Private Applicant") },
  }]);
  const before = structuredClone(input);
  const first = await provider.understand({ observation: input }, new AbortController().signal);
  const second = await provider.understand({ observation: input }, new AbortController().signal);
  const serialized = JSON.stringify(first);

  assert.deepEqual(first, second);
  assert.deepEqual(input, before);
  const identity = first.ok && first.value.kind === "understood"
    ? first.value.snapshot.pageIdentity
    : undefined;
  assert.equal(identity?.kind === "workday" ? identity.page : undefined, "profile");
  assert.equal(serialized.includes("alice@example.invalid"), false);
  assert.equal(serialized.includes("Private Applicant"), false);
  assert.equal(serialized.includes(input.sessionId), false);
  assert.equal(serialized.includes(input.pageId), false);
});

test("cancellation wins before observation handling", async () => {
  assert.deepEqual(await provider.understand(
    null as unknown as PageUnderstandingRequest,
    AbortSignal.abort(),
  ), {
    ok: false,
    error: providerError("operation_cancelled"),
  });
});

test("all distinct S1 behaviors match the canonical golden snapshot", async () => {
  const result = await provider.understand(
    { observation: canonicalObservation() },
    new AbortController().signal,
  );
  const golden = JSON.parse(readFileSync(
    "tests/golden/s1/understanding/supported-controls.json",
    "utf8",
  )) as unknown;
  assert.deepEqual(result, golden);
});
