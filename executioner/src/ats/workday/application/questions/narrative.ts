import { MAX_BROWSER_READBACK_CODE_POINTS } from "../../../../contracts/index.ts";

const narrativeQuestionId = "s1-question-configured-narrative" as const;
const opaqueIdentifier = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export interface ConfiguredNarrativeProvider {
  resolve(questionId: string):
    | {
        readonly text: string;
        readonly revision: string;
        readonly provenance: "configured_template";
      }
    | undefined;
}

export function createConfiguredNarrativeProvider(config: {
  readonly revision: string;
  readonly template: string | undefined;
}): ConfiguredNarrativeProvider {
  if (!opaqueIdentifier.test(config.revision)) {
    throw new TypeError("narrative revision must be an opaque identifier");
  }
  if (config.template === undefined) {
    return Object.freeze({ resolve: () => undefined });
  }
  const length = [...config.template].length;
  if (
    config.template.trim() === "" ||
    length > MAX_BROWSER_READBACK_CODE_POINTS
  ) {
    throw new RangeError("narrative template is empty or out of bounds");
  }
  if (/\b(?:placeholder|tbd|todo)\b|\{\{|\}\}/iu.test(config.template)) {
    throw new TypeError("narrative template contains a placeholder");
  }
  const answer = Object.freeze({
    text: config.template,
    revision: config.revision,
    provenance: "configured_template" as const,
  });
  return Object.freeze({
    resolve(questionId: string) {
      return questionId === narrativeQuestionId ? answer : undefined;
    },
  });
}
