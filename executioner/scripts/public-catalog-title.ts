export type PublicCatalogRow = Readonly<{
  sourceRow: number;
  company: string;
  expectedTitle: string;
  link: string;
}>;

export function matchesExactVisibleJobTitle(
  expected: string,
  observed: string,
): boolean {
  const expectedTitle = normalizeVisibleJobTitle(expected);
  return expectedTitle.length > 0 && expectedTitle === normalizeVisibleJobTitle(observed);
}
export function parsePublicCatalog(text: string, expectedRows = 100): PublicCatalogRow[] {
  if (!Number.isInteger(expectedRows) || expectedRows < 1) {
    throw new TypeError("expected row count is invalid");
  }
  const records = parseCsvRecords(text);
  const headers = records.shift()?.map((header) => header.trim()) ?? [];
  const requiredHeaders = ["company name", "job name", "link"];
  if (new Set(headers).size !== headers.length) throw new TypeError("CSV has duplicate headers");
  for (const header of requiredHeaders) {
    if (!headers.includes(header)) throw new TypeError(`CSV is missing required header: ${header}`);
  }
  if (records.length !== expectedRows) {
    throw new TypeError(`public catalog row count must be ${expectedRows}`);
  }

  const companyIndex = headers.indexOf("company name");
  const titleIndex = headers.indexOf("job name");
  const linkIndex = headers.indexOf("link");
  const companies = new Set<string>();
  const targets = new Set<string>();
  return records.map((cells, index) => {
    if (cells.length !== headers.length) throw new TypeError(`CSV row ${index + 2} has the wrong column count`);
    const company = cells[companyIndex]!.trim();
    const expectedTitle = cells[titleIndex]!.trim();
    const link = cells[linkIndex]!.trim();
    if (!company || !expectedTitle || !link) throw new TypeError(`CSV row ${index + 2} has an empty required value`);

    const companyKey = company.normalize("NFKC").toLocaleLowerCase("en-US");
    if (companies.has(companyKey)) throw new TypeError(`duplicate company at CSV row ${index + 2}`);
    companies.add(companyKey);

    const identity = workdayTargetIdentity(link);
    if (targets.has(identity)) throw new TypeError(`duplicate link at CSV row ${index + 2}`);
    targets.add(identity);
    return { sourceRow: index + 2, company, expectedTitle, link };
  });
}

export function verifiedPublicCatalogPosting(
  expectedUrl: string,
  finalUrl: string,
  httpStatus: number | null,
  expectedTitle: string,
  observedTitle: string,
): boolean {
  if (httpStatus !== 200) return false;
  try {
    if (workdayTargetIdentity(expectedUrl) !== workdayTargetIdentity(finalUrl)) return false;
  } catch {
    return false;
  }
  return matchesExactVisibleJobTitle(expectedTitle, observedTitle);
}

function normalizeVisibleJobTitle(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replaceAll("&", " and ")
    .replace(/[’‘]/gu, "'")
    .replace(/[“”"]/gu, " ")
    .replace(/\p{Dash_Punctuation}+/gu, " ")
    .replace(/[()[\]{},.:;!?]+/gu, " ")
    .replace(/\s*([+/#])\s*/gu, "$1")
    .trim()
    .replace(/\s+/gu, " ");
}

function workdayTargetIdentity(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:"
    || !url.hostname.toLocaleLowerCase("en-US").endsWith(".myworkdayjobs.com")
    || url.username
    || url.password
    || url.hash
  ) {
    throw new TypeError("catalog link is not an admitted Workday URL");
  }
  const segments = url.pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
  const jobIndex = segments.lastIndexOf("job");
  if (jobIndex < 1 || jobIndex >= segments.length - 1) {
    throw new TypeError("catalog link has no Workday target identity");
  }
  return JSON.stringify([
    url.hostname.toLocaleLowerCase("en-US"),
    segments[jobIndex - 1],
    segments.at(-1),
  ]);
}

function parseCsvRecords(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let value = "";
  let quoted = false;
  let afterQuote = false;
  const finishValue = () => {
    record.push(value);
    value = "";
    afterQuote = false;
  };
  const finishRecord = () => {
    finishValue();
    if (record.some((cell) => cell.length > 0)) records.push(record);
    record = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
        afterQuote = true;
      } else value += character;
      continue;
    }
    if (afterQuote && character !== "," && character !== "\r" && character !== "\n") {
      throw new TypeError("CSV has characters after a closing quote");
    }
    if (character === '"') {
      if (value.length > 0 || afterQuote) throw new TypeError("CSV has an invalid quote");
      quoted = true;
    } else if (character === ",") finishValue();
    else if (character === "\n") finishRecord();
    else if (character !== "\r") value += character;
  }
  if (quoted) throw new TypeError("CSV has an unterminated quote");
  if (record.length > 0 || value.length > 0 || afterQuote) finishRecord();
  return records;
}
