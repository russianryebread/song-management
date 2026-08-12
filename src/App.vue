<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  api, getCollection, meetingDate, meetingToken, songLastUsed, songLyrics, songNumber, songUses,
  type LyricCandidate, type Meeting, type MeetingSong, type Slide, type Song,
} from './api'
import { flattenDeck, parseLyrics } from './lyrics'

type Page = 'dashboard' | 'library' | 'meetings' | 'history'
type Session = { authenticated?: boolean; email?: string; user?: { id: string; email: string } }

const presenterToken = location.pathname.match(/^\/present\/([^/]+)/)?.[1]
const loading = ref(true)
const session = ref<Session | null>(null)
const password = ref('')
const loginError = ref('')
const page = ref<Page>('dashboard')
const notice = ref('')
const error = ref('')
const songs = ref<Song[]>([])
const meetings = ref<Meeting[]>([])
const songSearch = ref('')
const songFilter = ref('all')
const editingSong = ref<Song | null>(null)
const lyricCandidates = ref<LyricCandidate[]>([])
const slidePreview = ref<Slide[]>([])
const activeMeeting = ref<Meeting | null>(null)
const meetingSearch = ref('')
const editingMeetingSlides = ref(false)
const isBusy = ref(false)

const emptySong = (): Song => ({ id: '', title: '', hymnNumber: '', sourceUrl: '', lyricsText: '' })
const apiSongs = computed(() => songs.value)
const upcomingMeeting = computed(() => meetings.value.find((meeting) => meeting.status === 'draft') ?? null)
const recentMeetings = computed(() => [...meetings.value].sort((a, b) => meetingDate(b).localeCompare(meetingDate(a))).slice(0, 6))
const shownSongs = computed(() => {
  const query = songSearch.value.trim().toLocaleLowerCase()
  return apiSongs.value.filter((song) => {
    const matches = !query || `${song.title} ${songNumber(song)}`.toLowerCase().includes(query)
    const uses = songUses(song)
    return matches && (songFilter.value === 'all' || (songFilter.value === 'unused' && !uses) || (songFilter.value === 'recent' && uses))
  })
})
const meetingSongChoices = computed(() => {
  const q = meetingSearch.value.toLowerCase().trim()
  return songs.value.filter((song) => !q || `${song.title} ${songNumber(song)}`.toLowerCase().includes(q)).slice(0, 8)
})
const currentLyrics = computed({
  get: () => editingSong.value ? songLyrics(editingSong.value) : '',
  set: (value: string) => { if (editingSong.value) editingSong.value.lyricsText = value },
})

function payload<T>(data: T | { song?: T; meeting?: T }): T {
  if (typeof data === 'object' && data !== null) return (data as { song?: T; meeting?: T }).song ?? (data as { meeting?: T }).meeting ?? data as T
  return data
}

function displayDate(value?: string | null) {
  if (!value) return 'Never used'
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(`${value}T12:00:00`))
}

async function loadAppData() {
  const [songsResponse, meetingsResponse] = await Promise.all([
    api<Song[] | { songs?: Song[]; items?: Song[] }>('/api/songs'),
    api<Meeting[] | { meetings?: Meeting[]; items?: Meeting[] }>('/api/meetings'),
  ])
  songs.value = getCollection(songsResponse)
  meetings.value = getCollection(meetingsResponse)
}

async function initialize() {
  if (presenterToken) return
  try {
    session.value = await api<Session>('/api/session')
    if (session.value?.authenticated || session.value?.user) {
      session.value.authenticated = true
      await loadAppData()
    }
  } catch (caught) {
    const status = (caught as Error & { status?: number }).status
    if (status !== 401) error.value = (caught as Error).message
    session.value = { authenticated: false }
  } finally { loading.value = false }
}

async function login() {
  loginError.value = ''
  isBusy.value = true
  try {
    await api('/api/login', { method: 'POST', body: JSON.stringify({ password: password.value }) })
    password.value = ''
    session.value = { authenticated: true }
    await loadAppData()
  } catch (caught) { loginError.value = (caught as Error).message } finally { isBusy.value = false }
}

