import { createHash } from "node:crypto";

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value: string | Uint8Array): string {
  return `sha256.${createHash("sha256").update(value).digest("hex")}`;
}

export function normalizeTextLineEndings(value: string): string {
  return value.replaceAll("\r\n", "\n");
}

export function frozenDigest<T extends { freeze?: unknown }>(value: T): string {
  const { freeze: _freeze, ...content } = value;
  return sha256(canonicalJson(content));
}

export function dataRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export const sha256Pattern = /^sha256\.[a-f0-9]{64}$/u;
