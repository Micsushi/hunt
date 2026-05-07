/**
 * Compile-time type tests for TailorResult.
 * These are checked by `tsc --noEmit` (the typecheck CI step).
 * No runtime test runner needed.
 */
import type { TailorResult } from './control'

// TailorResult must have all fields
const _full: TailorResult = {
  reviewId: 'review',
  review: null,
  noSummary: new Blob(),
  withSummary: new Blob(),
  log: new Blob(),
  llmError: null,
  errorType: null,
  error: null,
}

// All fields must accept null
const _nulls: TailorResult = {
  reviewId: null,
  review: null,
  noSummary: null,
  withSummary: null,
  log: null,
  llmError: null,
  errorType: null,
  error: null,
}

// Exhaustiveness: adding an unexpected field must be a type error
const _extra: TailorResult = {
  reviewId: null,
  review: null,
  noSummary: null,
  withSummary: null,
  log: null,
  llmError: null,
  errorType: null,
  error: null,
  // @ts-expect-error extra field not allowed
  other: 'x',
}

export { _full, _nulls, _extra }
