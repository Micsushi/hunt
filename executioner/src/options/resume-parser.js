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

function normalizeLines(value) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map(normalizeWhitespace)
    .filter(Boolean);
}

function stripLatex(value) {
  return normalizeWhitespace(
    String(value || "")
      .replace(/\\textbf\{([^{}]*)\}/g, "$1")
      .replace(/\\fontsize\{[^{}]*\}\{[^{}]*\}\\selectfont/g, "")
      .replace(/[{}]/g, "")
      .replace(/\\&/g, "&")
      .replace(/\\%/g, "%")
      .replace(/\\\$/g, "$")
      .replace(/\\([#_])/g, "$1")
      .replace(/\\[a-zA-Z]+\*?(?:\[[^\]]*\])?/g, ""),
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

function monthNumber(value) {
  const text = normalizeWhitespace(value).toLowerCase().slice(0, 3);
  const months = {
    jan: "01",
    feb: "02",
    mar: "03",
    apr: "04",
    may: "05",
    jun: "06",
    jul: "07",
    aug: "08",
    sep: "09",
    oct: "10",
    nov: "11",
    dec: "12",
  };
  return months[text] || value || "";
}

function parseDateRange(text) {
  const cleaned = stripLatex(text).replace(/\s+[-–—]\s+/g, " - ");
  const parts = cleaned.split(/\s+-\s+/);
  const start = parseMonthYear(parts[0] || cleaned);
  const endText = parts[1] || cleaned;
  const end = parseMonthYear(endText);
  return {
    startMonth: monthNumber(start.month),
    startYear: start.year,
    endMonth: /present/i.test(endText) ? "" : monthNumber(end.month),
    endYear: /present/i.test(endText) ? "" : end.year,
    current: /present/i.test(endText),
  };
}

function parseInlineDateRange(line) {
  const match = normalizeWhitespace(line).match(
    /\b((?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+\d{4})\s*(?:-|–|—|to)\s*((?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+\d{4}|Present|Current)\b/i,
  );
  if (!match) {
    return { rangeText: "", dates: parseDateRange("") };
  }
  return { rangeText: match[0], dates: parseDateRange(match[0]) };
}

function inferDegreeLevel(value) {
  const text = normalizeWhitespace(value).toLowerCase();
  if (!text) {
    return "";
  }
  if (/\b(phd|doctor|doctorate)\b/.test(text)) {
    return "Doctorate";
  }
  if (/\b(masters?|m\.?sc|m\.?a|mba)\b/.test(text)) {
    return "Masters";
  }
  if (/\b(bachelors?|bachelor|bsc|b\.?sc|ba|b\.?a)\b/.test(text)) {
    return "Bachelors";
  }
  if (/\b(associate|associates)\b/.test(text)) {
    return "Associates";
  }
  if (/\b(high school)\b/.test(text)) {
    return "High School Diploma";
  }
  if (/\b(diploma)\b/.test(text)) {
    return "Diploma";
  }
  return "";
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

function splitInlineBulletLine(line) {
  const normalized = normalizeWhitespace(stripLatex(line || ""));
  if (!normalized) {
    return [];
  }
  return normalized
    .split(/\s+(?=(?:[-*]|\u2022)\s+[A-Z0-9])/)
    .map((part) => part.replace(/^(?:[-*]|\u2022)\s*/, ""))
    .map(normalizeWhitespace)
    .filter(Boolean);
}

function formatBulletDescription(lines) {
  return (lines || [])
    .flatMap(splitInlineBulletLine)
    .filter(Boolean)
    .map((line) => `- ${line}`)
    .join("\n");
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
      degreeLevel: inferDegreeLevel(degreeParts.join(",")),
      fieldOfStudy: /computer science/i.test(degreeParts.join(","))
        ? "Computer Science"
        : "",
      startMonth: "",
      startYear: "",
      endMonth: dates.endMonth || dates.startMonth,
      endYear: dates.endYear || dates.startYear,
      overallResult: extractBullets(block)
        .filter((line) => /\b(gpa|grade point|average)\b/i.test(line))
        .join("\n"),
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
        description: formatBulletDescription(extractBullets(detailBlock)),
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

function splitSectionText(text, names) {
  const lines = normalizeLines(text);
  const wanted = names.map((name) => name.toLowerCase());
  const startIndex = lines.findIndex((line) =>
    wanted.includes(line.toLowerCase().replace(/:$/, "")),
  );
  if (startIndex === -1) {
    return "";
  }
  const nextIndex = lines.findIndex(
    (line, index) =>
      index > startIndex &&
      /^(education|experience|work experience|employment|employment history|professional experience|projects|technical skills|skills|certifications|awards)$/i.test(
        line.replace(/:$/, ""),
      ),
  );
  return lines
    .slice(startIndex + 1, nextIndex === -1 ? lines.length : nextIndex)
    .join("\n");
}

function parsePlainSkills(text) {
  const block = splitSectionText(text, ["Technical Skills", "Skills"]);
  const seen = new Set();
  const skills = [];
  normalizeLines(block)
    .map((line) => line.replace(/^[^:]{1,60}:\s*/, ""))
    .flatMap((line) => line.split(/[,;|]/))
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

function parsePlainEducation(text) {
  const block = splitSectionText(text, ["Education"]);
  const lines = normalizeLines(block);
  if (!lines.length) {
    return [];
  }
  const dateLine = lines.find((line) => parseInlineDateRange(line).rangeText);
  const { rangeText, dates: rangeDates } = parseInlineDateRange(
    dateLine || lines.join(" "),
  );
  const singleDate = parseMonthYear(lines.join(" "));
  const dates = rangeText
    ? rangeDates
    : {
        startMonth: "",
        startYear: "",
        endMonth: monthNumber(singleDate.month),
        endYear: singleDate.year,
      };
  const header = normalizeWhitespace(
    lines.slice(0, 3).join(", ").replace(rangeText, ""),
  );
  const [school = "", ...degreeParts] = header.split(/\s*,\s*/);
  const degree = normalizeWhitespace(degreeParts.join(", "));
  return [
    {
      school,
      degree,
      degreeLevel: inferDegreeLevel(degree),
      fieldOfStudy: /computer science/i.test(degree) ? "Computer Science" : "",
      startMonth: dates.startMonth,
      startYear: dates.startYear,
      endMonth: dates.endMonth || dates.startMonth,
      endYear: dates.endYear || dates.startYear,
      overallResult: lines
        .slice(1)
        .filter((line) => line !== dateLine)
        .filter((line) => /\b(gpa|grade point|average)\b/i.test(line))
        .join("\n"),
    },
  ].filter((entry) => entry.school || entry.degree);
}

function looksLikePlainWorkHeader(line) {
  const cleaned = normalizeWhitespace(line).replace(/^[*-]\s*/, "");
  if (!cleaned || /^[*-]\s*/.test(line)) {
    return false;
  }
  const inlineDateRange = parseInlineDateRange(cleaned).rangeText;
  if (inlineDateRange) {
    return true;
  }
  if (/[.!?]$/.test(cleaned) && cleaned.length > 80) {
    return false;
  }
  return (
    /\b(intern|developer|engineer|analyst|manager|designer|consultant|assistant|researcher|coordinator|lead)\b/i.test(
      cleaned,
    ) &&
    (cleaned.includes("--") ||
      cleaned.includes("|") ||
      cleaned.split(/\s*,\s*/).length >= 2) &&
    cleaned.length <= 180
  );
}

function parsePlainWorkExperience(text) {
  const block = splitSectionText(text, [
    "Experience",
    "Work Experience",
    "Employment",
    "Employment History",
    "Professional Experience",
  ]);
  const lines = normalizeLines(block);
  const entries = [];
  let current = null;

  const flush = () => {
    if (current && (current.jobTitle || current.company)) {
      current.description = formatBulletDescription(current.descriptionLines);
      delete current.descriptionLines;
      entries.push(current);
    }
  };

  for (const line of lines) {
    if (
      looksLikePlainWorkHeader(line) &&
      (!current || current.descriptionLines.length)
    ) {
      flush();
      const { rangeText, dates } = parseInlineDateRange(line);
      const header = normalizeWhitespace(line.replace(rangeText, ""));
      const [titlePart = "", rest = ""] = header.split(
        /\s+[-–—]{2,}\s+|\s+\|\s+/,
        2,
      );
      const [jobTitle = "", companyPart = ""] = titlePart.split(/\s*,\s*/, 2);
      const [fallbackCompany = "", fallbackLocation = ""] = String(rest).split(
        /\s*,\s*/,
        2,
      );
      current = {
        jobTitle: normalizeWhitespace(jobTitle || titlePart),
        company: normalizeWhitespace(companyPart || fallbackCompany),
        location: normalizeWhitespace(companyPart ? rest : fallbackLocation),
        startMonth: dates.startMonth,
        startYear: dates.startYear,
        endMonth: dates.endMonth,
        endYear: dates.endYear,
        current: dates.current,
        descriptionLines: [],
      };
      continue;
    }
    if (current) {
      current.descriptionLines.push(line);
    }
  }
  flush();
  return entries.slice(0, 20);
}

function parsePlainHeader(text) {
  const lines = normalizeLines(text).slice(0, 12);
  const hrefs = findHrefTargets(text);
  const email =
    (String(text || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i) ||
      [])[0] || "";
  const urlMatches = [
    ...String(text || "").matchAll(
      /\b(?:https?:\/\/)?(?:www\.)?[a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s|]*)?/gi,
    ),
  ]
    .map((match) => match[0])
    .filter((url) => !email.toLowerCase().includes(url.toLowerCase()));
  const urls = [...hrefs.map((href) => href.target), ...urlMatches];
  const fullName =
    lines.find(
      (line) =>
        !line.includes("@") &&
        !/\d/.test(line) &&
        line.split(/\s+/).length <= 4 &&
        !/^(education|experience|skills)$/i.test(line),
    ) || "";
  const location =
    lines.find(
      (line) =>
        !line.includes("@") &&
        !/github|linkedin|https?:\/\//i.test(line) &&
        /,\s*[A-Z]{2}\b|remote/i.test(line),
    ) || "";
  return {
    fullName,
    email,
    phone: parsePhone(text),
    location,
    linkedinUrl: normalizeUrl(
      urls.find((url) => /linkedin\.com/i.test(url)) || "",
    ),
    githubUrl: normalizeUrl(urls.find((url) => /github\.com/i.test(url)) || ""),
    websiteUrl: normalizeUrl(
      urls.find((url) => !/linkedin\.com|github\.com|mailto:/i.test(url)) || "",
    ),
  };
}

export function parseResumeText(text) {
  return {
    ...parsePlainHeader(text),
    workExperience: parsePlainWorkExperience(text),
    education: parsePlainEducation(text),
    skills: parsePlainSkills(text),
  };
}

function decodePdfLiteral(value) {
  return String(value || "")
    .replace(/\\([nrtbf()\\])/g, (_match, char) => {
      const replacements = {
        n: "\n",
        r: "\r",
        t: "\t",
        b: "",
        f: "",
        "(": "(",
        ")": ")",
        "\\": "\\",
      };
      return replacements[char] ?? char;
    })
    .replace(/\\\d{1,3}/g, " ");
}

function decodePdfHex(value) {
  const clean = String(value || "").replace(/[^0-9a-f]/gi, "");
  const bytes = [];
  for (let index = 0; index + 1 < clean.length; index += 2) {
    bytes.push(parseInt(clean.slice(index, index + 2), 16));
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(
    new Uint8Array(bytes),
  );
}

function extractPdfText(pdfSource) {
  const source = String(pdfSource || "");
  const chunks = [];
  for (const match of source.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g)) {
    chunks.push(decodePdfLiteral(match[1]));
  }
  for (const match of source.matchAll(
    /\[((?:\s*(?:\((?:\\.|[^\\)])*\)|<[\da-fA-F\s]+>|-?\d+)\s*)+)\]\s*TJ/g,
  )) {
    for (const literal of match[1].matchAll(
      /\(((?:\\.|[^\\)])*)\)|<([\da-fA-F\s]+)>/g,
    )) {
      chunks.push(
        literal[1] ? decodePdfLiteral(literal[1]) : decodePdfHex(literal[2]),
      );
    }
    chunks.push("\n");
  }
  if (!chunks.length) {
    for (const match of source.matchAll(/\(([^)]{2,120})\)/g)) {
      chunks.push(decodePdfLiteral(match[1]));
    }
  }
  return chunks.join("\n");
}

export function parseResumePdfBytes(buffer) {
  const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : buffer;
  const source = new TextDecoder("latin1", { fatal: false }).decode(bytes);
  return parseResumeText(extractPdfText(source));
}

export async function parseResumeFile(file) {
  const name = String(file?.name || "").toLowerCase();
  const type = String(file?.type || "").toLowerCase();
  if (name.endsWith(".pdf") || type.includes("pdf")) {
    return parseResumePdfBytes(await file.arrayBuffer());
  }
  if (typeof file?.text === "function") {
    const text = await file.text();
    return name.endsWith(".tex") || /\\section\{|\\begin\{/.test(text)
      ? parseResumeTex(text)
      : parseResumeText(text);
  }
  return parseResumeText("");
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
