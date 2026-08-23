import { s2StableErrorPolicy } from "../../../contracts/s2-common-wire.ts";
import {
  completeWorkdayProfilePage,
  type ProfilePageCompletionResult,
  type ProfilePagePlan,
  type WorkdayProfilePagePort,
} from "./profile/index.ts";
import type {
  QuestionnairePageHandler,
  QuestionnairePageRequest,
  QuestionnairePageValue,
} from "./questions/index.ts";
import {
  isWorkdayResumeFileIntent,
  type WorkdayResumeAcceptance,
  type WorkdayResumeFileIntent,
  type WorkdayResumeUploadHandler,
} from "./resume/index.ts";
import {
  applicationPageForCheckpoint,
  isValidApplicationPageSequence,
  type ApplicationCheckpoint,
  type ApplicationPageHandlerPort,
  type ApplicationPortFailure,
  type ApplicationWalkDependencies,
} from "./page-walk-contract.ts";

export interface ImmutableApplicationLaneSources {
  resumeIntent(): WorkdayResumeFileIntent;
  profilePlan(): ProfilePagePlan;
  questionnaireRequest(): QuestionnairePageRequest;
}

export interface ApplicationLaneSourceValues {
  readonly resumeIntent: WorkdayResumeFileIntent;
  readonly profilePlan: ProfilePagePlan;
  readonly questionnaireRequest: QuestionnairePageRequest;
}

export function createImmutableApplicationLaneSources(
  values: ApplicationLaneSourceValues,
): ImmutableApplicationLaneSources {
  if (!isWorkdayResumeFileIntent(values.resumeIntent)) {
    throw new TypeError("resume source must contain an admitted immutable intent");
  }
  if (
    !["live", "synthetic_test_non_submittable"].includes(values.profilePlan.mode) ||
    !["live", "synthetic_test_non_submittable"].includes(values.questionnaireRequest.mode)
  ) {
    throw new TypeError("production application lanes require live owner mode");
  }
  const profilePlan = deepFreeze(structuredClone(values.profilePlan));
  const requestClone = structuredClone({
    mode: values.questionnaireRequest.mode,
    journeyId: values.questionnaireRequest.journeyId,
    sessionId: values.questionnaireRequest.sessionId,
    pageId: values.questionnaireRequest.pageId,
    guardRevision: values.questionnaireRequest.guardRevision,
    profileId: values.questionnaireRequest.profileId,
    profileRevision: values.questionnaireRequest.profileRevision,
    resume: values.questionnaireRequest.resume,
    page: values.questionnaireRequest.page,
    activeListboxes: values.questionnaireRequest.activeListboxes,
  });
  const questionnaireRequest = deepFreeze({
    ...requestClone,
    resumeArtifact: values.questionnaireRequest.resumeArtifact,
  }) as QuestionnairePageRequest;
  const resumeIntent = values.resumeIntent;
  return Object.freeze({
    resumeIntent: () => resumeIntent,
    profilePlan: () => profilePlan,
    questionnaireRequest: () => questionnaireRequest,
  });
}

export interface ApplicationLaneHandlerDependencies {
  readonly sources: ImmutableApplicationLaneSources;
  readonly resume: WorkdayResumeUploadHandler;
  readonly profilePage: WorkdayProfilePagePort;
  readonly questionnaire: QuestionnairePageHandler;
  readonly acceptanceSink?: ApplicationLaneAcceptanceSink;
}

type VerifiedProfilePage = Extract<
  ProfilePageCompletionResult,
  { readonly kind: "verified" }
>;
type VerifiedQuestionnairePage = Extract<
  QuestionnairePageValue,
  { readonly kind: "verified" }
>;

export type ApplicationLaneAcceptance =
  | WorkdayResumeAcceptance
  | {
      readonly schemaVersion: 1;
      readonly checkpoint: "profile_verified";
      readonly pageType: VerifiedProfilePage["pageType"];
      readonly verifiedFields: VerifiedProfilePage["verifiedFields"];
      readonly ownedDuplicateRows: 0;
      readonly independentlyVerified: true;
      readonly profileFieldLearningSha256?: string;
      readonly submitActivated: false;
      readonly privacyScan: "pass";
    }
  | {
      readonly schemaVersion: 1;
      readonly checkpoint: "questionnaire_verified";
      readonly answers: VerifiedQuestionnairePage["answers"];
      readonly protectedPlaceholderCount: 0;
      readonly independentlyVerified: true;
      readonly submitActivated: false;
      readonly privacyScan: "pass";
    };

