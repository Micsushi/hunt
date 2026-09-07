import { createHash } from "node:crypto";
import { closeSync, globSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export interface CampaignGate {
  readonly id: string;
  readonly status: "passed" | "failed";
  readonly directory: string;
  readonly evidenceSha256: string;
}
export interface CampaignCheckpoint {
  readonly schemaVersion: 1;
  readonly sourceSha256: string;
  readonly gates: readonly CampaignGate[];
}

export function acquireCampaignLock(root: string): () => void {
  const path = join(root, "campaign.lock");
  // Never steal even an apparently stale lock. A fresh output root is safe recovery.
  closeSync(openSync(path, "wx"));
  let held = true;
  return () => { if (held) { unlinkSync(path); held = false; } };
}

export function contentDigest(root: string, files: readonly string[]): string {
  const digest = createHash("sha256");
  for (const file of [...files].sort()) {
    const bytes = readFileSync(join(root, file));
    digest.update(`${file.replaceAll("\\", "/")}\0${bytes.length}\0`).update(bytes);
  }
  return digest.digest("hex");
}

export function evidenceDigest(root: string): string {
  return contentDigest(root, globSync("**/*", { cwd: root, withFileTypes: true })
    .filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1)));
}

export function baselineEvidencePresent(root: string, jobIds: readonly string[]): boolean {
  try {
    return jobIds.every((id) => {
      const result = JSON.parse(readFileSync(join(root, id, "result.json"), "utf8"));
      const png = readFileSync(join(root, id, "review.png"));
      const trace = readFileSync(join(root, id, "trace.zip"));
      return result.job === id && result.transport === "synthetic_browser" &&
        result.terminal === "review" && result.externalRequests === 0 &&
        result.progress?.at(-1)?.checkpoint === "pre_review" &&
        png.length > 100 && png.subarray(0, 8).toString("hex") === "89504e470d0a1a0a" &&
        trace.length > 100 && trace.subarray(0, 4).toString("hex") === "504b0304";
    });
  } catch { return false; }
}

export function verifyCampaignCheckpoint(value: unknown, sourceSha256: string, gateIds: readonly string[]): CampaignCheckpoint {
  if (!value || typeof value !== "object") throw Error("invalid campaign checkpoint");
  const checkpoint = value as CampaignCheckpoint;
  if (checkpoint.schemaVersion !== 1 || checkpoint.sourceSha256 !== sourceSha256 || !Array.isArray(checkpoint.gates)) {
    throw Error("checkpoint source mismatch; start a new evidence directory");
  }
  const ids = new Set<string>();
  for (const gate of checkpoint.gates) {
    if (!gate || !gateIds.includes(gate.id) || ids.has(gate.id) ||
        !["passed", "failed"].includes(gate.status) ||
        !/^attempt-[a-f0-9-]{36}$/u.test(gate.directory) ||
        !/^[a-f0-9]{64}$/u.test(gate.evidenceSha256)) throw Error("invalid checkpoint gate");
    ids.add(gate.id);
  }
  return checkpoint;
}
