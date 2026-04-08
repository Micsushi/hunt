(async () => {
  const stateResponse = await chrome.runtime.sendMessage({ type: "hunt.apply.get_state" });
  const hostname = window.location.hostname;
  const isWorkday =
    hostname.includes("workday.com") || hostname.includes("myworkdayjobs.com");

  console.log("Hunt Apply content bootstrap loaded.", {
    ok: stateResponse?.ok,
    isWorkday,
    autofillOnLoad: stateResponse?.settings?.autofillOnLoad,
    activeJobId: stateResponse?.activeApplyContext?.jobId || ""
  });

  if (
    isWorkday &&
    stateResponse?.ok &&
    stateResponse?.settings?.autofillOnLoad &&
    (
      stateResponse?.activeApplyContext?.selectedResumeDataUrl ||
      stateResponse?.defaultResume?.pdfDataUrl
    )
  ) {
    console.log("Autofill on load is enabled for this Workday page.");
  }
})();
