// Content script injected into all registered ATS pages (see manifest.json).
// ATS detection and fill dispatch live in the background; this script only:
//   - logs that the extension is active on this page
//   - signals to the background when autofill-on-load may apply
(async () => {
  const stateResponse = await chrome.runtime.sendMessage({ type: "hunt.apply.get_state" });

  console.log("Hunt Apply content bootstrap loaded.", {
    ok: stateResponse?.ok,
    url: window.location.href,
    autofillOnLoad: stateResponse?.settings?.autofillOnLoad,
    activeJobId: stateResponse?.activeApplyContext?.jobId || ""
  });

  if (
    stateResponse?.ok &&
    stateResponse?.settings?.autofillOnLoad &&
    (
      stateResponse?.activeApplyContext?.selectedResumeDataUrl ||
      stateResponse?.defaultResume?.pdfDataUrl
    )
  ) {
    console.log("Autofill on load is enabled for this page.");
    // Actual fill is triggered by the tabs.onUpdated listener in background/index.js.
  }
})();
