<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  api, getCollection, meetingDate, meetingToken, songLastUsed, songLyrics, songNumber, songUses,
  type AppSettings, type LyricCandidate, type Meeting, type MeetingSong, type Slide, type Song, type TrustedSource, type UserAccount,
} from './api'
import { flattenDeck, parseLyrics } from './lyrics'

type Page = 'dashboard' | 'library' | 'meetings' | 'history' | 'settings'
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
const trustedSources = ref<TrustedSource[]>([])
const newTrustedSource = ref({ name: '', baseUrl: '' })
const settings = ref<AppSettings>({ groupName: 'Men’s group', defaultTextScale: 1, defaultRepeatChorus: false, defaultShowSlideCount: true })
const users = ref<UserAccount[]>([])
const newUser = ref({ email: '', password: '' })
let toastTimer: number | undefined

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

function routePath(value = location.pathname): string {
  return value.replace(/\/+$/, '') || '/'
}

function setPath(path: string, { replace = false } = {}) {
  const nextPath = routePath(path)
  if (routePath() !== nextPath) window.history[replace ? 'replaceState' : 'pushState']({}, '', nextPath)
}

function navigate(path: string, { replace = false } = {}) {
  setPath(path, { replace })
  void applyRoute()
}

async function applyRoute() {
  if (presenterToken || !session.value?.authenticated) return
  const path = routePath()
  const songMatch = path.match(/^\/library\/([^/]+)$/)
  const meetingMatch = path.match(/^\/(?:meetings|history)\/([^/]+)$/)
  lyricCandidates.value = []
  editingMeetingSlides.value = false

  if (path === '/library') {
    page.value = 'library'; activeMeeting.value = null; editingSong.value = null; return
  }
  if (path === '/library/new') {
    page.value = 'library'; activeMeeting.value = null; editSong(undefined, false); return
  }
  if (songMatch) {
    page.value = 'library'; activeMeeting.value = null
    try {
      const result = await api<Song | { song: Song }>(`/api/songs/${songMatch[1]}`)
      editSong(payload(result), false)
    } catch (caught) {
      error.value = (caught as Error).message
      navigate('/library', { replace: true })
    }
    return
  }
  if (path === '/meetings') {
    page.value = 'meetings'; activeMeeting.value = null; editingSong.value = null; return
  }
  if (meetingMatch) {
    page.value = 'meetings'
    editingSong.value = null
    const known = meetings.value.find((meeting) => meeting.id === meetingMatch[1])
    const routePage = meetingMatch[0].startsWith('/history/') ? 'history' : 'meetings'
    if (known) {
      if (!(await openMeeting(known, false, routePage))) navigate(routePage === 'history' ? '/history' : '/meetings', { replace: true })
    }
    else {
      if (!(await openMeeting({ id: meetingMatch[1], status: 'draft' }, false, routePage))) navigate(routePage === 'history' ? '/history' : '/meetings', { replace: true })
    }
    return
  }
  page.value = path === '/history' ? 'history' : path === '/settings' ? 'settings' : 'dashboard'
  activeMeeting.value = null
  editingSong.value = null
  if (path !== '/' && path !== '/history' && path !== '/settings') navigate(page.value === 'history' ? '/history' : page.value === 'settings' ? '/settings' : '/', { replace: true })
}

async function loadAppData() {
  const [songsResponse, meetingsResponse, sourceResponse, settingsResponse, usersResponse] = await Promise.all([
    api<Song[] | { songs?: Song[]; items?: Song[] }>('/api/songs'),
    api<Meeting[] | { meetings?: Meeting[]; items?: Meeting[] }>('/api/meetings'),
    api<{ sources: TrustedSource[] }>('/api/trusted-sources'),
    api<{ settings: AppSettings }>('/api/settings'),
    api<{ users: UserAccount[] }>('/api/users'),
  ])
  songs.value = getCollection(songsResponse)
  meetings.value = getCollection(meetingsResponse)
  trustedSources.value = sourceResponse.sources
  settings.value = settingsResponse.settings
  users.value = usersResponse.users
}

