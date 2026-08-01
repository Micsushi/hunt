import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const acceptedF1Base = "f274d9a6624978b61ab1dd1433ebdddfdef029d2";
const repository = resolve(process.cwd(), "..");
const manifestPath = "tests/connections/component-revisions.json";
const f12Paths = [
  "executioner/tests/connections/component-manifest.test.ts",
  "executioner/tests/connections/component-revisions.json",
] as const;
const contractTreeOids = {
  "executioner/src/contracts": "7b7ac5d76b79612a85089f3ca49a8a58f8971541",
  "executioner/src/testing/contracts":
    "b64bef789a3153d496613567a57f9b0a83b70708",
  "executioner/tests/contracts": "4980df277be36fde63711515f47f3ab332d26a89",
  "executioner/tests/security/privacy":
    "24771827d97117615b9360579e3293a05d3784dd",
} as const;
const serializedVersions = {
  fixtureManifest: 2,
  durableJourneyState: 3,
  eventEnvelope: 2,
  errorEnvelope: 2,
  evidenceManifest: 2,
  terminalResult: 3,
  mcpRequest: 2,
  mcpResponse: 3,
} as const;
const acceptedTips = {
  F2: "c6f84dd020359bd62c50b33654b131b0bece41d2",
  F3: "8f7d3096e443cd927f900c1c0bccfaf3d0a5a4d1",
  F4: "d010b402a845285049a29d3d03f013a2fc50f65a",
  F5: "37620784a6d67655d85a8f8466b462b320740975",
  F6: "49ef638431b7b268a564960dfde8bf0d35459fb8",
  F7: "b0a62dbf5e1719089810e502e1386fb57e5d929e",
  F8: "b3cdc5e5cc4c9c3728e814e961735bb624e513d1",
  F9: "a09317752f68ecba5e9864ec2a2994c6f6ffe311",
  F10: "107602245b10204d0a07e34177f2150b51e65b2d",
  F11: "4eec124405df73d01e98590fc9e466b553f92940",
} as const;

type Feature = keyof typeof acceptedTips;

interface ComponentEvidence {
  feature: Feature;
  tip: string;
  tipTreeOid: string;
  pathSetSha256: string;
  conformance: string;
}

interface ComponentManifest {
  schemaVersion: number;
  acceptedF1Base: string;
  contractTreeOids: Record<string, string>;
  serializedVersions: Record<string, number>;
  candidateInputs: CandidateInputs;
  components: ComponentEvidence[];
}

interface CandidateInputs {
  admittedFeatures: Feature[];
  f12Paths: string[];
}

type Git = (cwd: string, args: readonly string[]) => string;

interface AdmissionOptions {
  repository: string;
  candidate?: string;
  candidateWorktree?: string;
  sourceWorktrees?: Partial<Record<Feature, string>>;
  git?: Git;
}

const canonicalManifest = JSON.parse(
  readFileSync(manifestPath, "utf8"),
) as ComponentManifest;

test("the canonical manifest freezes all accepted F2-F11 inputs", () => {
  assert.doesNotThrow(() => assertCanonicalManifest(canonicalManifest));
});

test("the canonical checker accepts manifest-updated cluster inputs", () => {
  const cluster = cloneManifest();
  cluster.candidateInputs = { admittedFeatures: ["F2"], f12Paths: [] };
  assert.doesNotThrow(() => assertCanonicalManifest(cluster, acceptedTips.F2));
});

test("a valid partial cluster proves exact candidate blobs without history assembly", () => {
  const partial = manifestFor("F2");
  partial.candidateInputs = { admittedFeatures: ["F2"], f12Paths: [] };
  assert.doesNotThrow(() =>
    assertComponentManifest(partial, {
      repository,
      candidate: acceptedTips.F2,
    }),
  );
});

