/** Deterministic, bounded synthesis for supported browser-native constraints. */
export interface SyntheticTextConstraints {
  readonly inputType: "text" | "email" | "url" | "number";
  readonly min: number | null;
  readonly max: number | null;
  readonly step?: number | null;
  readonly minLength?: number | null;
  readonly maxLength: number | null;
  readonly pattern: string | null;
}

export type SyntheticTextValue =
  | { readonly kind: "generated"; readonly value: string }
  | { readonly kind: "unsupported_constraint" };

export function generateSyntheticTextValue(
  constraints: SyntheticTextConstraints | undefined,
): SyntheticTextValue {
  const normalized: Required<SyntheticTextConstraints> = {
    inputType: constraints?.inputType ?? "text",
    min: constraints?.min ?? null,
    max: constraints?.max ?? null,
    step: constraints?.step ?? null,
    minLength: constraints?.minLength ?? null,
    maxLength: constraints?.maxLength ?? null,
    pattern: constraints?.pattern ?? null,
  };
  if (!validBounds(normalized)) return { kind: "unsupported_constraint" };
  if (normalized.inputType === "number") return generatedNumber(normalized);

  const patterned = normalized.pattern === null
    ? undefined
    : generatePatternValue(normalized.pattern, normalized.minLength, normalized.maxLength);
  if (normalized.pattern !== null && patterned === undefined) {
    return { kind: "unsupported_constraint" };
  }
  const initial = patterned ?? (normalized.inputType === "email"
    ? "test@example.invalid"
    : normalized.inputType === "url"
      ? "https://example.invalid/test"
      : "Test response pending owner review.");
  const value = fitLength(initial, normalized.minLength, normalized.maxLength);
  if (value === undefined || !validType(value, normalized.inputType) ||
      !matchesPattern(value, normalized.pattern)) {
    return { kind: "unsupported_constraint" };
  }
  return { kind: "generated", value };
}

function generatedNumber(constraints: Required<SyntheticTextConstraints>): SyntheticTextValue {
  const minimum = constraints.min ?? 0;
  const maximum = constraints.max ?? Math.max(minimum, 0);
  if (minimum > maximum) return { kind: "unsupported_constraint" };
  const step = constraints.step ?? 1;
  if (!Number.isFinite(step) || step <= 0) return { kind: "unsupported_constraint" };
  const base = constraints.min ?? 0;
  const preferred = Math.min(maximum, Math.max(minimum, 0));
  const value = base + Math.ceil((preferred - base) / step) * step;
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    return { kind: "unsupported_constraint" };
  }
  const text = String(Number(value.toFixed(12)));
  return fitsLength(text, constraints.minLength, constraints.maxLength)
    ? { kind: "generated", value: text }
    : { kind: "unsupported_constraint" };
}

function generatePatternValue(
  source: string,
  minLength: number | null,
  maxLength: number | null,
): string | undefined {
  let pattern = source;
  if (pattern.startsWith("^")) pattern = pattern.slice(1);
  if (pattern.endsWith("$")) pattern = pattern.slice(0, -1);
  if (pattern === "" || /[|()]/u.test(pattern)) return undefined;
  const tokens: { sample: string; minimum: number; maximum: number }[] = [];
  for (let index = 0; index < pattern.length;) {
    let sample: string;
    if (pattern.startsWith("\\d", index)) {
      sample = "0";
      index += 2;
    } else if (pattern.startsWith("\\w", index)) {
      sample = "A";
      index += 2;
    } else if (pattern[index] === "[") {
      const end = pattern.indexOf("]", index + 1);
      if (end < 0) return undefined;
      const klass = pattern.slice(index + 1, end);
      sample = sampleForClass(klass);
      if (sample === "") return undefined;
      index = end + 1;
    } else if (pattern[index] === "\\") {
      const escaped = pattern[index + 1];
      if (escaped === undefined || /[AbBdDsSwWZpPkK]/u.test(escaped)) return undefined;
      sample = escaped;
      index += 2;
    } else {
      const literal = pattern[index]!;
      if (".*+?{}".includes(literal)) return undefined;
      sample = literal;
      index += 1;
    }
    const quantified = quantifier(pattern, index);
    if (quantified === undefined) return undefined;
    index = quantified.next;
    tokens.push({ sample, minimum: quantified.minimum, maximum: quantified.maximum });
  }
  let length = tokens.reduce((total, token) => total + token.minimum, 0);
  const required = Math.max(length, minLength ?? 0);
  for (let index = tokens.length - 1; index >= 0 && length < required; index -= 1) {
    const token = tokens[index]!;
    const add = Math.min(required - length, token.maximum - token.minimum);
    token.minimum += add;
    length += add;
  }
  if (length < required || maxLength !== null && length > maxLength) return undefined;
  const value = tokens.map(({ sample, minimum }) => sample.repeat(minimum)).join("");
  return matchesPattern(value, source) ? value : undefined;
}

