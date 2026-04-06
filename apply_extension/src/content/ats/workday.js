export function detectWorkdayPage() {
  return window.location.hostname.includes("workday");
}

export function fillWorkdayPage(_context) {
  throw new Error("Workday autofill is not implemented yet.");
}
