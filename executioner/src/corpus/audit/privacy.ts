import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";

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
const forbiddenKeys: ReadonlyMap<string, "credential" | "email_body"> = new Map([
  ["password", "credential"],
  ["passcode", "credential"],
  ["credentialvalue", "credential"],
  ["oauthtoken", "credential"],
  ["accesstoken", "credential"],
  ["refreshtoken", "credential"],
  ["messagebody", "email_body"],
  ["emailbody", "email_body"],
  ["rawmessage", "email_body"],
] as const);

export interface FilePrivacyViolation {
  readonly file: string;
  readonly code:
    | "credential_file"
    | "private_key"
    | "real_email"
    | "secret_token";
}

export function scanCorpusPrivacyFiles(
  executionerRoot: string,
): readonly FilePrivacyViolation[] {
  const violations: FilePrivacyViolation[] = [];
  for (const scope of ["src", "tests", "fixtures", "scripts"]) {
    const root = join(executionerRoot, scope);
    if (existsSync(root)) scan(root);
  }
  return violations.sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.code.localeCompare(right.code),
  );

  function scan(path: string): void {
    if (statSync(path).isDirectory()) {
      if (ignoredDirectories.has(basename(path))) return;
      for (const entry of readdirSync(path)) scan(join(path, entry));
      return;
    }
    const file = relative(executionerRoot, path).replaceAll("\\", "/");
    const name = basename(file).toLowerCase();
    if (
      name === ".env" ||
      name === "credentials.json" ||
      name.endsWith(".key") ||
      name.endsWith(".pem")
    ) {
      violations.push({ file, code: "credential_file" });
      return;
    }
    if (!scannedExtensions.has(extname(name))) return;
    const content = readFileSync(path, "utf8");
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(content)) {
      violations.push({ file, code: "private_key" });
    }
    if (
      /\b(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,})\b/u
        .test(content)
    ) {
      violations.push({ file, code: "secret_token" });
    }
    const emails = content.match(
      /\b[A-Z0-9._%+-]+@(?:[A-Z0-9-]+\.)+[A-Z]{2,}\b/giu,
    ) ?? [];
    if (emails.some((email) => !email.toLowerCase().endsWith(".invalid"))) {
      violations.push({ file, code: "real_email" });
    }
  }
}

export function findArtifactPrivacyViolations(
  value: unknown,
): readonly string[] {
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
      if (/^https?:\/\//iu.test(candidate)) {
        violations.push(`${path}:raw_url`);
      }
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
        visit(child, `${path}[${index}]`, depth + 1)
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