function quantifier(
  pattern: string,
  index: number,
): { readonly minimum: number; readonly maximum: number; readonly next: number } | undefined {
  if (pattern[index] === undefined) return { minimum: 1, maximum: 1, next: index };
  if (pattern[index] === "?") return { minimum: 0, maximum: 1, next: index + 1 };
  if (pattern[index] === "+") return { minimum: 1, maximum: 512, next: index + 1 };
  if (pattern[index] !== "{") return { minimum: 1, maximum: 1, next: index };
  const end = pattern.indexOf("}", index + 1);
  if (end < 0) return undefined;
  const match = /^(\d{1,3})(?:,(\d{0,3}))?$/u.exec(pattern.slice(index + 1, end));
  if (match === null) return undefined;
  const minimum = Number(match[1]);
  const maximum = match[2] === undefined ? minimum : match[2] === "" ? 512 : Number(match[2]);
  if (minimum > maximum || maximum > 512) return undefined;
  return { minimum, maximum, next: end + 1 };
}

function sampleForClass(value: string): string {
  if (value.startsWith("^")) {
    for (const candidate of ["A", "0", "a"]) {
      if (!value.slice(1).includes(candidate)) return candidate;
    }
    return "";
  }
  if (/0-9|\\d/u.test(value)) return "0";
  if (/A-Z/u.test(value)) return "A";
  if (/a-z/u.test(value)) return "a";
  const literal = value.replace(/^\^/u, "").replace(/\\(.)/gu, "$1")[0];
  return literal !== undefined && !"-]".includes(literal) ? literal : "";
}

function fitLength(value: string, minimum: number | null, maximum: number | null): string | undefined {
  const ceiling = maximum ?? 512;
  if (ceiling < 1 || minimum !== null && minimum > ceiling) return undefined;
  let result = [...value].slice(0, ceiling).join("");
  if (minimum !== null && [...result].length < minimum) {
    result += "X".repeat(minimum - [...result].length);
  }
  return result === "" || [...result].length > ceiling ? undefined : result;
}

function validBounds(value: Required<SyntheticTextConstraints>): boolean {
  return (value.min === null || Number.isFinite(value.min)) &&
    (value.max === null || Number.isFinite(value.max)) &&
    (value.min === null || value.max === null || value.min <= value.max) &&
    (value.minLength === null || Number.isSafeInteger(value.minLength) && value.minLength >= 0) &&
    (value.maxLength === null || Number.isSafeInteger(value.maxLength) && value.maxLength >= 0) &&
    (value.minLength === null || value.maxLength === null || value.minLength <= value.maxLength);
}

function fitsLength(value: string, minimum: number | null, maximum: number | null): boolean {
  const length = [...value].length;
  return (minimum === null || length >= minimum) && (maximum === null || length <= maximum);
}

function validType(value: string, type: SyntheticTextConstraints["inputType"]): boolean {
  if (type === "email") return /^[^@\s]+@[^@\s]+$/u.test(value);
  if (type === "url") {
    try {
      return ["http:", "https:"].includes(new URL(value).protocol);
    } catch {
      return false;
    }
  }
  return type !== "number" || Number.isFinite(Number(value));
}

function matchesPattern(value: string, pattern: string | null): boolean {
  if (pattern === null) return true;
  try {
    return new RegExp(`^(?:${pattern})$`, "u").test(value);
  } catch {
    return false;
  }
}
