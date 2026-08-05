import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  useResumeArtifactUpload,
} from "../../src/contracts/index.ts";
import {
  FileBackedStage2ApplicationOwnerSourceResolver,
  type Stage2ApplicationOwnerSourceRequest,
} from "../../src/composition/private/s2-application-owner-source.ts";

const ids = {
  revisionId: "revision_abcdefghijklmnop",
  approvalId: "approval_abcdefghijklmnop",
  journeyId: "journey_abcdefghijklmnop",
  targetHandleId: "target_ref_abcdefghijklmnop",
  profileRef: "profile_ref_abcdefghijklmnop",
  resumeRef: "resume_ref_abcdefghijklmnop",
  approvedAt: "2099-08-05T05:00:00.000Z",
} as const;

test("resolves one immutable resume snapshot and authoritative profile/question source", async () => {
  const fixture = ownerFixture();
  try {
    const bytes = Buffer.from("%PDF-1.7\noriginal owner resume\n", "utf8");
    writeSources(fixture.runtimeRoot, bytes);
    const resolver = new FileBackedStage2ApplicationOwnerSourceResolver({
      forbiddenRoots: [resolve("..")],
    });

    const resolved = await resolver.resolve(request(fixture.runtimeRoot), AbortSignal.any([]));
    assert.equal(Object.isFrozen(resolved.profilePlan), true);
    assert.equal(resolved.profileId, "profile-owner-approved");
    assert.equal(resolved.profileRevision, 3);

    const answer = await resolved.profileQuery.query({
      profileId: resolved.profileId,
      profileRevision: resolved.profileRevision,
      factId: "given_name",
    }, AbortSignal.any([]));
    assert.deepEqual(answer, {
      ok: true,
      value: { kind: "answered", value: "Ada", provenance: "owner_provided" },
    });
    assert.deepEqual(resolved.narrative.resolve("s1-question-configured-narrative"), {
      text: "I build dependable systems.",
      revision: "narrative-v1",
      provenance: "configured_template",
    });

    writeFileSync(join(fixture.runtimeRoot, "application-profile.json"), "{}");
    writeFileSync(join(fixture.runtimeRoot, "application-resume.pdf"), "changed");
    const answerAfterMutation = await resolved.profileQuery.query({
      profileId: resolved.profileId,
      profileRevision: resolved.profileRevision,
      factId: "given_name",
    }, AbortSignal.any([]));
    assert.deepEqual(answerAfterMutation, answer);
    assert.equal(
      resolved.narrative.resolve("s1-question-configured-narrative")?.text,
      "I build dependable systems.",
    );
    const upload = await useResumeArtifactUpload(
      resolved.resumeIntent.artifact,
      (captured) => ({ ok: true as const, value: Buffer.from(captured).toString("utf8") }),
    );
    assert.deepEqual(upload, { ok: true, value: bytes.toString("utf8") });
  } finally {
    fixture.cleanup();
  }
});

