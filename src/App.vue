<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  api, getCollection, meetingDate, meetingToken, songLastUsed, songLyrics, songNumber, songUses,
  type AppSettings, type LyricCandidate, type Meeting, type MeetingSong, type Slide, type Song, type SongListResponse, type TrustedSource, type UserAccount,
} from './api'
import { parseLyrics } from './lyrics'
import { readOpenLyrics } from './openlyrics'
import AppSidebar from './components/AppSidebar.vue'
import PresenterView from './components/PresenterView.vue'
import SettingsView from './components/SettingsView.vue'
import ToastStack from './components/ToastStack.vue'

type Page = 'dashboard' | 'library' | 'meetings' | 'history' | 'settings'
type Session = { authenticated?: boolean; email?: string; user?: { id: string; email: string } }

const route = useRoute()
const router = useRouter()
const isPresenter = computed(() => route.name === 'presenter')
const loading = ref(true)
const session = ref<Session | null>(null)
const email = ref('')
const password = ref('')
const loginError = ref('')
const page = ref<Page>('dashboard')
const notice = ref('')
const error = ref('')
const songs = ref<Song[]>([])
const librarySongs = ref<Song[]>([])
const meetings = ref<Meeting[]>([])
const songSearch = ref('')
const songFilter = ref('all')
const songPage = ref(1)
const songPageSize = 25
const songTotal = ref(0)
const songTotalPages = ref(1)
const importingSongs = ref(false)
const editingSong = ref<Song | null>(null)
const lyricCandidates = ref<LyricCandidate[]>([])
const slidePreview = ref<Slide[]>([])
const activeMeeting = ref<Meeting | null>(null)
const meetingSearch = ref('')
const editingMeetingSlides = ref(false)
const isBusy = ref(false)
const trustedSources = ref<TrustedSource[]>([])
const newTrustedSource = ref({ name: '', baseUrl: '' })
const settings = ref<AppSettings>({ groupName: 'Men’s group', defaultTextScale: 1, defaultPresenterFont: 'libre-baskerville', defaultRepeatChorus: false, defaultShowSlideCount: true })
const users = ref<UserAccount[]>([])
let toastTimer: number | undefined
let songSearchTimer: number | undefined

const emptySong = (): Song => ({ id: '', title: '', hymnNumber: '', sourceUrl: '', lyricsText: '' })
const upcomingMeeting = computed(() => meetings.value.find((meeting) => meeting.status === 'draft') ?? null)
const recentMeetings = computed(() => [...meetings.value].sort((a, b) => meetingDate(b).localeCompare(meetingDate(a))).slice(0, 6))
const planningMeetings = computed(() => meetings.value.filter((meeting) => meeting.status === 'draft' || meeting.status === 'published'))
const pastMeetings = computed(() => meetings.value.filter((meeting) => meeting.status === 'past'))
const shownSongs = computed(() => librarySongs.value)
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

function setPath(path: string, { replace = false } = {}) { void (replace ? router.replace(path) : router.push(path)) }
function navigate(path: string, options: { replace?: boolean } = {}) { setPath(path, options) }

async function applyRoute() {
  if (isPresenter.value || !session.value?.authenticated) return
  const routeName = String(route.name ?? 'dashboard')
  lyricCandidates.value = []
  editingMeetingSlides.value = false

  if (routeName === 'library') {
    page.value = 'library'; activeMeeting.value = null; editingSong.value = null; return
  }
  if (routeName === 'song-new') {
    page.value = 'library'; activeMeeting.value = null; editSong(undefined, false); return
  }
  if (routeName === 'song-edit') {
    page.value = 'library'; activeMeeting.value = null
    try {
      const result = await api<Song | { song: Song }>(`/api/songs/${String(route.params.songId)}`)
      editSong(payload(result), false)
    } catch (caught) {
      error.value = (caught as Error).message
      navigate('/library', { replace: true })
    }
    return
  }
  if (routeName === 'meetings') {
    page.value = 'meetings'; activeMeeting.value = null; editingSong.value = null; return
  }
  if (routeName === 'meeting-edit') {
    page.value = 'meetings'
    editingSong.value = null
    const meetingId = String(route.params.meetingId)
    const known = meetings.value.find((meeting) => meeting.id === meetingId)
    const routePage = 'meetings'
    if (known) {
      if (!(await openMeeting(known, false, routePage))) navigate('/meetings', { replace: true })
    }
    else {
      if (!(await openMeeting({ id: meetingId, status: 'draft' }, false, routePage))) navigate('/meetings', { replace: true })
    }
    return
  }
  page.value = routeName === 'history' ? 'history' : routeName === 'settings' ? 'settings' : 'dashboard'
  activeMeeting.value = null
  editingSong.value = null
  if (!['dashboard', 'history', 'settings'].includes(routeName)) navigate(page.value === 'history' ? '/history' : page.value === 'settings' ? '/settings' : '/', { replace: true })
}

