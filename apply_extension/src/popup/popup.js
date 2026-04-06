document.getElementById("fill-now")?.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  console.log("Fill requested for tab", tab?.id);
});
