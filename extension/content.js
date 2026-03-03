function dispatchEvents(field) {
  field.dispatchEvent(new Event("input", { bubbles: true }));
  field.dispatchEvent(new Event("change", { bubbles: true }));
  field.dispatchEvent(new Event("blur", { bubbles: true }));
}

function fillTextField(field, value) {
  if (!value) return false;
  field.focus();
  field.value = value;
  dispatchEvents(field);
  return true;
}

function fillSelectField(field, value) {
  if (!value) return false;

  const valueLower = value.toLowerCase();
  const options = Array.from(field.options);

  const match =
    options.find((o) => o.value.toLowerCase() === valueLower) ||
    options.find((o) => o.textContent.trim().toLowerCase() === valueLower) ||
    options.find((o) => o.textContent.trim().toLowerCase().includes(valueLower)) ||
    options.find((o) => valueLower.includes(o.textContent.trim().toLowerCase()));

  if (match) {
    field.value = match.value;
    dispatchEvents(field);
    return true;
  }
  return false;
}

function fillCheckboxOrRadio(field, value) {
  if (!value) return false;
  const valueLower = String(value).toLowerCase();
  const label = getFieldLabel(field).toLowerCase();

  const shouldCheck =
    (valueLower === "yes" || valueLower === "true") &&
    (label.includes("yes") || label.includes("agree") || label.includes("confirm"));

  if (shouldCheck && !field.checked) {
    field.click();
    return true;
  }
  return false;
}

function getFormFields() {
  return Array.from(
    document.querySelectorAll(
      'input:not([type="hidden"]):not([type="submit"]):not([type="button"]), ' +
      "textarea, select"
    )
  ).filter((f) => {
    const style = window.getComputedStyle(f);
    return style.display !== "none" && style.visibility !== "hidden" && f.offsetParent !== null;
  });
}

function highlightField(field, success) {
  const color = success ? "rgba(34, 197, 94, 0.15)" : "rgba(234, 179, 8, 0.15)";
  const border = success ? "1px solid rgba(34, 197, 94, 0.5)" : "1px solid rgba(234, 179, 8, 0.5)";
  field.style.backgroundColor = color;
  field.style.border = border;
}

async function fillForm() {
  const profile = await new Promise((resolve) => {
    chrome.storage.local.get("profile", (data) => resolve(data.profile || {}));
  });

  if (!profile || Object.keys(profile).length === 0) {
    console.warn("[Hunt Autofill] No profile saved. Open the extension popup to set up your profile.");
    return { filled: 0, total: 0 };
  }

  const fields = getFormFields();
  let filled = 0;
  let total = 0;

  for (const field of fields) {
    if (field.type === "file") continue;
    if (field.type === "checkbox" || field.type === "radio") continue;

    const fieldType = detectFieldType(field);
    if (!fieldType) {
      highlightField(field, false);
      total++;
      continue;
    }

    const value = profile[fieldType];
    let success = false;

    if (field.tagName === "SELECT") {
      success = fillSelectField(field, value);
    } else {
      success = fillTextField(field, value);
    }

    highlightField(field, success);
    total++;
    if (success) filled++;
  }

  console.log(`[Hunt Autofill] Filled ${filled}/${total} fields`);
  return { filled, total };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === "FILL_FORM") {
    fillForm().then((result) => sendResponse(result));
    return true;
  }

  if (message.action === "GET_FORM_FIELDS") {
    const fields = getFormFields();
    const detected = fields.map((f) => ({
      tag: f.tagName,
      type: f.type,
      name: f.name,
      id: f.id,
      detected: detectFieldType(f),
      label: getFieldLabel(f),
    }));
    sendResponse(detected);
    return true;
  }
});

document.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.shiftKey && e.key === "F") {
    e.preventDefault();
    fillForm();
  }
});
