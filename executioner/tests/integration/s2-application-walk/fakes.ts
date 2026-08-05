import assert from "node:assert/strict";

import type {
  ApplicationHandlerPage,
  ApplicationPage,
  ApplicationPageHandlerPort,
  ApplicationPageTruth,
  ApplicationPortResult,
  ApplicationVerifiedCheckpoint,
  ApplicationWalkDependencies,
} from "../../../src/ats/workday/application/page-walk.ts";
import { walkFixture } from "./fixtures.ts";

export function dependenciesFor(
  truths: readonly ApplicationPageTruth[],
  calls: string[],
  reconcile: (
    page: ApplicationHandlerPage,
    attempt: number,
    pageId: ApplicationPageTruth["pageId"],
  ) => ApplicationPortResult<{
    readonly page: ApplicationHandlerPage;
    readonly pageId: ApplicationPageTruth["pageId"];
    readonly checkpoint?: ApplicationVerifiedCheckpoint;
    readonly independentlyVerified?: true;
  }> = (page, _attempt, pageId) => ({ ok: true, value: { page, pageId } }),
): ApplicationWalkDependencies {
  let observed = 0;
  const handler = <Page extends ApplicationHandlerPage>(
    page: Page,
  ): ApplicationPageHandlerPort<Page> => ({
    async reconcile(request): Promise<
      Awaited<ReturnType<ApplicationPageHandlerPort<Page>["reconcile"]>>
    > {
      calls.push(`reconcile:${page}:${request.attempt}`);
      const result = reconcile(page, request.attempt, request.pageId);
      return (result.ok
        ? {
            ok: true,
            value: {
              page,
              pageId: result.value.pageId,
              checkpoint: result.value.checkpoint !== undefined
                ? result.value.checkpoint
                : page === "resume"
                  ? "resume_verified"
                  : page === "profile"
                    ? "profile_verified"
                    : "questionnaire_verified",
              independentlyVerified: result.value.independentlyVerified !== undefined
                ? result.value.independentlyVerified
                : true,
            },
          }
        : result) as Awaited<
          ReturnType<ApplicationPageHandlerPort<Page>["reconcile"]>
        >;
    },
  });
  return {
    observer: {
      async observe() {
        const value = truths[observed++];
        assert.ok(value, "fixture observation exhausted");
        calls.push(`observe:${value.page}`);
        return { ok: true, value };
      },
    },
    handlers: {
      resume: handler("resume"),
      profile: handler("profile"),
      questionnaire: handler("questionnaire"),
    },
    navigation: {
      async next(request) {
        calls.push(`next:${request.from}:${request.expected}`);
        return { ok: true, value: { advanced: true } };
      },
    },
    progress: {
      async record(progress) {
        calls.push(
          `progress:${progress.checkpoint}:${progress.completedPages}`,
        );
        return { ok: true, value: undefined };
      },
    },
  };
}

export function truth(page: ApplicationPage): ApplicationPageTruth {
  if (page === "pre_review") {
    return {
      page,
      pageId: walkFixture.pages.pre_review,
      requiredFields: [],
      c3OwnedDuplicateRows: 0,
      submitActivated: false,
    };
  }
  return {
    page,
    pageId: walkFixture.pages[page],
    requiredFields: [
      {
        fieldId: walkFixture.fields[page],
        verification: "verified",
      },
    ],
    c3OwnedDuplicateRows: 0,
    submitActivated: false,
  };
}
