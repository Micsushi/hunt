import { globSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";

export interface SourceFile {
  path: string;
  source: string;
}

const owners: ReadonlyArray<readonly [RegExp, string]> = [
  [/^src\/contracts(?:\/|$)/, "contracts"],
  [/^src\/testing\/contracts(?:\/|$)/, "contracts"],
  [/^src\/testing\/fixture-(?:server|state)\.ts$/, "fixtures"],
  [/^src\/browser(?:\/|$)/, "browser"],
  [/^src\/(?:intake|profile|journey)(?:\/|$)/, "state"],
  [/^src\/ats(?:\/|$)/, "understanding"],
  [/^src\/form\/(?:discovery|ui)(?:\/|$)/, "understanding"],
  [/^src\/form\/semantic-snapshot\.ts$/, "understanding"],
  [/^src\/form\/(?:questions|answers|options)(?:\/|$)/, "answers"],
  [/^src\/interaction\/drivers(?:\/|$)/, "drivers"],
  [/^src\/interaction\/(?:verification|completion|navigation)(?:\/|$)/, "verification"],
  [/^src\/control\/(?:orchestrator|mcp)(?:\/|$)/, "orchestrator"],
  [/^src\/observability(?:\/|$)/, "observability"],
  [/^src\/(?:safety|evidence)(?:\/|$)/, "safety"],
  [/^src\/control\/model(?:\/|$)/, "safety"],
  [/^src\/composition(?:\/|$)/, "composition"],
];

const legacyRoots = /^(?:src\/)?(?:background|content|options|popup|shared)(?:\/|$)/;
const legacyVersion = /(?:^|[/.-])v2(?:[/.-]|$)/;
const imports =
  /(?:import|export)\s+(?:[^'"]*?\s+from\s*)?["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;

function owner(path: string): string | undefined {
  return owners.find(([pattern]) => pattern.test(path))?.[1];
}

export function dependencyViolations(files: readonly SourceFile[]): string[] {
  return files.flatMap((file) => {
    const importerOwner = owner(file.path);

    return [...file.source.matchAll(imports)].flatMap((match) => {
      const specifier = match[1] ?? match[2];
      if (!specifier?.startsWith(".")) {
        return [];
      }

      const target = posix.normalize(
        posix.join(posix.dirname(file.path), specifier),
      );
      if (legacyRoots.test(target) || legacyVersion.test(target)) {
        return [`${file.path} imports C3 v2 path ${target}`];
      }

      const targetOwner = owner(target);
      if (
        targetOwner !== undefined &&
        targetOwner !== "contracts" &&
        importerOwner !== "composition" &&
        targetOwner !== importerOwner
      ) {
        return [`${file.path} imports peer implementation ${target}`];
      }

      return [];
    });
  });
}

export function sourceFiles(root: string): SourceFile[] {
  return globSync("**/*.ts", { cwd: root }).map((relativePath) => ({
    path: posix.join(
      root.replaceAll("\\", "/"),
      relativePath.replaceAll("\\", "/"),
    ),
    source: readFileSync(join(root, relativePath), "utf8"),
  }));
}
