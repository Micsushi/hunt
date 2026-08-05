import { basename, dirname, isAbsolute, join, normalize } from "node:path";

const RUN_KEY = /^run_\d{8}_[a-z0-9]{16}$/u;

export type Stage2AcceptanceCheckpoint =
  | "account_access"
  | "mailbox_candidate"
  | "account_verified"
  | "resume_verified"
  | "profile_verified"
  | "questionnaire_verified"
  | "pre_review";

export interface Stage2AcceptanceArgs {
  readonly checkpoint: Stage2AcceptanceCheckpoint;
  readonly configPath: string;
  readonly evidenceRoot: string;
}

const checkpoints = new Set<string>([
  "account_access",
  "mailbox_candidate",
  "account_verified",
  "resume_verified",
  "profile_verified",
  "questionnaire_verified",
  "pre_review",
]);

export function parseStage2AcceptanceArgs(
  values: readonly string[],
): Stage2AcceptanceArgs {
  if (values.length !== 6) invalid();
  const parsed = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (
      name === undefined ||
      value === undefined ||
      !["--config", "--stop-after", "--evidence-root"].includes(name) ||
      parsed.has(name)
    ) invalid();
    parsed.set(name, value);
  }
  const configPath = parsed.get("--config");
  const evidenceRoot = parsed.get("--evidence-root");
  const checkpoint = parsed.get("--stop-after");
  if (
    configPath === undefined ||
    evidenceRoot === undefined ||
    !validCheckpoint(checkpoint) ||
    !canonicalAbsolute(configPath) ||
    !canonicalAbsolute(evidenceRoot) ||
    !separatedStorageLayout(configPath, evidenceRoot)
  ) invalid();
  return Object.freeze({ checkpoint, configPath, evidenceRoot });
}

function validCheckpoint(value: unknown): value is Stage2AcceptanceCheckpoint {
  return typeof value === "string" && checkpoints.has(value);
}

function separatedStorageLayout(configPath: string, evidenceRoot: string): boolean {
  if (basename(configPath) !== "owner-input.json") return false;
  const transientRun = dirname(configPath);
  const runKey = basename(transientRun);
  const transientParent = dirname(transientRun);
  if (!RUN_KEY.test(runKey) || basename(transientParent) !== "transient") return false;
  const storageRoot = dirname(transientParent);
  return comparable(evidenceRoot) === comparable(
    join(storageRoot, "retained", runKey, "evidence"),
  );
}

function comparable(value: string): string {
  const normalized = normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function canonicalAbsolute(value: string): boolean {
  return isAbsolute(value) && normalize(value) === value;
}

function invalid(): never {
  throw new TypeError("invalid Stage 2 arguments");
}
