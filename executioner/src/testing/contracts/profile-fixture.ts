import type { ProfileId } from "../../contracts/index.ts";
import {
  applicationProfileFactIds,
  type ApplicationProfileFact,
  type ApplicationProfileFactId,
  type DiscoveredIntakeField,
} from "../../form/answers/application-types.ts";

interface ApplicationProfileFixture {
  readonly profileId: ProfileId;
  readonly revision: number;
  readonly facts: readonly ApplicationProfileFact[];
  readonly unsetFactIds: readonly ApplicationProfileFactId[];
  readonly discoveredFields: readonly DiscoveredIntakeField[];
}

export function applicantProfileFixture<const Facts extends readonly ApplicationProfileFact[]>(input: {
  readonly profileId: ProfileId;
  readonly revision: number;
  readonly facts: Facts;
}): ApplicationProfileFixture & { readonly facts: Facts } {
  const answered = new Set(input.facts.map(({ factId }) => factId));
  return Object.freeze({
    ...input,
    facts: Object.freeze([...input.facts]) as unknown as Facts,
    unsetFactIds: Object.freeze(applicationProfileFactIds.filter((factId) => !answered.has(factId))),
    discoveredFields: Object.freeze([]),
  });
}
