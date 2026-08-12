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
  return `[verse 1]\n${normalized}`
}
