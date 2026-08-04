import { basename, dirname, normalize } from "node:path";

export interface Stage2OwnerStorageBinding {
  readonly ownerConfigPath: string;
  readonly runtimeRoot: string;
  readonly ownerEvidenceRoot: string;
  readonly requestedEvidenceRoot: string;
}

export function matchesStage2OwnerStorageBinding(
  binding: Stage2OwnerStorageBinding,
): boolean {
  return stage2StorageRootForOwnerBinding(binding) !== undefined;
}

export function stage2StorageRootForOwnerBinding(
  binding: Stage2OwnerStorageBinding,
): string | undefined {
  const ownerRunRoot = dirname(binding.ownerConfigPath);
  const transientParent = dirname(ownerRunRoot);
  const storageRoot = dirname(transientParent);
  const runKey = basename(ownerRunRoot);
  const evidenceRunRoot = dirname(binding.ownerEvidenceRoot);
  const retainedParent = dirname(evidenceRunRoot);
  if (
    basename(binding.ownerConfigPath) !== "owner-input.json" ||
    basename(binding.runtimeRoot) !== "runtime" ||
    basename(binding.ownerEvidenceRoot) !== "evidence" ||
    basename(transientParent) !== "transient" ||
    basename(retainedParent) !== "retained" ||
    !/^run_\d{8}_[a-z0-9]{16}$/u.test(runKey) ||
    basename(evidenceRunRoot) !== runKey ||
    !samePath(ownerRunRoot, dirname(binding.runtimeRoot)) ||
    !samePath(storageRoot, dirname(retainedParent)) ||
    !samePath(binding.ownerEvidenceRoot, binding.requestedEvidenceRoot)
  ) return undefined;
  return normalize(storageRoot);
}

function samePath(left: string, right: string): boolean {
  const leftNormalized = normalize(left);
  const rightNormalized = normalize(right);
  return process.platform === "win32"
    ? leftNormalized.toLowerCase() === rightNormalized.toLowerCase()
    : leftNormalized === rightNormalized;
}
