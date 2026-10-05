import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getRepoRoot } from "../../generator/scripts/build-lib.mjs";
import { createCheck } from "./report-lib.mjs";

const confidenceValues = new Set(["high", "medium", "low"]);
const stateAliases = new Map([
  ["colorado", "co"],
  ["california", "ca"],
  ["new york", "ny"],
  ["texas", "tx"],
  ["washington", "wa"]
]);
const synonymGroups = [
  new Set(["javascript", "node js", "node.js", "nodejs"]),
  new Set(["postgres", "postgresql"]),
  new Set(["amazon web services", "aws"])
];

export async function compareResumeFiles(options) {
  const [beforeText, afterText, beforeStructured, afterStructured, profileStructured] =
    await Promise.all([
      readText(options.before),
      readText(options.after),
      readOptionalJson(options.beforeFacts),
      readOptionalJson(options.afterFacts),
      readOptionalJson(options.profileFacts)
    ]);
  const before = beforeStructured || extractSourceFacts(beforeText);
  const after = afterStructured || extractSourceFacts(afterText);
  const beforeSource = beforeStructured ? "structured" : "source";
  const afterSource = afterStructured ? "structured" : "source";
  const checks = compareFactSets(before, after, {
    profileFacts: profileStructured,
    beforeSource,
    afterSource,
    protectedIds: options.protectedIds,
    omittedIds: options.omittedIds,
    strengthSeverity: options.strengthSeverity,
    jdSignals: options.jdSignals
  });
  const protectedSet = new Set(options.protectedIds || []);
  const omittedSet = new Set(options.omittedIds || []);
  const protectedFacts = normalizeFactSet(before, { source: beforeSource })
    .facts.filter((item) => protectedSet.has(item.id) && !omittedSet.has(item.id))
    .map((item) => ({ id: item.id, normalized: item.normalized }));
  return { checks, protectedFacts };
}

export function compareResumeText(beforeText, afterText) {
  return compareFactSets(extractSourceFacts(beforeText), extractSourceFacts(afterText), {
    beforeSource: "source",
    afterSource: "source"
  });
}

export function normalizeFactSet(input, { source = "structured" } = {}) {
  if (input?.schema_version !== 1 || !Array.isArray(input.facts)) {
    throw invalid("Fact input must use schema_version 1 with a facts array.");
  }
  const ids = new Set();
  const normalizedFacts = input.facts.map((item, index) => {
    if (
      typeof item?.id !== "string" ||
      !item.id ||
      ids.has(item.id) ||
      typeof item?.kind !== "string" ||
      !item.kind ||
      typeof item?.field !== "string" ||
      !item.field ||
      typeof item?.value !== "string"
    ) {
      throw invalid(`Fact at index ${index} is malformed or has a duplicate ID.`);
    }
    ids.add(item.id);
    const confidence = item.confidence || (source === "structured" ? "high" : "low");
    if (!confidenceValues.has(confidence)) {
      throw invalid(`Fact at index ${index} has invalid confidence.`);
    }
    if (
      source === "structured" &&
      ["education", "experience"].includes(item.kind) &&
      (typeof item.entry_id !== "string" || !item.entry_id)
    ) {
      throw invalid(`Structured ${item.kind} fact at index ${index} requires entry_id.`);
    }
    return {
      id: item.id,
      kind: item.kind,
      field: item.field,
      entry_id: item.entry_id || null,
      immutable: item.immutable === true,
      material: item.material === true,
      source: item.source || source,
      confidence,
      normalized: normalizeValue(item.field, item.value)
    };
  });
  return { schema_version: 1, facts: normalizedFacts };
}

export function validateComparisonPolicy({ protectedIds = [], omittedIds = [] } = {}) {
  if (!stringList(protectedIds) || !stringList(omittedIds)) {
    throw invalid("Protected and omitted IDs must be arrays of unique strings.");
  }
  const protectedSet = new Set(protectedIds);
  const unknown = omittedIds.filter((id) => !protectedSet.has(id));
  if (unknown.length > 0) {
    throw invalid("Every intentional omission must name a protected fact ID.");
  }
  return { protectedIds, omittedIds };
}

export function compareFactSets(beforeInput, afterInput, options = {}) {
  const policy = validateComparisonPolicy(options);
  const before = normalizeFactSet(beforeInput, { source: options.beforeSource || "structured" });
  const after = normalizeFactSet(afterInput, { source: options.afterSource || "structured" });
  const profile = options.profileFacts ? normalizeFactSet(options.profileFacts).facts : [];
  return [
    compareImmutableFacts(before.facts, after.facts),
    compareAmbiguousFacts(before.facts, after.facts),
    compareProtectedStrengths(before.facts, after.facts, {
      ...policy,
      severity: options.strengthSeverity
    }),
    compareMaterialAdditions(before.facts, after.facts, profile, options.jdSignals || [])
  ];
}

