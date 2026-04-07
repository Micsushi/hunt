export function detectWorkdayPage() {
  const hostname = window.location.hostname || "";
  return hostname.includes("workday.com") || hostname.includes("myworkdayjobs.com");
}

export function fillWorkdayPage(_context) {
  return {
    supported: true,
    delegatedToBackground: true
  };
}