async function initialize() {
  if (presenterToken) return
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
    await api('/api/login', { method: 'POST', body: JSON.stringify({ password: password.value }) })
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
    if (isNew) songs.value.unshift(saved)
    else songs.value = songs.value.map((existing) => existing.id === saved.id ? saved : existing)
    editingSong.value = { ...saved, lyricsText: songLyrics(saved) }
    slidePreview.value = parseLyrics(saved.title, songLyrics(saved))
    if (isNew) setPath(`/library/${saved.id}`, { replace: true })
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

async function addUser() {
  if (!newUser.value.email.trim() || !newUser.value.password) return
  isBusy.value = true
  try {
    const result = await api<{ user: UserAccount }>('/api/users', { method: 'POST', body: JSON.stringify(newUser.value) })
    users.value.push(result.user)
    newUser.value = { email: '', password: '' }
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
const presenterSettingsKey = 'song-management:presenter-settings'
const deckMeeting = ref<Meeting | null>(null)
const textScale = ref(1)
const repeatChorus = ref(false)
const showSlideCount = ref(true)
const activeSlide = computed(() => deckSlides.value[deckIndex.value])

function cloneSlide(slide: Slide): Slide {
  return { ...slide, lines: [...slide.lines] }
}

function slidesWithRepeatedChorus(meeting: Meeting, fallback?: Slide[]): Slide[] {
  if (!repeatChorus.value || !meeting.songs?.length) return flattenDeck(meeting, fallback)
  return meeting.songs.flatMap((song) => {
    const slides = song.slides ?? []
    const chorus = slides.filter((slide) => /^chorus\b/i.test(slide.section ?? ''))
    if (!chorus.length) return slides
    return slides.flatMap((slide, index) => {
      const next = slides[index + 1]
      const isLastSlideOfVerse = /^verse\b/i.test(slide.section ?? '') && next?.section !== slide.section
      const hasFollowingChorus = /^chorus\b/i.test(next?.section ?? '')
      return isLastSlideOfVerse && !hasFollowingChorus ? [slide, ...chorus.map(cloneSlide)] : [slide]
    })
  })
}

function rebuildDeck() {
  if (!deckMeeting.value) return
  const current = activeSlide.value
  deckSlides.value = slidesWithRepeatedChorus(deckMeeting.value)
  const currentIndex = current ? deckSlides.value.findIndex((slide) => slide.id === current.id && slide.kind === current.kind) : -1
  deckIndex.value = Math.max(0, currentIndex)
}

function adjustTextSize(amount: number) {
  textScale.value = Math.round(Math.min(1.35, Math.max(.75, textScale.value + amount)) * 100) / 100
}

async function loadDeck() {
  if (!presenterToken || deckLoading.value) return
  deckLoading.value = true
  deckError.value = ''
  try {
    const data = await api<{ deck?: Meeting; meeting?: Meeting; title?: string; slides?: Slide[]; settings?: AppSettings }>(`/api/present/${presenterToken}`)
    const meeting: Meeting = data.deck ?? data.meeting ?? ({ id: '', status: 'draft' } as Meeting)
    deckTitle.value = data.title ?? meeting.title ?? 'Song night'
    deckMeeting.value = meeting
    if (data.settings && localStorage.getItem(presenterSettingsKey) === null) {
      textScale.value = data.settings.defaultTextScale
      repeatChorus.value = data.settings.defaultRepeatChorus
      showSlideCount.value = data.settings.defaultShowSlideCount
    }
    deckSlides.value = slidesWithRepeatedChorus(meeting, data.slides)
    if (!deckSlides.value.length) throw new Error('This meeting does not have a slide deck yet.')
    sessionStorage.setItem(deckCacheKey, JSON.stringify({ title: deckTitle.value, meeting, slides: deckSlides.value }))
    deckReady.value = true
  } catch (caught) {
    const cached = sessionStorage.getItem(deckCacheKey)
    if (cached) {
      const data = JSON.parse(cached) as { title: string; meeting?: Meeting; slides: Slide[] }
      deckTitle.value = data.title
      deckMeeting.value = data.meeting ?? null
      deckSlides.value = deckMeeting.value ? slidesWithRepeatedChorus(deckMeeting.value) : data.slides
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
  else if (event.key === '-' || event.key === '_') adjustTextSize(-.05)
  else if (event.key === '=' || event.key === '+') adjustTextSize(.05)
  else if (event.key.toLowerCase() === 'c') { repeatChorus.value = !repeatChorus.value; rebuildDeck() }
}

watch([songSearch, songFilter], () => { /* filtering is intentionally instant and local */ })
watch([notice, error], () => {
  if (toastTimer) window.clearTimeout(toastTimer)
  if (notice.value || error.value) toastTimer = window.setTimeout(() => { notice.value = ''; error.value = '' }, 4000)
})
watch([textScale, repeatChorus, showSlideCount], () => {
  if (!presenterToken) return
  localStorage.setItem(presenterSettingsKey, JSON.stringify({ textScale: textScale.value, repeatChorus: repeatChorus.value, showSlideCount: showSlideCount.value }))
})
onMounted(() => {
  window.addEventListener('keydown', presentationKeydown)
  window.addEventListener('popstate', applyRoute)
  if (presenterToken) {
    try {
      const settings = JSON.parse(localStorage.getItem(presenterSettingsKey) ?? '{}') as { textScale?: number; repeatChorus?: boolean; showSlideCount?: boolean }
      if (typeof settings.textScale === 'number') textScale.value = Math.min(1.35, Math.max(.75, settings.textScale))
      if (typeof settings.repeatChorus === 'boolean') repeatChorus.value = settings.repeatChorus
      if (typeof settings.showSlideCount === 'boolean') showSlideCount.value = settings.showSlideCount
    } catch { /* Default presenter settings are safe. */ }
    void loadDeck()
  } else void initialize()
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', presentationKeydown)
  window.removeEventListener('popstate', applyRoute)
  if (toastTimer) window.clearTimeout(toastTimer)
})
</script>

<template>
  <main v-if="presenterToken" class="presenter" @click="changeSlide(1)">
    <div v-if="deckLoading" class="presenter-status">Loading the complete meeting deck…</div>
    <div v-else-if="deckError" class="presenter-status presenter-error">
      <p>{{ deckError }}</p><button class="button" @click.stop="loadDeck">Try again</button>
    </div>
    <template v-else-if="deckReady && activeSlide">
      <div class="presenter-heading">{{ deckTitle }}</div>
      <section class="slide" :class="`slide-${activeSlide.kind}`" :style="{ '--text-scale': textScale }">
        <p v-if="activeSlide.section" class="slide-section">{{ activeSlide.section }}</p>
        <h1 v-for="line in activeSlide.lines" :key="line">{{ line }}</h1>
      </section>
      <div class="presenter-controls" @click.stop>
        <button aria-label="Previous slide" :disabled="deckIndex === 0" @click="changeSlide(-1)">←</button>
        <span v-if="showSlideCount">{{ deckIndex + 1 }} / {{ deckSlides.length }}</span>
        <button aria-label="Next slide" :disabled="deckIndex === deckSlides.length - 1" @click="changeSlide(1)">→</button>
        <div class="presenter-divider" aria-hidden="true"></div>
        <button aria-label="Smaller lyric text" title="Smaller text (−)" @click="adjustTextSize(-.05)">A−</button>
        <button aria-label="Larger lyric text" title="Larger text (+)" @click="adjustTextSize(.05)">A+</button>
        <button class="chorus-toggle" :class="{ active: repeatChorus }" :aria-pressed="repeatChorus" title="Repeat chorus after every verse (C)" @click="repeatChorus = !repeatChorus; rebuildDeck()">Ch</button>
        <button :class="{ active: showSlideCount }" :aria-pressed="showSlideCount" title="Show slide count" @click="showSlideCount = !showSlideCount">#</button>
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
      <div class="brand"><span>♪</span><div><strong>Songbook</strong><small>{{ settings.groupName }}</small></div></div>
      <nav aria-label="Main navigation">
        <button :class="{ active: page === 'dashboard' }" @click="selectPage('dashboard')">Dashboard</button>
        <button :class="{ active: page === 'library' }" @click="selectPage('library')">Song library</button>
        <button :class="{ active: page === 'meetings' }" @click="selectPage('meetings')">Plan meeting</button>
        <button :class="{ active: page === 'history' }" @click="selectPage('history')">History</button>
        <button :class="{ active: page === 'settings' }" @click="selectPage('settings')">Settings</button>
      </nav>
      <button class="logout" @click="logout">Sign out</button>
    </aside>

    <div class="toast-stack" aria-live="polite">
      <div v-if="error" class="toast toast-error"><span>{{ error }}</span><button @click="error = ''">×</button></div>
      <div v-if="notice" class="toast"><span>{{ notice }}</span><button @click="notice = ''">×</button></div>
    </div>
    <section class="workspace">

      <template v-if="page === 'dashboard'">
        <header class="page-header"><div><p class="eyebrow">{{ settings.groupName }}</p><h1>Good evening</h1><p class="muted">Your songs, meetings, and projector deck in one quiet place.</p></div><button class="button" @click="createMeeting">+ Plan a meeting</button></header>
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
        <header class="page-header"><div><button v-if="editingSong" class="text-button back-button" @click="backToLibrary">← Back to library</button><p class="eyebrow">LIBRARY</p><h1>{{ editingSong ? (editingSong.id ? 'Edit song' : 'New song') : 'Songs' }}</h1></div><button v-if="!editingSong" class="button" @click="editSong()">+ Add song</button></header>
        <section v-if="!editingSong" class="card library">
          <div class="search-bar"><input v-model="songSearch" placeholder="Search title or hymn number" /><select v-model="songFilter"><option value="all">All songs</option><option value="unused">Never used</option><option value="recent">Used before</option></select></div>
          <div class="table-wrap"><table><thead><tr><th>Song</th><th>Used</th><th>Last sung</th><th></th></tr></thead><tbody><tr v-for="song in shownSongs" :key="song.id"><td><strong>{{ song.title }}</strong><small v-if="songNumber(song)">#{{ songNumber(song) }}</small></td><td>{{ songUses(song) }}×</td><td>{{ displayDate(songLastUsed(song)) }}</td><td><button class="text-button" @click="editSong(song)">Edit</button></td></tr></tbody></table></div>
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
        <header class="page-header"><div><p class="eyebrow">PLANNING</p><h1>{{ activeMeeting ? displayDate(meetingDate(activeMeeting)) : 'Plan a meeting' }}</h1></div><button v-if="!activeMeeting" class="button" @click="createMeeting">+ New meeting</button><button v-else class="text-button" @click="navigate('/meetings')">All meetings</button></header>
        <section v-if="!activeMeeting" class="card"><ul class="meeting-list"><li v-for="meeting in meetings" :key="meeting.id"><button @click="openMeeting(meeting)"><span><strong>{{ displayDate(meetingDate(meeting)) }}</strong><small>{{ meeting.title || 'Men’s group' }}</small></span><span class="meeting-state" :class="meeting.status">{{ meeting.status }}</span></button></li></ul></section>
        <div v-else class="meeting-grid"><section class="card"><div class="card-heading"><div><p class="eyebrow">SELECTED SONGS</p><h2>{{ activeMeeting.songs?.length ?? 0 }} songs</h2></div><span class="meeting-state" :class="activeMeeting.status">{{ activeMeeting.status }}</span></div><ol class="planned-list"><li v-for="(song, index) in activeMeeting.songs ?? []" :key="song.meetingSongId ?? song.meeting_song_id"><span class="position">{{ index + 1 }}</span><div><strong>{{ song.title }}</strong><small>{{ songUses(song) ? `Used ${songUses(song)}× · last ${displayDate(songLastUsed(song))}` : 'Never used' }}</small></div><div class="row-actions"><button :disabled="index === 0" @click="moveMeetingSong(index, -1)">↑</button><button :disabled="index === (activeMeeting.songs?.length ?? 0) - 1" @click="moveMeetingSong(index, 1)">↓</button><button aria-label="Remove song" @click="removeMeetingSong(song)">×</button></div></li><li v-if="!(activeMeeting.songs ?? []).length" class="muted">Add songs from the library on the right.</li></ol><div class="meeting-actions"><button class="secondary-button" :disabled="isBusy || !(activeMeeting.songs?.length)" @click="generateSlides">Generate deck</button><button class="secondary-button" :disabled="!(activeMeeting.songs?.length)" @click="editingMeetingSlides = !editingMeetingSlides">{{ editingMeetingSlides ? 'Close slide editor' : 'Edit slides' }}</button><button class="button" :disabled="isBusy || !(activeMeeting.songs?.length)" @click="publishMeeting">Publish presenter</button></div><a v-if="meetingToken(activeMeeting)" class="presenter-link" :href="`/present/${meetingToken(activeMeeting)}`" target="_blank" rel="noreferrer">Open ready-to-present deck ↗</a></section><section class="card"><p class="eyebrow">ADD SONGS</p><label class="sr-only" for="meeting-search">Search songs</label><input id="meeting-search" v-model="meetingSearch" placeholder="Search song library" /><ul class="add-song-list"><li v-for="song in meetingSongChoices" :key="song.id"><div><strong>{{ song.title }}</strong><small>{{ songUses(song) ? `${songUses(song)}× used · ${displayDate(songLastUsed(song))}` : 'Never used' }}</small></div><button class="text-button" :disabled="activeMeeting.songs?.some((item) => item.id === song.id)" @click="addSongToMeeting(song)">Add</button></li></ul></section></div>
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
        <section class="card"><ul class="meeting-list"><li v-for="meeting in recentMeetings" :key="meeting.id"><button @click="openMeeting(meeting)"><span><strong>{{ displayDate(meetingDate(meeting)) }}</strong><small>{{ (meeting.songs ?? []).map((song) => song.title).join(' · ') || 'No songs recorded' }}</small></span><span class="meeting-state" :class="meeting.status">{{ meeting.status }}</span></button></li></ul></section>
      </template>

      <template v-else>
        <header class="page-header"><div><p class="eyebrow">SETTINGS</p><h1>Songbook settings</h1><p class="muted">Set the group identity, projector defaults, and administrator access.</p></div></header>
        <div class="settings-grid">
          <form class="card form-card" @submit.prevent="saveSettings">
            <div><p class="eyebrow">GENERAL</p><h2>Default experience</h2></div>
            <label>Group name <input v-model="settings.groupName" maxlength="100" required /></label>
            <label>Default lyric size <input v-model.number="settings.defaultTextScale" type="range" min="0.75" max="1.35" step="0.05" /><small>{{ Math.round(settings.defaultTextScale * 100) }}%</small></label>
            <label class="toggle-row"><input v-model="settings.defaultRepeatChorus" type="checkbox" /> Repeat each song’s chorus after every verse</label>
            <label class="toggle-row"><input v-model="settings.defaultShowSlideCount" type="checkbox" /> Show slide count in the presenter</label>
            <button class="button" :disabled="isBusy">Save settings</button>
          </form>
          <section class="card form-card">
            <div><p class="eyebrow">USERS</p><h2>Administrators</h2></div>
            <ul class="user-list"><li v-for="user in users" :key="user.id"><div><strong>{{ user.email }}</strong><small>Added {{ displayDate(user.createdAt.slice(0, 10)) }}</small></div><button class="text-button" :disabled="user.id === session?.user?.id" @click="removeUser(user)">{{ user.id === session?.user?.id ? 'Current user' : 'Remove' }}</button></li></ul>
            <form class="new-user-form" @submit.prevent="addUser"><label>Email <input v-model="newUser.email" type="email" required /></label><label>Temporary password <input v-model="newUser.password" type="password" minlength="12" required /></label><button class="secondary-button" :disabled="isBusy">Add administrator</button></form>
          </section>
        </div>
      </template>
    </section>
  </main>
</template>
