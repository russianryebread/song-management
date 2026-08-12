import type { Slide } from './api'
import { parseSectionedLyrics } from './shared/lyrics'

/** Browser adapter for the one canonical sectioned-v1 parser. */
export function parseLyrics(title: string, lyrics: string): Slide[] {
  return parseSectionedLyrics(lyrics, title).slides
}

export function flattenDeck(meeting: { songs?: Array<{ title: string; slides?: Slide[] }> }, slides?: Slide[]): Slide[] {
  if (slides?.length) return slides
  return (meeting.songs ?? []).flatMap((song) => song.slides?.length ? song.slides : parseLyrics(song.title, ''))
}
