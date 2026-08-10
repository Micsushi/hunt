import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { auditStage2AccountVerifiedCompletion } from "./s2-account-verified-completion-audit.ts";
import { auditStage2AccountAccessCompletion } from "./s2-completion-audit.ts";
import { auditStage2ReviewCompletion } from "./s2-review-completion-audit.ts";

export async function auditStage2Completion(root: string): Promise<unknown> {
  if (existsSync(join(root, "review-acceptance.json"))) {
    return auditStage2ReviewCompletion(root);
  }
  try {
    const acceptance = JSON.parse(readFileSync(join(root, "acceptance.json"), "utf8")) as {
      readonly evidenceRevision?: unknown;
    };
    if (acceptance.evidenceRevision === "s2-account-access-acceptance-v1") {
      return auditStage2AccountAccessCompletion(root);
    }
    if (acceptance.evidenceRevision === "s2-account-verified-acceptance-v2") {
      return auditStage2AccountVerifiedCompletion(root);
    }
  } catch {
    try {
      const diagnostics = JSON.parse(readFileSync(join(root, "diagnostics.json"), "utf8")) as {
        readonly evidenceRevision?: unknown;
      };
      if (diagnostics.evidenceRevision === "s2-account-access-diagnostics-v1") {
        return auditStage2AccountAccessCompletion(root);
      }
    } catch {
      // The public audit boundary emits one bounded denial below.
    }
  }
  throw new Error("completion audit denied");
}
