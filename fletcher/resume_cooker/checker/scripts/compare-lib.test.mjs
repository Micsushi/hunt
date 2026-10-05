import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compareFactSets,
  compareResumeText,
  extractSourceFacts,
  normalizeFactSet,
  validateComparisonPolicy
} from "./compare-lib.mjs";

const facts = (items) => ({ schema_version: 1, facts: items });
const fact = (id, kind, field, value, extra = {}) => ({
  id,
  kind,
  field,
  value,
  entry_id: extra.entry_id || null,
  immutable: extra.immutable ?? false,
  material: extra.material ?? false,
  ...extra
});

test("normalizeFactSet accepts formatting-only contact, date, location, and LaTeX differences", () => {
  const left = normalizeFactSet(
    facts([
      fact("contact.email", "contact", "email", "CASE@Example.com", { immutable: true }),
      fact("contact.phone", "contact", "phone", "(555) 010-0200", { immutable: true }),
      fact("job.date", "experience", "date", "Jan. 2024 — Present", {
        immutable: true,
        entry_id: "job-1"
      }),
      fact("job.location", "experience", "location", "Denver, Colorado", {
        immutable: true,
        entry_id: "job-1"
      }),
      fact("skill.cpp", "skill", "name", "C\\+\\+", { material: true })
    ])
  );
  const right = normalizeFactSet(
    facts([
      fact("contact.email", "contact", "email", "case@example.com", { immutable: true }),
      fact("contact.phone", "contact", "phone", "555-010-0200", { immutable: true }),
      fact("job.date", "experience", "date", "January 2024 - Current", {
        immutable: true,
        entry_id: "job-1"
      }),
      fact("job.location", "experience", "location", "denver, CO", {
        immutable: true,
        entry_id: "job-1"
      }),
      fact("skill.cpp", "skill", "name", "C++", { material: true })
    ])
  );

  assert.deepEqual(
    left.facts.map((item) => item.normalized),
    right.facts.map((item) => item.normalized)
  );
});

test("normalizeFactSet rejects malformed or duplicate structured facts", () => {
  assert.throws(
    () => normalizeFactSet({ schema_version: 2, facts: [] }),
    (error) => error.code === "INVALID_USAGE"
  );
  assert.throws(
    () =>
      normalizeFactSet(
        facts([fact("same", "skill", "name", "A"), fact("same", "skill", "name", "B")])
      ),
    (error) => error.code === "INVALID_USAGE"
  );
  assert.throws(
    () =>
      normalizeFactSet(
        facts([fact("job.title", "experience", "title", "Engineer", { immutable: true })])
      ),
    (error) => error.code === "INVALID_USAGE"
  );
});

test("compareFactSets fails changed immutable families without retaining values", () => {
  const before = facts([
    fact("contact.email", "contact", "email", "source@example.test", { immutable: true }),
    fact("job.employer", "experience", "employer", "Northwind Labs", {
      immutable: true,
      entry_id: "job-1"
    }),
    fact("job.title", "experience", "title", "Engineer", {
      immutable: true,
      entry_id: "job-1"
    }),
    fact("job.date", "experience", "date", "2024 - Present", {
      immutable: true,
      entry_id: "job-1"
    })
  ]);
  const after = JSON.parse(JSON.stringify(before));
  after.facts[0].value = "changed@example.test";
  after.facts[1].value = "Changed Employer";
  after.facts[2].value = "Changed Title";
  after.facts[3].value = "2025 - Present";

  const checks = compareFactSets(before, after);
  const changed = checks.find((check) => check.id === "immutable_facts_preserved");

  assert.equal(changed.status, "fail");
  assert.deepEqual(changed.metadata.changed_fields, [
    "contact.email",
    "experience.date",
    "experience.employer",
    "experience.title"
  ]);
  assert.doesNotMatch(JSON.stringify(checks), /source@example|changed@example|Northwind|Employer/);
});

