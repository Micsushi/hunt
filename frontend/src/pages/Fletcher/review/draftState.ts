import type { ResumeDocument } from './types'

export interface DraftState {
  doc: ResumeDocument
  savedJson: string
  baseRevision: number
  undoStack: ResumeDocument[]
  redoStack: ResumeDocument[]
}

function documentJson(doc: ResumeDocument): string {
  return JSON.stringify(doc)
}

export function selectDraft(
  storedDraft: DraftState | undefined,
  serverJson: string,
  serverRevision: number,
): DraftState | undefined {
  if (!storedDraft) return undefined
  const dirty = documentJson(storedDraft.doc) !== storedDraft.savedJson
  return dirty ||
    (storedDraft.savedJson === serverJson && storedDraft.baseRevision === serverRevision)
    ? storedDraft
    : undefined
}

export function draftBaselineForEdit(
  previous: DraftState | undefined,
  serverDoc: ResumeDocument,
  serverJson: string,
  serverRevision: number,
): DraftState {
  return (
    previous || {
      doc: serverDoc,
      savedJson: serverJson,
      baseRevision: serverRevision,
      undoStack: [],
      redoStack: [],
    }
  )
}

export function expectedRevisionForDraft(
  draft: DraftState | undefined,
  currentRevision: number,
): number {
  return draft?.baseRevision ?? currentRevision
}
