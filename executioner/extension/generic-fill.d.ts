export interface PartialFillResult {
  status: 'partial';
  filled: string[];
  skipped: { label: string; reason: string }[];
  canUndo: boolean;
  canRedo: boolean;
}
export function fillVisibleFields(input?: {
  facts?: readonly { factId: string; value: unknown }[];
  action?: 'fill' | 'undo' | 'redo' | 'status';
  scope?: 'application' | 'page';
  expectedUrl?: string;
  expiresAt?: number;
}): Promise<PartialFillResult>;
