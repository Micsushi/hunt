import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  compileFletcherReviewVersion,
  fetchFletcherReview,
  saveFletcherReviewVersion,
} from '@/api/control'
import { useUiStore } from '@/store/ui'
import { applySegmentRevert, buildDiffSegments, type DiffSegment } from './diff'
import { buildReviewBlocks, setBlockText, type ReviewBlock } from './documentBlocks'
import { humanizeLatex, latexInlineParts } from './latexInline'
import type { KeywordScore, ResumeDocument, ResumeReviewPackage, ReviewVersionName } from './types'
import styles from './ResumeReviewWorkspace.module.css'

interface WorkspaceSelection {
  block: ReviewBlock
  segment?: DiffSegment
}

interface DraftState {
  doc: ResumeDocument
  savedJson: string
  undoStack: ResumeDocument[]
  redoStack: ResumeDocument[]
}

function cloneDoc(doc: ResumeDocument): ResumeDocument {
  return JSON.parse(JSON.stringify(doc)) as ResumeDocument
}

function docJson(doc: ResumeDocument): string {
  return JSON.stringify(doc)
}

export function ResumeReviewWorkspace({ reviewId }: { reviewId: string }) {
  const showToast = useUiStore((s) => s.showToast)
  const qc = useQueryClient()
  const [versionName, setVersionName] = useState<ReviewVersionName>('no_summary')
  const [selected, setSelected] = useState<WorkspaceSelection | null>(null)
  const [editingBlockId, setEditingBlockId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [drafts, setDrafts] = useState<Record<string, DraftState>>({})

  const { data, isLoading, isError } = useQuery({
    queryKey: ['fletcher-review', reviewId],
    queryFn: () => fetchFletcherReview(reviewId),
  })

  const saveMutation = useMutation({
    mutationFn: ({ version, doc }: { version: ReviewVersionName; doc: ResumeDocument }) =>
      saveFletcherReviewVersion(reviewId, version, doc),
    onSuccess: (review) => {
      qc.setQueryData(['fletcher-review', reviewId], review)
      showToast('Resume edits saved')
    },
    onError: (e) => showToast(e instanceof Error ? e.message : 'Save failed', 'error'),
  })

  const compileMutation = useMutation({
    mutationFn: (version: ReviewVersionName) => compileFletcherReviewVersion(reviewId, version),
    onSuccess: (review) => {
      qc.setQueryData(['fletcher-review', reviewId], review)
      showToast('Resume compiled')
    },
    onError: (e) => showToast(e instanceof Error ? e.message : 'Compile failed', 'error'),
  })

  const availableVersions = Object.keys(data?.versions || {}) as ReviewVersionName[]
  const activeVersionName = availableVersions.includes(versionName)
    ? versionName
    : availableVersions[0] || 'no_summary'
  const version = data?.versions[activeVersionName]
  const draftKey = `${reviewId}:${activeVersionName}`
  const storedDraft = drafts[draftKey]
  const versionJson = version ? docJson(version.current) : ''
  const storedDraftDirty = storedDraft && docJson(storedDraft.doc) !== storedDraft.savedJson
  const draft =
    storedDraft && (storedDraftDirty || storedDraft.savedJson === versionJson)
      ? storedDraft
      : undefined
  const draftDoc = draft?.doc || version?.current
  const hasUnsavedDraft = !!draft && docJson(draft.doc) !== draft.savedJson
  const blocks = useMemo(
    () =>
      version && draftDoc ? buildReviewBlocks(version.original, version.generated, draftDoc) : [],
    [version, draftDoc],
  )
  const changedCount = blocks.filter(
    (block) => block.original.trim() !== block.current.trim(),
  ).length

  useEffect(() => {
    function onBeforeUnload(event: BeforeUnloadEvent) {
      const dirty = Object.values(drafts).some((item) => docJson(item.doc) !== item.savedJson)
      if (!dirty) return
      event.preventDefault()
      event.returnValue = ''
    }

    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [drafts])

  function pushDraft(doc: ResumeDocument) {
    setDrafts((current) => {
      const previous = current[draftKey]
      const base = previous || {
        doc: cloneDoc(version?.current || doc),
        savedJson: docJson(version?.current || doc),
        undoStack: [],
        redoStack: [],
      }
      if (docJson(base.doc) === docJson(doc)) return current
      return {
        ...current,
        [draftKey]: {
          ...base,
          doc: cloneDoc(doc),
          undoStack: [...base.undoStack, cloneDoc(base.doc)].slice(-50),
          redoStack: [],
        },
      }
    })
  }

  async function saveDraft(): Promise<boolean> {
    if (!draftDoc) return false
    try {
      const review = await saveMutation.mutateAsync({
        version: activeVersionName,
        doc: draftDoc,
      })
      const savedDoc = review.versions[activeVersionName]?.current || draftDoc
      setDrafts((current) => {
        const existing = current[draftKey]
        return {
          ...current,
          [draftKey]: {
            doc: cloneDoc(savedDoc),
            savedJson: docJson(savedDoc),
            undoStack: existing?.undoStack || [],
            redoStack: existing?.redoStack || [],
          },
        }
      })
      return true
    } catch {
      return false
    }
  }

  async function compileDraft() {
    if (hasUnsavedDraft) {
      const saved = await saveDraft()
      if (!saved) return
    }
    compileMutation.mutate(activeVersionName)
  }

  function updateBlock(block: ReviewBlock, value: string) {
    if (!draftDoc) return
    pushDraft(setBlockText(draftDoc, block.blockId, value))
  }

  function revertSelectedSegment() {
    if (!selected?.segment || !draftDoc) return
    const nextText = applySegmentRevert(
      selected.block.original,
      selected.block.current,
      selected.segment,
    )
    updateBlock(selected.block, nextText)
    setSelected(null)
  }

  function startEdit(block: ReviewBlock) {
    setEditingBlockId(block.blockId)
    setEditText(block.current)
  }

  function undoDraft() {
    setDrafts((current) => {
      const existing = current[draftKey]
      const previous = existing?.undoStack[existing.undoStack.length - 1]
      if (!existing || !previous) return current
      return {
        ...current,
        [draftKey]: {
          ...existing,
          doc: cloneDoc(previous),
          undoStack: existing.undoStack.slice(0, -1),
          redoStack: [...existing.redoStack, cloneDoc(existing.doc)],
        },
      }
    })
    setSelected(null)
  }

  function redoDraft() {
    setDrafts((current) => {
      const existing = current[draftKey]
      const next = existing?.redoStack[existing.redoStack.length - 1]
      if (!existing || !next) return current
      return {
        ...current,
        [draftKey]: {
          ...existing,
          doc: cloneDoc(next),
          undoStack: [...existing.undoStack, cloneDoc(existing.doc)],
          redoStack: existing.redoStack.slice(0, -1),
        },
      }
    })
    setSelected(null)
  }

  function undoAllChanges() {
    if (!version) return
    pushDraft(version.original)
    setSelected(null)
  }

  async function openPossiblyDirtyHref(href: string | undefined) {
    if (!href) return
    if (hasUnsavedDraft) {
      const shouldSave = window.confirm(
        'Save your resume edits before leaving? Press OK to save and continue, or Cancel to stay here.',
      )
      if (!shouldSave) return
      const saved = await saveDraft()
      if (!saved) return
    }
    window.location.href = href
  }

  function chooseVersion(nextVersion: ReviewVersionName) {
    setSelected(null)
    setEditingBlockId(null)
    setVersionName(nextVersion)
  }

  if (isLoading) return <div className={styles.meta}>Loading review...</div>
  if (isError || !data || !version || !draftDoc) {
    return <div className={styles.warning}>Review not found.</div>
  }

  return (
    <div className={styles.workspace}>
      <ReviewToolbar
        review={data}
        versionName={activeVersionName}
        versions={availableVersions}
        changedCount={changedCount}
        dirty={hasUnsavedDraft}
        canUndo={!!draft?.undoStack.length}
        canRedo={!!draft?.redoStack.length}
        saving={saveMutation.isPending}
        compiling={compileMutation.isPending}
        onVersion={chooseVersion}
        onUndo={undoDraft}
        onRedo={redoDraft}
        onUndoAll={undoAllChanges}
        onSave={() => void saveDraft()}
        onCompile={() => void compileDraft()}
        onOpenLink={(href) => void openPossiblyDirtyHref(href)}
      />
      {data.source.import_warnings.length ? (
        <div className={styles.warning}>{data.source.import_warnings.join(' ')}</div>
      ) : null}
      {data.llm?.cloud ? (
        <div className={styles.warning}>
          Cloud provider active: {data.llm.provider}. Resume text may leave this machine.
        </div>
      ) : null}
      <div className={styles.layout}>
        <ResumeDiffDocument
          doc={draftDoc}
          blocks={blocks}
          selected={selected}
          onSelect={setSelected}
          onEdit={startEdit}
        />
        <aside className={styles.inspector}>
          <h2>Inspector</h2>
          {selected ? (
            <div className={styles.smallStack}>
              <div className={styles.meta}>{selected.block.label}</div>
              {selected.segment ? (
                <button className={styles.buttonPrimary} onClick={revertSelectedSegment}>
                  Revert segment
                </button>
              ) : null}
              <button className={styles.button} onClick={() => startEdit(selected.block)}>
                Edit block
              </button>
            </div>
          ) : (
            <div className={styles.meta}>Select a block, changed segment, or edit a block.</div>
          )}
          {editingBlockId ? (
            <div className={styles.smallStack}>
              <textarea
                className={styles.textarea}
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
              />
              <button
                className={styles.buttonPrimary}
                onClick={() => {
                  const block = blocks.find((item) => item.blockId === editingBlockId)
                  if (block) updateBlock(block, editText)
                  setEditingBlockId(null)
                }}
              >
                Save block
              </button>
              <button className={styles.button} onClick={() => setEditingBlockId(null)}>
                Cancel
              </button>
            </div>
          ) : null}
          <KeywordPanel review={data} />
        </aside>
      </div>
    </div>
  )
}

function normalizeKeywordScores(review: ResumeReviewPackage): KeywordScore[] {
  const raw = review.keywords.raw || []
  const present = new Set((review.keywords.present || []).map((item) => item.toLowerCase()))
  const missing = new Set((review.keywords.missing || []).map((item) => item.toLowerCase()))
  const scored = new Map<string, KeywordScore>()
  for (const item of review.keywords.rag_scores || []) {
    if (!item.keyword) continue
    const key = item.keyword.toLowerCase()
    const existing = scored.get(key)
    if (existing && (existing.score || 0) >= (item.score || 0)) continue
    scored.set(key, item)
  }
  const seen = new Set<string>()
  return raw
    .map((keyword) => {
      const key = keyword.toLowerCase()
      const item = scored.get(key) || { keyword }
      const status =
        item.status || (present.has(key) ? 'present' : missing.has(key) ? 'missing' : 'raw')
      return {
        ...item,
        keyword: item.keyword || keyword,
        status,
        tier: item.tier || status,
        score: typeof item.score === 'number' ? item.score : status === 'present' ? 1 : 0,
      }
    })
    .filter((item) => {
      const key = item.keyword.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((a, b) => {
      const tierRank: Record<string, number> = { high: 4, mid: 3, low: 2, present: 1, error: 0 }
      const aRank = tierRank[String(a.tier || a.status)] ?? 0
      const bRank = tierRank[String(b.tier || b.status)] ?? 0
      if (aRank !== bRank) return bRank - aRank
      return (b.score || 0) - (a.score || 0)
    })
}

function KeywordPanel({ review }: { review: ResumeReviewPackage }) {
  const keywords = useMemo(() => normalizeKeywordScores(review), [review])
  return (
    <section className={styles.keywordPanel}>
      <div className={styles.panelTitle}>Keywords</div>
      {keywords.length ? (
        <div className={styles.keywordList}>
          {keywords.map((item) => (
            <div className={styles.keywordItem} key={item.keyword}>
              <div>
                <div className={styles.keywordName}>{item.keyword}</div>
                <div className={styles.keywordMeta}>
                  {item.bullet_idx === null || item.bullet_idx === undefined
                    ? 'No matched bullet'
                    : `Best bullet ${Number(item.bullet_idx) + 1}`}
                </div>
              </div>
              <div className={styles.keywordScore}>
                <span>{item.tier || item.status || 'raw'}</span>
                <strong>{Math.round((item.score || 0) * 100)}</strong>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className={styles.meta}>No extracted keywords found.</div>
      )}
    </section>
  )
}

function ReviewToolbar({
  review,
  versionName,
  versions,
  changedCount,
  dirty,
  canUndo,
  canRedo,
  saving,
  compiling,
  onVersion,
  onUndo,
  onRedo,
  onUndoAll,
  onSave,
  onCompile,
  onOpenLink,
}: {
  review: ResumeReviewPackage
  versionName: ReviewVersionName
  versions: ReviewVersionName[]
  changedCount: number
  dirty: boolean
  canUndo: boolean
  canRedo: boolean
  saving: boolean
  compiling: boolean
  onVersion: (version: ReviewVersionName) => void
  onUndo: () => void
  onRedo: () => void
  onUndoAll: () => void
  onSave: () => void
  onCompile: () => void
  onOpenLink: (href: string | undefined) => void
}) {
  const version = review.versions[versionName]
  return (
    <div className={styles.toolbar}>
      <div className={styles.toolbarGroup}>
        <div className={styles.segmented}>
          {versions.map((item) => (
            <button
              key={item}
              className={item === versionName ? styles.active : ''}
              onClick={() => onVersion(item)}
            >
              {item === 'starting'
                ? 'Starting'
                : item === 'with_summary'
                  ? 'With summary'
                  : 'No summary'}
            </button>
          ))}
        </div>
        <span className={styles.meta}>
          {changedCount} changed block{changedCount === 1 ? '' : 's'}
          {dirty ? ' : unsaved draft' : version?.dirty ? ' : uncompiled edits' : ''}
        </span>
      </div>
      <div className={styles.toolbarGroup}>
        <button className={styles.button} disabled={!canUndo} onClick={onUndo}>
          Undo
        </button>
        <button className={styles.button} disabled={!canRedo} onClick={onRedo}>
          Redo
        </button>
        <button className={styles.button} onClick={onUndoAll}>
          Undo all
        </button>
        <button className={styles.buttonPrimary} disabled={!dirty || saving} onClick={onSave}>
          {saving ? 'Saving...' : 'Save'}
        </button>
        <button className={styles.buttonPrimary} disabled={compiling} onClick={onCompile}>
          {compiling ? 'Compiling...' : 'Compile'}
        </button>
        <button className={styles.button} onClick={() => onOpenLink(version?.pdf_url)}>
          PDF
        </button>
        <button className={styles.button} onClick={() => onOpenLink(version?.tex_url)}>
          TeX
        </button>
        <button className={styles.button} onClick={() => onOpenLink(review.log_url)}>
          Log
        </button>
      </div>
    </div>
  )
}

function ResumeDiffDocument({
  doc,
  blocks,
  selected,
  onSelect,
  onEdit,
}: {
  doc: ResumeDocument
  blocks: ReviewBlock[]
  selected: WorkspaceSelection | null
  onSelect: (value: WorkspaceSelection) => void
  onEdit: (block: ReviewBlock) => void
}) {
  const blockMap = useMemo(() => new Map(blocks.map((block) => [block.blockId, block])), [blocks])

  function renderBlock(blockId: string, className = '') {
    const block = blockMap.get(blockId)
    if (!block) return null
    return (
      <DiffTextBlock
        block={block}
        selected={selected}
        onSelect={onSelect}
        onEdit={onEdit}
        className={className}
      />
    )
  }

  const summaryBlock = blockMap.get('summary')

  return (
    <main className={styles.paper}>
      <header className={styles.resumeHeader}>
        <div className={styles.resumeName}>{renderBlock('header.name')}</div>
        <div className={styles.resumeContact}>{renderBlock('header.contact_line')}</div>
      </header>

      {summaryBlock && (summaryBlock.current || summaryBlock.original) ? (
        <section className={styles.resumeSection}>
          <p className={styles.summaryText}>{renderBlock('summary')}</p>
        </section>
      ) : null}

      <section className={styles.resumeSection}>
        <h2 className={styles.resumeSectionTitle}>Education</h2>
        <div className={styles.entryHeader}>
          <div className={styles.entryTitle}>
            {renderBlock(`education.${doc.education.entry.entry_id}.header`)}
          </div>
          <div className={styles.entryDate}>
            {renderBlock(`education.${doc.education.entry.entry_id}.date`)}
          </div>
        </div>
        {doc.education.bullets.length ? (
          <ul className={styles.bulletList}>
            {doc.education.bullets.map((_bullet, idx) => (
              <li key={idx}>
                {renderBlock(`education.${doc.education.entry.entry_id}.bullet.${idx}`)}
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className={styles.resumeSection}>
        <h2 className={styles.resumeSectionTitle}>Experience</h2>
        {doc.experience.map((entry) => (
          <article className={styles.resumeEntry} key={entry.entry_id}>
            <div className={styles.entryHeader}>
              <div className={styles.entryTitle}>
                {renderBlock(`experience.${entry.entry_id}.header`)}
              </div>
              <div className={styles.entryDate}>
                {renderBlock(`experience.${entry.entry_id}.date`)}
              </div>
            </div>
            <ul className={styles.bulletList}>
              {entry.bullets.map((_bullet, idx) => (
                <li key={idx}>{renderBlock(`experience.${entry.entry_id}.bullet.${idx}`)}</li>
              ))}
            </ul>
          </article>
        ))}
      </section>

      <section className={styles.resumeSection}>
        <h2 className={styles.resumeSectionTitle}>Projects</h2>
        {doc.projects.map((entry) => (
          <article className={styles.resumeEntry} key={entry.entry_id}>
            <div className={styles.entryHeader}>
              <div className={styles.entryTitle}>
                {renderBlock(`projects.${entry.entry_id}.header`)}
              </div>
              <div className={styles.entryDate}>
                {renderBlock(`projects.${entry.entry_id}.date`)}
              </div>
            </div>
            <ul className={styles.bulletList}>
              {entry.bullets.map((_bullet, idx) => (
                <li key={idx}>{renderBlock(`projects.${entry.entry_id}.bullet.${idx}`)}</li>
              ))}
            </ul>
          </article>
        ))}
      </section>

      <section className={styles.resumeSection}>
        <h2 className={styles.resumeSectionTitle}>Technical Skills</h2>
        <div className={styles.skillRow}>
          <strong>Languages:</strong>
          <span>{renderBlock('skills.languages')}</span>
        </div>
        <div className={styles.skillRow}>
          <strong>Frameworks:</strong>
          <span>{renderBlock('skills.frameworks')}</span>
        </div>
        <div className={styles.skillRow}>
          <strong>Developer Tools:</strong>
          <span>{renderBlock('skills.developer_tools')}</span>
        </div>
      </section>
    </main>
  )
}

function DiffTextBlock({
  block,
  selected,
  onSelect,
  onEdit,
  className = '',
}: {
  block: ReviewBlock
  selected: WorkspaceSelection | null
  onSelect: (value: WorkspaceSelection) => void
  onEdit: (block: ReviewBlock) => void
  className?: string
}) {
  const segments = buildDiffSegments(block.blockId, block.original, block.current)
  const selectedBlock = selected?.block.blockId === block.blockId
  return (
    <span
      className={[styles.diffText, className, selectedBlock ? styles.selectedBlock : ''].join(' ')}
      onClick={() => onSelect({ block })}
      onDoubleClick={() => onEdit(block)}
    >
      {segments.map((segment) => {
        const text = humanizeLatex(segment.text)
        if (!text) return null
        return (
          <span
            key={segment.id}
            className={[
              styles.segment,
              segment.kind === 'add' ? styles.segmentAdd : '',
              segment.kind === 'del' ? styles.segmentDel : '',
              selected?.segment?.id === segment.id ? styles.selected : '',
            ].join(' ')}
            onClick={(event) => {
              if (segment.kind === 'same') return
              event.stopPropagation()
              onSelect({ block, segment })
            }}
          >
            <LatexInline text={segment.text} />
          </span>
        )
      })}
    </span>
  )
}

function LatexInline({ text }: { text: string }) {
  return (
    <>
      {latexInlineParts(text).map((part, idx) => {
        if (part.kind === 'bold') return <strong key={idx}>{part.text}</strong>
        if (part.kind === 'link') {
          return (
            <a key={idx} href={part.href} target="_blank" rel="noreferrer">
              {part.text}
            </a>
          )
        }
        return part.text
      })}
    </>
  )
}
