import {
  useEphemeralByteBatch,
  useEphemeralBytes,
} from "../../contracts/live/private/privileged-capabilities.ts";

type LivePrivacyCode =
  | "credential"
  | "email_body"
  | "pii"
  | "raw_url";

const forbiddenKeys = new Map<string, LivePrivacyCode>([
  ["password", "credential"],
  ["passcode", "credential"],
  ["credentialvalue", "credential"],
  ["oauthtoken", "credential"],
  ["accesstoken", "credential"],
  ["refreshtoken", "credential"],
  ["messagebody", "email_body"],
  ["emailbody", "email_body"],
  ["rawmessage", "email_body"],
]);

export function findLivePrivacyViolations(value: unknown): readonly string[] {
  const violations: string[] = [];
  const seen = new WeakSet<object>();
  let visited = 0;

  function visit(candidate: unknown, path: string, depth: number): void {
    visited += 1;
    if (visited > 4_000 || depth > 24) {
      violations.push(`${path}:graph_limit`);
      return;
    }
    if (typeof candidate === "string") {
      if (/^https?:\/\//iu.test(candidate)) violations.push(`${path}:raw_url`);
      if (
        /\b[A-Z0-9._%+-]+@(?:[A-Z0-9-]+\.)+[A-Z]{2,}\b/iu.test(candidate) &&
        !candidate.toLowerCase().endsWith(".invalid")
      ) {
        violations.push(`${path}:pii`);
      }
      return;
    }
    if (typeof candidate !== "object" || candidate === null) return;
    if (seen.has(candidate)) return;
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      candidate.forEach((child, index) =>
        visit(child, `${path}[${index}]`, depth + 1),
      );
      return;
    }
    for (const [key, child] of Object.entries(candidate)) {
      const childPath = `${path}.${key}`;
      const code = forbiddenKeys.get(
        key.replaceAll(/[^a-z0-9]/giu, "").toLowerCase(),
      );
      if (code !== undefined) violations.push(`${childPath}:${code}`);
      visit(child, childPath, depth + 1);
    }
  }

  visit(value, "$", 0);
  return [...new Set(violations)].sort();
}

export async function runEphemeralSentinelProof(): Promise<{
  readonly callbacksObservedNonzeroBytes: number;
  readonly clearedBuffers: number;
}> {
  const single = Uint8Array.from([41, 73, 107, 139]);
  const batch = [
    Uint8Array.from([53, 85, 117, 149]),
    Uint8Array.from([67, 99, 131, 163]),
  ];
  const exceptional = Uint8Array.from([79, 111, 143, 175]);
  let callbacksObservedNonzeroBytes = 0;

  await useEphemeralBytes(single, async (bytes) => {
    if (bytes.some((byte) => byte !== 0)) callbacksObservedNonzeroBytes += 1;
    return { kind: "completed" };
  });
  await useEphemeralByteBatch(batch, async (values) => {
    if (values.every((bytes) => bytes.some((byte) => byte !== 0))) {
      callbacksObservedNonzeroBytes += 1;
    }
    return { kind: "completed" };
  });
  try {
    await useEphemeralBytes(exceptional, async (bytes) => {
      if (bytes.some((byte) => byte !== 0)) callbacksObservedNonzeroBytes += 1;
      throw new TypeError("synthetic callback failure");
    });
  } catch (caught) {
    if (!(caught instanceof TypeError)) throw caught;
  }

  const clearedBuffers = [single, ...batch, exceptional].filter((bytes) =>
    bytes.every((byte) => byte === 0),
  ).length;
  return { callbacksObservedNonzeroBytes, clearedBuffers };
}
