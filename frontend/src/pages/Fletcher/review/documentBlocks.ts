import type { ResumeDocument } from './types'

export interface ReviewBlock {
  blockId: string
  section: string
  label: string
  contextLabel?: string
  original: string
  generated: string
  current: string
}

const DEFAULT_SKILL_CATEGORIES = [
  { label: 'Languages', field: 'languages' },
  { label: 'Frameworks', field: 'frameworks' },
  { label: 'Developer Tools', field: 'developer_tools' },
] as const

type DefaultSkillField = (typeof DEFAULT_SKILL_CATEGORIES)[number]['field']

function cloneDoc(doc: ResumeDocument): ResumeDocument {
  return JSON.parse(JSON.stringify(doc)) as ResumeDocument
}

function encodeSkillLabel(label: string): string {
  return encodeURIComponent(label).replace(/\./g, '%2E')
}

function decodeSkillLabel(encoded: string): string {
  return decodeURIComponent(encoded)
}

function skillBlockId(label: string): string {
  return `skills.categories.${encodeSkillLabel(label)}`
}

function hasCategory(doc: ResumeDocument, label: string): boolean {
  return Object.prototype.hasOwnProperty.call(doc.skills.categories || {}, label)
}

function defaultSkillField(label: string): DefaultSkillField | null {
  return DEFAULT_SKILL_CATEGORIES.find((item) => item.label === label)?.field || null
}

function skillCategoryValues(doc: ResumeDocument, label: string): string[] {
  if (hasCategory(doc, label)) return doc.skills.categories?.[label] || []
  const field = defaultSkillField(label)
  return field ? doc.skills[field] : []
}

export function skillRowsForDoc(doc: ResumeDocument): { label: string; blockId: string }[] {
  const categoryEntries = Object.entries(doc.skills.categories || {}).filter(
    ([, values]) => values.length,
  )
  if (categoryEntries.length) {
    return categoryEntries.map(([label]) => ({ label, blockId: skillBlockId(label) }))
  }
  return DEFAULT_SKILL_CATEGORIES.filter(({ field }) => doc.skills[field].length).map(
    ({ label, field }) => ({ label, blockId: `skills.${field}` }),
  )
}

function setSkillCategory(doc: ResumeDocument, label: string, values: string[]) {
  doc.skills.categories = { ...(doc.skills.categories || {}), [label]: values }
  const field = defaultSkillField(label)
  if (field) doc.skills[field] = values
}

function getById(doc: ResumeDocument, blockId: string): string {
  const parts = blockId.split('.')
  if (blockId === 'header.name') return doc.header.name
  if (blockId === 'header.contact_line') return doc.header.contact_line
  if (blockId === 'summary') return doc.summary || ''
  if (parts[0] === 'education') {
    if (parts[2] === 'header') return doc.education.entry.institution_and_degree
    if (parts[2] === 'date') return doc.education.entry.date_text
    if (parts[2] === 'bullet') return doc.education.bullets[Number(parts[3])] || ''
  }
  if (parts[0] === 'experience') {
    const entry = doc.experience.find((item) => item.entry_id === parts[1])
    if (!entry) return ''
    if (parts[2] === 'header') return entry.title_company_location
    if (parts[2] === 'date') return entry.date_text
    if (parts[2] === 'bullet') return entry.bullets[Number(parts[3])] || ''
  }
  if (parts[0] === 'projects') {
    const entry = doc.projects.find((item) => item.entry_id === parts[1])
    if (!entry) return ''
    if (parts[2] === 'header') return entry.project_title
    if (parts[2] === 'date') return entry.date_or_link_text
    if (parts[2] === 'bullet') return entry.bullets[Number(parts[3])] || ''
  }
  if (blockId === 'skills.languages') return doc.skills.languages.join(', ')
  if (blockId === 'skills.frameworks') return doc.skills.frameworks.join(', ')
  if (blockId === 'skills.developer_tools') return doc.skills.developer_tools.join(', ')
  if (parts[0] === 'skills' && parts[1] === 'categories') {
    return skillCategoryValues(doc, decodeSkillLabel(parts.slice(2).join('.'))).join(', ')
  }
  return ''
}

