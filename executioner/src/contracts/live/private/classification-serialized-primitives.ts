import { copyContractDataGraph } from "../../admission.ts";
import { ContractParseError } from "../../serialized.ts";
import { optionId, questionId } from "../../types.ts";
import type {
  ClassificationId,
  ClassificationRevisionId,
  UiVariantId,
} from "../classification.ts";
import type {
  ClassificationLayer,
  ClassificationLineageV1,
  LearningIdentifier,
  StructuralTraitId,
} from "../learning.ts";
import { classificationLayers } from "../learning.ts";

export type JsonObject = Record<string, unknown>;

export function snapshot(value: unknown): unknown {
  const copied = copyContractDataGraph(value);
  if (!copied.ok) throw new ContractParseError("invalid_type", "$");
  return copied.value;
}

export function record(value: unknown, path: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ContractParseError("invalid_type", path);
  }
  return value as JsonObject;
}

export function exact(
  value: unknown,
  path: string,
  required: readonly string[],
): JsonObject {
  const input = record(value, path);
  for (const key of required) {
    if (!Object.hasOwn(input, key)) {
      throw new ContractParseError("missing_key", `${path}.${key}`);
    }
  }
  const allowed = new Set(required);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      throw new ContractParseError("extra_key", `${path}.${key}`);
    }
  }
  return input;
}

export function versioned(
  value: unknown,
  path: string,
  required: readonly string[],
): JsonObject {
  const input = exact(value, path, ["schemaVersion", ...required]);
  if (input.schemaVersion !== 1) {
    throw new ContractParseError(
      typeof input.schemaVersion === "number"
        ? "incompatible_version"
        : "invalid_type",
      `${path}.schemaVersion`,
    );
  }
  return input;
}

export function oneOf<const T extends string>(
  value: unknown,
  values: readonly T[],
  path: string,
): T {
  if (typeof value !== "string") {
    throw new ContractParseError("invalid_type", path);
  }
  if (!(values as readonly string[]).includes(value)) {
    throw new ContractParseError("invalid_value", path);
  }
  return value as T;
}

export function identifier<Kind extends string>(
  value: unknown,
  prefix: string,
  path: string,
): LearningIdentifier<Kind> {
  if (typeof value !== "string") {
    throw new ContractParseError("invalid_type", path);
  }
  const expression = new RegExp(`^${prefix}_[A-Za-z0-9_-]{16,64}$`, "u");
  if (!expression.test(value)) {
    throw new ContractParseError("invalid_value", path);
  }
  return value as LearningIdentifier<Kind>;
}

export function classificationId(
  value: unknown,
  path: string,
): ClassificationId {
  return identifier(value, "classification", path) as unknown as ClassificationId;
}

export function revisionId(
  value: unknown,
  path: string,
): ClassificationRevisionId {
  return identifier(
    value,
    "classification_revision",
    path,
  ) as unknown as ClassificationRevisionId;
}

export function uiVariantId(value: unknown, path: string): UiVariantId {
  return identifier(value, "ui_variant", path) as unknown as UiVariantId;
}

export function nullableVariant(
  value: unknown,
  path: string,
): UiVariantId | null {
  return value === null ? null : uiVariantId(value, path);
}

export function parseQuestionId(value: unknown, path: string) {
  if (typeof value !== "string") {
    throw new ContractParseError("invalid_type", path);
  }
  try {
    return questionId(value);
  } catch {
    throw new ContractParseError("invalid_value", path);
  }
}

export function parseOptionId(value: unknown, path: string) {
  if (typeof value !== "string") {
    throw new ContractParseError("invalid_type", path);
  }
  try {
    return optionId(value);
  } catch {
    throw new ContractParseError("invalid_value", path);
  }
}

export function parseLineage(
  value: unknown,
  layer: ClassificationLayer,
  path: string,
): readonly ClassificationLineageV1[] {
  if (!Array.isArray(value)) {
    throw new ContractParseError("invalid_type", path);
  }
  const layerIndex = classificationLayers.indexOf(layer);
  if (value.length !== layerIndex) {
    throw new ContractParseError("invalid_value", path);
  }
  return value.map((entry, index) => {
    const entryPath = `${path}[${index}]`;
    const input = exact(entry, entryPath, ["layer", "classificationId"]);
    const expectedLayer = classificationLayers[index];
    const parsedLayer = oneOf(input.layer, classificationLayers, `${entryPath}.layer`);
    if (parsedLayer !== expectedLayer) {
      throw new ContractParseError("invalid_value", `${entryPath}.layer`);
    }
    return {
      layer: parsedLayer,
      classificationId: classificationId(
        input.classificationId,
        `${entryPath}.classificationId`,
      ),
    };
  });
}

export function parseTraits(
  value: unknown,
  path: string,
): readonly StructuralTraitId[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    throw new ContractParseError(
      Array.isArray(value) ? "invalid_value" : "invalid_type",
      path,
    );
  }
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const entryPath = `${path}[${index}]`;
    const parsed = identifier(
      entry,
      "structural_trait",
      entryPath,
    ) as StructuralTraitId;
    if (seen.has(parsed)) {
      throw new ContractParseError("invalid_value", entryPath);
    }
    seen.add(parsed);
    return parsed;
  });
}

export function structuralCount(value: unknown, path: string): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 64) {
    throw new ContractParseError(
      typeof value === "number" ? "invalid_value" : "invalid_type",
      path,
    );
  }
  return value as number;
}

export function orderedUniqueIdentifiers<Kind extends string>(
  value: unknown,
  prefix: string,
  path: string,
): readonly LearningIdentifier<Kind>[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    throw new ContractParseError(
      Array.isArray(value) ? "invalid_value" : "invalid_type",
      path,
    );
  }
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const entryPath = `${path}[${index}]`;
    const parsed = identifier(entry, prefix, entryPath) as LearningIdentifier<Kind>;
    if (seen.has(parsed)) {
      throw new ContractParseError("invalid_value", entryPath);
    }
    seen.add(parsed);
    return parsed;
  });
}
