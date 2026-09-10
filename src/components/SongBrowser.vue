<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { api, songLastUsed, songLyrics, songNumber, songUses, type Song, type SongListResponse, type SongIndexResponse } from '../api'
import { alphabet, indexKey, titleLetter } from '../shared/song-index'
const props = withDefaults(defineProps<{ selection?: boolean; selectedIds?: string[]; busy?: boolean; revision?: number }>(), { selectedIds: () => [] })
const emit = defineEmits<{ select: [song: Song] }>()
const query = ref('')
const usage = ref('all')
const lyrics = ref('all')
const sort = ref('title')
const page = ref(1)
const pageSize = ref(25)
const result = ref<SongListResponse>({ songs: [], page: 1, pageSize: 25, total: 0, totalPages: 1 })
const loading = ref(false)
const error = ref('')
const expanded = ref<string | null>(null)
const indexSongs = ref<Song[]>([])
const includeAliases = ref(true)
const onlyLetter = ref(false)
const activeLetter = ref('')
const tableViewport = ref<HTMLElement>()
const letterStrip = ref<HTMLElement>()
const details = ref<Record<string, Song>>({})
const detailBusy = ref(false)
const tailSpace = ref(0)
let resizeObserver: ResizeObserver | undefined
const alphabetical = computed(() => sort.value === 'title')
type Entry = { key: string; title: string; song: Song; alias: boolean }
const sections = computed(() => {
  const entries: Entry[] = []
  for (const song of indexSongs.value) {
    entries.push({ key: song.id, title: song.title, song, alias: false })
    if (includeAliases.value && !query.value.trim()) for (const alias of song.aliases ?? []) {
      if (indexKey(alias.title) !== indexKey(song.title)) entries.push({ key: `${song.id}:${alias.title}`, title: alias.title, song, alias: true })
    }
  }
  entries.sort((a, b) => indexKey(a.title).localeCompare(indexKey(b.title), 'en', { numeric: true }) || a.key.localeCompare(b.key))
  return alphabet.map(letter => ({ letter, entries: entries.filter(entry => titleLetter(entry.title) === letter) })).filter(section => section.entries.length)
})
const visibleSections = computed(() => onlyLetter.value && activeLetter.value ? sections.value.filter(section => section.letter === activeLetter.value) : sections.value)
const entryCount = computed(() => visibleSections.value.reduce((sum, section) => sum + section.entries.length, 0))
const songCount = computed(() => new Set(visibleSections.value.flatMap(section => section.entries.map(entry => entry.song.id))).size)
const groups = computed(() => alphabetical.value ? visibleSections.value : [{ letter: '', entries: result.value.songs.map(song => ({ key: song.id, title: song.title, song, alias: false })) }])
function ready(song: Song) { return song.hasLyrics ?? Boolean(songLyrics(song).trim()) }
function aliasDescription(song: Song) {
  const aliases = song.aliases ?? []
  const terms = indexKey(query.value).split(/\s+/).filter(Boolean)
  const matched = terms.length ? aliases.find(alias => terms.some(term => indexKey(alias.title).includes(term))) : undefined
  if (matched) return `Matched ${matched.kind === 'first-line' ? 'first line' : 'alternate title'}: ${matched.title}`
  return aliases.map(alias => `${alias.kind === 'first-line' ? 'First line' : 'Also known as'}: ${alias.title}`).join(' · ')
}
async function fullSong(song: Song) {
  if (song.lyricsText !== undefined || song.lyrics_text !== undefined) return song
  if (!details.value[song.id]) {
    const current = generation
    const data = await api<{ song: Song }>(`/api/songs/${encodeURIComponent(song.id)}`)
    if (current === generation) details.value[song.id] = data.song
    return data.song
  }
  return details.value[song.id]!
}
async function expand(entry: Entry) {
  if (expanded.value === entry.key) { expanded.value = null; return }
  const current = generation
  detailBusy.value = true
  try { await fullSong(entry.song); if (current === generation) expanded.value = entry.key } catch (caught) { error.value = (caught as Error).message }
  finally { detailBusy.value = false }
}
async function select(song: Song) {
  const current = generation
  detailBusy.value = true
  try { const full = await fullSong(song); if (current === generation) emit('select', full) } catch (caught) { error.value = (caught as Error).message }
  finally { detailBusy.value = false }
}
function updateTailSpace() {
  const viewport = tableViewport.value
  const last = viewport?.querySelector<HTMLElement>('tbody[data-section]:last-of-type')
  tailSpace.value = alphabetical.value && !onlyLetter.value && viewport && last ? Math.max(0, viewport.clientHeight - 40 - last.offsetHeight) : 0
}
function scrollLetters(direction: number) {
  letterStrip.value?.scrollBy({ left: direction * 240, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
}
function revealLetter() {
  const button = letterStrip.value?.querySelector<HTMLElement>(`[data-letter="${activeLetter.value}"]`)
  if (button && letterStrip.value) letterStrip.value.scrollTo({ left: button.offsetLeft - letterStrip.value.offsetWidth / 2 + button.offsetWidth / 2, behavior: 'auto' })
}
async function jump(letter: string) {
  activeLetter.value = letter
  if (!letter) onlyLetter.value = false
  await nextTick()
  updateTailSpace()
  await nextTick()
  const viewport = tableViewport.value
  const target = viewport?.querySelector<HTMLElement>(`[data-section="${letter}"]`)
  if (viewport) viewport.scrollTo({ top: target ? viewport.scrollTop + target.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 40 : 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  revealLetter()
}
function onScroll() {
  if (onlyLetter.value || !alphabetical.value || !tableViewport.value) return
  const top = tableViewport.value.getBoundingClientRect().top + 85
  let letter = ''
  for (const group of tableViewport.value.querySelectorAll<HTMLElement>('[data-section]')) {
    if (group.getBoundingClientRect().top <= top) letter = group.dataset.section ?? ''
  }
  if (letter !== activeLetter.value) { activeLetter.value = letter; revealLetter() }
}
function stripKey(event: KeyboardEvent) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  const buttons = Array.from(letterStrip.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
  const current = buttons.indexOf(event.target as HTMLButtonElement)
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, current + (event.key === 'ArrowRight' ? 1 : -1)))
  buttons[next]?.focus()
  event.preventDefault()
}
let timer: ReturnType<typeof setTimeout> | undefined
let controller: AbortController | undefined
let generation = 0
const hasFilters = computed(() => query.value || usage.value !== 'all' || lyrics.value !== 'all' || sort.value !== 'title' || onlyLetter.value || !includeAliases.value)
function reset() { query.value = ''; usage.value = 'all'; lyrics.value = 'all'; sort.value = 'title'; onlyLetter.value = false; includeAliases.value = true; activeLetter.value = '' }
function lastUsed(song: Song) {
  const value = songLastUsed(song)
  return value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(`${value}T12:00:00`)) : 'Never used'
}
async function load() {
  const current = ++generation
  controller?.abort()
  controller = new AbortController()
  loading.value = true
  error.value = ''
  try {
    const params = new URLSearchParams({ q: query.value, filter: usage.value, lyrics: lyrics.value, sort: sort.value, page: String(page.value), pageSize: String(pageSize.value) })
    if (alphabetical.value) params.set('mode', 'index')
    const data = await api<SongListResponse | SongIndexResponse>(`/api/songs?${params}`, { signal: controller.signal })
    if (current !== generation) return
    if (alphabetical.value) {
      indexSongs.value = data.songs
      if (!sections.value.some(section => section.letter === activeLetter.value)) { activeLetter.value = ''; onlyLetter.value = false }
    } else if ('page' in data) { result.value = data; page.value = data.page }
    details.value = {}
    expanded.value = null
    await nextTick()
    if (tableViewport.value) tableViewport.value.scrollTop = 0
  } catch (caught) {
    if (current === generation && (caught as Error).name !== 'AbortError') error.value = (caught as Error).message
  } finally { if (current === generation) loading.value = false }
}
watch([query, usage, lyrics, sort, pageSize], () => {
  clearTimeout(timer)
  ++generation
  controller?.abort()
  loading.value = true
  page.value = 1
  timer = setTimeout(load, 220)
})
watch(() => props.revision, () => { clearTimeout(timer); void load() })
watch(onlyLetter, () => { if (onlyLetter.value && !activeLetter.value) activeLetter.value = sections.value[0]?.letter ?? ''; void nextTick(() => { if (tableViewport.value) tableViewport.value.scrollTop = 0 }) })
watch(includeAliases, () => { if (!sections.value.some(section => section.letter === activeLetter.value)) { activeLetter.value = ''; onlyLetter.value = false } })
function go(target: number) { page.value = target; void load() }
watch([groups, expanded], () => { updateTailSpace() }, { flush: 'post' })
onMounted(() => {
  resizeObserver = new ResizeObserver(updateTailSpace)
  if (tableViewport.value) resizeObserver.observe(tableViewport.value)
})
void load()
onBeforeUnmount(() => { resizeObserver?.disconnect(); clearTimeout(timer); ++generation; controller?.abort() })
</script>

<template>
  <div class="song-browser" :aria-busy="loading">
    <label class="browser-search">Search songs<input v-model="query" type="search" placeholder="Title, alternate title, hymn number, or lyric words" /></label>
    <div class="browser-filters">
      <label>Usage<select v-model="usage"><option value="all">All songs</option><option value="used">Used before</option><option value="unused">Never used</option></select></label>
      <label>Lyrics<select v-model="lyrics"><option value="all">Any lyrics status</option><option value="ready">With lyrics</option><option value="missing">Missing lyrics</option></select></label>
      <label>Sort by<select v-model="sort"><option value="title">Title A–Z</option><option value="number">Hymn number</option><option value="recent">Recently used</option><option value="least-used">Least used</option><option value="most-used">Most used</option><option value="oldest">Longest since used</option></select></label>
      <button v-if="hasFilters" class="text-button" @click="reset">Clear filters</button>
    </div>
    <p v-if="error" role="alert" class="form-error">{{ error }} <button class="text-button" @click="load">Retry</button></p>
    <p role="status" class="muted">{{ loading ? 'Searching…' : alphabetical ? `${songCount} songs · ${entryCount} index entries` : `${result.total} songs found` }}</p>
    <div v-if="alphabetical" class="alphabet-controls">
      <nav class="alphabet-navigation" aria-label="Song alphabet">
        <button class="text-button strip-arrow" aria-label="Scroll alphabet left" @click="scrollLetters(-1)">‹</button>
        <div ref="letterStrip" class="letter-strip" @keydown="stripKey">
          <button :aria-pressed="!activeLetter" @click="jump('')">All</button>
          <button v-for="letter in alphabet" :key="letter" :data-letter="letter" :aria-label="letter === '#' ? 'Number titles' : letter === '…' ? 'Other alphabets' : letter" :aria-pressed="activeLetter === letter" :disabled="loading || !sections.some(section => section.letter === letter)" @click="jump(letter)">{{ letter }}</button>
        </div>
        <button class="text-button strip-arrow" aria-label="Scroll alphabet right" @click="scrollLetters(1)">›</button>
      </nav>
      <div class="alphabet-options">
        <label><input v-model="onlyLetter" type="checkbox" :disabled="!sections.length" /> Only show this letter</label>
        <label><input v-model="includeAliases" type="checkbox" /> Include alternate titles</label>
      </div>
    </div>
    <div ref="tableViewport" class="table-wrap" :class="{ 'alphabet-table': alphabetical }" tabindex="0" role="region" aria-label="Songs" @scroll.passive="onScroll">
      <table><thead><tr><th>Song</th><th>Used</th><th>Last used</th><th><span class="sr-only">Actions</span></th></tr></thead>
        <tbody v-for="group in groups" :key="group.letter" :data-section="group.letter">
          <tr v-if="group.letter" class="letter-heading"><th colspan="4" scope="rowgroup">{{ group.letter }} <span>· {{ group.entries.length }} {{ group.entries.length === 1 ? 'entry' : 'entries' }}</span></th></tr>
          <template v-for="entry in group.entries" :key="entry.key">
            <tr><td>
              <button class="song-title-link" :disabled="loading || detailBusy" :aria-expanded="expanded === entry.key" @click="expand(entry)">{{ entry.title }}</button>
              <small v-if="entry.alias">Alternate title of: {{ entry.song.title }}</small>
              <small v-else-if="aliasDescription(entry.song)" class="alias-description">{{ aliasDescription(entry.song) }}</small>
              <small>{{ songNumber(entry.song) ? `#${songNumber(entry.song)} · ` : '' }}{{ ready(entry.song) ? 'Lyrics available' : 'Missing lyrics' }}</small>
            </td><td>{{ songUses(entry.song) }}×</td><td>{{ lastUsed(entry.song) }}</td><td>
              <button class="text-button" :disabled="loading || busy || detailBusy || (selection && (selectedIds.includes(entry.song.id) || !ready(entry.song)))" @click="select(entry.song)">{{ selection ? (selectedIds.includes(entry.song.id) ? 'Added' : 'Add') : 'Edit' }}</button>
            </td></tr>
            <tr v-if="expanded === entry.key"><td colspan="4"><pre class="browser-lyrics">{{ songLyrics(details[entry.song.id] ?? entry.song) || 'Add lyrics in the song library before using this song in a meeting.' }}</pre></td></tr>
          </template>
        </tbody>
        <tbody v-if="!loading && !error && !groups.some(group => group.entries.length)"><tr><td colspan="4" class="muted">No songs match. Try fewer words or clear the filters.</td></tr></tbody>
      </table>
      <div v-if="tailSpace" aria-hidden="true" :style="{ height: `${tailSpace}px` }"></div>
    </div>
    <nav v-if="!alphabetical" class="pagination" aria-label="Song pages"><span>Page {{ result.page }} of {{ result.totalPages }}</span><label>Per page<select v-model.number="pageSize"><option :value="10">10</option><option :value="25">25</option><option :value="50">50</option></select></label><div><button class="secondary-button" :disabled="loading || result.page <= 1" @click="go(result.page - 1)">Previous</button><button class="secondary-button" :disabled="loading || result.page >= result.totalPages" @click="go(result.page + 1)">Next</button></div></nav>
  </div>
</template>
<style scoped>
.song-browser { min-width: 0; }
.browser-search, .browser-filters label { display: grid; gap: .4rem; }
.browser-filters { display: flex; flex-wrap: wrap; gap: .75rem; align-items: end; margin-top: 1rem; }
.browser-filters label { flex: 1; min-width: 130px; }
table { min-width: 0; }
th, td { padding: .7rem .4rem; overflow-wrap: anywhere; }
.pagination label { white-space: nowrap; }
.browser-lyrics { white-space: pre-wrap; font: inherit; max-height: 20rem; overflow: auto; }
.pagination { flex-wrap: wrap; gap: .75rem; }
.pagination label { display: flex; align-items: center; gap: .5rem; }
.alphabet-controls { background: #fff; border: 1px solid #e4e9e3; border-radius: .65rem .65rem 0 0; padding: .5rem; }
.alphabet-navigation { display: flex; align-items: center; min-width: 0; }
.letter-strip { min-width: 0; display: flex; position: relative; overflow-x: auto; scroll-snap-type: x mandatory; scrollbar-width: thin; gap: .25rem; flex: 1; }
.letter-strip button { flex: 0 0 auto; min-width: 2.6rem; min-height: 2.75rem; border: 0; background: transparent; border-radius: .4rem; color: #385044; scroll-snap-align: center; }
.letter-strip button[aria-pressed="true"] { color: white; background: #315e46; }
.letter-strip button:disabled { opacity: .3; }
.strip-arrow { font-size: 1.5rem; padding: .25rem .65rem; }
.alphabet-options { display: flex; flex-wrap: wrap; gap: .5rem 1.5rem; padding: .6rem .5rem .2rem; font-size: .85rem; }
.alphabet-options label { display: flex; gap: .5rem; align-items: center; }
.alphabet-options input { width: auto; margin: 0; accent-color: #315e46; }
.alphabet-table { max-height: 65vh; overflow: auto; border: 1px solid #e4e9e3; border-top: 0; border-radius: 0 0 .65rem .65rem; }
.alphabet-table table { border-collapse: separate; border-spacing: 0; }
.alphabet-table thead th { position: sticky; top: 0; z-index: 3; background: #fff; height: 40px; white-space: nowrap; box-sizing: border-box; }
.letter-heading th { position: sticky; top: 40px; z-index: 2; background: #eaf0e9; color: #315e46; font-size: 1rem; letter-spacing: 0; padding: .65rem; }
.letter-heading span { font-size: .75rem; font-weight: 400; text-transform: none; }
.alias-description { max-width: 40rem; }
td:first-child { width: 60%; }
td:last-child button { white-space: nowrap; }
button:focus-visible, .table-wrap:focus-visible { outline: 2px solid #315e46; outline-offset: 2px; }
@media (max-width: 600px) { th, td { font-size: .8rem; } td:first-child { width: 50%; } .alphabet-table { max-height: 60vh; } }
@media (prefers-reduced-motion: reduce) { .letter-strip { scroll-behavior: auto; } }
</style>