export interface ApplicationLaneAcceptanceSink {
  record(acceptance: ApplicationLaneAcceptance): void;
}

export interface ApplicationLaneAcceptanceCollector
  extends ApplicationLaneAcceptanceSink {
  snapshot(checkpoint: ApplicationCheckpoint): readonly ApplicationLaneAcceptance[];
}

export function createApplicationLaneAcceptanceCollector(): ApplicationLaneAcceptanceCollector {
  const records: ApplicationLaneAcceptance[] = [];
  return Object.freeze({
    record(acceptance: ApplicationLaneAcceptance): void {
      if (!liveLaneAcceptance(acceptance)) {
        throw new TypeError("application lane acceptance provenance is invalid");
      }
      const candidate = [...records, acceptance];
      if (!isValidApplicationPageSequence(candidate.map(({ checkpoint }) =>
        applicationPageForCheckpoint(checkpoint)
      ))) {
        throw new TypeError("application lane acceptance order is invalid");
      }
      records.push(deepFreeze(structuredClone(acceptance)));
    },
    snapshot(checkpoint: ApplicationCheckpoint): readonly ApplicationLaneAcceptance[] {
      let count = records.length;
      if (checkpoint !== "pre_review") {
        count = 0;
        for (let index = records.length - 1; index >= 0; index -= 1) {
          if (records[index]?.checkpoint === checkpoint) {
            count = index + 1;
            break;
          }
        }
      }
      if (count < 1 && checkpoint !== "pre_review") {
        throw new TypeError("application lane acceptance is incomplete");
      }
      return Object.freeze(records.slice(0, count));
    },
  });
}

export function createApplicationLaneHandlers(
  dependencies: ApplicationLaneHandlerDependencies,
): ApplicationWalkDependencies["handlers"] {
  return Object.freeze({
    resume: resumeHandler(dependencies),
    profile: profileHandler(dependencies),
    questionnaire: questionnaireHandler(dependencies),
  });
}

function resumeHandler(
  dependencies: ApplicationLaneHandlerDependencies,
): ApplicationPageHandlerPort<"resume"> {
  return Object.freeze({
    async reconcile(
      request: Parameters<ApplicationPageHandlerPort<"resume">["reconcile"]>[0],
      signal: AbortSignal,
    ) {
      const result = await dependencies.resume.upload(
        dependencies.sources.resumeIntent(),
        signal,
      );
      if (!result.ok) return laneFailure("resume", result.error);
      if (
        result.value.checkpoint !== "resume_verified" ||
        result.value.independentlyVerified !== true ||
        result.value.submitActivated !== false ||
        result.value.privacyScan !== "pass"
      ) return laneFailure("resume", undefined);
      if (!recordAcceptance(dependencies.acceptanceSink, result.value)) {
        return laneFailure("resume", { code: "evidence_denied" });
      }
      return verified("resume", "resume_verified", request.pageId);
    },
  });
}

function profileHandler(
  dependencies: ApplicationLaneHandlerDependencies,
): ApplicationPageHandlerPort<"profile"> {
  return Object.freeze({
    async reconcile(
      request: Parameters<ApplicationPageHandlerPort<"profile">["reconcile"]>[0],
      signal: AbortSignal,
    ) {
      const result = await completeWorkdayProfilePage(
        dependencies.sources.profilePlan(),
        dependencies.profilePage,
        signal,
      );
      if (result.kind !== "verified" || result.ownedDuplicateRows !== 0) {
        return laneFailure("profile", result);
      }
      if (!recordAcceptance(dependencies.acceptanceSink, {
        schemaVersion: 1,
        checkpoint: "profile_verified",
        pageType: result.pageType,
        verifiedFields: result.verifiedFields,
        ownedDuplicateRows: 0,
        independentlyVerified: true,
        submitActivated: false,
        privacyScan: "pass",
      })) return laneFailure("profile", { code: "evidence_denied" });
      return verified("profile", "profile_verified", request.pageId);
    },
  });
}