test("a wrong F1 SHA fails with a stable diagnostic", () => {
  const manifest = cloneManifest();
  manifest.acceptedF1Base = "0".repeat(40);
  assert.throws(
    () => assertComponentManifest(manifest, { repository }),
    /^Error: accepted F1 base mismatch$/u,
  );
});

test("missing component evidence fails with a stable diagnostic", () => {
  const manifest = cloneManifest();
  delete (manifest.components[0] as Partial<ComponentEvidence>).tipTreeOid;
  assert.throws(
    () => assertComponentManifest(manifest, { repository }),
    /^Error: component evidence missing: F2: tipTreeOid$/u,
  );
});

test("a serialized version mismatch fails with a stable diagnostic", () => {
  const manifest = cloneManifest();
  manifest.serializedVersions.terminalResult = 2;
  assert.throws(
    () => assertComponentManifest(manifest, { repository }),
    /^Error: serialized version mismatch: terminalResult: expected 3, received 2$/u,
  );
});

test("a contract tree mismatch fails with a stable diagnostic", () => {
  const manifest = cloneManifest();
  manifest.contractTreeOids["executioner/src/contracts"] = "0".repeat(40);
  assert.throws(
    () => assertComponentManifest(manifest, { repository }),
    /^Error: contract tree evidence mismatch: executioner\/src\/contracts$/u,
  );
});

test("a duplicate feature fails with a stable diagnostic", () => {
  const manifest = cloneManifest();
  manifest.components.push(structuredClone(manifest.components[0]!));
  assert.throws(
    () => assertComponentManifest(manifest, { repository }),
    /^Error: duplicate component feature: F2$/u,
  );
});

test("a non-descendant component tip fails with a stable diagnostic", () => {
  const git: Git = (cwd, args) => {
    if (
      args[0] === "merge-base" &&
      args[1] === "--is-ancestor" &&
      args[3] === acceptedTips.F2
    ) {
      throw new Error("not an ancestor");
    }
    return nativeGit(cwd, args);
  };
  assert.throws(
    () => assertComponentManifest(manifestFor("F2"), { repository, git }),
    /^Error: component tip is not descended from accepted F1 base: F2$/u,
  );
});

test("skipped conformance fails with a stable diagnostic", () => {
  const manifest = cloneManifest();
  manifest.components[0]!.conformance = "skipped";
  assert.throws(
    () => assertComponentManifest(manifest, { repository }),
    /^Error: component conformance not passed: F2$/u,
  );
});

test("a dirty candidate worktree fails with a stable diagnostic", () => {
  const git: Git = (cwd, args) =>
    cwd === "dirty-candidate" && args[0] === "status"
      ? " M executioner/tests/connections/component-revisions.json\n"
      : nativeGit(repository, args);
  assert.throws(
    () =>
      assertComponentManifest(canonicalManifest, {
        repository,
        candidateWorktree: "dirty-candidate",
        git,
      }),
    /^Error: dirty candidate worktree$/u,
  );
});

test("a dirty component source worktree fails with a stable diagnostic", () => {
  const git: Git = (cwd, args) =>
    cwd === "dirty-f2-source" && args[0] === "status"
      ? "?? executioner/src/fixture/untracked.ts\n"
      : nativeGit(repository, args);
  assert.throws(
    () =>
      assertComponentManifest(candidateManifest(["F2"]), {
        repository,
        candidate: acceptedTips.F2,
        sourceWorktrees: { F2: "dirty-f2-source" },
        git,
      }),
    /^Error: dirty component source worktree: F2$/u,
  );
});

test("a candidate with another component's content fails closed", () => {
  assert.throws(
    () =>
      assertComponentManifest(candidateManifest(["F2"]), {
        repository,
        candidate: acceptedTips.F3,
      }),
    /^Error: candidate component blob mismatch: F2:/u,
  );
});

