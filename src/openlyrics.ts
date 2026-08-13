import { unzipSync } from 'fflate'
import { normalizeLyricsDraft } from './shared/lyrics'

export type ImportedOpenLyric = { title: string; hymnNumber?: string; lyricsText: string }
export type ImportIssue = { file: string; reason: string }

const MAX_ARCHIVE_BYTES = 10 * 1024 * 1024
const MAX_SONG_FILES = 100
const MAX_XML_BYTES = 256 * 1024

function linesFrom(node: Node): string {
  let text = ''
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE || child.nodeType === Node.CDATA_SECTION_NODE) text += child.nodeValue ?? ''
    else if ((child as Element).tagName?.toLowerCase() === 'br') text += '\n'
    else {
      text += linesFrom(child)
      if ((child as Element).tagName?.toLowerCase() === 'line') text += '\n'
    }
  }
  return text
}

function sectionName(raw: string, index: number): string {
  const name = raw.trim().toLowerCase()
  if (/^(?:c|chorus|refrain)\d*$/.test(name)) return `chorus ${name.match(/\d+/)?.[0] ?? 1}`
  if (/^(?:b|bridge)\d*$/.test(name)) return `bridge${name.match(/\d+/)?.[0] ? ` ${name.match(/\d+/)?.[0]}` : ''}`
  if (/^(?:v|verse)\d*$/.test(name)) return `verse ${name.match(/\d+/)?.[0] ?? index + 1}`
  return raw.trim() || `verse ${index + 1}`
}

export function parseOpenLyricsXml(xml: string): ImportedOpenLyric {
  const document = new DOMParser().parseFromString(xml, 'application/xml')
  if (document.querySelector('parsererror')) throw new Error('Invalid OpenLyrics XML.')
  const title = document.querySelector('properties > titles > title, title')?.textContent?.trim()
  if (!title) throw new Error('No song title was found.')
  const hymnNumber = document.querySelector('properties > songbooks > songbook > entry, songbook entry')?.textContent?.trim() || undefined
  const sections = Array.from(document.querySelectorAll('lyrics > verse, verse')).map((verse, index) => {
    const raw = linesFrom(verse).replace(/\r\n?/g, '\n').split('\n').map((line) => line.trim()).filter(Boolean)
    return `[${sectionName(verse.getAttribute('name') ?? '', index)}]\n${raw.join('\n')}`
  }).filter((section) => !/\]\s*$/.test(section))
  const lyricsText = normalizeLyricsDraft(sections.join('\n\n'))
  if (!lyricsText) throw new Error('No lyric lines were found.')
  return { title, hymnNumber, lyricsText }
}

async function xmlInputs(file: File): Promise<Array<{ name: string; text: string }>> {
  if (file.size > MAX_ARCHIVE_BYTES) throw new Error(`${file.name} is larger than 10 MB.`)
  if (!/\.zip$/i.test(file.name)) return [{ name: file.name, text: await file.text() }]
  const entries = unzipSync(new Uint8Array(await file.arrayBuffer()), { filter: (entry) => /\.xml$/i.test(entry.name) })
  const xmlFiles = Object.entries(entries).filter(([name]) => /\.xml$/i.test(name)).slice(0, MAX_SONG_FILES)
  if (!xmlFiles.length) throw new Error(`${file.name} does not contain OpenLyrics XML files.`)
  return xmlFiles.map(([name, bytes]) => {
    if (bytes.byteLength > MAX_XML_BYTES) throw new Error(`${name} is larger than 512 KB.`)
    return { name, text: new TextDecoder().decode(bytes) }
  })
}

export async function readOpenLyrics(files: File[]): Promise<{ songs: ImportedOpenLyric[]; issues: ImportIssue[] }> {
  const songs: ImportedOpenLyric[] = []
  const issues: ImportIssue[] = []
  for (const file of files.slice(0, MAX_SONG_FILES)) {
    try {
      for (const xml of await xmlInputs(file)) {
        try { songs.push(parseOpenLyricsXml(xml.text)) } catch (error) { issues.push({ file: xml.name, reason: error instanceof Error ? error.message : 'Could not read this song.' }) }
      }
    } catch (error) { issues.push({ file: file.name, reason: error instanceof Error ? error.message : 'Could not open this file.' }) }
  }
  return { songs, issues }
}