test("denies wrong references, bindings, changed bytes, oversized files, and repository scope", async () => {
  const fixture = ownerFixture();
  try {
    const bytes = Buffer.from("%PDF-1.7\nowner resume\n", "utf8");
    writeSources(fixture.runtimeRoot, bytes);
    const resolver = new FileBackedStage2ApplicationOwnerSourceResolver({
      forbiddenRoots: [resolve("..")],
    });
    const base = request(fixture.runtimeRoot);
    for (const changed of [
      { ...base, profileRef: "profile_ref_wrongwrongwrong1" },
      { ...base, resumeRef: "resume_ref_wrongwrongwrong12" },
      { ...base, journeyId: "journey_wrongwrongwrong12" },
      { ...base, revisionId: "revision_wrongwrongwrong1" },
      { ...base, approvalId: "approval_wrongwrongwrong1" },
      { ...base, targetHandleId: "target_ref_wrongwrongwrong" },
    ]) {
      await assert.rejects(
        resolver.resolve(changed as Stage2ApplicationOwnerSourceRequest, AbortSignal.any([])),
        exactDenial,
      );
    }

    const manifestPath = join(fixture.runtimeRoot, "application-profile.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, scope: "account_access" }));
    await assert.rejects(resolver.resolve(base, AbortSignal.any([])), exactDenial);

    writeSources(fixture.runtimeRoot, bytes);
    const injectedPage = JSON.parse(readFileSync(manifestPath, "utf8"));
    injectedPage.questionnaire = { page: "owner-supplied-browser-truth" };
    writeFileSync(manifestPath, JSON.stringify(injectedPage));
    await assert.rejects(resolver.resolve(base, AbortSignal.any([])), exactDenial);

    writeSources(fixture.runtimeRoot, bytes);
    const malformedPlan = JSON.parse(readFileSync(manifestPath, "utf8"));
    malformedPlan.profilePlan.fields[0].questionType = "credential";
    writeFileSync(manifestPath, JSON.stringify(malformedPlan));
    await assert.rejects(resolver.resolve(base, AbortSignal.any([])), exactDenial);

    writeSources(fixture.runtimeRoot, bytes);
    writeFileSync(
      join(fixture.runtimeRoot, "application-resume.pdf"),
      "changed before capture",
    );
    await assert.rejects(resolver.resolve(base, AbortSignal.any([])), exactDenial);

    writeFileSync(
      join(fixture.runtimeRoot, "application-resume.pdf"),
      Buffer.alloc(5 * 1024 * 1024 + 1),
    );
    await assert.rejects(resolver.resolve(base, AbortSignal.any([])), exactDenial);

    writeFileSync(
      join(fixture.runtimeRoot, "application-profile.json"),
      Buffer.alloc(512 * 1024 + 1),
    );
    await assert.rejects(resolver.resolve(base, AbortSignal.any([])), exactDenial);

    writeSources(fixture.runtimeRoot, Buffer.from("not a pdf"));
    await assert.rejects(resolver.resolve(base, AbortSignal.any([])), exactDenial);

    rmSync(join(fixture.runtimeRoot, "application-resume.pdf"));
    await assert.rejects(resolver.resolve(base, AbortSignal.any([])), exactDenial);

    writeSources(fixture.runtimeRoot, bytes);
    const aliasedResume = join(fixture.root, "aliased-resume.pdf");
    linkSync(join(fixture.runtimeRoot, "application-resume.pdf"), aliasedResume);
    await assert.rejects(resolver.resolve(base, AbortSignal.any([])), exactDenial);

    rmSync(aliasedResume);
    const replacement = Buffer.from("%PDF-1.7\nreplacement owner resume\n");
    writeSources(fixture.runtimeRoot, replacement);
    const changedAt = new Date("2099-08-05T05:01:00.000Z");
    utimesSync(join(fixture.runtimeRoot, "application-profile.json"), changedAt, changedAt);
    utimesSync(join(fixture.runtimeRoot, "application-resume.pdf"), changedAt, changedAt);
    await assert.rejects(resolver.resolve(base, AbortSignal.any([])), exactDenial);

    await assert.rejects(
      resolver.resolve({ ...base, runtimeRoot: resolve("..") }, AbortSignal.any([])),
      exactDenial,
    );
  } finally {
    fixture.cleanup();
  }
});

function ownerFixture(): {
  readonly root: string;
  readonly runtimeRoot: string;
  cleanup(): void;
} {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-application-owner-"));
  const runtimeRoot = join(root, "runtime");
  mkdirSync(runtimeRoot);
  return {
    root,
    runtimeRoot,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function request(runtimeRoot: string): Stage2ApplicationOwnerSourceRequest {
  return { ...ids, runtimeRoot };
}

function writeSources(runtimeRoot: string, resumeBytes: Buffer): void {
  const sha256 = createHash("sha256").update(resumeBytes).digest("hex");
  writeFileSync(join(runtimeRoot, "application-resume.pdf"), resumeBytes);
  writeFileSync(join(runtimeRoot, "application-profile.json"), JSON.stringify({
    schemaVersion: 1,
    sourceRevision: "s2-application-owner-source-v1",
    scope: "application_completion",
    ...ids,
    resume: {
      resumeId: "resume-owner-approved",
      sha256,
      sizeBytes: resumeBytes.byteLength,
      fileType: "pdf",
    },
    profile: {
      profileId: "profile-owner-approved",
      revision: 3,
      facts: [
        { factId: "given_name", value: "Ada", provenance: "owner_provided" },
        {
          factId: "configured_narrative",
          value: "I build dependable systems.",
          provenance: "configured_template",
        },
      ],
    },
    profilePlan: {
      pageType: "profile",
      fields: [{
        fieldId: "identity.given_name",
        questionType: "identity",
        answerType: "text",
        answer: { kind: "answered", value: "Ada", provenance: "owner_provided" },
      }],
      repeatables: [],
    },
    narrative: { revision: "narrative-v1" },
  }));
}

function exactDenial(error: unknown): boolean {
  assert.equal(error instanceof Error, true);
  assert.equal((error as Error).message, "application owner source denied");
  return true;
}
