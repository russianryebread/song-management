<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { api, songLastUsed, songLyrics, songNumber, songUses, type Song, type SongListResponse } from '../api'
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
let timer: ReturnType<typeof setTimeout> | undefined
let controller: AbortController | undefined
let generation = 0
const hasFilters = computed(() => query.value || usage.value !== 'all' || lyrics.value !== 'all' || sort.value !== 'title')
function reset() { query.value = ''; usage.value = 'all'; lyrics.value = 'all'; sort.value = 'title' }
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
    const data = await api<SongListResponse>(`/api/songs?${params}`, { signal: controller.signal })
    if (current !== generation) return
    result.value = data
    page.value = data.page
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
function go(target: number) { page.value = target; void load() }
void load()
onBeforeUnmount(() => { clearTimeout(timer); ++generation; controller?.abort() })
</script>

<template>
  <div class="song-browser" :aria-busy="loading">
    <label class="browser-search">Search songs<input v-model="query" type="search" placeholder="Title, hymn number, or lyric words" /></label>
    <div class="browser-filters">
      <label>Usage<select v-model="usage"><option value="all">All songs</option><option value="used">Used before</option><option value="unused">Never used</option></select></label>
      <label>Lyrics<select v-model="lyrics"><option value="all">Any lyrics status</option><option value="ready">With lyrics</option><option value="missing">Missing lyrics</option></select></label>
      <label>Sort by<select v-model="sort"><option value="title">Title A–Z</option><option value="number">Hymn number</option><option value="recent">Recently used</option><option value="least-used">Least used</option><option value="most-used">Most used</option><option value="oldest">Longest since used</option></select></label>
      <button v-if="hasFilters" class="text-button" @click="reset">Clear filters</button>
    </div>
    <p v-if="error" role="alert" class="form-error">{{ error }} <button class="text-button" @click="load">Retry</button></p>
    <p role="status" class="muted">{{ loading ? 'Searching…' : `${result.total} song${result.total === 1 ? '' : 's'} found` }}</p>
    <div class="table-wrap"><table><thead><tr><th>Song</th><th>Used</th><th>Last used</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>
      <template v-for="song in result.songs" :key="song.id">
        <tr><td><button class="song-title-link" :aria-expanded="expanded === song.id" @click="expanded = expanded === song.id ? null : song.id">{{ song.title }}</button><small>{{ songNumber(song) ? `#${songNumber(song)} · ` : '' }}{{ songLyrics(song).trim() ? 'Lyrics available' : 'Missing lyrics' }}</small></td><td>{{ songUses(song) }}×</td><td>{{ lastUsed(song) }}</td><td><button class="text-button" :disabled="loading || busy || (selection && (selectedIds.includes(song.id) || !songLyrics(song).trim()))" @click="emit('select', song)">{{ selection ? (selectedIds.includes(song.id) ? 'Added' : 'Add') : 'Edit' }}</button></td></tr>
        <tr v-if="expanded === song.id"><td colspan="4"><pre class="browser-lyrics">{{ songLyrics(song) || 'Add lyrics in the song library before using this song in a meeting.' }}</pre></td></tr>
      </template>
      <tr v-if="!loading && !error && !result.songs.length"><td colspan="4" class="muted">No songs match. Try fewer words or clear the filters.</td></tr>
    </tbody></table></div>
    <nav class="pagination" aria-label="Song pages"><span>Page {{ result.page }} of {{ result.totalPages }}</span><label>Per page<select v-model.number="pageSize"><option :value="10">10</option><option :value="25">25</option><option :value="50">50</option></select></label><div><button class="secondary-button" :disabled="loading || result.page <= 1" @click="go(result.page - 1)">Previous</button><button class="secondary-button" :disabled="loading || result.page >= result.totalPages" @click="go(result.page + 1)">Next</button></div></nav>
  </div>
</template>
<style scoped>
.browser-search, .browser-filters label { display: grid; gap: .4rem; }
.browser-filters { display: flex; flex-wrap: wrap; gap: .75rem; align-items: end; margin-top: 1rem; }
.browser-filters label { flex: 1; min-width: 130px; }
table { min-width: 0; }
th, td { padding: .7rem .4rem; overflow-wrap: anywhere; }
.pagination label { white-space: nowrap; }
.browser-lyrics { white-space: pre-wrap; font: inherit; max-height: 20rem; overflow: auto; }
.pagination { flex-wrap: wrap; gap: .75rem; }
.pagination label { display: flex; align-items: center; gap: .5rem; }
</style>
