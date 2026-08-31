import type { Locator } from "playwright";

type BackingStatus = "uncontrolled" | "committed" | "uncommitted";

export async function formattedDateBackingCommitted(
  input: Locator,
  isoDate: string,
  timeoutMs = 750,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    const status = await input.evaluate((element, expectedIso): BackingStatus => {
      if (!(element instanceof HTMLInputElement)) return "uncommitted";
      const normalize = (value: string): string => value.replace(
        /[\s\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/gu,
        "",
      );
      const acceptedString = (value: string): boolean => {
        const normalized = normalize(value);
        if (normalized === expectedIso) return true;
        const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/u.exec(normalized);
        return match !== null &&
          `${match[3]}-${match[1]!.padStart(2, "0")}-${match[2]!.padStart(2, "0")}` ===
            expectedIso;
      };
      const acceptedValue = (value: unknown): boolean => {
        if (typeof value === "string") return acceptedString(value);
        if (typeof value !== "object" || value === null) return false;
        const record = value as Record<string, unknown>;
        for (const key of ["value", "displayValue", "formattedValue", "dateValue"] as const) {
          if (typeof record[key] === "string" && acceptedString(record[key])) return true;
        }
        const year = Number(record.year);
        const month = Number(record.month);
        const day = Number(record.day);
        return Number.isSafeInteger(year) && Number.isSafeInteger(month) &&
          Number.isSafeInteger(day) &&
          `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${
            String(day).padStart(2, "0")}` === expectedIso;
      };
      const elementRecord = element as unknown as Record<string, unknown>;
      const records: Record<string, unknown>[] = Object.keys(element)
        .filter((key) => key.startsWith("__reactProps$"))
        .map((key) => elementRecord[key])
        .filter((value): value is Record<string, unknown> =>
          typeof value === "object" && value !== null
        );
      const fiberKey = Object.keys(element).find((key) => key.startsWith("__reactFiber$"));
      let fiber = fiberKey === undefined
        ? undefined
        : elementRecord[fiberKey] as Record<string, unknown> | undefined;
      const seen = new Set<object>();
      for (let depth = 0; fiber !== undefined && depth < 16 && !seen.has(fiber); depth += 1) {
        seen.add(fiber);
        for (const key of ["memoizedProps", "pendingProps"] as const) {
          const props = fiber[key];
          if (typeof props === "object" && props !== null) {
            records.push(props as Record<string, unknown>);
          }
        }
        const parent = fiber.return;
        fiber = typeof parent === "object" && parent !== null
          ? parent as Record<string, unknown>
          : undefined;
      }
      const controlled = records.filter((props) =>
        Object.hasOwn(props, "value") && (
          typeof props.onChange === "function" || typeof props.onDatePicked === "function"
        )
      );
      if (controlled.length === 0) return "uncontrolled";
      return controlled.some((props) => acceptedValue(props.value))
        ? "committed"
        : "uncommitted";
    }, isoDate).catch((): BackingStatus => "uncommitted");
    if (status === "uncontrolled" || status === "committed") return true;
    if (Date.now() < deadline) await input.page().waitForTimeout(50);
  } while (Date.now() < deadline);
  return false;
}
