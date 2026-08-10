export interface ExternalMonitorPage {
  screenshot(options?: { readonly type?: "png" }): Promise<Buffer>;
  title(): Promise<string>;
  url(): string | Promise<string>;
}

export interface ExternalMonitorTaxonomy {
  readonly fieldCount: number;
  readonly requiredFieldCount: number;
  readonly controlTypes: readonly string[];
  readonly questionTypes: readonly string[];
  readonly answerTypes: readonly string[];
  readonly validationState: "clear";
  readonly submitPresent: boolean;
  readonly submitActivated: false;
}

export interface ExternalMonitorLifecycleEvent {
  readonly operationId: string;
  readonly attempt: number;
}

/** Browser-owned port only; evidence persistence remains composition-injected. */
export interface ExternalMonitorPort {
  auth(
    page: ExternalMonitorPage,
    pageName: string,
    moment: string,
    taxonomy: ExternalMonitorTaxonomy,
    event: ExternalMonitorLifecycleEvent,
    signal: AbortSignal,
  ): Promise<void>;
  application(
    page: ExternalMonitorPage,
    pageName: "resume" | "profile" | "questionnaire" | "review",
    moment: string,
    taxonomy: ExternalMonitorTaxonomy,
    event: ExternalMonitorLifecycleEvent,
    signal: AbortSignal,
  ): Promise<void>;
}