async function logout() {
  await api('/api/logout', { method: 'POST' })
  session.value = { authenticated: false }
  songs.value = []
  meetings.value = []
}

function selectPage(target: Page) {
  page.value = target
  activeMeeting.value = null
  editingSong.value = null
}

function editSong(song?: Song) {
  lyricCandidates.value = []
  editingSong.value = song ? { ...song, lyricsText: songLyrics(song), sourceUrl: song.sourceUrl ?? song.source_url ?? '' } : emptySong()
  slidePreview.value = editingSong.value.title ? parseLyrics(editingSong.value.title, currentLyrics.value) : []
  page.value = 'library'
  nextTick(() => document.querySelector<HTMLInputElement>('#song-title')?.focus())
}

async function saveSong() {
  const song = editingSong.value
  if (!song || !song.title.trim()) return
  isBusy.value = true
  try {
    const isNew = !song.id
    const result = await api<Song | { song: Song }>(isNew ? '/api/songs' : `/api/songs/${song.id}`, {
      method: isNew ? 'POST' : 'PATCH',
      body: JSON.stringify({
        title: song.title.trim(), hymnNumber: songNumber(song) || null, sourceUrl: song.sourceUrl ?? song.source_url ?? null,
        lyricsText: currentLyrics.value, lyricsFormat: 'sectioned-v1',
      }),
    })
    const saved = payload(result)
    if (isNew) songs.value.unshift(saved)
    else songs.value = songs.value.map((existing) => existing.id === saved.id ? saved : existing)
    editingSong.value = { ...saved, lyricsText: songLyrics(saved) }
    slidePreview.value = parseLyrics(saved.title, songLyrics(saved))
    notice.value = 'Song saved.'
  } catch (caught) { error.value = (caught as Error).message } finally { isBusy.value = false }
}

async function findLyrics() {
  const song = editingSong.value
  if (!song?.id) { notice.value = 'Save the song first, then find lyrics.'; return }
  isBusy.value = true
  try {
    const response = await api<LyricCandidate[] | { candidates: LyricCandidate[] }>(`/api/songs/${song.id}/find-lyrics`, {
      method: 'POST', body: JSON.stringify({ title: song.title, hymnNumber: songNumber(song) || undefined }),
    })
    lyricCandidates.value = Array.isArray(response) ? response : response.candidates
    if (!lyricCandidates.value.length) notice.value = 'No permitted lyric source was found.'
  } catch (caught) { error.value = (caught as Error).message } finally { isBusy.value = false }
}

async function useCandidate(candidate: LyricCandidate) {
  const song = editingSong.value
  if (!song) return
  isBusy.value = true
  try {
    const result = await api<Song | { song: Song }>(`/api/songs/${song.id}/use-lyric-candidate`, {
      method: 'POST', body: JSON.stringify({ candidateId: candidate.id }),
    })
    const updated = payload(result)
    editingSong.value = { ...updated, lyricsText: songLyrics(updated) }
    slidePreview.value = parseLyrics(updated.title, songLyrics(updated))
    notice.value = 'Lyrics loaded for review. Save when you are satisfied.'
  } catch (caught) { error.value = (caught as Error).message } finally { isBusy.value = false }
}

async function formatText() {
  const song = editingSong.value
  if (!song) return
  isBusy.value = true
  try {
    const result = await api<{ lyricsText?: string; lyrics_text?: string; song?: Song }>(`/api/songs/${song.id}/format-text`, { method: 'POST', body: JSON.stringify({ sourceText: currentLyrics.value }) })
    const formatted = result.lyricsText ?? result.lyrics_text ?? (result.song ? songLyrics(result.song) : '')
    if (formatted) currentLyrics.value = formatted
    slidePreview.value = parseLyrics(song.title, currentLyrics.value)
    notice.value = 'AI draft applied. Review it before saving.'
  } catch (caught) { error.value = (caught as Error).message } finally { isBusy.value = false }
}

function updatePreview() {
  if (editingSong.value) slidePreview.value = parseLyrics(editingSong.value.title || 'Song title', currentLyrics.value)
}

