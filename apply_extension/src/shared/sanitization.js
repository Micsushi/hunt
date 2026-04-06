export function stripDisallowedPunctuation(value) {
  if (typeof value !== "string") {
    return value;
  }

  return value.replace(/\u2014/g, "-").replace(/\u2013/g, "-");
}
