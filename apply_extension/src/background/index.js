chrome.runtime.onInstalled.addListener(() => {
  console.log("Hunt Apply extension installed.");
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "hunt.apply.ping") {
    sendResponse({ ok: true, source: "background" });
    return;
  }

  if (message?.type === "hunt.apply.fill_current_page") {
    sendResponse({ ok: false, reason: "not_implemented" });
  }
});
