const ALL_KEYS = [
  "firstName", "lastName", "email", "phone",
  "address", "city", "province", "postalCode", "country",
  "linkedin", "github", "portfolio",
  "school", "degree", "fieldOfStudy", "graduationDate", "gpa",
  "jobTitle", "company",
  "salary", "startDate",
];

function showStatus(msg, durationMs = 2000) {
  const el = document.getElementById("status");
  el.textContent = msg;
  el.classList.add("visible");
  setTimeout(() => el.classList.remove("visible"), durationMs);
}

function collectProfile() {
  const profile = {};
  for (const key of ALL_KEYS) {
    const input = document.querySelector(`[data-key="${key}"]`);
    if (input && input.value.trim()) {
      profile[key] = input.value.trim();
    }
  }
  profile.fullName = [profile.firstName, profile.lastName].filter(Boolean).join(" ");
  return profile;
}

function populateForm(profile) {
  for (const key of ALL_KEYS) {
    const input = document.querySelector(`[data-key="${key}"]`);
    if (input && profile[key]) {
      input.value = profile[key];
    }
  }
}

function saveProfile() {
  const profile = collectProfile();
  chrome.storage.local.set({ profile }, () => {
    showStatus("Profile saved");
  });
}

function loadProfile() {
  chrome.storage.local.get("profile", (data) => {
    if (data.profile) {
      populateForm(data.profile);
    }
  });
}

function fillPage() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) return;
    chrome.tabs.sendMessage(tabs[0].id, { action: "FILL_FORM" }, (result) => {
      if (chrome.runtime.lastError) {
        showStatus("Could not fill - refresh the page and try again");
        return;
      }
      if (result) {
        showStatus(`Filled ${result.filled}/${result.total} fields`);
      }
    });
  });
}

function exportProfile() {
  const profile = collectProfile();
  const blob = new Blob([JSON.stringify(profile, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "hunt_profile.json";
  a.click();
  URL.revokeObjectURL(url);
  showStatus("Profile exported");
}

function importProfile() {
  document.getElementById("importFile").click();
}

function handleImportFile(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const profile = JSON.parse(e.target.result);
      populateForm(profile);
      chrome.storage.local.set({ profile }, () => {
        showStatus("Profile imported and saved");
      });
    } catch {
      showStatus("Invalid JSON file");
    }
  };
  reader.readAsText(file);
  event.target.value = "";
}

document.addEventListener("DOMContentLoaded", () => {
  loadProfile();
  document.getElementById("saveBtn").addEventListener("click", saveProfile);
  document.getElementById("fillBtn").addEventListener("click", fillPage);
  document.getElementById("exportBtn").addEventListener("click", exportProfile);
  document.getElementById("importBtn").addEventListener("click", importProfile);
  document.getElementById("importFile").addEventListener("change", handleImportFile);
});
