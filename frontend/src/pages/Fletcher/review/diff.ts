import { diffWordsWithSpace } from 'diff'

export type DiffSegmentKind = 'same' | 'add' | 'del'

export interface DiffSegment {
  id: string
  kind: DiffSegmentKind
  text: string
  index: number
  replacementIndexes?: number[]
}

function buildRawDiffSegments(blockId: string, original: string, current: string): DiffSegment[] {
  return diffWordsWithSpace(original || '', current || '').map((part, index) => ({
    id: `${blockId}.${index}`,
    kind: part.added ? 'add' : part.removed ? 'del' : 'same',
    text: part.value,
    index,
  }))
}

function isChanged(segment: DiffSegment): boolean {
  return segment.kind === 'add' || segment.kind === 'del'
}

function isWhitespaceOnly(segment: DiffSegment): boolean {
  return segment.kind === 'same' && segment.text.trim() === ''
}

function groupReplacementSegments(blockId: string, segments: DiffSegment[]): DiffSegment[] {
  const out: DiffSegment[] = []
  let cursor = 0
  while (cursor < segments.length) {
    const segment = segments[cursor]
    if (!isChanged(segment)) {
      out.push(segment)
      cursor += 1
      continue
    }

    const cluster: DiffSegment[] = [segment]
    let next = cursor + 1
    while (next < segments.length) {
      const item = segments[next]
      if (isChanged(item)) {
        cluster.push(item)
        next += 1
        continue
      }
      if (isWhitespaceOnly(item) && segments[next + 1] && isChanged(segments[next + 1])) {
        cluster.push(item)
        next += 1
        continue
      }
      break
    }

    const changed = cluster.filter(isChanged)
    const hasAdd = changed.some((item) => item.kind === 'add')
    const hasDel = changed.some((item) => item.kind === 'del')
    if (!hasAdd || !hasDel || changed.length < 2) {
      out.push(...cluster)
      cursor = next
      continue
    }

    const replacementIndexes = changed.map((item) => item.index)
    const delText = cluster
      .filter((item) => item.kind === 'del' || isWhitespaceOnly(item))
      .map((item) => item.text)
      .join('')
    const addText = cluster
      .filter((item) => item.kind === 'add' || isWhitespaceOnly(item))
      .map((item) => item.text)
      .join('')
    const firstIndex = changed[0].index
    if (delText) {
      out.push({
        id: `${blockId}.${firstIndex}.delGroup`,
        kind: 'del',
        text: delText,
        index: firstIndex,
        replacementIndexes,
      })
    }
    if (addText) {
      out.push({
        id: `${blockId}.${firstIndex}.addGroup`,
        kind: 'add',
        text: addText,
        index: firstIndex,
        replacementIndexes,
      })
    }
    cursor = next
  }
  return out
}

export function buildDiffSegments(
  blockId: string,
  original: string,
  current: string,
): DiffSegment[] {
  return groupReplacementSegments(blockId, buildRawDiffSegments(blockId, original, current))
}

export function isBlockChanged(original: string, current: string): boolean {
  return (original || '').trim() !== (current || '').trim()
}

export function applySegmentRevert(
  original: string,
  current: string,
  segment: DiffSegment,
): string {
  if (segment.kind === 'same') return current
  const before = buildRawDiffSegments('tmp', original, current)
  const replacementIndexes = new Set(segment.replacementIndexes || [segment.index])
  let out = ''
  for (const part of before) {
    if (replacementIndexes.has(part.index) && part.kind === 'add') continue
    if (replacementIndexes.has(part.index) && part.kind === 'del') {
      out += part.text
      continue
    }
    if (part.kind !== 'del') out += part.text
  }
  return out
}
