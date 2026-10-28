import { useEffect, useMemo, useRef, useState } from 'react'
import {
  skipToken,
  useIsMutating,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import {
  compileFletcherReviewVersion,
  fetchFletcherReview,
  saveFletcherReviewVersion,
} from '@/api/control'
import { useUiStore } from '@/store/ui'
import { applySegmentRevert, buildDiffSegments, type DiffSegment } from './diff'
import {
  buildReviewBlocks,
  setBlockText,
  skillRowsForDoc,
  type ReviewBlock,
} from './documentBlocks'
import { humanizeLatex, latexInlineParts } from './latexInline'
import {
  draftBaselineForEdit,
  expectedRevisionForDraft,
  selectDraft,
  type DraftState,
} from './draftState'
import type { KeywordScore, ResumeDocument, ResumeReviewPackage, ReviewVersionName } from './types'
import styles from './ResumeReviewWorkspace.module.css'

interface WorkspaceSelection {
  block: ReviewBlock
  segment?: DiffSegment
}

interface DraftCache {
  drafts: Record<string, DraftState>
  versionName: ReviewVersionName
  editingBlockId: string | null
  editText: string
}

const EMPTY_DRAFT_CACHE: DraftCache = {
  drafts: {},
  versionName: 'no_summary',
  editingBlockId: null,
  editText: '',
}

function cloneDoc(doc: ResumeDocument): ResumeDocument {
  return JSON.parse(JSON.stringify(doc)) as ResumeDocument
}

function docJson(doc: ResumeDocument): string {
  return JSON.stringify(doc)
}

export function ResumeReviewWorkspace({ reviewId }: { reviewId: string }) {
  return <ReviewWorkspace key={reviewId} reviewId={reviewId} />
}

function ReviewWorkspace({ reviewId }: { reviewId: string }) {
  const showToast = useUiStore((s) => s.showToast)
  const qc = useQueryClient()
  const cacheKey = ['fletcher-review-draft', reviewId]
  const { data: recovery = EMPTY_DRAFT_CACHE } = useQuery<DraftCache>({
    queryKey: cacheKey,
    queryFn: skipToken,
    initialData: EMPTY_DRAFT_CACHE,
    gcTime: Infinity,
  })
  const [versionName, setVersionName] = useState<ReviewVersionName>(
    recovery?.versionName ?? 'no_summary',
  )
  const [selection, setSelected] = useState<WorkspaceSelection | null>(null)
  const [editingBlockId, setEditingBlockId] = useState<string | null>(
    recovery?.editingBlockId ?? null,
  )
  const [editText, setEditText] = useState(recovery?.editText ?? '')
  const drafts = recovery.drafts
  function setDrafts(update: (current: Record<string, DraftState>) => Record<string, DraftState>) {
    qc.setQueryData<DraftCache>(cacheKey, (current) => ({
      ...(current ?? recovery),
      drafts: update(current?.drafts ?? {}),
    }))
  }
  const isSaving = useIsMutating({ mutationKey: ['fletcher-review-save', reviewId] }) > 0
  const isCompiling = useIsMutating({ mutationKey: ['fletcher-review-compile', reviewId] }) > 0
  const saving = useRef(false)
  const compiling = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const [saveError, setSaveError] = useState<string | null>(null)
  const [showSavedVersion, setShowSavedVersion] = useState(false)
  useEffect(() => {
    const key = ['fletcher-review-draft', reviewId]
    qc.setQueryData<DraftCache>(key, (current) => ({
      drafts: current?.drafts ?? {},
      versionName,
      editingBlockId,
      editText,
    }))
  }, [qc, reviewId, versionName, editingBlockId, editText])

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['fletcher-review', reviewId],
    queryFn: () => fetchFletcherReview(reviewId),
  })

  async function updateReviewVersion(
    review: ResumeReviewPackage,
    updatedVersion: ReviewVersionName,
  ) {
    await qc.cancelQueries(
      { queryKey: ['fletcher-review', reviewId], exact: true },
      { revert: false },
    )
    qc.setQueryData<ResumeReviewPackage>(['fletcher-review', reviewId], (current) => {
      if (!current) return review
      const incoming = review.versions[updatedVersion]
      const existing = current.versions[updatedVersion]
      if (
        !incoming ||
        (existing &&
          (existing.edit_revision > incoming.edit_revision ||
            (existing.edit_revision === incoming.edit_revision &&
              existing.compiled_revision > incoming.compiled_revision)))
      )
        return current
      return { ...current, versions: { ...current.versions, [updatedVersion]: incoming } }
    })
  }

  const saveMutation = useMutation({
    mutationKey: ['fletcher-review-save', reviewId],
    mutationFn: ({
      version,
      doc,
      revision,
    }: {
      version: ReviewVersionName
      doc: ResumeDocument
      revision: number
    }) => saveFletcherReviewVersion(reviewId, version, doc, revision),
    onSuccess: async (review, { version: savedVersion }) => {
      await updateReviewVersion(review, savedVersion)
      if (mounted.current) showToast('Resume edits saved')
    },
    onError: (e) => showToast(e instanceof Error ? e.message : 'Save failed', 'error'),
  })

  const compileMutation = useMutation({
    mutationKey: ['fletcher-review-compile', reviewId],
    mutationFn: ({ version, revision }: { version: ReviewVersionName; revision: number }) =>
      compileFletcherReviewVersion(reviewId, version, revision),
    onSuccess: async (review, { version: compiledVersion }) => {
      await updateReviewVersion(review, compiledVersion)
      if (!mounted.current) return
      const status = review.versions[compiledVersion]?.compile_status
      if (status && status !== 'ok') {
        showToast(`Compile failed: ${status}`, 'error')
      } else {
        showToast('Resume compiled')
      }
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
  const draft = selectDraft(storedDraft, versionJson, version?.edit_revision ?? 0)
  const draftDoc = draft?.doc || version?.current
  const hasUnsavedDraft = !!draft && docJson(draft.doc) !== draft.savedJson
  const blocks = useMemo(
    () =>
      version && draftDoc ? buildReviewBlocks(version.original, version.generated, draftDoc) : [],
    [version, draftDoc],
  )
  const selected =
    selection &&
    blocks.some(
      (block) =>
        block.blockId === selection.block.blockId &&
        block.original === selection.block.original &&
        block.current === selection.block.current,
    )
      ? selection
      : null
  const changedCount = blocks.filter(
    (block) => block.original.trim() !== block.current.trim(),
  ).length

  useEffect(() => {
    function onBeforeUnload(event: BeforeUnloadEvent) {
      const dirty = Object.values(drafts).some((item) => docJson(item.doc) !== item.savedJson)
      if (!dirty && editingBlockId === null) return
      event.preventDefault()
      event.returnValue = ''
    }

    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [drafts, editingBlockId])

  function pushDraft(doc: ResumeDocument) {
    setDrafts((current) => {
      const cached = current[draftKey]
      const previous = selectDraft(cached, versionJson, version?.edit_revision ?? 0)
      const base = draftBaselineForEdit(
        previous,
        cloneDoc(version?.current || doc),
        docJson(version?.current || doc),
        version?.edit_revision ?? 0,
      )
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

  async function saveDraft(): Promise<number | false> {
    if (!draftDoc || saving.current || isSaving || isCompiling || editingBlockId !== null)
      return false
    saving.current = true
    setSaveError(null)
    const submittedJson = docJson(draftDoc)
    try {
      const review = await saveMutation.mutateAsync({
        version: activeVersionName,
        doc: draftDoc,
        revision: expectedRevisionForDraft(draft, version?.edit_revision ?? 0),
      })
      const savedDoc = review.versions[activeVersionName]?.current || draftDoc
      setDrafts((current) => {
        const existing = current[draftKey]
        const savedRevision = review.versions[activeVersionName]?.edit_revision ?? 0
        if (existing && existing.baseRevision > savedRevision) return current
        return {
          ...current,
          [draftKey]: {
            doc:
              existing && docJson(existing.doc) !== submittedJson
                ? existing.doc
                : cloneDoc(savedDoc),
            savedJson: docJson(savedDoc),
            baseRevision: savedRevision,
            undoStack: existing?.undoStack || [],
            redoStack: existing?.redoStack || [],
          },
        }
      })
      return review.versions[activeVersionName]?.edit_revision ?? 0
    } catch (error) {
      if (!mounted.current) return false
      setSaveError(error instanceof Error ? error.message : 'Save failed. Your draft is preserved.')
      return false
    } finally {
      saving.current = false
    }
  }

  async function compileDraft() {
    if (saving.current || isSaving || compiling.current || isCompiling || editingBlockId !== null)
      return
    compiling.current = true
    try {
      let expectedRevision = expectedRevisionForDraft(draft, version?.edit_revision ?? 0)
      if (hasUnsavedDraft) {
        const saved = await saveDraft()
        if (saved === false || !mounted.current) return
        expectedRevision = saved
      }
      await compileMutation.mutateAsync({ version: activeVersionName, revision: expectedRevision })
    } catch {
      // The mutation reports the compilation failure; the draft remains available.
    } finally {
      compiling.current = false
    }
  }

  function updateBlock(block: ReviewBlock, value: string) {
    if (!draftDoc) return
    pushDraft(setBlockText(draftDoc, block.blockId, value))
    setSelected(null)
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
    if (editingBlockId === block.blockId) return
    if (editingBlockId !== null && editingBlockId !== block.blockId) {
      setSaveError('Apply or cancel the current block edit before editing another block.')
      return
    }
    setEditingBlockId(block.blockId)
    setEditText(blocks.find((item) => item.blockId === block.blockId)?.current ?? block.current)
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
    if (editingBlockId !== null) {
      setSaveError('Apply or cancel the current block edit before opening an artifact.')
      return
    }
    if (hasUnsavedDraft) {
      const shouldSave = window.confirm(
        'Save your resume edits before leaving? Press OK to save and continue, or Cancel to stay here.',
      )
      if (!shouldSave) return
      const saved = await saveDraft()
      if (!saved || !mounted.current) return
    }
    window.location.href = href
  }

  function chooseVersion(nextVersion: ReviewVersionName) {
    if (editingBlockId !== null) {
      setSaveError('Apply or cancel the current block edit before switching versions.')
      return
    }
    setShowSavedVersion(false)
    setSaveError(null)
    setSelected(null)
    setEditingBlockId(null)
    setVersionName(nextVersion)
  }

  if (isLoading) return <div className={styles.meta}>Loading review...</div>
  if (!data || !version || !draftDoc) {
    return (
      <div className={styles.warning} role="alert">
        The review could not be loaded. <button onClick={() => void refetch()}>Retry</button>
      </div>
    )
  }

  return (
    <div className={styles.workspace}>
      {isError && (
        <div className={styles.warning} role="alert">
          Refresh failed. Your draft and the last loaded review are still available.{' '}
          <button className={styles.button} onClick={() => void refetch()}>
            Retry review
          </button>
        </div>
      )}
      {saveError && (
        <div className={styles.warning} role="alert">
          {saveError}
          <button
            className={styles.button}
            disabled={isSaving || isCompiling}
            onClick={async () => {
              const refreshed = await refetch()
              if (refreshed.error) {
                setSaveError('The saved resume could not be loaded. Your draft is preserved.')
                return
              }
              setShowSavedVersion(true)
            }}
          >
            Review saved version
          </button>
        </div>
      )}
      {showSavedVersion && (
        <section className={styles.warning}>
          <h2>Currently saved version</h2>
          <p>Your draft is still in the editor below. Compare it before choosing what to keep.</p>
          <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {buildReviewBlocks(version.original, version.generated, version.current)
              .map((block) => humanizeLatex(block.current))
              .join('\n\n')}
          </pre>
          <button
            className={styles.button}
            disabled={editingBlockId !== null || isSaving || isCompiling}
            onClick={() => {
              setDrafts((current) => ({
                ...current,
                [draftKey]: {
                  ...(current[draftKey] ?? {
                    doc: cloneDoc(draftDoc),
                    undoStack: [],
                    redoStack: [],
                  }),
                  savedJson: docJson(version.current),
                  baseRevision: version.edit_revision ?? 0,
                },
              }))
              setShowSavedVersion(false)
              setSaveError('Your draft is ready. Choose Save to replace the reviewed version.')
            }}
          >
            Keep my draft for saving
          </button>
          <button
            className={styles.button}
            disabled={editingBlockId !== null || isSaving || isCompiling}
            onClick={() => {
              setDrafts((current) => ({
                ...current,
                [draftKey]: {
                  doc: cloneDoc(version.current),
                  savedJson: docJson(version.current),
                  baseRevision: version.edit_revision ?? 0,
                  undoStack: [...(current[draftKey]?.undoStack ?? []), cloneDoc(draftDoc)].slice(
                    -50,
                  ),
                  redoStack: [],
                },
              }))
              setShowSavedVersion(false)
              setSaveError(null)
            }}
          >
            Use saved version
          </button>
        </section>
      )}
      <ReviewToolbar
        review={data}
        versionName={activeVersionName}
        versions={availableVersions}
        changedCount={changedCount}
        dirty={hasUnsavedDraft}
        canUndo={!!draft?.undoStack.length}
        canRedo={!!draft?.redoStack.length}
        saving={isSaving}
        compiling={isCompiling}
        editing={editingBlockId !== null}
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
              {selected.block.contextLabel ? (
                <div className={styles.meta}>{selected.block.contextLabel}</div>
              ) : null}
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
                Apply block edit
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

interface KeywordPanelItem extends KeywordScore {
  candidates: NonNullable<KeywordScore['candidates']>
}

type KeywordGroupKind = 'supported' | 'rewrite' | 'other'

function normalizeKeywordText(value: string | undefined): string {
  return humanizeLatex(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9+#./]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function keywordVisibleInText(keyword: string, text: string | undefined): boolean {
  const key = normalizeKeywordText(keyword)
  const visible = normalizeKeywordText(text)
  return !!key && !!visible && visible.includes(key)
}

function resumeBullets(doc: ResumeDocument | undefined): string[] {
  if (!doc) return []
  return [
    ...doc.experience.flatMap((entry) => entry.bullets),
    ...doc.projects.flatMap((entry) => entry.bullets),
  ]
}

function inferLegacySupportKind(
  keyword: string,
  usedItem: { bullet_idx?: number | null; support_kind?: string } | undefined,
  originalBullets: string[],
  generatedBullets: string[],
): string | undefined {
  if (!usedItem || usedItem.support_kind) return usedItem?.support_kind
  const bulletIdx = usedItem.bullet_idx
  if (bulletIdx === null || bulletIdx === undefined) return undefined
  const original = originalBullets[bulletIdx]
  const generated = generatedBullets[bulletIdx]
  if (keywordVisibleInText(keyword, generated) && !keywordVisibleInText(keyword, original)) {
    return 'rewrite_added'
  }
  return 'legacy_supported'
}

function normalizeKeywordScores(review: ResumeReviewPackage): KeywordPanelItem[] {
  const raw = review.keywords.raw || []
  const comparisonVersion =
    review.versions.no_summary || review.versions.with_summary || review.versions.starting
  const originalBullets = resumeBullets(comparisonVersion?.original)
  const generatedBullets = resumeBullets(comparisonVersion?.generated)
  const present = new Set((review.keywords.present || []).map((item) => item.toLowerCase()))
  const missing = new Set((review.keywords.missing || []).map((item) => item.toLowerCase()))
  const used = new Map(
    (review.keywords.used || [])
      .filter((item) => item.keyword)
      .map((item) => [item.keyword.toLowerCase(), item]),
  )
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
      const usedItem = used.get(key)
      const supportKind = inferLegacySupportKind(
        keyword,
        usedItem,
        originalBullets,
        generatedBullets,
      )
      const fallbackStatus =
        supportKind === 'rewrite_added'
          ? 'rewrite_used'
          : usedItem
            ? 'supported'
            : present.has(key)
              ? 'present'
              : missing.has(key)
                ? 'missing'
                : 'raw'
      const rawStatus = item.status || fallbackStatus
      const status =
        rawStatus === 'used'
          ? supportKind === 'rewrite_added'
            ? 'rewrite_used'
            : 'supported'
          : rawStatus
      const usedBulletIdx =
        item.used_bullet_idx ??
        (usedItem?.bullet_idx === undefined ? undefined : usedItem.bullet_idx)
      const fallbackBulletIdx = usedBulletIdx ?? item.bullet_idx
      const candidates = [...(item.candidates || [])]
      if (
        fallbackBulletIdx !== null &&
        fallbackBulletIdx !== undefined &&
        !candidates.some((candidate) => candidate.bullet_idx === fallbackBulletIdx)
      ) {
        candidates.unshift({
          bullet_idx: fallbackBulletIdx,
          score: item.score,
          bullet_text: usedItem?.bullet_text,
        })
      }
      return {
        ...item,
        keyword: item.keyword || keyword,
        status,
        tier: item.tier || status,
        score: typeof item.score === 'number' ? item.score : status === 'present' ? 1 : 0,
        used_bullet_idx: usedBulletIdx,
        support_kind: item.support_kind || supportKind,
        candidates,
      }
    })
    .filter((item) => {
      const key = item.keyword.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((a, b) => {
      const tierRank: Record<string, number> = {
        rewrite_used: 6,
        supported: 5,
        used: 5,
        high: 4,
        mid: 3,
        low: 2,
        present: 1,
        error: 0,
      }
      const aRank = tierRank[String(a.tier || a.status)] ?? 0
      const bRank = tierRank[String(b.tier || b.status)] ?? 0
      if (aRank !== bRank) return bRank - aRank
      return (b.score || 0) - (a.score || 0)
    })
}

function KeywordPanel({ review }: { review: ResumeReviewPackage }) {
  const keywords = useMemo(() => normalizeKeywordScores(review), [review])
  const supportedKeywords = keywords.filter(
    (item) => item.status === 'present' || item.status === 'supported',
  )
  const rewriteKeywords = keywords.filter((item) => item.status === 'rewrite_used')
  const otherKeywords = keywords.filter((item) => {
    const tier = String(item.tier || '').toLowerCase()
    return item.status === 'missing' && (tier === 'high' || tier === 'mid')
  })
  return (
    <section className={styles.keywordPanel}>
      <div className={styles.panelTitle}>Keywords</div>
      {keywords.length ? (
        <>
          <KeywordGroup
            title="Already supported"
            emptyText="No extracted keywords were already supported."
            keywords={supportedKeywords}
            kind="supported"
          />
          <KeywordGroup
            title="Added by rewrite"
            emptyText="No keyword was newly added to a bullet."
            keywords={rewriteKeywords}
            kind="rewrite"
          />
          <KeywordGroup
            title="Other keywords"
            emptyText="No unused high or medium keyword candidates."
            keywords={otherKeywords}
            kind="other"
          />
        </>
      ) : (
        <div className={styles.meta}>No extracted keywords found.</div>
      )}
    </section>
  )
}

function KeywordGroup({
  title,
  emptyText,
  keywords,
  kind,
}: {
  title: string
  emptyText: string
  keywords: KeywordPanelItem[]
  kind: KeywordGroupKind
}) {
  return (
    <div className={styles.keywordGroup}>
      <div className={styles.keywordGroupTitle}>{title}</div>
      {keywords.length ? (
        <div className={styles.keywordList}>
          {keywords.map((item) => (
            <KeywordCard item={item} key={item.keyword} kind={kind} />
          ))}
        </div>
      ) : (
        <div className={styles.keywordEmpty}>{emptyText}</div>
      )}
    </div>
  )
}

function KeywordCard({ item, kind }: { item: KeywordPanelItem; kind: KeywordGroupKind }) {
  const usedBulletIdx = item.used_bullet_idx ?? item.bullet_idx
  const hasHighMatch = String(item.tier || '').toLowerCase() === 'high'
  const otherCandidates =
    !hasHighMatch || usedBulletIdx === null || usedBulletIdx === undefined
      ? item.candidates
      : item.candidates.filter((candidate) => candidate.bullet_idx !== usedBulletIdx)
  const visibleCandidates =
    kind === 'rewrite' && hasHighMatch
      ? otherCandidates
      : kind === 'other' && hasHighMatch
        ? item.candidates
        : []
  const supportIdx = usedBulletIdx ?? item.candidates[0]?.bullet_idx
  const meta =
    kind === 'rewrite'
      ? supportIdx === null || supportIdx === undefined
        ? 'Added in an unmatched bullet'
        : `Added in bullet ${Number(supportIdx) + 1}`
      : kind === 'supported'
        ? supportIdx === null || supportIdx === undefined
          ? 'Supported in resume'
          : `Supported by bullet ${Number(supportIdx) + 1}`
        : visibleCandidates.length
          ? 'Best resume bullet'
          : String(item.tier || '').toLowerCase() === 'mid'
            ? 'Medium match, not used'
            : 'No high-match bullet candidates'
  return (
    <div className={styles.keywordItem}>
      <div>
        <div className={styles.keywordName}>{item.keyword}</div>
        <div className={styles.keywordMeta}>{meta}</div>
        <CandidateList candidates={visibleCandidates} kind={kind} showEmptyHint={hasHighMatch} />
      </div>
      <div className={styles.keywordScore}>
        <span>{item.tier || item.status || 'raw'}</span>
        <strong>{Math.round((item.score || 0) * 100)}%</strong>
      </div>
    </div>
  )
}

function CandidateList({
  candidates,
  kind,
  showEmptyHint,
}: {
  candidates: NonNullable<KeywordScore['candidates']>
  kind: KeywordGroupKind
  showEmptyHint: boolean
}) {
  if (!candidates.length) {
    return kind === 'rewrite' && showEmptyHint ? (
      <div className={styles.keywordCandidateHint}>No alternate bullet candidates.</div>
    ) : null
  }
  return (
    <div
      className={styles.keywordCandidates}
      aria-label={kind === 'rewrite' ? 'Alternative candidate bullets' : 'Possible bullets'}
    >
      {kind === 'rewrite' ? (
        <span className={styles.keywordCandidateLabel}>Alternative candidates</span>
      ) : null}
      {candidates.map((candidate, idx) => (
        <span
          className={styles.keywordCandidate}
          title={candidate.bullet_text || candidate.bullet_preview}
          key={`${candidate.bullet_idx ?? 'none'}:${idx}`}
        >
          {candidate.bullet_idx === null || candidate.bullet_idx === undefined
            ? 'No bullet'
            : `Bullet ${Number(candidate.bullet_idx) + 1}`}
          {typeof candidate.score === 'number'
            ? ` (${Math.round(candidate.score * 100)}% match)`
            : ''}
        </span>
      ))}
    </div>
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
  editing,
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
  editing: boolean
  onCompile: () => void
  onOpenLink: (href: string | undefined) => void
}) {
  const version = review.versions[versionName]
  const compileFailed = !!version?.compile_status && version.compile_status !== 'ok'
  const pdfUnavailable = compileFailed && !version?.compiled_revision
  const statusSuffix = dirty
    ? ' : unsaved draft'
    : version?.dirty
      ? ' : uncompiled edits'
      : pdfUnavailable
        ? ' : PDF compile failed'
        : compileFailed
          ? ' : latest compile failed'
          : ''
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
          {statusSuffix}
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
        <button
          className={styles.buttonPrimary}
          disabled={!dirty || saving || compiling || editing}
          onClick={onSave}
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
        <button
          className={styles.buttonPrimary}
          disabled={compiling || saving || editing}
          onClick={onCompile}
        >
          {compiling ? 'Compiling...' : 'Compile'}
        </button>
        <button
          className={styles.button}
          disabled={!version?.pdf_url || pdfUnavailable}
          title={pdfUnavailable ? 'Compile this version before opening its PDF.' : undefined}
          onClick={() => onOpenLink(version?.pdf_url)}
        >
          PDF
        </button>
        <button
          className={styles.button}
          disabled={!version?.tex_url}
          onClick={() => onOpenLink(version?.tex_url)}
        >
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
        {skillRowsForDoc(doc).map((row) => (
          <div className={styles.skillRow} key={row.blockId}>
            <strong>{row.label}:</strong>
            <span>{renderBlock(row.blockId)}</span>
          </div>
        ))}
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
      role="button"
      tabIndex={0}
      aria-label={`Edit ${block.label}`}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onEdit(block)
        }
      }}
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
