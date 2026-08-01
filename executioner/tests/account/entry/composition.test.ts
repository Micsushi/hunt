import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { createStage2AccountEntryCredentialMutationAdapter } from "../../../src/composition/s2-account-entry.ts";
import type { ClassifiedAccountObservationSource } from "../../../src/ats/workday/live/index.ts";
import type { PlaywrightPersistentBrowserSession } from "../../../src/browser/playwright-live/session.ts";
import type { CredentialMutationResult } from "../../../src/contracts/live/index.ts";
import type { CredentialMutationRequest } from "../../../src/contracts/live/index.ts";
import type { AccountCredentialResolver } from "../../../src/secrets/windows-dpapi/private/resolver.ts";

test("composition injects the accepted T2, T3, and T4 private capabilities", () => {
  const browser = {} as Pick<PlaywrightPersistentBrowserSession, "withOwnedAccountPageAccess">;
  const classified = {} as ClassifiedAccountObservationSource;
  const resolver = {} as AccountCredentialResolver;
  const adapter = createStage2AccountEntryCredentialMutationAdapter(
    browser,
    classified,
    resolver,
    "fresh_create",
  );
  const structural: {
    mutate: (...args: never[]) => Promise<unknown>;
  } = adapter as never;
  assert.equal(typeof structural.mutate, "function");
  void (undefined as unknown as CredentialMutationResult);
});

test("production composition replaces the frozen create default with admitted sign-in", async () => {
  const operations: string[] = [];
  let classification = 0;
  const browser = {
    withOwnedAccountPageAccess: async (_request: unknown, _signal: AbortSignal, use: (access: unknown) => Promise<void>) => {
      const access = {
        inspectField: async () => ({ ok: true, value: { cardinality: 1, actionable: true } }),
        inspectAction: async () => ({ ok: true, value: { cardinality: 1, actionable: true } }),
        fill: async (field: string) => {
          operations.push(`fill:${field}`);
          return { ok: true, value: undefined };
        },
        matches: async (field: string) => {
          operations.push(`matches:${field}`);
          return { ok: true, value: true };
        },
        clear: async () => ({ ok: true, value: undefined }),
        isEmpty: async () => ({ ok: true, value: true }),
        activate: async (action: string) => {
          operations.push(`activate:${action}`);
          return { ok: true, value: undefined };
        },
      };
      await use(access);
      return { ok: true, value: undefined };
    },
  } as never;
  const classified = {
    inspectClassifiedAccount: async () => {
      classification += 1;
      const kind = classification === 1 ? "existing_account" : "application_ready";
      return {
        ok: true,
        value: {
          kind: "classified_account",
          state: {
            kind,
            classificationId: `classification_${kind}`,
            sourceRevisionId: "classification_revision_live_entry_v1",
          },
          classificationId: `classification_${kind}`,
          sourceRevisionId: "classification_revision_live_entry_v1",
          snapshotId: `snapshot_${classification}`,
          documentGenerationId: `generation_${classification}`,
        },
      };
    },
  } as never;
  const resolver = {
    useAccountCredentials: async (_handle: unknown, _signal: AbortSignal, use: (value: unknown) => Promise<unknown>) => ({
      ok: true,
      value: await use({ email: Uint8Array.from([101]), password: Uint8Array.from([112]) }),
    }),
  } as never;
  const adapter = createStage2AccountEntryCredentialMutationAdapter(
    browser,
    classified,
    resolver,
    "sign_in" as never,
  );
  const request = {
    schemaVersion: 1,
    journeyId: "journey_composed_account_0001",
    operationId: "operation_composed_account_0001",
    sessionId: "live_session_composed_account_0001",
    target: {
      schemaVersion: 1,
      atsFamily: "workday",
      hostId: "host_composed",
      tenantId: "tenant_composed",
      postingId: "posting_composed",
    },
    now: "2026-08-01T13:00:00.000Z",
    mode: "create_account",
    credential: {
      schemaVersion: 1,
      handleId: "secret_handle_composed_0001",
      journeyId: "journey_composed_account_0001",
      provider: "windows_dpapi_current_user_v1",
      purpose: "account_credentials",
      consumer: "credential_mutation_adapter",
      issuedAt: "2026-08-01T12:00:00.000Z",
      expiresAt: "2026-08-02T12:00:00.000Z",
      state: "active",
    },
    fields: ["email", "password"],
  } as unknown as CredentialMutationRequest;

  const result = await adapter.mutate(request, new AbortController().signal);
  assert.equal(result.ok && result.value.kind, "application_ready");
  assert.deepEqual(operations, [
    "fill:email",
    "matches:email",
    "fill:password",
    "matches:password",
    "activate:submit_sign_in",
  ]);
});

test("account entry consumes classified state and semantic intents, never traits or DOM", () => {
  const source = [
    readFileSync("src/account/entry/adapter.ts", "utf8"),
    readFileSync("src/account/entry/types.ts", "utf8"),
  ].join("\n");
  assert.doesNotMatch(source, /traitIds|locator|selector|getByRole|raw(?:Text|Html)|document\./u);
  assert.match(source, /inspectClassifiedAccount/u);
  assert.match(source, /show_sign_in|show_create_account/u);
});
