import { globSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import * as ts from "typescript";

import { componentBoundaries } from "../../src/contracts/ownership.ts";

export interface SourceFile {
  path: string;
  source: string;
}

type ModuleReference =
  | { kind: "module"; path: string }
  | { kind: "path"; path: string }
  | { kind: "nonliteral-dynamic" };

const fixedOwners: ReadonlyArray<readonly [RegExp, string]> = [
  [/^src\/contracts(?:\/|$)/, "contracts"],
  [/^src\/testing\/(?:contracts|live)(?:\/|$)/, "test-kit"],
  [/^src\/testing\/s2-revision\.ts$/, "test-kit"],
  [/^src\/live\/preflight(?:\/|$)/, "live-preflight"],
  [/^src\/composition(?:\/|$)/, "composition"],
  [/^tests(?:\/|$)/, "tests"],
];

export const componentSourceOwners = componentBoundaries.flatMap(
  ({ feature, sourceOwnership }) =>
    sourceOwnership.map((pattern) => ({ pattern, owner: feature })),
);

const legacyRoots = /^(?:src\/)?(?:background|content|options|popup|shared)(?:\/|$)/;
const legacyVersion = /(?:^|[/.-])v2(?:[/.-]|$)/;

function owner(path: string): string | undefined {
  const fixedOwner = fixedOwners.find(([pattern]) => pattern.test(path))?.[1];
  if (fixedOwner !== undefined) {
    return fixedOwner;
  }

  return componentSourceOwners.find(({ pattern }) => {
    const directory = pattern.endsWith("/**")
      ? pattern.slice(0, -3)
      : undefined;
    return directory === undefined
      ? path === pattern
      : path === directory || path.startsWith(`${directory}/`);
  })?.owner;
}

function moduleReferences(file: SourceFile): ModuleReference[] {
  const source = ts.createSourceFile(
    file.path,
    file.source,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
  );
  const references: ModuleReference[] = source.referencedFiles.map(
    ({ fileName }) => ({ kind: "path", path: fileName }),
  );

  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      references.push({ kind: "module", path: node.moduleSpecifier.text });
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    ) {
      references.push({ kind: "module", path: node.argument.literal.text });
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const firstArgument = node.arguments[0];
      references.push(
        firstArgument !== undefined && ts.isStringLiteralLike(firstArgument)
          ? { kind: "module", path: firstArgument.text }
          : { kind: "nonliteral-dynamic" },
      );
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  return references;
}

export function dependencyViolations(files: readonly SourceFile[]): string[] {
  return files.flatMap((file) => {
    const importerOwner = owner(file.path);
    if (importerOwner === undefined) {
      return [`${file.path} has no component owner`];
    }

    return moduleReferences(file).flatMap((reference) => {
      if (reference.kind === "nonliteral-dynamic") {
        return [`${file.path} uses a nonliteral dynamic import`];
      }
      if (reference.kind === "module" && !reference.path.startsWith(".")) {
        return [];
      }

      const target = posix.normalize(
        posix.join(posix.dirname(file.path), reference.path),
      );
      if (legacyRoots.test(target) || legacyVersion.test(target)) {
        return [`${file.path} imports C3 v2 path ${target}`];
      }

      const targetOwner = owner(target);
      if (targetOwner === undefined) {
        return [`${file.path} imports unowned source ${target}`];
      }
      if (
        targetOwner === "contracts" ||
        targetOwner === importerOwner ||
        importerOwner === "tests"
      ) {
        return [];
      }
      if (targetOwner === "test-kit" || targetOwner === "tests") {
        return [`${file.path} imports test-only source ${target}`];
      }
      if (importerOwner === "composition") {
        return [];
      }

      return [`${file.path} imports peer implementation ${target}`];
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
