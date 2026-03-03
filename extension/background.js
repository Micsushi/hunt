chrome.commands.onCommand.addListener((command) => {
  if (command === "fill-form") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, { action: "FILL_FORM" });
      }
    });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "FILL_ACTIVE_TAB") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, { action: "FILL_FORM" }, (result) => {
          sendResponse(result);
        });
      }
    });
    return true;
  }

  if (message.action === "GET_PROFILE") {
    chrome.storage.local.get("profile", (data) => {
      sendResponse(data.profile || {});
    });
    return true;
  }

  if (message.action === "SET_PROFILE") {
    chrome.storage.local.set({ profile: message.profile }, () => {
      sendResponse({ success: true });
    });
    return true;
  }
});

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  if (message.action === "FILL_FORM") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, { action: "FILL_FORM" }, (result) => {
          sendResponse(result);
        });
      }
    });
    return true;
  }

  if (message.action === "GET_PROFILE") {
    chrome.storage.local.get("profile", (data) => {
      sendResponse(data.profile || {});
    });
    return true;
  }

  if (message.action === "SET_PROFILE") {
    chrome.storage.local.set({ profile: message.profile }, () => {
      sendResponse({ success: true });
    });
    return true;
  }
});
