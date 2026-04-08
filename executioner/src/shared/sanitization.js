export function stripDisallowedPunctuation(value) {
  if (typeof value !== "string") {
    return value;
  }

  return value.replace(/\u2014/g, "-").replace(/\u2013/g, "-");
}

export function sanitizeText(value) {
  if (typeof value !== "string") {
    return "";
  }

  return stripDisallowedPunctuation(value).trim();
}

export function sanitizeUrl(value) {
  const normalized = sanitizeText(value);
  return normalized;
}

export function sanitizeBoolean(value) {
  return Boolean(value);
}

export function sanitizeStringArray(values) {
  if (!Array.isArray(values)) {
    return [];
  }

  return values
    .map((value) => sanitizeText(String(value)))
    .filter((value) => value.length > 0);
}