async function createMeeting() {
  const today = new Date().toISOString().slice(0, 10)
  const date = window.prompt('Meeting date (YYYY-MM-DD)', today)
  if (!date) return
  isBusy.value = true
  try {
    const result = await api<Meeting | { meeting: Meeting }>('/api/meetings', { method: 'POST', body: JSON.stringify({ meetingDate: date, title: 'Men’s group' }) })
    const meeting = { ...payload(result), songs: [] }
    meetings.value.unshift(meeting)
    openMeeting(meeting)
  } catch (caught) { error.value = (caught as Error).message } finally { isBusy.value = false }
}

async function openMeeting(meeting: Meeting) {
  page.value = 'meetings'
  isBusy.value = true
  try {
    activeMeeting.value = await api<Meeting>(`/api/meetings/${meeting.id}`)
  } catch (caught) {
    activeMeeting.value = { ...meeting, songs: meeting.songs ?? [] }
    error.value = (caught as Error).message
  } finally { isBusy.value = false }
}

async function addSongToMeeting(song: Song) {
  const meeting = activeMeeting.value
  if (!meeting || meeting.songs?.some((existing) => existing.id === song.id)) return
  isBusy.value = true
  try {
    const result = await api<Meeting | { meeting: Meeting }>(`/api/meetings/${meeting.id}/songs`, { method: 'POST', body: JSON.stringify({ songId: song.id }) })
    activeMeeting.value = (result as { meeting?: Meeting }).meeting ?? result as Meeting
  } catch (caught) { error.value = (caught as Error).message } finally { isBusy.value = false }
}

async function removeMeetingSong(song: MeetingSong) {
  const meeting = activeMeeting.value
  if (!meeting) return
  const id = song.meetingSongId ?? song.meeting_song_id
  if (!id) return
  try {
    await api(`/api/meeting-songs/${id}`, { method: 'DELETE' })
    meeting.songs = (meeting.songs ?? []).filter((item) => (item.meetingSongId ?? item.meeting_song_id) !== id)
  } catch (caught) { error.value = (caught as Error).message }
}

async function moveMeetingSong(index: number, delta: number) {
  const meeting = activeMeeting.value
  if (!meeting?.songs || index + delta < 0 || index + delta >= meeting.songs.length) return
  const reordered = [...meeting.songs]
  const [moved] = reordered.splice(index, 1)
  reordered.splice(index + delta, 0, moved)
  meeting.songs = reordered
  try {
    await api(`/api/meetings/${meeting.id}`, { method: 'PATCH', body: JSON.stringify({ songOrder: reordered.map((song) => song.meetingSongId ?? song.meeting_song_id) }) })
  } catch (caught) { error.value = (caught as Error).message }
}

async function generateSlides() {
  if (!activeMeeting.value) return
  isBusy.value = true
  try {
    const result = await api<Meeting | { meeting: Meeting }>(`/api/meetings/${activeMeeting.value.id}/slides/regenerate`, { method: 'POST' })
    activeMeeting.value = (result as { meeting?: Meeting }).meeting ?? result as Meeting
    notice.value = 'Meeting deck generated.'
  } catch (caught) { error.value = (caught as Error).message } finally { isBusy.value = false }
}

async function publishMeeting() {
  if (!activeMeeting.value) return
  isBusy.value = true
  try {
    const result = await api<{ viewToken: string; presenterPath: string }>(`/api/meetings/${activeMeeting.value.id}/publish`, { method: 'POST' })
    activeMeeting.value = { ...activeMeeting.value, status: 'published', viewToken: result.viewToken }
    meetings.value = meetings.value.map((meeting) => meeting.id === activeMeeting.value?.id ? activeMeeting.value! : meeting)
  } catch (caught) { error.value = (caught as Error).message } finally { isBusy.value = false }
}

