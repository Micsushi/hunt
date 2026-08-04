export interface PackageLock {
  readonly name: string;
  readonly version: string;
  readonly packages: Readonly<Record<string, { readonly version?: string; readonly dev?: boolean }>>;
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
      return normalized !== "package.json" &&
        normalized !== "README.md" &&
        normalized !== "docs/corpus-release.md" &&
        !/^src\/.+\.ts$/u.test(normalized);
    })
    .sort();
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
      component: { type: "application", name: lock.name, version: lock.version },
    },
    components: Object.freeze(components),
  });
}
