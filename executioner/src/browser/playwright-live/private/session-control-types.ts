import type { PersistentPage } from "./types.ts";

export type SessionLogoutResult = {
  readonly kind: "signed_out" | "already_signed_out";
};

export interface SemanticSessionControlAdapter {
  logout(page: PersistentPage): Promise<SessionLogoutResult>;
}