test("compareFactSets preserves structured entry associations instead of sorting fields globally", () => {
  const before = facts([
    fact("job.a.employer", "experience", "employer", "Alpha", {
      immutable: true,
      entry_id: "job.a"
    }),
    fact("job.a.title", "experience", "title", "Engineer", {
      immutable: true,
      entry_id: "job.a"
    }),
    fact("job.b.employer", "experience", "employer", "Beta", {
      immutable: true,
      entry_id: "job.b"
    }),
    fact("job.b.title", "experience", "title", "Builder", {
      immutable: true,
      entry_id: "job.b"
    })
  ]);
  const after = facts([
    fact("job.a.employer", "experience", "employer", "Beta", {
      immutable: true,
      entry_id: "job.a"
    }),
    fact("job.a.title", "experience", "title", "Engineer", {
      immutable: true,
      entry_id: "job.a"
    }),
    fact("job.b.employer", "experience", "employer", "Alpha", {
      immutable: true,
      entry_id: "job.b"
    }),
    fact("job.b.title", "experience", "title", "Builder", {
      immutable: true,
      entry_id: "job.b"
    })
  ]);

  const check = compareFactSets(before, after).find(
    (item) => item.id === "immutable_facts_preserved"
  );
  assert.equal(check.status, "fail");
  assert.deepEqual(check.metadata.changed_fields, ["experience.employer"]);
});

test("compareFactSets records ambiguous low-confidence entries as review", () => {
  const before = facts([
    fact("source.experience.0.title", "experience", "title", "Engineer", {
      immutable: true,
      confidence: "low"
    })
  ]);
  const after = facts([
    fact("source.experience.1.title", "experience", "title", "Engineer", {
      immutable: true,
      confidence: "low"
    })
  ]);

  const check = compareFactSets(before, after, {
    beforeSource: "source",
    afterSource: "source"
  }).find((item) => item.id === "ambiguous_fact_matching");
  assert.equal(check.status, "warning");
});

test("protected strengths support exact omissions and reject unknown IDs", () => {
  const before = facts([
    fact("skill.typescript", "skill", "name", "TypeScript", { material: true }),
    fact("skill.react", "skill", "name", "React", { material: true })
  ]);
  const after = facts([fact("skill.react", "skill", "name", "React", { material: true })]);

  const lost = compareFactSets(before, after, { protectedIds: ["skill.typescript"] }).find(
    (check) => check.id === "protected_strengths_retained"
  );
  assert.equal(lost.status, "warning");
  assert.deepEqual(lost.metadata.lost_ids, ["skill.typescript"]);

  const omitted = compareFactSets(before, after, {
    protectedIds: ["skill.typescript"],
    omittedIds: ["skill.typescript"]
  }).find((check) => check.id === "protected_strengths_retained");
  assert.equal(omitted.status, "pass");
  assert.equal(omitted.metadata.intentional_omission_count, 1);

  assert.throws(
    () => validateComparisonPolicy({ protectedIds: ["skill.react"], omittedIds: ["unknown"] }),
    (error) => error.code === "INVALID_USAGE"
  );
});

test("grounding uses source/profile facts while JD-only evidence remains ungrounded", () => {
  const before = facts([fact("skill.ts", "skill", "name", "TypeScript", { material: true })]);
  const after = facts([
    fact("skill.ts", "skill", "name", "TypeScript", { material: true }),
    fact("skill.python", "skill", "name", "Python", { material: true })
  ]);
  const profile = facts([fact("profile.python", "skill", "name", "Python", { material: true })]);

  const grounded = compareFactSets(before, after, { profileFacts: profile }).find(
    (check) => check.id === "material_additions_grounded"
  );
  assert.equal(grounded.status, "pass");
  assert.equal(grounded.metadata.grounded_count, 1);

  const jdOnly = compareFactSets(before, after, { jdSignals: ["Python"] }).find(
    (check) => check.id === "material_additions_grounded"
  );
  assert.equal(jdOnly.status, "fail");
  assert.equal(jdOnly.metadata.jd_relevant_ungrounded_count, 1);
  assert.doesNotMatch(JSON.stringify(jdOnly), /Python/);
});