test("malformed candidate inputs fail with stable closed diagnostics", () => {
  const missing = cloneManifest() as Partial<ComponentManifest>;
  delete missing.candidateInputs;
  assert.throws(
    () => assertComponentManifest(missing as ComponentManifest, { repository }),
    /^Error: candidate input evidence missing$/u,
  );

  const extraKey = cloneManifest();
  (extraKey.candidateInputs as CandidateInputs & { extra: boolean }).extra = true;
  assert.throws(
    () => assertComponentManifest(extraKey, { repository }),
    /^Error: candidate input keys mismatch$/u,
  );

  const duplicateFeature = cloneManifest();
  duplicateFeature.candidateInputs.admittedFeatures = ["F2", "F2"];
  assert.throws(
    () => assertComponentManifest(duplicateFeature, { repository }),
    /^Error: duplicate candidate component: F2$/u,
  );

  const unknownFeature = cloneManifest();
  unknownFeature.candidateInputs.admittedFeatures = ["F12" as Feature];
  assert.throws(
    () => assertComponentManifest(unknownFeature, { repository }),
    /^Error: unknown candidate component: F12$/u,
  );

  const duplicatePath = cloneManifest();
  duplicatePath.candidateInputs.f12Paths = [f12Paths[0], f12Paths[0]];
  assert.throws(
    () => assertComponentManifest(duplicatePath, { repository }),
    new RegExp(`^Error: duplicate F12 candidate path: ${f12Paths[0]}$`, "u"),
  );

  const unownedPath = cloneManifest();
  unownedPath.candidateInputs.f12Paths = ["executioner/src/orchestrator.ts"];
  assert.throws(
    () => assertComponentManifest(unownedPath, { repository }),
    /^Error: unowned F12 candidate path: executioner\/src\/orchestrator\.ts$/u,
  );
});

function assertComponentManifest(
  manifest: ComponentManifest,
  options: AdmissionOptions,
): void {
  const git = options.git ?? nativeGit;
  const candidate = options.candidate ?? "HEAD";

  if (manifest.schemaVersion !== 1) {
    throw new Error("component manifest schema mismatch");
  }
  if (manifest.acceptedF1Base !== acceptedF1Base) {
    throw new Error("accepted F1 base mismatch");
  }
  assertAuthorityMap(
    manifest.contractTreeOids,
    contractTreeOids,
    "contract tree evidence mismatch",
  );
  assertAuthorityMap(
    manifest.serializedVersions,
    serializedVersions,
    "serialized version mismatch",
  );
  assertCandidateInputs(manifest.candidateInputs);
  const admitted = manifest.candidateInputs.admittedFeatures;
  const allowedF12Paths = new Set(manifest.candidateInputs.f12Paths);
  if (!Array.isArray(manifest.components)) {
    throw new Error("component evidence missing");
  }

  const components = new Map<Feature, ComponentEvidence>();
  const ownedPaths = new Map<Feature, string[]>();
  const ownerByPath = new Map<string, Feature>();
  for (const component of manifest.components) {
    assertComponentEvidence(component);
    if (components.has(component.feature)) {
      throw new Error(`duplicate component feature: ${component.feature}`);
    }
    components.set(component.feature, component);
    if (component.tip !== acceptedTips[component.feature]) {
      throw new Error(`component tip mismatch: ${component.feature}`);
    }
    if (component.conformance !== "passed") {
      throw new Error(`component conformance not passed: ${component.feature}`);
    }
    assertAncestor(
      acceptedF1Base,
      component.tip,
      options.repository,
      git,
      `component tip is not descended from accepted F1 base: ${component.feature}`,
    );
    assertFrozenRoots(component.tip, manifest, options.repository, git);
    const actualTree = git(options.repository, [
      "rev-parse",
      `${component.tip}^{tree}`,
    ]).trim();
    if (actualTree !== component.tipTreeOid) {
      throw new Error(`component tip tree mismatch: ${component.feature}`);
    }
    const paths = changedPaths(
      acceptedF1Base,
      component.tip,
      options.repository,
      git,
    );
    if (hashPaths(paths) !== component.pathSetSha256) {
      throw new Error(`component path evidence mismatch: ${component.feature}`);
    }
    for (const path of paths) {
      const other = ownerByPath.get(path);
      if (other !== undefined) {
        throw new Error(`component path overlap: ${other}/${component.feature}: ${path}`);
      }
      ownerByPath.set(path, component.feature);
    }
    ownedPaths.set(component.feature, paths);
  }

  assertAncestor(
    acceptedF1Base,
    candidate,
    options.repository,
    git,
    "candidate is not descended from accepted F1 base",
  );
  assertFrozenRoots(candidate, manifest, options.repository, git);
  assertCleanWorktree(options.candidateWorktree, "dirty candidate worktree", git);

  const expectedPaths = new Set<string>();
  for (const path of allowedF12Paths) {
    expectedPaths.add(path);
  }
  for (const feature of admitted) {
    const component = components.get(feature);
    if (component === undefined) {
      throw new Error(`component admission evidence missing: ${feature}`);
    }
    const source = options.sourceWorktrees?.[feature];
    if (options.sourceWorktrees !== undefined) {
      if (source === undefined) {
        throw new Error(`component source worktree missing: ${feature}`);
      }
      assertCleanWorktree(source, `dirty component source worktree: ${feature}`, git);
    }
    for (const path of ownedPaths.get(feature)!) {
      expectedPaths.add(path);
      const candidateBlob = revisionBlob(candidate, path, options.repository, git);
      const ownerBlob = revisionBlob(component.tip, path, options.repository, git);
      if (candidateBlob !== ownerBlob) {
        throw new Error(`candidate component blob mismatch: ${feature}: ${path}`);
      }
    }
  }

  const candidatePaths = changedPaths(
    acceptedF1Base,
    candidate,
    options.repository,
    git,
  );
  const missing = [...expectedPaths].find((path) => !candidatePaths.includes(path));
  if (missing !== undefined) {
    throw new Error(`candidate path set mismatch: missing ${missing}`);
  }
  const unexpected = candidatePaths.find((path) => !expectedPaths.has(path));
  if (unexpected !== undefined) {
    throw new Error(`candidate path set mismatch: unexpected ${unexpected}`);
  }
}

