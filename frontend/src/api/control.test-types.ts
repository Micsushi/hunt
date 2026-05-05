/**
 * Compile-time type tests for TailorResult.
 * These are checked by `tsc --noEmit` (the typecheck CI step).
 * No runtime test runner needed.
 */
import type { TailorResult } from './control'

// TailorResult must have all four fields
const _full: TailorResult = {
  noSummary: new Blob(),
  withSummary: new Blob(),
  log: new Blob(),
  llmError: null,
}

// All fields must accept null
const _nulls: TailorResult = {
  noSummary: null,
  withSummary: null,
  log: null,
  llmError: null,
}

// Exhaustiveness: adding an unexpected field must be a type error
// @ts-expect-error extra field not allowed
const _extra: TailorResult = { noSummary: null, withSummary: null, log: null, llmError: null, other: 'x' }

export { _full, _nulls, _extra }
