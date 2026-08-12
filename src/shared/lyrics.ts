export type LyricSlide = {
  kind: 'title' | 'lyrics'
  section?: string
  lines: string[]
}

export type ParsedLyrics = {
  slides: LyricSlide[]
  errors: string[]
}

const SECTION_HEADER = /^\[([^\]\r\n]+)\]$/
const SLIDE_BREAK = '|||'

/**
 * Parses the app's intentionally small, human-editable lyric format.
 * Empty lines are for readability only; `|||` starts the next lyric slide.
 */
export function parseSectionedLyrics(lyricsText: string, title?: string): ParsedLyrics {
  const errors: string[] = []
  const slides: LyricSlide[] = []
  let section: string | undefined
  let lines: string[] = []

  const flush = () => {
    if (!lines.length) return
    slides.push({ kind: 'lyrics', ...(section ? { section } : {}), lines })
    lines = []
  }

  for (const [index, sourceLine] of lyricsText.replace(/\r\n?/g, '\n').split('\n').entries()) {
    const line = sourceLine.trim()
    if (!line) continue

    const heading = line.match(SECTION_HEADER)
    if (heading) {
      flush()
      section = heading[1].trim()
      if (!section) errors.push(`Line ${index + 1}: section headers cannot be empty.`)
      continue
    }

    if (line === SLIDE_BREAK) {
      if (!lines.length) errors.push(`Line ${index + 1}: ${SLIDE_BREAK} cannot create an empty slide.`)
      flush()
      continue
    }

    lines.push(line)
    if (lines.length === 4) flush()
  }
  flush()

  if (title?.trim()) slides.unshift({ kind: 'title', lines: [title.trim()] })
  if (!slides.some((slide) => slide.kind === 'lyrics')) errors.push('Add at least one lyric line.')
  return { slides, errors }
}

export function validateSectionedLyrics(lyricsText: string, title?: string): ParsedLyrics {
  const parsed = parseSectionedLyrics(lyricsText, title)
  for (const slide of parsed.slides) {
    if (slide.kind === 'lyrics' && (slide.lines.length < 1 || slide.lines.length > 4)) {
      parsed.errors.push('Each lyric slide must contain one to four lines.')
    }
  }
  return parsed
}

/**
 * Gives pasted, unstructured text a safe draft shape. It deliberately does not
 * invent labels, words, or slide breaks; review in the editor remains required.
 */
export function normalizeLyricsDraft(text: string): string {
  const normalized = text.replace(/\r\n?/g, '\n').trim()
  if (!normalized) return ''
  if (normalized.split('\n').some((line) => SECTION_HEADER.test(line.trim()))) return normalized

  type Section = { label: string; lines: string[] }
  const sections: Section[] = []
  let active: Section | null = null
  let chorusNumber = 0
  const startSection = (label: string): Section => {
    const section = { label, lines: [] }
    active = section
    return section
  }
  const finishSection = (splitUnlabelledRefrain = false) => {
    if (!active) return
    const lines = active.lines.filter(Boolean)
    if (splitUnlabelledRefrain && /^verse \d+$/i.test(active.label) && lines.length === 8) {
      sections.push({ label: active.label, lines: lines.slice(0, 4) })
      chorusNumber += 1
      sections.push({ label: `chorus ${chorusNumber}`, lines: lines.slice(4) })
    } else if (lines.length) {
      sections.push({ label: active.label, lines })
    }
    active = null
  }

  for (const rawLine of normalized.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    const refrain = line.match(/^(?:refrain|chorus)\s*:?\s*(.*)$/i)
    if (refrain) {
      finishSection()
      chorusNumber += 1
      const section = startSection(`chorus ${chorusNumber}`)
      if (refrain[1]) section.lines.push(refrain[1])
      continue
    }
    const verse = line.match(/^(\d{1,2})\s*[.)]?\s*(.*)$/)
    if (verse && (!verse[2] || verse[2].trim().length > 2)) {
      finishSection(true)
      const section = startSection(`verse ${verse[1]}`)
      if (verse[2].trim()) section.lines.push(verse[2].trim())
      continue
    }
    const section = active ?? startSection('verse 1')
    section.lines.push(line)
  }
  finishSection()
  return sections.map((section) => `[${section.label}]\n${section.lines.join('\n')}`).join('\n\n')
}
