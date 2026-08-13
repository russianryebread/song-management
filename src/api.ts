export type Slide = {
  id?: string
  kind: 'title' | 'lyrics'
  section?: string
  lines: string[]
}

export type Song = {
  id: string
  title: string
  hymnNumber?: string | null
  hymn_number?: string | null
  sourceUrl?: string | null
  source_url?: string | null
  lyricsText?: string | null
  lyrics_text?: string | null
  lyricsSourceName?: string | null
  useCount?: number
  use_count?: number
  lastUsed?: string | null
  last_used?: string | null
  lastUsedAt?: string | null
  last_used_at?: string | null
  previousUses?: string[]
  previous_uses?: string[]
}

export type MeetingSong = Song & {
  meetingSongId?: string
  meeting_song_id?: string
  position: number
  slides?: Slide[]
}

export type Meeting = {
  id: string
  date?: string
  meetingDate?: string
  meeting_date?: string
  title?: string | null
  notes?: string | null
  status: 'draft' | 'published' | 'past'
  songCount?: number
  songTitles?: string
  viewToken?: string | null
  view_token?: string | null
  songs?: MeetingSong[]
}

export type LyricCandidate = {
  id?: string
  title: string
  sourceName?: string
  source_name?: string
  sourceUrl?: string
  source_url?: string
  url?: string
  provider?: string
  available?: boolean
  message?: string
}

export type TrustedSource = {
  id: string
  name: string
  baseUrl: string
  enabled: boolean
}

export type AppSettings = {
  groupName: string
  defaultTextScale: number
  defaultPresenterFont: 'libre-baskerville' | 'inter' | 'raleway'
  defaultRepeatChorus: boolean
  defaultShowSlideCount: boolean
}

export type UserAccount = {
  id: string
  email: string
  createdAt: string
}

export type SongListResponse = { songs: Song[]; page: number; pageSize: number; total: number; totalPages: number }

type ApiError = Error & { status?: number }

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  headers.set('Accept', 'application/json')
  const response = await fetch(path, { credentials: 'same-origin', ...init, headers })
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string }
    const error: ApiError = new Error(payload.error || `Request failed (${response.status})`)
    error.status = response.status
    throw error
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

export const songNumber = (song: Song) => song.hymnNumber ?? song.hymn_number ?? ''
export const songLyrics = (song: Song) => song.lyricsText ?? song.lyrics_text ?? ''
export const songUses = (song: Song) => song.useCount ?? song.use_count ?? 0
export const songLastUsed = (song: Song) => song.lastUsed ?? song.last_used ?? song.lastUsedAt ?? song.last_used_at ?? null
export const meetingDate = (meeting: Meeting) => meeting.meetingDate ?? meeting.meeting_date ?? meeting.date ?? ''
export const meetingToken = (meeting: Meeting) => meeting.viewToken ?? meeting.view_token ?? null

export function getCollection<T>(payload: T[] | { items?: T[]; songs?: T[]; meetings?: T[] }): T[] {
  if (Array.isArray(payload)) return payload
  return payload.items ?? payload.songs ?? payload.meetings ?? []
}
