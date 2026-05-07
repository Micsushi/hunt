export type LatexInlinePart =
  | { kind: 'text'; text: string }
  | { kind: 'bold'; text: string }
  | { kind: 'link'; text: string; href: string }

function findMatchingBrace(text: string, openIndex: number): number {
  let depth = 0
  for (let idx = openIndex; idx < text.length; idx += 1) {
    const char = text[idx]
    const escaped = idx > 0 && text[idx - 1] === '\\'
    if (char === '{' && !escaped) depth += 1
    else if (char === '}' && !escaped) {
      depth -= 1
      if (depth === 0) return idx
    }
  }
  return -1
}

function readBraced(text: string, openIndex: number): { value: string; end: number } | null {
  if (text[openIndex] !== '{') return null
  const closeIndex = findMatchingBrace(text, openIndex)
  if (closeIndex === -1) return null
  return { value: text.slice(openIndex + 1, closeIndex), end: closeIndex + 1 }
}

function cleanText(text: string): string {
  return text
    .replace(/\\([#$%&_{}])/g, '$1')
    .replace(/\\[a-zA-Z]+\*?(?:\[[^\]]*\])?/g, '')
    .replace(/[{}]/g, '')
}

export function latexInlineParts(value: string): LatexInlinePart[] {
  const parts: LatexInlinePart[] = []
  let cursor = 0
  while (cursor < value.length) {
    const nextBold = value.indexOf('\\textbf', cursor)
    const nextHref = value.indexOf('\\href', cursor)
    const candidates = [nextBold, nextHref].filter((idx) => idx >= 0)
    const next = candidates.length ? Math.min(...candidates) : -1
    if (next === -1) {
      const text = cleanText(value.slice(cursor))
      if (text) parts.push({ kind: 'text', text })
      break
    }
    if (next > cursor) {
      const text = cleanText(value.slice(cursor, next))
      if (text) parts.push({ kind: 'text', text })
    }
    if (value.startsWith('\\textbf', next)) {
      const content = readBraced(value, next + '\\textbf'.length)
      if (!content) {
        const fallback = cleanText(value.slice(next + '\\textbf'.length))
        if (fallback) parts.push({ kind: 'bold', text: fallback })
        break
      }
      parts.push({ kind: 'bold', text: cleanText(content.value) })
      cursor = content.end
      continue
    }
    const href = readBraced(value, next + '\\href'.length)
    const label = href ? readBraced(value, href.end) : null
    if (!href || !label) {
      const fallback = cleanText(value.slice(next + '\\href'.length))
      if (fallback) parts.push({ kind: 'link', href: fallback, text: fallback })
      break
    }
    parts.push({ kind: 'link', href: cleanText(href.value), text: cleanText(label.value) })
    cursor = label.end
  }
  return parts
}

export function humanizeLatex(value: string): string {
  return latexInlineParts(value)
    .map((part) => part.text)
    .join('')
}
