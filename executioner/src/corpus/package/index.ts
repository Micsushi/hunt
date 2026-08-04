export interface PackageLock {
  readonly name: string;
  readonly version: string;
  readonly packages: Readonly<Record<string, { readonly name?: string; readonly version?: string; readonly dev?: boolean }>>;
}

export function verifyPackageManifest(value: unknown): readonly string[] {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    return ["package_manifest_invalid"];
  }
  const manifest = value as Record<string, unknown>;
  const exports = manifest.exports;
  if (
    manifest.name !== "@hunt/executioner" ||
    typeof manifest.version !== "string" ||
    manifest.private !== true ||
    exports === null ||
    Array.isArray(exports) ||
    typeof exports !== "object"
  ) return ["package_manifest_invalid"];
  const entries = Object.entries(exports as Record<string, unknown>);
  const mcp = entries[0]?.[1];
  return entries.length === 1 &&
    entries[0]?.[0] === "./mcp" &&
    mcp !== null &&
    !Array.isArray(mcp) &&
    typeof mcp === "object" &&
    Object.keys(mcp).length === 2 &&
    (mcp as Record<string, unknown>).types === "./dist/control/mcp/index.d.ts" &&
    (mcp as Record<string, unknown>).import === "./dist/control/mcp/index.js"
    ? []
    : ["package_exports_invalid"];
}

export function verifyReproduciblePackage(first: string, second: string): readonly string[] {
  return /^[0-9a-f]{64}$/u.test(first) && first === second
    ? []
    : ["package_not_reproducible"];
}

export interface PackageSbom {
  readonly bomFormat: "CycloneDX";
  readonly specVersion: "1.5";
  readonly version: 1;
  readonly metadata: {
    readonly component: { readonly type: "application"; readonly name: string; readonly version: string };
  };
  readonly components: readonly {
    readonly type: "library";
    readonly name: string;
    readonly version: string;
  }[];
}

export function verifyPackageFileList(files: readonly string[]): readonly string[] {
  return files
    .filter((path) => {
      const normalized = path.replaceAll("\\", "/").replace(/^package\//u, "");
      return normalized.startsWith("/") ||
        normalized.split("/").includes("..") ||
        (normalized !== "package.json" &&
        normalized !== "README.md" &&
        normalized !== "docs/corpus-release.md" &&
        normalized !== "docs/corpus-acceptance-summary.md" &&
        !/^dist\/.+\.(?:js|d\.ts)$/u.test(normalized));
    })
    .sort();
}

export function findPackageContentViolations(
  contents: ReadonlyMap<string, string>,
): readonly string[] {
  const violations: string[] = [];
  for (const [path, content] of contents) {
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(content)) {
      violations.push(`${path}:private_key`);
    }
    if (/\b(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,})\b/u.test(content)) {
      violations.push(`${path}:secret_token`);
    }
    const emails = content.match(/\b[A-Z0-9._%+-]+@(?:[A-Z0-9-]+\.)+[A-Z]{2,}\b/giu) ?? [];
    if (emails.some((email) => !email.toLowerCase().endsWith(".invalid"))) {
      violations.push(`${path}:real_email`);
    }
  }
  return violations.sort();
}

export function createPackageSbom(lock: PackageLock): PackageSbom {
  const components = Object.entries(lock.packages)
    .filter(([path, value]) => path.startsWith("node_modules/") && value.version !== undefined && value.dev !== true)
    .map(([path, value]) => ({
      type: "library" as const,
      name: path.slice("node_modules/".length),
      version: value.version!,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  return Object.freeze({
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    version: 1,
    metadata: {
      component: { type: "application" as const, name: lock.name, version: lock.version },
    },
    components: Object.freeze(components),
  });
}
