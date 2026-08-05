import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  captureResumeArtifact,
  upstreamResumeId,
} from "../../../../src/contracts/index.ts";
import {
  createWorkdayResumeFileIntent,
  createWorkdayResumeUploadDriver,
  createWorkdayResumeUploadHandler,
  createWorkdayResumeVerifier,
  type WorkdayResumeFileIntent,
} from "../../../../src/ats/workday/application/resume/index.ts";

const fixturePath = new URL(
  "./fixtures/workday-resume-upload-v1.html",
  import.meta.url,
);

async function fixture(): Promise<{ browser: Browser; page: Page }> {
  const source = await readFile(fixturePath, "utf8");
  assert.match(source, /data-automation-id="file-upload-input-ref"/u);
  assert.match(source, /dataset\.automationId = "file-upload-item"/u);
  assert.match(source, /dataset\.uploadState = "success"/u);
  return { browser: { close: async () => undefined }, page: new ResumeFixturePage() };
}

interface Browser {
  close(): Promise<void>;
}

interface Page {
  locator(selector: string): ResumeFixtureLocator;
}

class ResumeFixturePage implements Page {
  uploadEffects = 0;
  deleteEffects = 0;
  uploadedFileCount = 0;
  uploadComplete = false;
  requiredErrorVisible = true;
  bytes = new Uint8Array();
  fileType = "";

  locator(selector: string): ResumeFixtureLocator {
    return new ResumeFixtureLocator(this, selector);
  }

  seed(bytes: Uint8Array): void {
    this.setFile(bytes, "application/pdf");
  }

  setFile(bytes: Uint8Array, fileType: string): void {
    this.uploadEffects += 1;
    this.bytes = Uint8Array.from(bytes);
    this.fileType = fileType;
    this.uploadedFileCount = 1;
    this.uploadComplete = true;
    this.requiredErrorVisible = false;
  }

  remove(): void {
    this.deleteEffects += 1;
    this.bytes.fill(0);
    this.bytes = new Uint8Array();
    this.fileType = "";
    this.uploadedFileCount = 0;
    this.uploadComplete = false;
    this.requiredErrorVisible = true;
  }
}

class ResumeFixtureLocator {
  private readonly page: ResumeFixturePage;
  private readonly selector: string;

  constructor(
    page: ResumeFixturePage,
    selector: string,
  ) {
    this.page = page;
    this.selector = selector;
  }

  async count(): Promise<number> {
    if (this.selector.includes("file-upload-input-ref")) return 1;
    if (this.selector.includes("file-upload-item")) return this.page.uploadedFileCount;
    if (this.selector.includes("file-upload-success")) return this.page.uploadComplete ? 1 : 0;
    if (this.selector.includes("delete-file")) return this.page.uploadedFileCount;
    if (this.selector.includes("file-upload-error")) return 1;
    return 0;
  }

  async isVisible(): Promise<boolean> {
    return this.selector.includes("file-upload-error")
      ? this.page.requiredErrorVisible
      : await this.count() === 1;
  }

  async click(): Promise<void> {
    if (this.selector.includes("delete-file")) this.page.remove();
  }

  async setInputFiles(file: {
    readonly mimeType: string;
    readonly buffer: Buffer;
  }): Promise<void> {
    this.page.setFile(file.buffer, file.mimeType);
  }

  async evaluate<Result, Argument>(
    _operation: (element: HTMLElement, argument: Argument) => Result | Promise<Result>,
    argument: Argument,
  ): Promise<Result> {
    const expected = argument as {
      readonly sha256: string;
      readonly sizeBytes: number;
      readonly mimeType: string;
    };
    const sha256 = createHash("sha256").update(this.page.bytes).digest("hex");
    return {
      fileCount: this.page.uploadedFileCount,
      identityMatches: this.page.uploadedFileCount === 1 &&
        this.page.bytes.byteLength === expected.sizeBytes &&
        this.page.fileType === expected.mimeType &&
        sha256 === expected.sha256,
    } as Result;
  }
}

