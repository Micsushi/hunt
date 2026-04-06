(async () => {
  const response = await chrome.runtime.sendMessage({ type: "hunt.apply.ping" });
  console.log("Hunt Apply content bootstrap loaded.", response);
})();
