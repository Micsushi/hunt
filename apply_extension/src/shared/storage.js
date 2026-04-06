export async function getFromSyncStorage(keys) {
  return chrome.storage.sync.get(keys);
}

export async function setInSyncStorage(values) {
  return chrome.storage.sync.set(values);
}