function intent(
  value = "synthetic selected resume",
  artifactId = "resume_0123456789abcdef",
): { readonly intent: WorkdayResumeFileIntent; readonly bytes: Uint8Array } {
  const bytes = new TextEncoder().encode(value);
  const resumeId = upstreamResumeId(artifactId);
  const captured = captureResumeArtifact({
    resumeId,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  }, bytes);
  assert.equal(captured.ok, true);
  if (!captured.ok) throw new Error("capture failed");
  const created = createWorkdayResumeFileIntent({
    artifactId: resumeId,
    artifact: captured.value,
    fileType: "pdf",
  });
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error("intent failed");
  return { intent: created.value, bytes };
}

test("uploads and independently identifies the exact selected resume", async () => {
  const { browser, page } = await fixture();
  try {
    const selected = intent();
    selected.bytes.fill(0);
    const events: unknown[] = [];
    const handler = createWorkdayResumeUploadHandler({
      driver: createWorkdayResumeUploadDriver(page),
      verifier: createWorkdayResumeVerifier(page, {
        maxAttempts: 3,
        intervalMs: 0,
      }),
      replaceExisting: true,
      emit: (event) => events.push(event),
    });

    const result = await handler.upload(
      selected.intent,
      new AbortController().signal,
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.value, {
      schemaVersion: 1,
      checkpoint: "resume_verified",
      artifactId: selected.intent.artifactId,
      sizeBytes: selected.intent.sizeBytes,
      fileType: "pdf",
      browserState: {
        variant: "workday_resume_file_upload_v1",
        inputCardinality: 1,
        uploadedFileCount: 1,
        uploadComplete: true,
        requiredErrorVisible: false,
        removeControlCardinality: 1,
      },
      independentlyVerified: true,
      duplicateUploadAvoided: false,
      replacedExisting: false,
      submitActivated: false,
      privacyScan: "pass",
    });
    assert.equal((page as ResumeFixturePage).uploadEffects, 1);

    const serialized = JSON.stringify({ evidence: result.value, events });
    assert.doesNotMatch(serialized, /synthetic selected resume|\.pdf|[a-f0-9]{64}|path|filename|digest/iu);
  } finally {
    await browser.close();
  }
});

test("avoids a duplicate upload after independent pre-verification", async () => {
  const { browser, page } = await fixture();
  try {
    const first = intent();
    const firstHandler = createWorkdayResumeUploadHandler({
      driver: createWorkdayResumeUploadDriver(page),
      verifier: createWorkdayResumeVerifier(page, { intervalMs: 0 }),
      replaceExisting: true,
    });
    assert.equal((await firstHandler.upload(first.intent, new AbortController().signal)).ok, true);

    const duplicate = intent();
    const duplicateResult = await createWorkdayResumeUploadHandler({
      driver: createWorkdayResumeUploadDriver(page),
      verifier: createWorkdayResumeVerifier(page, { intervalMs: 0 }),
      replaceExisting: true,
    }).upload(duplicate.intent, new AbortController().signal);

    assert.equal(duplicateResult.ok, true);
    if (duplicateResult.ok) {
      assert.equal(duplicateResult.value.duplicateUploadAvoided, true);
      assert.equal(duplicateResult.value.replacedExisting, false);
    }
    assert.equal((page as ResumeFixturePage).uploadEffects, 1);
  } finally {
    await browser.close();
  }
});