async function loadAppData() {
  const [songsResponse, meetingsResponse, sourceResponse, settingsResponse, usersResponse] = await Promise.all([
    api<SongListResponse>('/api/songs?page=1&pageSize=250'),
    api<Meeting[] | { meetings?: Meeting[]; items?: Meeting[] }>('/api/meetings'),
    api<{ sources: TrustedSource[] }>('/api/trusted-sources'),
    api<{ settings: AppSettings }>('/api/settings'),
    api<{ users: UserAccount[] }>('/api/users'),
  ])
  songs.value = songsResponse.songs
  librarySongs.value = songsResponse.songs.slice(0, songPageSize)
  songTotal.value = songsResponse.total
  songTotalPages.value = songsResponse.totalPages
  meetings.value = getCollection(meetingsResponse)
  trustedSources.value = sourceResponse.sources
  settings.value = settingsResponse.settings
  users.value = usersResponse.users
}

async function loadLibraryPage(page = songPage.value) {
  const targetPage = Math.max(1, page)
  isBusy.value = true
  try {
    const params = new URLSearchParams({ page: String(targetPage), pageSize: String(songPageSize), filter: songFilter.value })
    if (songSearch.value.trim()) params.set('q', songSearch.value.trim())
    const result = await api<SongListResponse>(`/api/songs?${params}`)
    librarySongs.value = result.songs
    songPage.value = result.page
    songTotal.value = result.total
    songTotalPages.value = result.totalPages
  } catch (caught) { error.value = (caught as Error).message } finally { isBusy.value = false }
}

async function initialize() {
  if (isPresenter.value) return
  try {
    session.value = await api<Session>('/api/session')
    if (session.value?.authenticated || session.value?.user) {
      session.value.authenticated = true
      await loadAppData()
      await applyRoute()
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
    await api('/api/login', { method: 'POST', body: JSON.stringify({ email: email.value, password: password.value }) })
    email.value = ''
    password.value = ''
    session.value = { authenticated: true }
    await loadAppData()
    await applyRoute()
  } catch (caught) { loginError.value = (caught as Error).message } finally { isBusy.value = false }
}

async function logout() {
  await api('/api/logout', { method: 'POST' })
  session.value = { authenticated: false }
  songs.value = []
  meetings.value = []
  setPath('/', { replace: true })
}

function selectPage(target: Page) {
  navigate(target === 'dashboard' ? '/' : `/${target === 'library' ? 'library' : target}`)
}

function editSong(song?: Song, updateRoute = true) {
  lyricCandidates.value = []
  editingSong.value = song ? { ...song, lyricsText: songLyrics(song), sourceUrl: song.sourceUrl ?? song.source_url ?? '' } : emptySong()
  slidePreview.value = editingSong.value.title ? parseLyrics(editingSong.value.title, currentLyrics.value) : []
  page.value = 'library'
  activeMeeting.value = null
  if (updateRoute) setPath(song?.id ? `/library/${song.id}` : '/library/new')
  nextTick(() => document.querySelector<HTMLInputElement>('#song-title')?.focus())
}

function backToLibrary() { navigate('/library') }

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
    await loadAppData()
    await loadLibraryPage(isNew ? 1 : songPage.value)
    editingSong.value = { ...saved, lyricsText: songLyrics(saved) }
    slidePreview.value = parseLyrics(saved.title, songLyrics(saved))
    if (isNew) setPath(`/library/${saved.id}`, { replace: true })
    notice.value = 'Song saved.'
  } catch (caught) { error.value = (caught as Error).message } finally { isBusy.value = false }
}