export function setBlockText(doc: ResumeDocument, blockId: string, value: string): ResumeDocument {
  const next = cloneDoc(doc)
  const parts = blockId.split('.')
  if (blockId === 'header.name') next.header.name = value
  else if (blockId === 'header.contact_line') next.header.contact_line = value
  else if (blockId === 'summary') next.summary = value
  else if (parts[0] === 'education') {
    if (parts[2] === 'header') next.education.entry.institution_and_degree = value
    else if (parts[2] === 'date') next.education.entry.date_text = value
    else if (parts[2] === 'bullet') next.education.bullets[Number(parts[3])] = value
  } else if (parts[0] === 'experience') {
    const entry = next.experience.find((item) => item.entry_id === parts[1])
    if (entry && parts[2] === 'header') entry.title_company_location = value
    else if (entry && parts[2] === 'date') entry.date_text = value
    else if (entry && parts[2] === 'bullet') entry.bullets[Number(parts[3])] = value
  } else if (parts[0] === 'projects') {
    const entry = next.projects.find((item) => item.entry_id === parts[1])
    if (entry && parts[2] === 'header') entry.project_title = value
    else if (entry && parts[2] === 'date') entry.date_or_link_text = value
    else if (entry && parts[2] === 'bullet') entry.bullets[Number(parts[3])] = value
  } else if (blockId === 'skills.languages') next.skills.languages = splitList(value)
  else if (blockId === 'skills.frameworks') next.skills.frameworks = splitList(value)
  else if (blockId === 'skills.developer_tools') next.skills.developer_tools = splitList(value)
  else if (parts[0] === 'skills' && parts[1] === 'categories') {
    setSkillCategory(next, decodeSkillLabel(parts.slice(2).join('.')), splitList(value))
  }
  if (blockId === 'skills.languages' && next.skills.categories) {
    setSkillCategory(next, 'Languages', next.skills.languages)
  } else if (blockId === 'skills.frameworks' && next.skills.categories) {
    setSkillCategory(next, 'Frameworks', next.skills.frameworks)
  } else if (blockId === 'skills.developer_tools' && next.skills.categories) {
    setSkillCategory(next, 'Developer Tools', next.skills.developer_tools)
  }
  return next
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function pushBlock(
  blocks: ReviewBlock[],
  section: string,
  label: string,
  blockId: string,
  original: ResumeDocument,
  generated: ResumeDocument,
  current: ResumeDocument,
  contextLabel?: string,
) {
  blocks.push({
    blockId,
    section,
    label,
    contextLabel,
    original: getById(original, blockId),
    generated: getById(generated, blockId),
    current: getById(current, blockId),
  })
}

export function buildReviewBlocks(
  original: ResumeDocument,
  generated: ResumeDocument,
  current: ResumeDocument,
): ReviewBlock[] {
  const blocks: ReviewBlock[] = []
  pushBlock(blocks, 'Header', 'Name', 'header.name', original, generated, current)
  pushBlock(blocks, 'Header', 'Contact', 'header.contact_line', original, generated, current)
  pushBlock(blocks, 'Summary', 'Summary', 'summary', original, generated, current)
  pushBlock(
    blocks,
    'Education',
    'Education',
    `education.${current.education.entry.entry_id}.header`,
    original,
    generated,
    current,
  )
  pushBlock(
    blocks,
    'Education',
    'Education date',
    `education.${current.education.entry.entry_id}.date`,
    original,
    generated,
    current,
  )
  current.education.bullets.forEach((_bullet, idx) =>
    pushBlock(
      blocks,
      'Education',
      `Education bullet ${idx + 1}`,
      `education.${current.education.entry.entry_id}.bullet.${idx}`,
      original,
      generated,
      current,
    ),
  )
  let resumeBulletNumber = 1
  current.experience.forEach((entry) => {
    pushBlock(
      blocks,
      'Experience',
      entry.title_company_location,
      `experience.${entry.entry_id}.header`,
      original,
      generated,
      current,
    )
    pushBlock(
      blocks,
      'Experience',
      'Date',
      `experience.${entry.entry_id}.date`,
      original,
      generated,
      current,
    )
    entry.bullets.forEach((_bullet, idx) => {
      pushBlock(
        blocks,
        'Experience',
        `Resume bullet ${resumeBulletNumber}`,
        `experience.${entry.entry_id}.bullet.${idx}`,
        original,
        generated,
        current,
        `${entry.title_company_location} bullet ${idx + 1}`,
      )
      resumeBulletNumber += 1
    })
  })
  current.projects.forEach((entry) => {
    pushBlock(
      blocks,
      'Projects',
      entry.project_title,
      `projects.${entry.entry_id}.header`,
      original,
      generated,
      current,
    )
    pushBlock(
      blocks,
      'Projects',
      'Date or link',
      `projects.${entry.entry_id}.date`,
      original,
      generated,
      current,
    )
    entry.bullets.forEach((_bullet, idx) => {
      pushBlock(
        blocks,
        'Projects',
        `Resume bullet ${resumeBulletNumber}`,
        `projects.${entry.entry_id}.bullet.${idx}`,
        original,
        generated,
        current,
        `${entry.project_title} bullet ${idx + 1}`,
      )
      resumeBulletNumber += 1
    })
  })
  skillRowsForDoc(current).forEach((row) =>
    pushBlock(blocks, 'Technical Skills', row.label, row.blockId, original, generated, current),
  )
  return blocks.filter((block) => block.original || block.generated || block.current)
}
