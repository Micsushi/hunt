import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { basename, extname, join, relative } from "node:path";

type PayloadPrivacyCode = "credential" | "email_body" | "raw_text";

const payloadKeyCodes: ReadonlyMap<string, PayloadPrivacyCode> = new Map([
  ["password", "credential"],
  ["passcode", "credential"],
  ["credential", "credential"],
  ["apikey", "credential"],
  ["accesstoken", "credential"],
  ["refreshtoken", "credential"],
  ["sessioncookie", "credential"],
  ["authorizationheader", "credential"],
  ["emailbody", "email_body"],
  ["messagebody", "email_body"],
  ["rawtext", "raw_text"],
  ["rawpagetext", "raw_text"],
] as const);

const scannedExtensions = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".md",
  ".ts",
  ".txt",
]);
const ignoredDirectories = new Set([
  "build",
  "coverage",
  "dist",
  "node_modules",
]);

export interface FilePrivacyViolation {
  readonly file: string;
  readonly code:
    | "credential_file"
    | "private_key"
    | "real_email"
    | "secret_token";
}

export function findPayloadPrivacyViolations(
  payload: unknown,
): readonly string[] {
  const violations: string[] = [];
  let visited = 0;

  function visit(value: unknown, path: string, depth: number): void {
    visited += 1;
    if (visited > 1_000 || depth > 16) {
      violations.push(`${path}:payload_too_large`);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) =>
        visit(item, `${path}[${index}]`, depth + 1),
      );
      return;
    }
    if (typeof value !== "object" || value === null) {
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      const code = payloadKeyCodes.get(
        key.replaceAll(/[^a-z0-9]/giu, "").toLowerCase(),
      );
      const childPath = `${path}.${key}`;
      if (code !== undefined) {
        violations.push(`${childPath}:${code}`);
      }
      visit(child, childPath, depth + 1);
    }
  }

  visit(payload, "$", 0);
  return violations;
}

export function scanPrivacyFiles(
  executionerRoot: string,
): readonly FilePrivacyViolation[] {
  const violations: FilePrivacyViolation[] = [];

  for (const scope of ["src", "tests", "fixtures"]) {
    const root = join(executionerRoot, scope);
    if (existsSync(root)) {
      scan(root);
    }
  }
  return violations.sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.code.localeCompare(right.code),
  );

  function scan(path: string): void {
    if (statSync(path).isDirectory()) {
      if (ignoredDirectories.has(basename(path))) {
        return;
      }
      for (const entry of readdirSync(path)) {
        scan(join(path, entry));
      }
      return;
    }

    const file = relative(executionerRoot, path).replaceAll("\\", "/");
    const name = file.split("/").at(-1)?.toLowerCase() ?? "";
    if (
      name === ".env" ||
      name === "credentials.json" ||
      name.endsWith(".key") ||
      name.endsWith(".pem")
    ) {
      violations.push({ file, code: "credential_file" });
      return;
    }
    if (!scannedExtensions.has(extname(name))) {
      return;
    }

    const content = readFileSync(path, "utf8");
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(content)) {
      violations.push({ file, code: "private_key" });
    }
    if (
      /\b(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,})\b/u.test(
        content,
      )
    ) {
      violations.push({ file, code: "secret_token" });
    }
    const emails =
      content.match(
        /\b[A-Z0-9._%+-]+@(?:[A-Z0-9-]+\.)+[A-Z]{2,}\b/giu,
      ) ?? [];
    if (
      emails.some(
        (email) =>
          !email.toLowerCase().endsWith(".invalid"),
      )
    ) {
      violations.push({ file, code: "real_email" });
    }
  }
}
