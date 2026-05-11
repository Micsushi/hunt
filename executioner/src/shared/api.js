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

async function requestJson({
  baseUrl,
  serviceToken,
  path,
  method = "GET",
  body,
}) {
  const response = await fetch(joinUrl(baseUrl, path), {
    method,
    headers: buildHeaders(serviceToken),
    body: body === undefined ? undefined : JSON.stringify(body),
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
  });
}

export async function postAnswerDecision(settings, payload) {
  return requestJson({
    baseUrl: settings.backendUrl,
    serviceToken: settings.serviceToken,
    path: "/api/c3/answer-decision",
    method: "POST",
    body: payload,
  });
}