async function importOpenLyrics(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  if (!files.length || importingSongs.value) return
  importingSongs.value = true
  try {
    const parsed = await readOpenLyrics(files)
    let imported = 0
    const skipped = [...parsed.issues]
    for (let start = 0; start < parsed.songs.length; start += 100) {
      const batch = parsed.songs.slice(start, start + 100)
      const result = await api<{ imported: Song[]; skipped: Array<{ title: string; reason: string }> }>('/api/songs/import', {
        method: 'POST', body: JSON.stringify({ sourceName: 'OpenLyrics import', songs: batch }),
      })
      imported += result.imported.length
      skipped.push(...result.skipped.map((issue) => ({ file: issue.title, reason: issue.reason })))
    }
    await loadAppData()
    await loadLibraryPage(1)
    notice.value = skipped.length ? `Imported ${imported} song${imported === 1 ? '' : 's'}; ${skipped.length} skipped.` : `Imported ${imported} song${imported === 1 ? '' : 's'}.`
  } catch (caught) { error.value = (caught as Error).message } finally { importingSongs.value = false }
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
    const result = await api<{ lyricsText: string; sourceUrl: string; lyricsSourceName: string }>(`/api/songs/${song.id}/use-lyric-candidate`, {
      method: 'POST', body: JSON.stringify({ sourceUrl: candidate.sourceUrl ?? candidate.source_url ?? candidate.url ?? candidate.id }),
    })
    editingSong.value = { ...song, sourceUrl: result.sourceUrl, lyricsText: result.lyricsText, lyricsSourceName: result.lyricsSourceName }
    slidePreview.value = parseLyrics(song.title, result.lyricsText)
    notice.value = 'Lyrics imported as a draft. Review, then save the song.'
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

async function addTrustedSource() {
  if (!newTrustedSource.value.name.trim() || !newTrustedSource.value.baseUrl.trim()) return
  try {
    const result = await api<{ source: TrustedSource }>('/api/trusted-sources', { method: 'POST', body: JSON.stringify(newTrustedSource.value) })
    trustedSources.value.push(result.source)
    newTrustedSource.value = { name: '', baseUrl: '' }
    notice.value = 'Trusted source added.'
  } catch (caught) { error.value = (caught as Error).message }
}

async function toggleTrustedSource(source: TrustedSource) {
  try {
    const result = await api<{ source: TrustedSource }>(`/api/trusted-sources/${source.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !source.enabled }) })
    trustedSources.value = trustedSources.value.map((item) => item.id === source.id ? result.source : item)
  } catch (caught) { error.value = (caught as Error).message }
}

async function saveTrustedSource(source: TrustedSource) {
  try {
    const result = await api<{ source: TrustedSource }>(`/api/trusted-sources/${source.id}`, {
      method: 'PATCH', body: JSON.stringify({ name: source.name, baseUrl: source.baseUrl, enabled: source.enabled }),
    })
    trustedSources.value = trustedSources.value.map((item) => item.id === source.id ? result.source : item)
    notice.value = 'Trusted source updated.'
  } catch (caught) { error.value = (caught as Error).message }
}

async function removeTrustedSource(source: TrustedSource) {
  if (!confirm(`Remove ${source.name} from the trusted list?`)) return
  try {
    await api(`/api/trusted-sources/${source.id}`, { method: 'DELETE' })
    trustedSources.value = trustedSources.value.filter((item) => item.id !== source.id)
    notice.value = 'Trusted source removed.'
  } catch (caught) { error.value = (caught as Error).message }
}

async function saveSettings() {
  isBusy.value = true
  try {
    const result = await api<{ settings: AppSettings }>('/api/settings', { method: 'PATCH', body: JSON.stringify(settings.value) })
    settings.value = result.settings
    notice.value = 'Settings saved.'
  } catch (caught) { error.value = (caught as Error).message } finally { isBusy.value = false }
}

async function addUser(value: { email: string; password: string }) {
  if (!value.email.trim() || !value.password) return
  isBusy.value = true
  try {
    const result = await api<{ user: UserAccount }>('/api/users', { method: 'POST', body: JSON.stringify(value) })
    users.value.push(result.user)
    notice.value = 'Administrator added.'
  } catch (caught) { error.value = (caught as Error).message } finally { isBusy.value = false }
}

async function removeUser(user: UserAccount) {
  if (!confirm(`Remove ${user.email}?`)) return
  try {
    await api(`/api/users/${user.id}`, { method: 'DELETE' })
    users.value = users.value.filter((item) => item.id !== user.id)
    notice.value = 'Administrator removed.'
  } catch (caught) { error.value = (caught as Error).message }
}

async function createMeeting() {
  const today = new Date().toISOString().slice(0, 10)
  const date = window.prompt('Meeting date (YYYY-MM-DD)', today)
  if (!date) return
  isBusy.value = true
  try {
    const result = await api<Meeting | { meeting: Meeting }>('/api/meetings', { method: 'POST', body: JSON.stringify({ meetingDate: date, title: settings.value.groupName }) })
    const meeting = { ...payload(result), songs: [] }
    meetings.value.unshift(meeting)
    openMeeting(meeting)
  } catch (caught) { error.value = (caught as Error).message } finally { isBusy.value = false }
}

async function openMeeting(meeting: Meeting, updateRoute = true, targetPage: 'meetings' | 'history' = 'meetings'): Promise<boolean> {
  page.value = targetPage
  editingSong.value = null
  if (updateRoute) setPath(`/${targetPage}/${meeting.id}`)
  isBusy.value = true
  try {
    activeMeeting.value = await api<Meeting>(`/api/meetings/${meeting.id}`)
    return true
  } catch (caught) {
    error.value = (caught as Error).message
    if (meeting.title || meeting.songs) {
      activeMeeting.value = { ...meeting, songs: meeting.songs ?? [] }
      return true
    }
    activeMeeting.value = null
    return false
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

async function updateMeetingStatus(status: Meeting['status']) {
  const meeting = activeMeeting.value
  if (!meeting) return
  isBusy.value = true
  try {
    const result = await api<Meeting | { meeting: Meeting }>(`/api/meetings/${meeting.id}`, { method: 'PATCH', body: JSON.stringify({ status }) })
    const updated = (result as { meeting?: Meeting }).meeting ?? result as Meeting
    activeMeeting.value = { ...meeting, ...updated, songs: updated.songs ?? meeting.songs }
    meetings.value = meetings.value.map((item) => item.id === meeting.id ? { ...item, ...updated } : item)
    notice.value = `Meeting marked ${status}.`
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

watch([songSearch, songFilter], () => {
  if (songSearchTimer) window.clearTimeout(songSearchTimer)
  songSearchTimer = window.setTimeout(() => { void loadLibraryPage(1) }, 220)
})
watch(() => route.fullPath, () => {
  if (!isPresenter.value && session.value?.authenticated) void applyRoute()
})
watch([notice, error], () => {
  if (toastTimer) window.clearTimeout(toastTimer)
  if (notice.value || error.value) toastTimer = window.setTimeout(() => { notice.value = ''; error.value = '' }, 4000)
})
onMounted(() => {
  if (!isPresenter.value) void initialize()
})
onBeforeUnmount(() => {
  if (toastTimer) window.clearTimeout(toastTimer)
  if (songSearchTimer) window.clearTimeout(songSearchTimer)
})
</script>

<template>
  <PresenterView v-if="isPresenter" />

  <div v-else-if="loading" class="loading-page">Opening song management…</div>

  <main v-else-if="!session?.authenticated" class="login-shell">
    <form class="login-card" @submit.prevent="login">
      <p class="eyebrow">SONG MANAGEMENT</p>
      <h1>Login</h1>
      <label>Email <input v-model="email" type="email" autocomplete="email" required autofocus /></label>
      <label>Password <input v-model="password" type="password" autocomplete="current-password" required /></label>
      <p v-if="loginError" class="form-error">{{ loginError }}</p>
      <button class="button" :disabled="isBusy">{{ isBusy ? 'Signing in…' : 'Sign in' }}</button>
    </form>
  </main>

  <main v-else class="app-shell">
    <AppSidebar :page="page" :group-name="settings.groupName" @navigate="selectPage" @logout="logout" />
    <ToastStack :notice="notice" :error="error" @clear-notice="notice = ''" @clear-error="error = ''" />
    <section class="workspace">

      <template v-if="page === 'dashboard'">
        <header class="page-header"><div><p class="eyebrow">{{ settings.groupName }}</p><h1>Good evening</h1><p class="muted">Your songs, meetings, and projector deck in one quiet place.</p></div><button class="button" @click="createMeeting">+ Plan a meeting</button></header>
        <div class="stat-grid"><article><strong>{{ songs.length }}</strong><span>Songs in library</span></article><article><strong>{{ songs.filter((s) => !songUses(s)).length }}</strong><span>Not yet used</span></article><article><strong>{{ meetings.length }}</strong><span>Meetings recorded</span></article></div>
        <div class="two-column">
          <section class="card">
            <div class="card-heading"><div><p class="eyebrow">UP NEXT</p><h2>{{ upcomingMeeting ? displayDate(meetingDate(upcomingMeeting)) : 'No meeting planned' }}</h2></div><button v-if="upcomingMeeting" class="text-button" @click="openMeeting(upcomingMeeting)">Open</button></div>
            <p v-if="!upcomingMeeting" class="muted">Start with a date, then choose songs from your library.</p>
            <ol v-else class="song-list"><li v-for="song in upcomingMeeting.songs ?? []" :key="song.id"><span>{{ song.title }}</span><small>{{ songNumber(song) }}</small></li><li v-if="!(upcomingMeeting.songs ?? []).length && upcomingMeeting.songTitles" class="muted">{{ upcomingMeeting.songTitles }}</li><li v-else-if="!(upcomingMeeting.songs ?? []).length" class="muted">No songs selected yet.</li></ol>
          </section>
          <section class="card"><div class="card-heading"><div><p class="eyebrow">RECENT</p><h2>Meeting history</h2></div><button class="text-button" @click="selectPage('history')">See all</button></div><ul class="history-list"><li v-for="meeting in recentMeetings" :key="meeting.id"><button @click="openMeeting(meeting)"><strong>{{ displayDate(meetingDate(meeting)) }}</strong><span>{{ meeting.songCount ?? meeting.songs?.length ?? 0 }} songs</span></button></li></ul></section>
        </div>
      </template>

      <template v-else-if="page === 'library'">
        <header class="page-header"><div><button v-if="editingSong" class="text-button back-button" @click="backToLibrary">← Back to library</button><p class="eyebrow">LIBRARY</p><h1>{{ editingSong ? (editingSong.id ? 'Edit song' : 'New song') : 'Songs' }}</h1></div><div v-if="!editingSong" class="header-actions"><label class="secondary-button import-button">{{ importingSongs ? 'Importing…' : 'Import OpenLyrics' }}<input type="file" accept=".xml,.zip,application/zip,text/xml" multiple :disabled="importingSongs" @change="importOpenLyrics" /></label><button class="button" @click="editSong()">+ Add song</button></div></header>
        <section v-if="!editingSong" class="card library">
          <div class="search-bar"><input v-model="songSearch" placeholder="Search title or hymn number" /><select v-model="songFilter"><option value="all">All songs</option><option value="unused">Never used</option><option value="recent">Used before</option></select></div>
          <div class="table-wrap"><table><thead><tr><th>Song</th><th>Used</th><th>Last sung</th><th></th></tr></thead><tbody><tr v-for="song in shownSongs" :key="song.id"><td><button class="song-title-link" @click="editSong(song)">{{ song.title }}</button><small v-if="songNumber(song)">#{{ songNumber(song) }}</small></td><td>{{ songUses(song) }}×</td><td>{{ displayDate(songLastUsed(song)) }}</td><td><button class="text-button" @click="editSong(song)">Edit</button></td></tr><tr v-if="!shownSongs.length"><td colspan="4" class="muted">No songs match this search.</td></tr></tbody></table></div>
          <nav class="pagination" aria-label="Song library pages"><span>{{ songTotal }} songs · Page {{ songPage }} of {{ songTotalPages }}</span><div><button class="secondary-button" :disabled="isBusy || songPage === 1" @click="loadLibraryPage(songPage - 1)">Previous</button><button class="secondary-button" :disabled="isBusy || songPage >= songTotalPages" @click="loadLibraryPage(songPage + 1)">Next</button></div></nav>
        </section>
        <form v-else class="editor-grid" @submit.prevent="saveSong">
          <section class="card form-card"><div class="form-row"><label>Title <input id="song-title" v-model="editingSong.title" required /></label><label>Hymn number <input v-model="editingSong.hymnNumber" inputmode="numeric" /></label></div><label>Source URL <input v-model="editingSong.sourceUrl" type="url" placeholder="Direct song page, e.g. https://hymnary.org/..." /></label><p class="field-help">For lookup, paste a direct song page from an allowed site, save the song, then choose <strong>Find lyrics</strong>.</p><div class="editor-actions"><button type="button" class="secondary-button" :disabled="isBusy || !editingSong.id" @click="findLyrics">Find lyrics</button><button type="button" class="secondary-button" :disabled="isBusy || !currentLyrics" @click="formatText">Format with AI</button></div><div v-if="lyricCandidates.length" class="candidate-list"><h3>Trusted-source results</h3><article v-for="candidate in lyricCandidates" :key="candidate.id ?? candidate.url"><div><strong>{{ candidate.title }}</strong><small>{{ candidate.sourceName ?? candidate.source_name ?? candidate.provider ?? 'Trusted source' }}</small><a v-if="candidate.sourceUrl ?? candidate.source_url ?? candidate.url" :href="candidate.sourceUrl ?? candidate.source_url ?? candidate.url" target="_blank" rel="noreferrer">View source</a></div><button type="button" class="text-button" :disabled="candidate.available === false || !candidate.id" @click="useCandidate(candidate)">Use</button></article></div><label>Lyrics <textarea v-model="currentLyrics" rows="20" spellcheck="true" @input="updatePreview" placeholder="[verse 1]\nOne displayed line per row\n|||\nA forced new slide"></textarea></label><p class="field-help">Use <code>[verse 1]</code> or <code>[chorus]</code> for a section. A standalone <code>|||</code> starts a new slide. Slides never exceed four lines.</p><button class="button" :disabled="isBusy">{{ isBusy ? 'Saving…' : 'Save song' }}</button></section>
          <section class="card preview-panel"><div class="card-heading"><div><p class="eyebrow">PREVIEW</p><h2>{{ slidePreview.length }} slides</h2></div></div><div class="slide-thumbnails"><article v-for="(slide, index) in slidePreview" :key="index" class="thumbnail"><small v-if="slide.section">{{ slide.section }}</small><strong v-for="line in slide.lines" :key="line">{{ line }}</strong></article></div></section>
        </form>
        <section v-if="!editingSong" class="card trusted-source-card">
          <div class="card-heading"><div><p class="eyebrow">TRUSTED LYRIC SOURCES</p><h2>Allowed lookup sites</h2></div></div>
          <p class="muted">Only page URLs from enabled sources can be fetched and auto-formatted.</p>
          <ul class="trusted-source-list"><li v-for="source in trustedSources" :key="source.id"><div class="trusted-source-fields"><input v-model="source.name" aria-label="Source name" @change="saveTrustedSource(source)" /><input v-model="source.baseUrl" type="url" aria-label="Source URL" @change="saveTrustedSource(source)" /></div><div class="row-actions"><button :title="source.enabled ? 'Disable source' : 'Enable source'" @click="toggleTrustedSource(source)">{{ source.enabled ? 'On' : 'Off' }}</button><button aria-label="Remove source" @click="removeTrustedSource(source)">×</button></div></li></ul>
          <form class="trusted-source-form" @submit.prevent="addTrustedSource"><input v-model="newTrustedSource.name" placeholder="Source name" /><input v-model="newTrustedSource.baseUrl" type="url" placeholder="https://example.org/" /><button class="secondary-button">Add source</button></form>
        </section>
      </template>

      <template v-else-if="page === 'meetings'">
        <header class="page-header"><div><p class="eyebrow">PLANNING</p><h1>{{ activeMeeting ? displayDate(meetingDate(activeMeeting)) : 'Plan a meeting' }}</h1></div><button v-if="!activeMeeting" class="button" @click="createMeeting">+ New meeting</button><div v-else class="header-actions"><button class="secondary-button" @click="createMeeting">+ New meeting</button><button class="text-button" @click="navigate('/meetings')">All meetings</button></div></header>
        <section v-if="!activeMeeting" class="card"><ul class="meeting-list"><li v-for="meeting in planningMeetings" :key="meeting.id"><button @click="openMeeting(meeting)"><span><strong>{{ displayDate(meetingDate(meeting)) }}</strong><small>{{ meeting.songTitles || meeting.title || settings.groupName }}</small></span><span class="meeting-state" :class="meeting.status">{{ meeting.status }}</span></button></li><li v-if="!planningMeetings.length" class="muted">No draft or published meetings.</li></ul></section>
        <div v-else class="meeting-grid"><section class="card"><div class="card-heading"><div><p class="eyebrow">SELECTED SONGS</p><h2>{{ activeMeeting.songs?.length ?? 0 }} songs</h2></div><select class="meeting-status-select" :value="activeMeeting.status" :disabled="isBusy" aria-label="Meeting status" @change="updateMeetingStatus(($event.target as HTMLSelectElement).value as Meeting['status'])"><option value="draft">Draft</option><option value="published">Published</option><option value="past">Past / archive</option></select></div><ol class="planned-list"><li v-for="(song, index) in activeMeeting.songs ?? []" :key="song.meetingSongId ?? song.meeting_song_id"><span class="position">{{ index + 1 }}</span><div><strong>{{ song.title }}</strong><small>{{ songUses(song) ? `Used ${songUses(song)}× · last ${displayDate(songLastUsed(song))}` : 'Never used' }}</small></div><div class="row-actions"><button :disabled="index === 0" @click="moveMeetingSong(index, -1)">↑</button><button :disabled="index === (activeMeeting.songs?.length ?? 0) - 1" @click="moveMeetingSong(index, 1)">↓</button><button aria-label="Remove song" @click="removeMeetingSong(song)">×</button></div></li><li v-if="!(activeMeeting.songs ?? []).length" class="muted">Add songs from the library on the right.</li></ol><div class="meeting-actions"><button class="secondary-button" :disabled="isBusy || !(activeMeeting.songs?.length)" @click="generateSlides">Generate deck</button><button class="secondary-button" :disabled="!(activeMeeting.songs?.length)" @click="editingMeetingSlides = !editingMeetingSlides">{{ editingMeetingSlides ? 'Close slide editor' : 'Edit slides' }}</button><button class="button" :disabled="isBusy || !(activeMeeting.songs?.length)" @click="publishMeeting">Publish presenter</button></div><a v-if="meetingToken(activeMeeting)" class="presenter-link" :href="`/present/${meetingToken(activeMeeting)}`" target="_blank" rel="noreferrer">Open ready-to-present deck ↗</a></section><section class="card"><p class="eyebrow">ADD SONGS</p><label class="sr-only" for="meeting-search">Search songs</label><input id="meeting-search" v-model="meetingSearch" placeholder="Search song library" /><ul class="add-song-list"><li v-for="song in meetingSongChoices" :key="song.id"><div><strong>{{ song.title }}</strong><small>{{ songUses(song) ? `${songUses(song)}× used · ${displayDate(songLastUsed(song))}` : 'Never used' }}</small></div><button class="text-button" :disabled="activeMeeting.songs?.some((item) => item.id === song.id)" @click="addSongToMeeting(song)">Add</button></li></ul></section></div>
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

      <template v-else-if="page === 'history'">
        <header class="page-header"><div><p class="eyebrow">HISTORY</p><h1>Past meetings</h1><p class="muted">Every song’s previous use is counted from these meeting records.</p></div></header>
        <section class="card"><ul class="meeting-list"><li v-for="meeting in pastMeetings" :key="meeting.id"><button @click="openMeeting(meeting)"><span><strong>{{ displayDate(meetingDate(meeting)) }}</strong><small>{{ meeting.songTitles || 'No songs recorded' }}</small></span><span class="meeting-state" :class="meeting.status">{{ meeting.status }}</span></button></li><li v-if="!pastMeetings.length" class="muted">No archived meetings.</li></ul></section>
      </template>

      <SettingsView v-else :settings="settings" :users="users" :current-user-id="session?.user?.id" :busy="isBusy" @save="saveSettings" @add-user="addUser" @remove-user="removeUser" />
    </section>
  </main>
</template>