test("rejects replay of the exact consumed artifact handle", async () => {
  const { browser, page } = await fixture();
  try {
    const selected = intent();
    const handler = createWorkdayResumeUploadHandler({
      driver: createWorkdayResumeUploadDriver(page),
      verifier: createWorkdayResumeVerifier(page, { intervalMs: 0 }),
      replaceExisting: true,
    });
    assert.equal((await handler.upload(
      selected.intent,
      new AbortController().signal,
    )).ok, true);

    const replacementHandler = createWorkdayResumeUploadHandler({
      driver: createWorkdayResumeUploadDriver(page),
      verifier: createWorkdayResumeVerifier(page, { intervalMs: 0 }),
      replaceExisting: true,
    });
    assert.deepEqual(await replacementHandler.upload(
      selected.intent,
      new AbortController().signal,
    ), {
      ok: false,
      error: { code: "artifact_already_consumed", retryable: false },
    });
    assert.equal((page as ResumeFixturePage).uploadEffects, 1);
  } finally {
    await browser.close();
  }
});

test("rejects a forged file intent before any browser side effect", async () => {
  const { browser, page } = await fixture();
  try {
    const selected = intent();
    const forged = Object.freeze({ ...selected.intent });
    const result = await createWorkdayResumeUploadHandler({
      driver: createWorkdayResumeUploadDriver(page),
      verifier: createWorkdayResumeVerifier(page, { intervalMs: 0 }),
      replaceExisting: true,
    }).upload(forged, new AbortController().signal);

    assert.deepEqual(result, {
      ok: false,
      error: { code: "artifact_handle_invalid", retryable: false },
    });
    assert.equal((page as ResumeFixturePage).uploadEffects, 0);
  } finally {
    await browser.close();
  }
});

test("replaces one independently mismatched existing upload without duplicates", async () => {
  const { browser, page } = await fixture();
  try {
    (page as ResumeFixturePage).seed(new TextEncoder().encode("different artifact"));
    const selected = intent();
    const result = await createWorkdayResumeUploadHandler({
      driver: createWorkdayResumeUploadDriver(page),
      verifier: createWorkdayResumeVerifier(page, { intervalMs: 0 }),
      replaceExisting: true,
    }).upload(selected.intent, new AbortController().signal);

    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value.replacedExisting, true);
    assert.equal((page as ResumeFixturePage).uploadedFileCount, 1);
    assert.deepEqual({
      uploads: (page as ResumeFixturePage).uploadEffects,
      deletes: (page as ResumeFixturePage).deleteEffects,
    }, { uploads: 2, deletes: 1 });
  } finally {
    await browser.close();
  }
});

test("does not accept a driver's success without fresh structural verification", async () => {
  const selected = intent();
  const result = await createWorkdayResumeUploadHandler({
    driver: {
      async upload() {
        return { ok: true as const, value: { attempted: true as const, replacedExisting: false } };
      },
    },
    verifier: {
      async inspect() {
        return { ok: true as const, value: { kind: "empty" as const } };
      },
    },
    replaceExisting: true,
  }).upload(selected.intent, new AbortController().signal);

  assert.deepEqual(result, {
    ok: false,
    error: { code: "resume_verification_failed", retryable: false },
  });
});

test("fails closed and disposes the artifact when an injected port throws", async () => {
  const verifierFailure = intent("verifier failure resume", "resume_1111111111111111");
  const throwingVerifier = createWorkdayResumeUploadHandler({
    driver: {
      async upload() {
        throw new Error("must not run");
      },
    },
    verifier: {
      async inspect() {
        throw new Error("fixture verifier failure");
      },
    },
    replaceExisting: true,
  });
  assert.deepEqual(await throwingVerifier.upload(
    verifierFailure.intent,
    new AbortController().signal,
  ), {
    ok: false,
    error: { code: "resume_verification_failed", retryable: false },
  });

  const driverFailure = intent("driver failure resume", "resume_2222222222222222");
  const throwingDriver = createWorkdayResumeUploadHandler({
    driver: {
      async upload() {
        throw new Error("fixture driver failure");
      },
    },
    verifier: {
      async inspect() {
        return { ok: true as const, value: { kind: "empty" as const } };
      },
    },
    replaceExisting: true,
  });
  assert.deepEqual(await throwingDriver.upload(
    driverFailure.intent,
    new AbortController().signal,
  ), {
    ok: false,
    error: { code: "resume_upload_failed", retryable: false },
  });
});
