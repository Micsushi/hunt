import { globSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import * as ts from "typescript";

export interface SourceFile {
  path: string;
  source: string;
}

const owners: ReadonlyArray<readonly [RegExp, string]> = [
  [/^src\/contracts(?:\/|$)/, "contracts"],
  [/^src\/testing\/contracts(?:\/|$)/, "test-kit"],
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
  [/^tests(?:\/|$)/, "tests"],
];

const legacyRoots = /^(?:src\/)?(?:background|content|options|popup|shared)(?:\/|$)/;
const legacyVersion = /(?:^|[/.-])v2(?:[/.-]|$)/;

function owner(path: string): string | undefined {
  return owners.find(([pattern]) => pattern.test(path))?.[1];
}

function moduleSpecifiers(file: SourceFile): string[] {
  const source = ts.createSourceFile(
    file.path,
    file.source,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
  );
  const specifiers: string[] = [];

  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    ) {
      specifiers.push(node.argument.literal.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0]!)
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  return specifiers;
}

export function dependencyViolations(files: readonly SourceFile[]): string[] {
  return files.flatMap((file) => {
    const importerOwner = owner(file.path);
    if (importerOwner === undefined) {
      return [`${file.path} has no component owner`];
    }

    return moduleSpecifiers(file).flatMap((specifier) => {
      if (!specifier.startsWith(".")) {
        return [];
      }

      const target = posix.normalize(
        posix.join(posix.dirname(file.path), specifier),
      );
      if (legacyRoots.test(target) || legacyVersion.test(target)) {
        return [`${file.path} imports C3 v2 path ${target}`];
      }

      const targetOwner = owner(target);
      if (targetOwner === undefined) {
        return [`${file.path} imports unowned source ${target}`];
      }
      if (targetOwner === "test-kit" && importerOwner !== "tests") {
        return [`${file.path} imports test-only source ${target}`];
      }
      if (
        targetOwner !== "contracts" &&
        importerOwner !== "composition" &&
        importerOwner !== "tests" &&
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
