const PROFILE_FIELD_LABELS = {
  fullName: "Full name",
  email: "Email",
  phone: "Phone",
  location: "Location",
  linkedinUrl: "LinkedIn URL",
  githubUrl: "GitHub URL",
  websiteUrl: "Website URL",
};

function normalizeWhitespace(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function stripLatex(value) {
  return normalizeWhitespace(
    String(value || "")
      .replace(/\\textbf\{([^{}]*)\}/g, "$1")
      .replace(/\\fontsize\{[^{}]*\}\{[^{}]*\}\\selectfont/g, "")
      .replace(/\\[a-zA-Z]+\*?(?:\[[^\]]*\])?/g, "")
      .replace(/[{}]/g, "")
      .replace(/\\&/g, "&")
      .replace(/\\%/g, "%"),
  );
}

function normalizeUrl(value) {
  const cleaned = normalizeWhitespace(value);
  if (!cleaned) {
    return "";
  }
  if (/^https?:\/\//i.test(cleaned) || /^mailto:/i.test(cleaned)) {
    return cleaned;
  }
  return `https://${cleaned}`;
}

function findHrefTargets(tex) {
  return [...String(tex || "").matchAll(/\\href\{([^{}]+)\}\{([^{}]+)\}/g)].map(
    (match) => ({
      target: normalizeWhitespace(match[1]),
      label: stripLatex(match[2]),
    }),
  );
}

function parseName(tex) {
  const explicitName = String(tex || "").match(
    /\\selectfont\\textbf\{([^{}]+)\}/,
  );
  if (explicitName?.[1]) {
    return stripLatex(explicitName[1]);
  }

  const pdfAuthor = String(tex || "").match(/pdfauthor=\{([^{}]+)\}/);
  return pdfAuthor?.[1] ? stripLatex(pdfAuthor[1]) : "";
}

function parseHeaderText(tex) {
  const centerBlock = String(tex || "").match(
    /\\begin\{center\}([\s\S]*?)\\end\{center\}/,
  );
  return centerBlock?.[1] || String(tex || "");
}

function parseLocation(headerText) {
  const contactLine =
    String(headerText || "")
      .split(/\r?\n/)
      .find((line) => line.includes("\\href{")) || "";
  const contactPrefix = contactLine.split("|")[0] || "";
  const candidates = contactPrefix
    .split("|")
    .map(stripLatex)
    .filter(Boolean)
    .filter((part) => !part.includes("@"))
    .filter((part) => !/^https?:\/\//i.test(part))
    .filter((part) => !/github|linkedin/i.test(part));

  return candidates.find((part) => /,|remote|[A-Z]{2}/.test(part)) || "";
}

function parsePhone(tex) {
  const match = String(tex || "").match(
    /(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}/,
  );
  return match?.[0] ? normalizeWhitespace(match[0]) : "";
}

export function parseResumeTex(tex) {
  const hrefs = findHrefTargets(tex);
  const headerText = parseHeaderText(tex);
  const emailHref = hrefs.find((href) => href.target.startsWith("mailto:"));
  const linkedinHref = hrefs.find((href) => /linkedin\.com/i.test(href.target));
  const githubHref = hrefs.find((href) => /github\.com/i.test(href.target));
  const websiteHref = hrefs.find(
    (href) =>
      !href.target.startsWith("mailto:") &&
      !/linkedin\.com|github\.com/i.test(href.target),
  );

  return {
    fullName: parseName(tex),
    email: emailHref?.target.replace(/^mailto:/i, "") || "",
    phone: parsePhone(tex),
    location: parseLocation(headerText),
    linkedinUrl: linkedinHref ? normalizeUrl(linkedinHref.target) : "",
    githubUrl: githubHref ? normalizeUrl(githubHref.target) : "",
    websiteUrl: websiteHref ? normalizeUrl(websiteHref.target) : "",
  };
}

export function mergeProfileFromResume(currentProfile, parsedProfile) {
  return Object.fromEntries(
    Object.keys(PROFILE_FIELD_LABELS).map((key) => [
      key,
      parsedProfile[key] || currentProfile[key] || "",
    ]),
  );
}

export function listMissingProfileFields(profile) {
  return Object.entries(PROFILE_FIELD_LABELS)
    .filter(([key]) => !normalizeWhitespace(profile[key]))
    .map(([, label]) => label);
}