function compareImmutableFacts(before, after) {
  const beforeMap = factMap(before.filter((item) => item.immutable));
  const afterMap = factMap(after.filter((item) => item.immutable));
  const keys = new Set([...beforeMap.keys(), ...afterMap.keys()]);
  const changed = [];
  for (const key of keys) {
    const left = beforeMap.get(key);
    const right = afterMap.get(key);
    if (
      !left ||
      !right ||
      left.length !== right.length ||
      left.some((value, index) => value.normalized !== right[index]?.normalized)
    ) {
      const sample = left?.[0] || right?.[0];
      if (
        (!left || !right) &&
        sample.confidence === "low" &&
        ["education", "experience"].includes(sample.kind)
      ) {
        continue;
      }
      changed.push(`${sample.kind}.${sample.field}`);
    }
  }
  const changedFields = [...new Set(changed)].sort();
  return createCheck({
    id: "immutable_facts_preserved",
    category: "post_tailoring_regression",
    severity: "blocker",
    status: changedFields.length === 0 ? "pass" : "fail",
    evidence:
      changedFields.length === 0
        ? "Comparable immutable fact fields are preserved."
        : `${changedFields.length} immutable field type(s) changed, were removed, or were added.`,
    suggestedFix: changedFields.length === 0 ? "" : "Review the named fact fields before use.",
    metadata: { changed_fields: changedFields, changed_field_count: changedFields.length }
  });
}

function compareAmbiguousFacts(before, after) {
  const beforeLow = before.filter((item) => item.immutable && item.confidence === "low");
  const afterLow = after.filter((item) => item.immutable && item.confidence === "low");
  const ambiguous =
    beforeLow.length > 0 &&
    afterLow.length > 0 &&
    !sameSet(
      beforeLow.map((item) => item.id),
      afterLow.map((item) => item.id)
    );
  return createCheck({
    id: "ambiguous_fact_matching",
    category: "post_tailoring_regression",
    severity: "medium",
    status: ambiguous ? "warning" : "pass",
    evidence: ambiguous
      ? "Low-confidence source facts could not be paired by stable identifiers."
      : "No ambiguous low-confidence fact pairing was detected.",
    suggestedFix: ambiguous ? "Supply schema-v1 structured facts with stable entry IDs." : "",
    metadata: { ambiguous_entry_count: ambiguous ? Math.max(beforeLow.length, afterLow.length) : 0 }
  });
}

function compareProtectedStrengths(before, after, { protectedIds, omittedIds, severity }) {
  const beforeIds = new Set(before.map((item) => item.id));
  const afterIds = new Set(after.map((item) => item.id));
  const omitted = new Set(omittedIds);
  const unknownProtected = protectedIds.filter((id) => !beforeIds.has(id));
  if (unknownProtected.length > 0) {
    throw invalid("Every protected ID must exist in the source fact set.");
  }
  const lost = protectedIds.filter((id) => !afterIds.has(id) && !omitted.has(id)).sort();
  const status = lost.length === 0 ? "pass" : severity === "blocker" ? "fail" : "warning";
  return createCheck({
    id: "protected_strengths_retained",
    category: "post_tailoring_regression",
    severity: severity === "blocker" ? "blocker" : "medium",
    status,
    evidence:
      lost.length === 0
        ? "Configured protected strengths are retained or intentionally omitted."
        : `${lost.length} configured protected strength(s) are missing.`,
    suggestedFix: lost.length === 0 ? "" : "Restore the protected facts or acknowledge exact IDs.",
    metadata: {
      protected_count: protectedIds.length,
      lost_count: lost.length,
      lost_ids: lost,
      intentional_omission_count: omittedIds.length,
      intentional_omission_ids: [...omittedIds].sort()
    }
  });
}

