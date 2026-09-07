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

/** Normalize explicit headings and stanza boundaries without guessing lyric content. */
export function normalizeLyricsDraft(text: string): string {
  const normalized = text.replace(/\r\n?/g, '\n').trim()
  if (!normalized) return ''
  const output: string[] = []
  let verse = 0
  let hasSection = false
  let stanzaBreak = false
  for (const raw of normalized.split('\n')) {
    const line = raw.trim()
    if (!line) { stanzaBreak = true; continue }
    const bracket = line.match(SECTION_HEADER)
    const heading = line.match(/^(verse|chorus|refrain|bridge|intro|outro|tag|ending)(?:\s+(\d+))?\s*:?$/i)
    const numbered = line.match(/^(\d{1,2})(?:[.)]\s*|\s+)(.*)$/) ?? line.match(/^(\d{1,2})$/)
    if (bracket || heading || numbered) {
      const label = bracket ? bracket[1] : heading ? `${heading[1].toLowerCase() === 'refrain' ? 'chorus' : heading[1].toLowerCase()}${heading[2] ? ` ${heading[2]}` : ''}` : `verse ${numbered![1]}`
      output.push(`[${label}]`)
      const number = label.match(/^verse\s+(\d+)$/i)
      if (number) verse = Math.max(verse, Number(number[1]))
      if (numbered?.[2]) output.push(numbered[2])
      hasSection = true
    } else if (line === SLIDE_BREAK) {
      // A break after four lines is already satisfied by the parser.
      let count = 0
      for (let i = output.length - 1; i >= 0 && !SECTION_HEADER.test(output[i]) && output[i] !== SLIDE_BREAK; i--) count++
      if (count % 4) output.push(line)
    } else {
      if (!hasSection) { output.push(`[verse ${++verse}]`); hasSection = true }
      else if (stanzaBreak && output.length && !SECTION_HEADER.test(output[output.length - 1]) && output[output.length - 1] !== SLIDE_BREAK) {
        // Blank stanzas start a slide, without inventing a chorus or verse label.
        let count = 0
        for (let i = output.length - 1; i >= 0 && !SECTION_HEADER.test(output[i]) && output[i] !== SLIDE_BREAK; i--) count++
        if (count % 4) output.push(SLIDE_BREAK)
      }
      output.push(line)
    }
    stanzaBreak = false
  }
  return output.join('\n')
}
