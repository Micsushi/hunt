import assert from 'node:assert/strict'
import {
  draftBaselineForEdit,
  expectedRevisionForDraft,
  selectDraft,
  type DraftState,
} from './draftState.ts'
import type { ResumeDocument } from './types.ts'

const document = {} as ResumeDocument
const dirtyDraft: DraftState = {
  doc: document,
  savedJson: '{"server":"old"}',
  baseRevision: 3,
  undoStack: [],
  redoStack: [],
}

// A refetch may expose revision 4 while the retained dirty draft still belongs to revision 3.
assert.equal(selectDraft(dirtyDraft, '{"server":"new"}', 4), dirtyDraft)
assert.equal(expectedRevisionForDraft(dirtyDraft, 4), 3)

const cleanDraft: DraftState = {
  ...dirtyDraft,
  savedJson: '{}',
}
const refreshedDoc = {} as ResumeDocument
const refreshedDraft = draftBaselineForEdit(undefined, refreshedDoc, '{}', 4)
assert.equal(selectDraft(cleanDraft, '{}', 3), cleanDraft)
// Even identical remote content is a new baseline when its revision advances to 4.
assert.equal(selectDraft(cleanDraft, '{}', 4), undefined)
assert.equal(refreshedDraft.baseRevision, 4)
assert.equal(expectedRevisionForDraft(undefined, 4), 4)