test("approved synonyms produce review instead of silent grounding", () => {
  const before = facts([fact("skill.js", "skill", "name", "JavaScript", { material: true })]);
  const after = facts([
    fact("skill.js", "skill", "name", "JavaScript", { material: true }),
    fact("skill.node", "skill", "name", "Node.js", { material: true })
  ]);

  const check = compareFactSets(before, after).find(
    (item) => item.id === "material_additions_grounded"
  );
  assert.equal(check.status, "warning");
  assert.equal(check.metadata.ambiguous_count, 1);
});

test("source-only comparison retains contact behavior without exposing values", () => {
  const changed = compareResumeText(
    "A source@example.test (555) 010-0200",
    "A changed@example.test 555-010-0200"
  ).find((check) => check.id === "immutable_facts_preserved");
  assert.equal(changed.status, "fail");
  assert.doesNotMatch(JSON.stringify(changed), /source@example|changed@example/);

  const same = compareResumeText(
    "A SOURCE@example.test (555) 010-0200",
    "A source@example.test 555-010-0200"
  ).find((check) => check.id === "immutable_facts_preserved");
  assert.equal(same.status, "pass");
});

test("source-only extraction exposes low-confidence identity, education, experience, and skills", () => {
  const extracted = normalizeFactSet(
    extractSourceFacts(String.raw`
      \documentclass{article}
      \begin{document}
      \section*{Riley Example}
      riley@example.test
      \section*{Education}
      Example Polytechnic, Bachelor of Synthetic Engineering, May 2026
      \section*{Experience}
      Systems Builder, Synthetic Systems Cooperative, Denver, CO, Jan 2024 -- Present
      \section*{Skills}
      TypeScript, React
      \end{document}
    `),
    { source: "source" }
  );

  assert.deepEqual([...new Set(extracted.facts.map((item) => item.kind))].sort(), [
    "contact",
    "education",
    "experience",
    "identity",
    "skill"
  ]);
  assert.ok(extracted.facts.every((item) => item.confidence === "low"));
});

test("source-only experience pairing is stable when identical entries are reordered", () => {
  const header = String.raw`
    \documentclass{article}
    \begin{document}
    \section*{Experience}
  `;
  const footer = String.raw`
    \section*{Skills}
    TypeScript
    \end{document}
  `;
  const first = "Engineer, Alpha Cooperative, Denver, CO, Jan 2023 -- Dec 2023";
  const second = "Builder, Beta Cooperative, Austin, TX, Jan 2024 -- Present";

  const checks = compareResumeText(
    `${header}\n${first}\n${second}\n${footer}`,
    `${header}\n${second}\n${first}\n${footer}`
  );
  assert.equal(checks.find((check) => check.id === "immutable_facts_preserved").status, "pass");
  assert.equal(checks.find((check) => check.id === "ambiguous_fact_matching").status, "pass");
});

test("source-only complex entry changes produce review instead of a confirmed blocker", () => {
  const before = String.raw`
    \section*{Education}
    Example Polytechnic, Bachelor of Synthetic Engineering, May 2026
    \section*{Experience}
    Engineer, Alpha Cooperative, Denver, CO, Jan 2023 -- Dec 2023
  `;
  const after = String.raw`
    \section*{Education}
    Example Polytechnic, Bachelor of Synthetic Engineering, May 2027
    \section*{Experience}
    Senior Engineer, Alpha Cooperative, Denver, CO, Jan 2023 -- Dec 2023
  `;
  const checks = compareResumeText(before, after);

  assert.equal(checks.find((check) => check.id === "immutable_facts_preserved").status, "pass");
  assert.equal(checks.find((check) => check.id === "ambiguous_fact_matching").status, "warning");
});
