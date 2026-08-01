import type { PageIdentity } from "../../../contracts/index.ts";

type WorkdayPage = Extract<PageIdentity, { readonly kind: "workday" }> ["page"];

export interface WorkdayPageHandler {
  readonly page: WorkdayPage;
  readonly signatures: readonly string[];
}

export const workdayPageHandlers: readonly WorkdayPageHandler[] = Object.freeze([
  Object.freeze({ page: "account", signatures: Object.freeze(["account", "sign-in", "login", "create-account"]) }),
  Object.freeze({ page: "profile", signatures: Object.freeze(["profile", "my-information"]) }),
  Object.freeze({ page: "questionnaire", signatures: Object.freeze(["questionnaire", "application-questions"]) }),
  Object.freeze({ page: "review", signatures: Object.freeze(["review"]) }),
]);