function assertCanonicalManifest(
  manifest: ComponentManifest,
  candidate = "HEAD",
): void {
  assert.deepEqual(
    manifest.components.map(({ feature }) => feature),
    Object.keys(acceptedTips),
  );
  assertComponentManifest(manifest, { repository, candidate });
}

function assertCandidateInputs(
  value: CandidateInputs | undefined,
): asserts value is CandidateInputs {
  if (value === undefined || value === null || typeof value !== "object") {
    throw new Error("candidate input evidence missing");
  }
  if (
    Object.keys(value).sort().join("\n") !==
    ["admittedFeatures", "f12Paths"].sort().join("\n")
  ) {
    throw new Error("candidate input keys mismatch");
  }
  if (!Array.isArray(value.admittedFeatures) || !Array.isArray(value.f12Paths)) {
    throw new Error("candidate input evidence missing");
  }
  const features = new Set<string>();
  for (const feature of value.admittedFeatures) {
    if (!Object.hasOwn(acceptedTips, feature)) {
      throw new Error(`unknown candidate component: ${feature}`);
    }
    if (features.has(feature)) {
      throw new Error(`duplicate candidate component: ${feature}`);
    }
    features.add(feature);
  }
  const paths = new Set<string>();
  for (const path of value.f12Paths) {
    if (
      typeof path !== "string" ||
      (!/^executioner\/tests\/connections\/[a-zA-Z0-9._/-]+$/u.test(path) &&
        path !== "executioner/scripts/run-s1-connections.ts") ||
      path.includes("/../")
    ) {
      throw new Error(`unowned F12 candidate path: ${String(path)}`);
    }
    if (paths.has(path)) {
      throw new Error(`duplicate F12 candidate path: ${path}`);
    }
    paths.add(path);
  }
}