async function saveMeetingSlide(slide: Slide, rawLines: string) {
  if (!slide.id) return
  const lines = rawLines.split('\n').map((line) => line.trim()).filter(Boolean)
  if (!lines.length || lines.length > 4) {
    error.value = 'A lyric slide needs between one and four lines.'
    return
  }
  try {
    const result = await api<{ slide: Slide }>(`/api/meeting-slides/${slide.id}`, {
      method: 'PATCH', body: JSON.stringify({ kind: slide.kind, section: slide.section, lines }),
    })
    Object.assign(slide, result.slide)
    notice.value = 'Slide saved.'
  } catch (caught) { error.value = (caught as Error).message }
}

const deckSlides = ref<Slide[]>([])
const deckTitle = ref('')
const deckIndex = ref(0)
const deckReady = ref(false)
const deckError = ref('')
const deckLoading = ref(false)
const deckCacheKey = `song-management:deck:${presenterToken ?? ''}`
const activeSlide = computed(() => deckSlides.value[deckIndex.value])

async function loadDeck() {
  if (!presenterToken || deckLoading.value) return
  deckLoading.value = true
  deckError.value = ''
  try {
    const data = await api<{ deck?: Meeting; meeting?: Meeting; title?: string; slides?: Slide[] }>(`/api/present/${presenterToken}`)
    const meeting: Meeting = data.deck ?? data.meeting ?? ({ id: '', status: 'draft' } as Meeting)
    deckTitle.value = data.title ?? meeting.title ?? 'Song night'
    deckSlides.value = flattenDeck(meeting, data.slides)
    if (!deckSlides.value.length) throw new Error('This meeting does not have a slide deck yet.')
    sessionStorage.setItem(deckCacheKey, JSON.stringify({ title: deckTitle.value, slides: deckSlides.value }))
    deckReady.value = true
  } catch (caught) {
    const cached = sessionStorage.getItem(deckCacheKey)
    if (cached) {
      const data = JSON.parse(cached) as { title: string; slides: Slide[] }
      deckTitle.value = data.title
      deckSlides.value = data.slides
      deckReady.value = true
    } else deckError.value = (caught as Error).message
  } finally { deckLoading.value = false; loading.value = false }
}

function changeSlide(delta: number) {
  if (!deckReady.value) return
  deckIndex.value = Math.min(Math.max(deckIndex.value + delta, 0), deckSlides.value.length - 1)
}
async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen()
    else await document.documentElement.requestFullscreen()
  } catch { /* Browser may deny programmatic full-screen. */ }
}
function presentationKeydown(event: KeyboardEvent) {
  if (!presenterToken || !deckReady.value) return
  if ([' ', 'ArrowRight', 'ArrowDown'].includes(event.key)) { event.preventDefault(); changeSlide(1) }
  else if (['ArrowLeft', 'ArrowUp'].includes(event.key)) { event.preventDefault(); changeSlide(-1) }
  else if (event.key.toLowerCase() === 'f') void toggleFullscreen()
}

watch([songSearch, songFilter], () => { /* filtering is intentionally instant and local */ })
onMounted(() => {
  window.addEventListener('keydown', presentationKeydown)
  if (presenterToken) void loadDeck(); else void initialize()
})
onBeforeUnmount(() => window.removeEventListener('keydown', presentationKeydown))
</script>

