import {
  providerError,
  type AtsFamilyClassifier,
  type AtsFamilyClassificationRequestV1,
  type AtsFamilyClassificationResultV1,
  type CancellationError,
  type ClassificationId,
  type PortResult,
  type WorkdayPageType,
  type WorkdayPageTypeClassifier,
  type WorkdayPageTypeClassificationRequestV1,
  type WorkdayPageTypeClassificationResultV1,
} from "../../../contracts/index.ts";
import { LIVE_ENTRY_CLASSIFICATION_REVISION_ID, LIVE_ENTRY_TRAITS } from "./traits.ts";

const ATS_CLASSIFICATION_ID = "classification_live_workday_ats_v1" as ClassificationId;
const PAGE_CLASSIFICATION_IDS = Object.freeze({
  job_posting: "classification_live_job_posting_v1",
  account_entry: "classification_live_account_entry_v1",
  email_verification: "classification_live_email_verification_v1",
  candidate_home: "classification_live_candidate_home_v1",
  profile: "classification_live_profile_page_v1",
  questionnaire: "classification_live_questionnaire_v1",
  review: "classification_live_review_page_v1",
}) as Readonly<Record<WorkdayPageType, ClassificationId>>;

export function createLiveAtsFamilyClassifier(): AtsFamilyClassifier {
  return Object.freeze({
    async classify(
      request: AtsFamilyClassificationRequestV1,
      signal: AbortSignal,
    ): Promise<PortResult<AtsFamilyClassificationResultV1, CancellationError>> {
      if (signal.aborted) return { ok: false, error: cancelled() };
      const traits = new Set<string>(request.observation.traitIds);
      const workday = traits.has(LIVE_ENTRY_TRAITS.ats.workday);
      const nonWorkday = traits.has(LIVE_ENTRY_TRAITS.ats.nonWorkday);
      if (workday && nonWorkday) return success({ kind: "ats_ambiguous" });
      if (workday) {
        return success({
          kind: "classified",
          atsFamily: "workday",
          classificationId: ATS_CLASSIFICATION_ID,
        });
      }
      if (nonWorkday) {
        return success({
          kind: "ats_unsupported",
          familyId: "ats_family_non_workday_family_v1" as never,
        });
      }
      return success({ kind: "ats_unknown" });
    },
  });
}

export function createLiveWorkdayPageTypeClassifier(): WorkdayPageTypeClassifier {
  return Object.freeze({
    async classify(
      request: WorkdayPageTypeClassificationRequestV1,
      signal: AbortSignal,
    ): Promise<PortResult<WorkdayPageTypeClassificationResultV1, CancellationError>> {
      if (signal.aborted) return { ok: false, error: cancelled() };
      const traits = new Set<string>(request.observation.traitIds);
      const matches = (Object.entries(LIVE_ENTRY_TRAITS.pages) as ReadonlyArray<
        readonly [WorkdayPageType, string]
      >).filter(([, traitId]) => traits.has(traitId));
      if (matches.length === 0) return success({ kind: "workday_page_unknown" });
      if (matches.length > 1) return success({ kind: "workday_page_ambiguous" });
      const pageType = matches[0]![0];
      return success({
        kind: "classified",
        pageType,
        classificationId: PAGE_CLASSIFICATION_IDS[pageType],
      });
    },
  });
}

function cancelled() {
  return providerError("operation_cancelled");
}

function success<T extends { readonly kind: string }>(
  value: T,
): { readonly ok: true; readonly value: T & {
  readonly schemaVersion: 1;
  readonly sourceRevisionId: typeof LIVE_ENTRY_CLASSIFICATION_REVISION_ID;
} } {
  return Object.freeze({
    ok: true,
    value: Object.freeze({
      schemaVersion: 1,
      ...value,
      sourceRevisionId: LIVE_ENTRY_CLASSIFICATION_REVISION_ID,
    }),
  });
}