function compareMaterialAdditions(before, after, profile, jdSignals) {
  const beforeValues = comparableValues(before);
  const profileValues = comparableValues(profile);
  const jdValues = new Set(jdSignals.map((value) => normalizeValue("name", value)));
  const additions = after.filter(
    (item) => item.material && !beforeValues.has(comparableValue(item))
  );
  let grounded = 0;
  let ambiguous = 0;
  let ungrounded = 0;
  let jdRelevantUngrounded = 0;
  for (const item of additions) {
    const key = comparableValue(item);
    if (profileValues.has(key)) {
      grounded += 1;
    } else if (hasSynonymEvidence(item, [...before, ...profile])) {
      ambiguous += 1;
    } else {
      ungrounded += 1;
      if (jdValues.has(item.normalized)) jdRelevantUngrounded += 1;
    }
  }
  const status = ungrounded > 0 ? "fail" : ambiguous > 0 ? "warning" : "pass";
  return createCheck({
    id: "material_additions_grounded",
    category: "post_tailoring_regression",
    severity: ungrounded > 0 ? "blocker" : "medium",
    status,
    evidence:
      additions.length === 0
        ? "No material tailored-only facts were detected."
        : `${additions.length} material addition(s) were classified without using JD text as truth.`,
    suggestedFix:
      status === "pass"
        ? ""
        : "Remove ungrounded additions or supply approved profile evidence for review.",
    metadata: {
      addition_count: additions.length,
      grounded_count: grounded,
      ambiguous_count: ambiguous,
      ungrounded_count: ungrounded,
      jd_relevant_ungrounded_count: jdRelevantUngrounded
    }
  });
}

export function extractSourceFacts(text) {
  const facts = [];
  const emails = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  const phones = text.match(/(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}/g) || [];
  for (const [index, value] of [...new Set(emails)].entries()) {
    facts.push({
      id: `source.contact.email.${index}`,
      kind: "contact",
      field: "email",
      value,
      immutable: true,
      confidence: "low",
      source: "source"
    });
  }
  for (const [index, value] of [...new Set(phones)].entries()) {
    facts.push({
      id: `source.contact.phone.${index}`,
      kind: "contact",
      field: "phone",
      value,
      immutable: true,
      confidence: "low",
      source: "source"
    });
  }
  const sections = extractLatexSections(text);
  const author =
    text.match(/pdfauthor\s*=\s*\{([^}]+)\}/i)?.[1] ||
    sections.find((section) => !standardSection(section.title))?.title;
  if (author) {
    facts.push(sourceFact("source.identity.name", "identity", "name", author, { immutable: true }));
  }

  const education = sections.find((section) => /^education$/i.test(section.title));
  if (education) {
    const parts = firstVisibleLine(education.body)
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    const fields = [
      ["institution", parts[0]],
      ["degree", parts[1]],
      ["date", parts.at(-1)]
    ].filter(([, value]) => value);
    const entryId = `source.education.${sourceEntryFingerprint("education", fields)}.0`;
    for (const [field, value] of fields) {
      if (value) {
        facts.push(
          sourceFact(`${entryId}.${field}`, "education", field, value, {
            entry_id: entryId,
            immutable: true
          })
        );
      }
    }
  }

  const experience = sections.find((section) => /^experience$/i.test(section.title));
  if (experience) {
    const lines = visibleLines(experience.body).filter((line) => line.includes(","));
    const duplicateCounts = new Map();
    for (const line of lines) {
      const parts = line
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
      if (parts.length < 3) continue;
      const date = parts.at(-1);
      const location = parts.length >= 5 ? `${parts.at(-3)}, ${parts.at(-2)}` : parts.at(-2);
      const fields = [
        ["title", parts[0]],
        ["employer", parts[1]],
        ["location", location],
        ["date", date]
      ];
      const fingerprint = sourceEntryFingerprint("experience", fields);
      const duplicateIndex = duplicateCounts.get(fingerprint) || 0;
      duplicateCounts.set(fingerprint, duplicateIndex + 1);
      const entryId = `source.experience.${fingerprint}.${duplicateIndex}`;
      for (const [field, value] of fields) {
        facts.push(
          sourceFact(`${entryId}.${field}`, "experience", field, value, {
            entry_id: entryId,
            immutable: true
          })
        );
      }
    }
  }

  const skills = sections.find((section) => /^(technical\s+)?skills$/i.test(section.title));
  if (skills) {
    const values = visibleLines(skills.body).flatMap((line) =>
      line
        .replace(/^[^:]{1,40}:\s*/, "")
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
    );
    for (const [index, value] of [...new Set(values)].entries()) {
      facts.push(sourceFact(`source.skill.${index}`, "skill", "name", value, { material: true }));
    }
  }
  return { schema_version: 1, facts };
}

function extractLatexSections(text) {
  const matches = [...text.matchAll(/\\section\*?\{([^}]+)\}/g)];
  return matches.map((match, index) => ({
    title: plainText(match[1]),
    body: text.slice(match.index + match[0].length, matches[index + 1]?.index ?? text.length)
  }));
}

function standardSection(value) {
  return /^(education|experience|projects?|technical skills|skills)$/i.test(value);
}

