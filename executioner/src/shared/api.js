function joinUrl(baseUrl, path) {
  return `${String(baseUrl || "").replace(/\/+$/, "")}/${String(path || "").replace(/^\/+/, "")}`;
}

function buildHeaders(serviceToken) {
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (serviceToken) {
    headers.Authorization = `Bearer ${serviceToken}`;
  }
  return headers;
}

const DEFAULT_BACKGROUND_LOG_TIMEOUT_MS = 5000;

async function requestJson({
  baseUrl,
  serviceToken,
  path,
  method = "GET",
  body,
  signal,
  timeoutMs = 0,
}) {
  const controller = timeoutMs > 0 || signal ? new AbortController() : null;
  const requestSignal = controller?.signal;
  let timeoutId = null;
  const abortFromCaller = () => controller?.abort(signal?.reason || "aborted");
  if (signal) {
    if (signal.aborted) {
      abortFromCaller();
    } else {
      signal.addEventListener("abort", abortFromCaller, { once: true });
    }
  }
  if (controller && timeoutMs > 0) {
    timeoutId = setTimeout(
      () => controller.abort("request_timeout"),
      timeoutMs,
    );
  }
  try {
    const response = await fetch(joinUrl(baseUrl, path), {
      method,
      headers: buildHeaders(serviceToken),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: requestSignal,
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : {};
    if (!response.ok) {
      const message =
        payload?.detail ||
        payload?.message ||
        `${method} ${path} failed with ${response.status}`;
      throw new Error(message);
    }
    return payload;
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    if (signal) {
      signal.removeEventListener("abort", abortFromCaller);
    }
  }
}

export async function fetchPendingFills(settings, limit = 1) {
  return requestJson({
    baseUrl: settings.backendUrl,
    serviceToken: settings.serviceToken,
    path: `/api/c3/pending-fills?limit=${encodeURIComponent(String(limit))}`,
  });
}

export async function postFillResult(settings, runId, payload) {
  return requestJson({
    baseUrl: settings.backendUrl,
    serviceToken: settings.serviceToken,
    path: "/api/c3/fill-result",
    method: "POST",
    body: {
      run_id: runId,
      payload,
    },
  });
}

export async function postExtensionStatus(settings, payload) {
  return requestJson({
    baseUrl: settings.backendUrl,
    serviceToken: settings.serviceToken,
    path: "/api/c3/status",
    method: "POST",
    body: payload,
  });
}

export async function postDebugLog(settings, payload) {
  return requestJson({
    baseUrl: settings.backendUrl,
    serviceToken: settings.serviceToken,
    path: "/api/c3/debug-log",
    method: "POST",
    body: payload,
    timeoutMs: DEFAULT_BACKGROUND_LOG_TIMEOUT_MS,
  });
}

export async function postLedgerEvent(settings, payload) {
  return requestJson({
    baseUrl: settings.ledgerBackendUrl || settings.backendUrl,
    serviceToken: settings.serviceToken,
    path: "/api/ledger/events",
    method: "POST",
    body: payload,
    timeoutMs: DEFAULT_BACKGROUND_LOG_TIMEOUT_MS,
  });
}

export async function postAnswerDecision(settings, payload, options = {}) {
  return requestJson({
    baseUrl: settings.backendUrl,
    serviceToken: settings.serviceToken,
    path: "/api/c3/answer-decision",
    method: "POST",
    body: payload,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });
}
