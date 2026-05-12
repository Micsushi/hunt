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

function findSectionBlock(tex, wantedName) {
  const source = String(tex || "");
  const sectionMatches = [...source.matchAll(/\\section\{([^{}]+)\}/g)].map(
    (match) => ({
      name: stripLatex(match[1]),
      start: match.index,
      end: match.index + match[0].length,
    }),
  );
  const section = sectionMatches.find((entry) => wantedName.test(entry.name));
  if (!section) {
    return "";
  }
  const nextSection = sectionMatches.find(
    (entry) => entry.start > section.start,
  );
  return source.slice(
    section.end,
    nextSection ? nextSection.start : source.length,
  );
}

function readBalancedBraced(source, startIndex) {
  if (source[startIndex] !== "{") {
    return null;
  }
  let depth = 0;
  let value = "";
  for (let index = startIndex; index < source.length; index += 1) {
    const char = source[index];
    if (char === "\\" && index + 1 < source.length) {
      if (depth > 0) {
        value += char + source[index + 1];
      }
      index += 1;
      continue;
    }
    if (char === "{") {
      if (depth > 0) {
        value += char;
      }
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return { value, end: index + 1 };
      }
      value += char;
      continue;
    }
    if (depth > 0) {
      value += char;
    }
  }
  return null;
}

function findTwocolEntries(block) {
  const source = String(block || "");
  const marker = "\\begin{twocolentry}";
  const endMarker = "\\end{twocolentry}";
  const entries = [];
  let searchIndex = 0;
  while (searchIndex < source.length) {
    const start = source.indexOf(marker, searchIndex);
    if (start === -1) {
      break;
    }
    const argument = readBalancedBraced(source, start + marker.length);
    if (!argument) {
      searchIndex = start + marker.length;
      continue;
    }
    const contentStart = argument.end;
    const contentEnd = source.indexOf(endMarker, contentStart);
    if (contentEnd === -1) {
      break;
    }
    const end = contentEnd + endMarker.length;
    entries.push({
      start,
      end,
      argument: argument.value,
      content: source.slice(contentStart, contentEnd),
    });
    searchIndex = end;
  }
  return entries;
}

function parseMonthYear(text) {
  const match = stripLatex(text).match(
    /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{4})\b/i,
  );
  if (!match) {
    return { month: "", year: "" };
  }
  return { month: match[1], year: match[2] };
}

function parseDateRange(text) {
  const cleaned = stripLatex(text).replace(/\s+[-–—]\s+/g, " - ");
  const parts = cleaned.split(/\s+-\s+/);
  const start = parseMonthYear(parts[0] || cleaned);
  const endText = parts[1] || cleaned;
  const end = parseMonthYear(endText);
  return {
    startMonth: start.month,
    startYear: start.year,
    endMonth: /present/i.test(endText) ? "" : end.month,
    endYear: /present/i.test(endText) ? "" : end.year,
    current: /present/i.test(endText),
  };
}

function extractBullets(block) {
  return [
    ...String(block || "").matchAll(
      /\\item\s+([\s\S]*?)(?=\\item|\\end\{itemize\})/g,
    ),
  ]
    .map((match) => stripLatex(match[1]))
    .filter(Boolean);
}

function parseEducation(tex) {
  const block = findSectionBlock(tex, /^education$/i);
  const entry = findTwocolEntries(block)[0];
  if (!entry) {
    return [];
  }
  const header = stripLatex(entry.content);
  const [school = "", ...degreeParts] = header.split(",");
  const dates = parseDateRange(entry.argument);
  return [
    {
      school: normalizeWhitespace(school),
      degree: normalizeWhitespace(degreeParts.join(",")),
      fieldOfStudy: "",
      startMonth: "",
      startYear: "",
      endMonth: dates.endMonth || dates.startMonth,
      endYear: dates.endYear || dates.startYear,
      overallResult: extractBullets(block).join("\n"),
    },
  ].filter((item) => item.school || item.degree);
}

function parseWorkExperience(tex) {
  const block = findSectionBlock(tex, /^experience$/i);
  const entries = findTwocolEntries(block);
  return entries
    .map((entry, index) => {
      const header = stripLatex(entry.content).replace(/\s+--\s+/g, " -- ");
      const [title = "", ...restParts] = header.split(",");
      const rest = normalizeWhitespace(restParts.join(","));
      const [company = "", location = ""] = rest.split(/\s+--\s+/, 2);
      const nextEntry = entries[index + 1];
      const detailBlock = block.slice(
        entry.end,
        nextEntry ? nextEntry.start : block.length,
      );
      const dates = parseDateRange(entry.argument);
      return {
        jobTitle: normalizeWhitespace(title),
        company: normalizeWhitespace(company),
        location: normalizeWhitespace(location),
        startMonth: dates.startMonth,
        startYear: dates.startYear,
        endMonth: dates.endMonth,
        endYear: dates.endYear,
        current: dates.current,
        description: extractBullets(detailBlock).join("\n"),
      };
    })
    .filter((item) => item.jobTitle || item.company);
}

function parseSkills(tex) {
  const block = findSectionBlock(tex, /technical skills|skills/i);
  const seen = new Set();
  const skills = [];
  String(block || "")
    .split(/\r?\n/)
    .map(stripLatex)
    .filter((line) => line.includes(":"))
    .map((line) => line.replace(/^[^:]{1,60}:\s*/, ""))
    .flatMap((line) => line.split(","))
    .map(normalizeWhitespace)
    .filter(Boolean)
    .forEach((skill) => {
      const key = skill.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        skills.push(skill);
      }
    });
  return skills;
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
    workExperience: parseWorkExperience(tex),
    education: parseEducation(tex),
    skills: parseSkills(tex),
  };
}

export function mergeProfileFromResume(currentProfile, parsedProfile) {
  const merged = Object.fromEntries(
    Object.keys(PROFILE_FIELD_LABELS).map((key) => [
      key,
      parsedProfile[key] || currentProfile[key] || "",
    ]),
  );
  for (const key of ["workExperience", "education", "skills"]) {
    merged[key] =
      Array.isArray(parsedProfile[key]) && parsedProfile[key].length
        ? parsedProfile[key]
        : Array.isArray(currentProfile[key])
          ? currentProfile[key]
          : [];
  }
  return merged;
}

export function listMissingProfileFields(profile) {
  return Object.entries(PROFILE_FIELD_LABELS)
    .filter(([key]) => !normalizeWhitespace(profile[key]))
    .map(([, label]) => label);
}