function questionnaireHandler(
  dependencies: ApplicationLaneHandlerDependencies,
): ApplicationPageHandlerPort<"questionnaire"> {
  return Object.freeze({
    async reconcile(
      request: Parameters<ApplicationPageHandlerPort<"questionnaire">["reconcile"]>[0],
      signal: AbortSignal,
    ) {
      const source = dependencies.sources.questionnaireRequest();
      if (
        source.journeyId !== request.journeyId ||
        source.pageId !== request.pageId
      ) return laneFailure("questionnaire", undefined);
      const result = await dependencies.questionnaire.complete(source, signal);
      if (
        !result.ok ||
        result.value.kind !== "verified" ||
        result.value.protectedPlaceholderCount !== 0
      ) return laneFailure("questionnaire", result.ok ? result.value : result.error);
      if (!recordAcceptance(dependencies.acceptanceSink, {
        schemaVersion: 1,
        checkpoint: "questionnaire_verified",
        answers: result.value.answers,
        protectedPlaceholderCount: 0,
        independentlyVerified: true,
        submitActivated: false,
        privacyScan: "pass",
      })) return laneFailure("questionnaire", { code: "evidence_denied" });
      return verified(
        "questionnaire",
        "questionnaire_verified",
        request.pageId,
      );
    },
  });
}

function recordAcceptance(
  sink: ApplicationLaneAcceptanceSink | undefined,
  acceptance: ApplicationLaneAcceptance,
): boolean {
  try {
    if (!liveLaneAcceptance(acceptance)) return false;
    sink?.record(deepFreeze(structuredClone(acceptance)));
    return true;
  } catch {
    return false;
  }
}

function liveLaneAcceptance(acceptance: ApplicationLaneAcceptance): boolean {
  if (acceptance.checkpoint === "resume_verified") return true;
  if (acceptance.checkpoint === "profile_verified") {
    return acceptance.verifiedFields.every((field) =>
      (field.lane === "live_owner_fact" && field.provenance !== "generated_default") ||
      (field.lane === "synthetic_test_default" && field.provenance === "generated_default")
    );
  }
  return acceptance.answers.every((answer) =>
    (answer.lane === "live_owner_fact" &&
      answer.provenance !== "reviewed_catalog" && answer.provenance !== "visible_option") ||
    (answer.lane === "synthetic_test_default" &&
      (answer.provenance === "reviewed_catalog" || answer.provenance === "visible_option"))
  );
}

function verified<
  Page extends "resume" | "profile" | "questionnaire",
  Checkpoint extends Page extends "resume"
    ? "resume_verified"
    : Page extends "profile"
      ? "profile_verified"
      : "questionnaire_verified",
>(page: Page, checkpoint: Checkpoint, pageId: Parameters<ApplicationPageHandlerPort<Page>["reconcile"]>[0]["pageId"]) {
  return {
    ok: true as const,
    value: {
      page,
      pageId,
      checkpoint,
      independentlyVerified: true as const,
    },
  };
}

function laneFailure(
  page: "resume" | "profile" | "questionnaire",
  error: unknown,
): { readonly ok: false; readonly error: ApplicationPortFailure } {
  const code = errorCode(error);
  return {
    ok: false,
    error: {
      code,
      classifier: `${page}_page`,
      primitive: page === "resume"
        ? "file_upload"
        : page === "profile"
          ? "profile_control"
          : "question_control",
      unknownLayer: unknownLayer(page, error),
    },
  };
}

function errorCode(error: unknown): keyof typeof s2StableErrorPolicy {
  const code = nestedCode(error);
  if (code === "profile_port_unavailable") return "browser_timeout";
  return code !== undefined && Object.hasOwn(s2StableErrorPolicy, code)
    ? code as keyof typeof s2StableErrorPolicy
    : "page_incomplete";
}

function nestedCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  if ("code" in error && typeof error.code === "string") return error.code;
  if ("error" in error) return nestedCode(error.error);
  return undefined;
}

function unknownLayer(
  page: "resume" | "profile" | "questionnaire",
  error: unknown,
): ApplicationPortFailure["unknownLayer"] {
  const code = nestedCode(error) ?? "";
  if (page === "resume") return /artifact|identity|file_type/u.test(code)
    ? "required_field"
    : "ui_behavior";
  if (page === "profile") return /row|duplicate/u.test(code)
    ? "repeatable_row"
    : /missing/u.test(code)
      ? "required_field"
      : "ui_behavior";
  return /unknown|ambiguous|candidate/u.test(code)
    ? "question"
    : /answer|protected|option|narrative/u.test(code)
      ? "answer"
      : "ui_behavior";
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}
