"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildCaptureManifest,
  captureTargetVisual,
  captureVerifiedScreenshot,
  isCaptureErrorCandidate,
  parseArgs,
} = require("../scripts/c3_capture_final_ui");

const ONE_PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nXsAAAAASUVORK5CYII=";

function fakeClient({ identities, screenshot = ONE_PIXEL_PNG }) {
  const calls = [];
  let identityIndex = 0;
  return {
    calls,
    async evaluate() {
      const value = identities[Math.min(identityIndex, identities.length - 1)];
      identityIndex += 1;
      return value;
    },
    async send(method, params) {
      calls.push({ method, params });
      assert.equal(method, "Page.captureScreenshot");
      return { data: screenshot };
    },
  };
}

test("parseArgs accepts an exact per-port target and non-overwriting suffix", () => {
  const args = parseArgs([
    "node",
    "script",
    "--ports",
    "9982",
    "--out-dir",
    "capture",
    "--target",
    "9982=FBC465E387A6722624D8CCB6F59DCF82",
    "--suffix",
    "r3_verified",
  ]);

  assert.equal(args.targetIds.get(9982), "FBC465E387A6722624D8CCB6F59DCF82");
  assert.equal(args.suffix, "r3_verified");
});

test("successful upload status is not classified as a capture error", () => {
  assert.equal(
    isCaptureErrorCandidate({
      text: "main.pdf successfully uploaded",
      role: "status",
      liveRegion: true,
      linkedFileControl: true,
      automationId: "upload-error-message",
      id: "resume-upload-status",
    }),
    false,
  );
  assert.equal(
    isCaptureErrorCandidate({
      text: "Resume uploaded successfully",
      role: "alert",
      linkedFileControl: true,
    }),
    false,
  );
  assert.equal(
    isCaptureErrorCandidate({
      text: "Upload complete",
      role: "status",
      linkedFileControl: true,
    }),
    false,
  );
});

test("real upload failures remain capture errors", () => {
  for (const text of [
    "Upload failed. Please try again.",
    "Resume could not be uploaded.",
    "Unable to upload this file.",
    "Resume was not successfully uploaded.",
  ]) {
    assert.equal(
      isCaptureErrorCandidate({
        text,
        role: "status",
        liveRegion: true,
        linkedFileControl: true,
      }),
      true,
      text,
    );
  }
});

test("unrecognized live alerts remain capture errors", () => {
  assert.equal(
    isCaptureErrorCandidate({
      text: "The site reported a problem.",
      role: "alert",
      liveRegion: true,
    }),
    true,
  );
});

test("inactive pinned target is rejected before any screenshot request", async () => {
  const target = {
    id: "job-target",
    url: "https://tenant.example/job/1/apply",
  };
  const client = fakeClient({
    identities: [
      {
        href: target.url,
        title: "Job",
        visibilityState: "hidden",
      },
    ],
  });

  await assert.rejects(
    captureVerifiedScreenshot({
      client,
      target,
      listTargets: async () => [target],
    }),
    (error) => error.code === "selected_target_not_visible",
  );
  assert.deepEqual(client.calls, []);
});

test("inactive pinned target falls back to target-scoped print render without activation", async () => {
  const target = {
    id: "job-target",
    url: "https://tenant.example/job/1/apply",
  };
  const hiddenIdentity = {
    href: target.url,
    title: "Job",
    visibilityState: "hidden",
  };
  const pdfFixture = Buffer.from("%PDF-1.4 target pdf");
  const calls = [];
  const client = {
    async evaluate() {
      return hiddenIdentity;
    },
    async send(method, params) {
      calls.push({ method, params });
      assert.equal(method, "Page.printToPDF");
      return { data: pdfFixture.toString("base64") };
    },
  };

  const result = await captureTargetVisual({
    client,
    target,
    listTargets: async () => [target],
    renderPdfToPng: async (pdfBytes) => {
      assert.deepEqual(pdfBytes, pdfFixture);
      return Buffer.from(ONE_PIXEL_PNG, "base64");
    },
  });

  assert.equal(result.proof.verified, true);
  assert.equal(result.proof.method, "target_scoped_print_render");
  assert.equal(result.proof.renderingSemantics, "print_layout_not_viewport_screenshot");
  assert.equal(result.proof.selectedTargetId, target.id);
  assert.deepEqual(result.pdfBytes, pdfFixture);
  assert.deepEqual(calls.map(({ method }) => method), ["Page.printToPDF"]);
  assert.ok(
    calls.every(
      ({ method }) =>
        method !== "Target.activateTarget" &&
        method !== "Page.bringToFront",
    ),
  );
});

test("visible stable pinned target uses non-surface capture and returns proof", async () => {
  const target = {
    id: "job-target",
    url: "https://tenant.example/job/1/apply",
  };
  const identity = {
    href: target.url,
    title: "Job",
    visibilityState: "visible",
  };
  const client = fakeClient({ identities: [identity, identity] });

  const result = await captureVerifiedScreenshot({
    client,
    target,
    listTargets: async () => [target],
  });

  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].method, "Page.captureScreenshot");
  assert.equal(client.calls[0].params.fromSurface, false);
  assert.equal(result.proof.selectedTargetId, target.id);
  assert.equal(result.proof.selectedTargetUrl, target.url);
  assert.equal(result.proof.preCaptureIdentity.visibilityState, "visible");
  assert.equal(result.proof.postCaptureIdentity.href, target.url);
  assert.equal(result.proof.png.width, 1);
  assert.equal(result.proof.png.height, 1);
  assert.equal(result.proof.verified, true);
  assert.ok(result.bytes.includes(Buffer.from(`C3TargetId\0${target.id}`, "latin1")));
  assert.ok(result.bytes.includes(Buffer.from(`C3TargetUrl\0${target.url}`, "latin1")));
  assert.ok(
    client.calls.every(
      ({ method }) =>
        method !== "Target.activateTarget" &&
        method !== "Page.bringToFront",
    ),
  );
});

test("identity change after screenshot rejects the image instead of returning it", async () => {
  const target = {
    id: "job-target",
    url: "https://tenant.example/job/1/apply",
  };
  const client = fakeClient({
    identities: [
      {
        href: target.url,
        title: "Job",
        visibilityState: "visible",
      },
      {
        href: "chrome-extension://example/options.html",
        title: "Options",
        visibilityState: "visible",
      },
    ],
  });

  await assert.rejects(
    captureVerifiedScreenshot({
      client,
      target,
      listTargets: async () => [target],
    }),
    (error) => error.code === "screenshot_target_identity_changed",
  );
});

test("manifest binds every artifact hash to exact target identity", () => {
  const target = {
    id: "job-target",
    url: "https://tenant.example/job/1/apply",
  };
  const manifest = buildCaptureManifest({
    port: 9982,
    target,
    selectionPolicy: "explicit_target_id",
    outputs: {
      json: { path: "capture.json", bytes: Buffer.from("{}") },
      text: { path: "capture.txt", bytes: Buffer.from("body") },
      png: { path: "capture.png", bytes: Buffer.from(ONE_PIXEL_PNG, "base64") },
    },
    screenshotProof: {
      verified: true,
      selectedTargetId: target.id,
      selectedTargetUrl: target.url,
    },
  });

  assert.equal(manifest.target.id, target.id);
  assert.equal(manifest.target.url, target.url);
  assert.equal(manifest.screenshot.verified, true);
  for (const output of Object.values(manifest.outputs)) {
    assert.equal(output.target_id, target.id);
    assert.equal(output.target_url, target.url);
    assert.match(output.sha256, /^[a-f0-9]{64}$/);
  }
});
