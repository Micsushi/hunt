import { isAbsolute, normalize } from "node:path";

export function parseStage2CompletionAuditArgs(
  values: readonly string[],
): { readonly evidenceRoot: string } {
  if (
    values.length !== 2 ||
    values[0] !== "--evidence-root" ||
    values[1] === undefined ||
    !isAbsolute(values[1]) ||
    normalize(values[1]) !== values[1]
  ) throw new TypeError("completion audit arguments invalid");
  return Object.freeze({ evidenceRoot: values[1] });
}
