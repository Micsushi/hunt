export function parseCsv(source: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let closedQuote = false;
  for (let index = 0; index < source.length; index += 1) {
    const value = source[index]!;
    if (quoted) {
      if (value === '"' && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (value === '"') {
        quoted = false;
        closedQuote = true;
      } else {
        field += value;
      }
    } else if (closedQuote) {
      if (value === ",") {
        row.push(field);
        field = "";
        closedQuote = false;
      } else if (value === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
        closedQuote = false;
      } else if (value !== "\r" || source[index + 1] !== "\n") {
        invalid();
      }
    } else if (value === '"') {
      if (field !== "") invalid();
      quoted = true;
    } else if (value === ",") {
      row.push(field);
      field = "";
    } else if (value === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (value === "\r") {
      if (source[index + 1] !== "\n") invalid();
    } else {
      field += value;
    }
  }
  if (quoted) invalid();
  if (field !== "" || row.length > 0 || closedQuote) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function serializeCsv(rows: readonly (readonly string[])[]): string {
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

function csvCell(value: string): string {
  if (/^\s*[=+\-@]/u.test(value)) throw new Error("CSV value invalid");
  return /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function invalid(): never {
  throw new Error("catalog invalid");
}