function assertComponentEvidence(
  component: Partial<ComponentEvidence>,
): asserts component is ComponentEvidence {
  const feature = component.feature ?? "unknown";
  if (!(feature in acceptedTips)) {
    throw new Error(`unknown component feature: ${feature}`);
  }
  for (const field of ["tip", "tipTreeOid", "pathSetSha256"] as const) {
    if (!/^[0-9a-f]{40}$/u.test(component[field] ?? "") && field !== "pathSetSha256") {
      throw new Error(`component evidence missing: ${feature}: ${field}`);
    }
    if (field === "pathSetSha256" && !/^[0-9a-f]{64}$/u.test(component[field] ?? "")) {
      throw new Error(`component evidence missing: ${feature}: ${field}`);
    }
  }
  if (typeof component.conformance !== "string") {
    throw new Error(`component evidence missing: ${feature}: conformance`);
  }
}

function assertAuthorityMap(
  actual: Record<string, string | number>,
  expected: Readonly<Record<string, string | number>>,
  diagnostic: string,
): void {
  if (Object.keys(actual).sort().join("\n") !== Object.keys(expected).sort().join("\n")) {
    throw new Error(diagnostic);
  }
  for (const [name, value] of Object.entries(expected)) {
    if (actual[name] !== value) {
      if (diagnostic === "serialized version mismatch") {
        throw new Error(
          `${diagnostic}: ${name}: expected ${value}, received ${String(actual[name])}`,
        );
      }
      throw new Error(`${diagnostic}: ${name}`);
    }
  }
}

function assertFrozenRoots(
  revision: string,
  manifest: ComponentManifest,
  repositoryPath: string,
  git: Git,
): void {
  for (const [path, expected] of Object.entries(manifest.contractTreeOids)) {
    const actual = git(repositoryPath, ["rev-parse", `${revision}:${path}`]).trim();
    if (actual !== expected) {
      throw new Error(`frozen root mismatch: ${path}: ${revision}`);
    }
  }
}

function assertAncestor(
  ancestor: string,
  descendant: string,
  repositoryPath: string,
  git: Git,
  diagnostic: string,
): void {
  try {
    git(repositoryPath, ["merge-base", "--is-ancestor", ancestor, descendant]);
  } catch {
    throw new Error(diagnostic);
  }
}

function assertCleanWorktree(
  worktree: string | undefined,
  diagnostic: string,
  git: Git,
): void {
  if (
    worktree !== undefined &&
    git(worktree, ["status", "--porcelain", "--untracked-files=all"]).trim() !== ""
  ) {
    throw new Error(diagnostic);
  }
}

function changedPaths(
  base: string,
  revision: string,
  repositoryPath: string,
  git: Git,
): string[] {
  return git(repositoryPath, ["diff", "--name-only", base, revision])
    .split(/\r?\n/u)
    .filter(Boolean)
    .sort();
}

function revisionBlob(
  revision: string,
  path: string,
  repositoryPath: string,
  git: Git,
): string {
  try {
    return git(repositoryPath, ["rev-parse", `${revision}:${path}`]).trim();
  } catch {
    return "missing";
  }
}

function hashPaths(paths: readonly string[]): string {
  return createHash("sha256").update(`${paths.join("\n")}\n`).digest("hex");
}

function nativeGit(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function cloneManifest(): ComponentManifest {
  return structuredClone(canonicalManifest);
}

function manifestFor(...features: Feature[]): ComponentManifest {
  const selected = new Set(features);
  return {
    ...cloneManifest(),
    components: cloneManifest().components.filter(({ feature }) =>
      selected.has(feature),
    ),
  };
}

function candidateManifest(features: Feature[]): ComponentManifest {
  const manifest = manifestFor(...features);
  manifest.candidateInputs = { admittedFeatures: features, f12Paths: [] };
  return manifest;
}
