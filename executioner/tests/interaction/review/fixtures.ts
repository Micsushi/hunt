import type {
  ReviewReadOnlyLocator,
  ReviewReadOnlyPage,
} from "../../../src/interaction/review/index.ts";

export interface ReviewFixtureMatch {
  readonly count: number;
  readonly visible: boolean;
  readonly enabled?: boolean;
}

export const realWorkdayReviewFixture = Object.freeze({
  reviewRoot: { count: 1, visible: true },
  activeStep: { count: 1, visible: true },
  validationError: { count: 0, visible: false },
  finalSubmit: { count: 1, visible: true, enabled: true },
});

export function reviewPageFixture(
  fixture: Readonly<{
    reviewRoot: ReviewFixtureMatch;
    activeStep: ReviewFixtureMatch;
    validationError: ReviewFixtureMatch;
    finalSubmit: ReviewFixtureMatch;
  }> = realWorkdayReviewFixture,
): ReviewReadOnlyPage {
  return Object.freeze({
    locator(selector: string) {
      if (selector.includes("applyFlowReviewPage") && selector.includes("error")) {
        return locator(fixture.validationError);
      }
      if (selector.includes("pageFooter")) {
        return locator({ count: 1, visible: true }, fixture.finalSubmit);
      }
      if (selector.includes("applyFlowReviewPage")) {
        return locator(fixture.reviewRoot);
      }
      if (selector.includes("progressBarActiveStep")) {
        return locator(fixture.activeStep);
      }
      throw new TypeError(`unexpected fixture selector: ${selector}`);
    },
  });
}

function locator(
  match: ReviewFixtureMatch,
  roleMatch: ReviewFixtureMatch = { count: 0, visible: false },
): ReviewReadOnlyLocator {
  return Object.freeze({
    count: () => Promise.resolve(match.count),
    isVisible: () => Promise.resolve(match.visible),
    isEnabled: () => Promise.resolve(match.enabled ?? false),
    getByRole(role: "button", options: Readonly<{ name: RegExp }>) {
      if (role !== "button" || !options.name.test("Submit")) {
        throw new TypeError("unexpected fixture role query");
      }
      return locator(roleMatch);
    },
  });
}