function firstVisibleLine(value) {
  return visibleLines(value)[0] || "";
}

function visibleLines(value) {
  return value
    .split(/\r?\n/)
    .map(plainText)
    .filter(
      (line) =>
        line && !/^(begin|end)\b/i.test(line) && !/^item\b/i.test(line) && !/^[{}]+$/.test(line)
    );
}

function plainText(value) {
  let text = value
    .replace(/\\href\{[^}]*\}\{([^}]*)\}/g, "$1")
    .replace(/\\(?:textbf|textit|emph)\{([^}]*)\}/g, "$1")
    .replace(/\\hfill/g, ", ")
    .replace(/\\(?:quad|textbar)\{?\}?/g, " ")
    .replace(/\\(?:begin|end)\{[^}]+\}/g, " ")
    .replace(/\\[A-Za-z*]+(?:\[[^\]]*\])?/g, " ")
    .replace(/[{}]/g, " ")
    .replace(/\\([%$&#_])/g, "$1")
    .replace(/--+/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  text = text.replace(/^item\s+/i, "");
  return text;
}

function sourceFact(id, kind, field, value, extra = {}) {
  return {
    id,
    kind,
    field,
    value,
    confidence: "low",
    source: "source",
    ...extra
  };
}

function sourceEntryFingerprint(kind, fields) {
  const input = fields
    .map(([field, value]) => `${field}:${normalizeValue(field, value)}`)
    .sort()
    .join("\u0000");
  return createHash("sha256").update(`${kind}\u0000${input}`).digest("hex").slice(0, 12);
}

function normalizeValue(field, raw) {
  let value = raw
    .replace(/\\([+#&_])/g, "$1")
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (field === "email") return value;
  if (field === "phone") {
    const digits = value.replace(/\D/g, "");
    return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  }
  if (field === "date") return normalizeDate(value);
  if (field === "location") {
    const parts = value.split(",").map((part) => part.trim());
    if (parts.length > 1) parts[parts.length - 1] = stateAliases.get(parts.at(-1)) || parts.at(-1);
    return parts.join(",");
  }
  return value.replace(/[^\p{L}\p{N}+#.]+/gu, " ").trim();
}

function normalizeDate(value) {
  const months = {
    jan: "01",
    january: "01",
    feb: "02",
    february: "02",
    mar: "03",
    march: "03",
    apr: "04",
    april: "04",
    may: "05",
    jun: "06",
    june: "06",
    jul: "07",
    july: "07",
    aug: "08",
    august: "08",
    sep: "09",
    september: "09",
    oct: "10",
    october: "10",
    nov: "11",
    november: "11",
    dec: "12",
    december: "12"
  };
  return value
    .replace(/\./g, "")
    .replace(/\b(current|now|ongoing)\b/g, "present")
    .replace(
      /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\s+(\d{4})\b/g,
      (_, month, year) => `${year}-${months[month]}`
    )
    .replace(/\s*-\s*/g, ":");
}

function factMap(facts) {
  const map = new Map();
  for (const item of facts) {
    const key = `${item.kind}:${item.entry_id || ""}:${item.field}`;
    const list = map.get(key) || [];
    list.push(item);
    map.set(
      key,
      list.sort((a, b) => a.normalized.localeCompare(b.normalized))
    );
  }
  return map;
}

function comparableValues(facts) {
  return new Set(facts.map(comparableValue));
}

function comparableValue(item) {
  return `${item.kind}:${item.field}:${item.normalized}`;
}

function hasSynonymEvidence(addition, evidence) {
  return evidence.some(
    (item) =>
      item.kind === addition.kind &&
      item.field === addition.field &&
      synonymGroups.some((group) => group.has(item.normalized) && group.has(addition.normalized))
  );
}

function stringList(values) {
  return (
    Array.isArray(values) &&
    values.every((value) => typeof value === "string" && value.length > 0) &&
    new Set(values).size === values.length
  );
}

function sameSet(left, right) {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

async function readText(path) {
  try {
    return await readFile(resolve(getRepoRoot(), path), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") throw invalid("A required comparison input does not exist.");
    throw error;
  }
}

async function readOptionalJson(path) {
  if (!path) return null;
  try {
    return JSON.parse(await readText(path));
  } catch (error) {
    if (error.code === "INVALID_USAGE") throw error;
    if (error instanceof SyntaxError) throw invalid(`Structured fact input is not valid JSON.`);
    throw error;
  }
}

function invalid(message) {
  const error = new Error(message);
  error.code = "INVALID_USAGE";
  return error;
}