<template>
  <main v-if="presenterToken" class="presenter" @click="changeSlide(1)">
    <div v-if="deckLoading" class="presenter-status">Loading the complete meeting deck…</div>
    <div v-else-if="deckError" class="presenter-status presenter-error">
      <p>{{ deckError }}</p><button class="button" @click.stop="loadDeck">Try again</button>
    </div>
    <template v-else-if="deckReady && activeSlide">
      <div class="presenter-heading">{{ deckTitle }}</div>
      <section class="slide" :class="`slide-${activeSlide.kind}`">
        <p v-if="activeSlide.section" class="slide-section">{{ activeSlide.section }}</p>
        <h1 v-for="line in activeSlide.lines" :key="line">{{ line }}</h1>
      </section>
      <div class="presenter-controls" @click.stop>
        <button aria-label="Previous slide" :disabled="deckIndex === 0" @click="changeSlide(-1)">←</button>
        <span>{{ deckIndex + 1 }} / {{ deckSlides.length }}</span>
        <button aria-label="Next slide" :disabled="deckIndex === deckSlides.length - 1" @click="changeSlide(1)">→</button>
        <button class="fullscreen-button" aria-label="Toggle full screen" @click="toggleFullscreen">⛶</button>
      </div>
    </template>
  </main>

  <div v-else-if="loading" class="loading-page">Opening song management…</div>

  <main v-else-if="!session?.authenticated" class="login-shell">
    <form class="login-card" @submit.prevent="login">
      <p class="eyebrow">MEN’S GROUP</p><h1>Song management</h1>
      <p class="muted">Plan the evening, keep the history, and present without distractions.</p>
      <label>Password <input v-model="password" type="password" autocomplete="current-password" required autofocus /></label>
      <p v-if="loginError" class="form-error">{{ loginError }}</p>
      <button class="button" :disabled="isBusy">{{ isBusy ? 'Signing in…' : 'Sign in' }}</button>
    </form>
  </main>

  <main v-else class="app-shell">
    <aside class="sidebar">
      <div class="brand"><span>♪</span><div><strong>Songbook</strong><small>Men’s group</small></div></div>
      <nav aria-label="Main navigation">
        <button :class="{ active: page === 'dashboard' }" @click="selectPage('dashboard')">Dashboard</button>
        <button :class="{ active: page === 'library' }" @click="selectPage('library')">Song library</button>
        <button :class="{ active: page === 'meetings' }" @click="selectPage('meetings')">Plan meeting</button>
        <button :class="{ active: page === 'history' }" @click="selectPage('history')">History</button>
      </nav>
      <button class="logout" @click="logout">Sign out</button>
    </aside>

    <section class="workspace">
      <div v-if="error" class="alert alert-error"><span>{{ error }}</span><button @click="error = ''">×</button></div>
      <div v-if="notice" class="alert"><span>{{ notice }}</span><button @click="notice = ''">×</button></div>

      <template v-if="page === 'dashboard'">
        <header class="page-header"><div><p class="eyebrow">OVERVIEW</p><h1>Good evening</h1><p class="muted">Your songs, meetings, and projector deck in one quiet place.</p></div><button class="button" @click="createMeeting">+ Plan a meeting</button></header>
        <div class="stat-grid"><article><strong>{{ songs.length }}</strong><span>Songs in library</span></article><article><strong>{{ songs.filter((s) => !songUses(s)).length }}</strong><span>Not yet used</span></article><article><strong>{{ meetings.length }}</strong><span>Meetings recorded</span></article></div>
        <div class="two-column">
          <section class="card">
            <div class="card-heading"><div><p class="eyebrow">UP NEXT</p><h2>{{ upcomingMeeting ? displayDate(meetingDate(upcomingMeeting)) : 'No meeting planned' }}</h2></div><button v-if="upcomingMeeting" class="text-button" @click="openMeeting(upcomingMeeting)">Open</button></div>
            <p v-if="!upcomingMeeting" class="muted">Start with a date, then choose songs from your library.</p>
            <ol v-else class="song-list"><li v-for="song in upcomingMeeting.songs ?? []" :key="song.id"><span>{{ song.title }}</span><small>{{ songNumber(song) }}</small></li><li v-if="!(upcomingMeeting.songs ?? []).length" class="muted">No songs selected yet.</li></ol>
          </section>
          <section class="card"><div class="card-heading"><div><p class="eyebrow">RECENT</p><h2>Meeting history</h2></div><button class="text-button" @click="selectPage('history')">See all</button></div><ul class="history-list"><li v-for="meeting in recentMeetings" :key="meeting.id"><button @click="openMeeting(meeting)"><strong>{{ displayDate(meetingDate(meeting)) }}</strong><span>{{ meeting.songs?.length ?? 0 }} songs</span></button></li></ul></section>
        </div>
      </template>

      <template v-else-if="page === 'library'">
        <header class="page-header"><div><p class="eyebrow">LIBRARY</p><h1>{{ editingSong ? (editingSong.id ? 'Edit song' : 'New song') : 'Songs' }}</h1></div><button v-if="!editingSong" class="button" @click="editSong()">+ Add song</button><button v-else class="text-button" @click="editingSong = null">← Back to library</button></header>
        <section v-if="!editingSong" class="card library">
          <div class="search-bar"><input v-model="songSearch" placeholder="Search title or hymn number" /><select v-model="songFilter"><option value="all">All songs</option><option value="unused">Never used</option><option value="recent">Used before</option></select></div>
          <div class="table-wrap"><table><thead><tr><th>Song</th><th>Used</th><th>Last sung</th><th></th></tr></thead><tbody><tr v-for="song in shownSongs" :key="song.id"><td><strong>{{ song.title }}</strong><small v-if="songNumber(song)">#{{ songNumber(song) }}</small></td><td>{{ songUses(song) }}×</td><td>{{ displayDate(songLastUsed(song)) }}</td><td><button class="text-button" @click="editSong(song)">Edit</button></td></tr></tbody></table></div>
        </section>
        <form v-else class="editor-grid" @submit.prevent="saveSong">
          <section class="card form-card"><div class="form-row"><label>Title <input id="song-title" v-model="editingSong.title" required /></label><label>Hymn number <input v-model="editingSong.hymnNumber" inputmode="numeric" /></label></div><label>Source URL <input v-model="editingSong.sourceUrl" type="url" placeholder="https://hymnary.org/..." /></label><div class="editor-actions"><button type="button" class="secondary-button" :disabled="isBusy || !editingSong.id" @click="findLyrics">Find lyrics</button><button type="button" class="secondary-button" :disabled="isBusy || !currentLyrics" @click="formatText">Format with AI</button></div><div v-if="lyricCandidates.length" class="candidate-list"><h3>Trusted-source results</h3><article v-for="candidate in lyricCandidates" :key="candidate.id ?? candidate.url"><div><strong>{{ candidate.title }}</strong><small>{{ candidate.sourceName ?? candidate.source_name ?? candidate.provider ?? 'Trusted source' }}</small><a v-if="candidate.sourceUrl ?? candidate.source_url ?? candidate.url" :href="candidate.sourceUrl ?? candidate.source_url ?? candidate.url" target="_blank" rel="noreferrer">View source</a></div><button type="button" class="text-button" :disabled="candidate.available === false || !candidate.id" @click="useCandidate(candidate)">Use</button></article></div><label>Lyrics <textarea v-model="currentLyrics" rows="20" spellcheck="true" @input="updatePreview" placeholder="[verse 1]\nOne displayed line per row\n|||\nA forced new slide"></textarea></label><p class="field-help">Use <code>[verse 1]</code> or <code>[chorus]</code> for a section. A standalone <code>|||</code> starts a new slide. Slides never exceed four lines.</p><button class="button" :disabled="isBusy">{{ isBusy ? 'Saving…' : 'Save song' }}</button></section>
          <section class="card preview-panel"><div class="card-heading"><div><p class="eyebrow">PREVIEW</p><h2>{{ slidePreview.length }} slides</h2></div></div><div class="slide-thumbnails"><article v-for="(slide, index) in slidePreview" :key="index" class="thumbnail"><small v-if="slide.section">{{ slide.section }}</small><strong v-for="line in slide.lines" :key="line">{{ line }}</strong></article></div></section>
        </form>
      </template>

      <template v-else-if="page === 'meetings'">
        <header class="page-header"><div><p class="eyebrow">PLANNING</p><h1>{{ activeMeeting ? displayDate(meetingDate(activeMeeting)) : 'Plan a meeting' }}</h1></div><button v-if="!activeMeeting" class="button" @click="createMeeting">+ New meeting</button><button v-else class="text-button" @click="activeMeeting = null">All meetings</button></header>
        <section v-if="!activeMeeting" class="card"><ul class="meeting-list"><li v-for="meeting in meetings" :key="meeting.id"><button @click="openMeeting(meeting)"><span><strong>{{ displayDate(meetingDate(meeting)) }}</strong><small>{{ meeting.title || 'Men’s group' }}</small></span><span class="status" :class="meeting.status">{{ meeting.status }}</span></button></li></ul></section>
        <div v-else class="meeting-grid"><section class="card"><div class="card-heading"><div><p class="eyebrow">SELECTED SONGS</p><h2>{{ activeMeeting.songs?.length ?? 0 }} songs</h2></div><span class="status" :class="activeMeeting.status">{{ activeMeeting.status }}</span></div><ol class="planned-list"><li v-for="(song, index) in activeMeeting.songs ?? []" :key="song.meetingSongId ?? song.meeting_song_id"><span class="position">{{ index + 1 }}</span><div><strong>{{ song.title }}</strong><small>{{ songUses(song) ? `Used ${songUses(song)}× · last ${displayDate(songLastUsed(song))}` : 'Never used' }}</small></div><div class="row-actions"><button :disabled="index === 0" @click="moveMeetingSong(index, -1)">↑</button><button :disabled="index === (activeMeeting.songs?.length ?? 0) - 1" @click="moveMeetingSong(index, 1)">↓</button><button aria-label="Remove song" @click="removeMeetingSong(song)">×</button></div></li><li v-if="!(activeMeeting.songs ?? []).length" class="muted">Add songs from the library on the right.</li></ol><div class="meeting-actions"><button class="secondary-button" :disabled="isBusy || !(activeMeeting.songs?.length)" @click="generateSlides">Generate deck</button><button class="secondary-button" :disabled="!(activeMeeting.songs?.length)" @click="editingMeetingSlides = !editingMeetingSlides">{{ editingMeetingSlides ? 'Close slide editor' : 'Edit slides' }}</button><button class="button" :disabled="isBusy || !(activeMeeting.songs?.length)" @click="publishMeeting">Publish presenter</button></div><a v-if="meetingToken(activeMeeting)" class="presenter-link" :href="`/present/${meetingToken(activeMeeting)}`" target="_blank" rel="noreferrer">Open ready-to-present deck ↗</a></section><section class="card"><p class="eyebrow">ADD SONGS</p><label class="sr-only" for="meeting-search">Search songs</label><input id="meeting-search" v-model="meetingSearch" placeholder="Search song library" /><ul class="add-song-list"><li v-for="song in meetingSongChoices" :key="song.id"><div><strong>{{ song.title }}</strong><small>{{ songUses(song) ? `${songUses(song)}× used · ${displayDate(songLastUsed(song))}` : 'Never used' }}</small></div><button class="text-button" :disabled="activeMeeting.songs?.some((item) => item.id === song.id)" @click="addSongToMeeting(song)">Add</button></li></ul></section></div>
        <section v-if="activeMeeting && editingMeetingSlides" class="card meeting-slide-editor">
          <div class="card-heading"><div><p class="eyebrow">MEETING-SPECIFIC DECK</p><h2>Edit the saved projector slides</h2></div></div>
          <template v-for="song in activeMeeting.songs ?? []" :key="song.meetingSongId ?? song.meeting_song_id">
            <h3>{{ song.title }}</h3>
            <article v-for="(slide, index) in song.slides ?? []" :key="slide.id ?? index" class="slide-edit-row">
              <small>{{ slide.kind === 'title' ? 'Title' : slide.section || `Slide ${index + 1}` }}</small>
              <textarea :value="slide.lines.join('\n')" rows="4" @change="saveMeetingSlide(slide, ($event.target as HTMLTextAreaElement).value)" />
            </article>
          </template>
        </section>
      </template>

      <template v-else>
        <header class="page-header"><div><p class="eyebrow">HISTORY</p><h1>Past meetings</h1><p class="muted">Every song’s previous use is counted from these meeting records.</p></div></header>
        <section class="card"><ul class="meeting-list"><li v-for="meeting in recentMeetings" :key="meeting.id"><button @click="openMeeting(meeting)"><span><strong>{{ displayDate(meetingDate(meeting)) }}</strong><small>{{ (meeting.songs ?? []).map((song) => song.title).join(' · ') || 'No songs recorded' }}</small></span><span class="status" :class="meeting.status">{{ meeting.status }}</span></button></li></ul></section>
      </template>
    </section>
  </main>
</template>
