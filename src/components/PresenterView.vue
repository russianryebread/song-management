<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { api, type AppSettings, type Meeting, type Slide } from '../api'
import { flattenDeck } from '../lyrics'

const route = useRoute()
const token = computed(() => String(route.params.viewToken ?? ''))
const slides = ref<Slide[]>([])
const title = ref('Song night')
const index = ref(0)
const loading = ref(false)
const error = ref('')
const meeting = ref<Meeting | null>(null)
const textScale = ref(1)
const presenterFont = ref<AppSettings['defaultPresenterFont']>('libre-baskerville')
const repeatChorus = ref(false)
const showSlideCount = ref(true)
const isRebuilding = ref(false)
const cacheKey = computed(() => `song-management:deck:${token.value}`)
const settingsKey = 'song-management:presenter-settings'
const activeSlide = computed(() => slides.value[index.value])

function cloneSlide(slide: Slide): Slide { return { ...slide, lines: [...slide.lines] } }

function expandedSlides(source: Meeting, fallback?: Slide[]): Slide[] {
  if (!repeatChorus.value || !source.songs?.length) return flattenDeck(source, fallback)
  return source.songs.flatMap((song) => {
    const songSlides = song.slides ?? []
    const chorus = songSlides.filter((slide) => /^chorus\b/i.test(slide.section ?? ''))
    if (!chorus.length) return songSlides
    return songSlides.flatMap((slide, position) => {
      const next = songSlides[position + 1]
      const endsVerse = /^verse\b/i.test(slide.section ?? '') && next?.section !== slide.section
      return endsVerse && !/^chorus\b/i.test(next?.section ?? '') ? [slide, ...chorus.map(cloneSlide)] : [slide]
    })
  })
}

function rebuildSlides() {
  if (!meeting.value || isRebuilding.value) return
  isRebuilding.value = true
  const current = activeSlide.value
  try {
    // Always expand from the saved deck, never from the current display list.
    // This prevents repeated chorus toggles from accumulating slide copies.
    slides.value = expandedSlides(meeting.value)
    const nextIndex = current ? slides.value.findIndex((slide) => slide.id === current.id && slide.kind === current.kind) : 0
    index.value = Math.max(0, nextIndex)
  } finally { isRebuilding.value = false }
}

function changeSlide(amount: number) {
  index.value = Math.min(Math.max(index.value + amount, 0), slides.value.length - 1)
}
function adjustTextSize(amount: number) {
  textScale.value = Math.round(Math.min(1.35, Math.max(.75, textScale.value + amount)) * 100) / 100
}
async function toggleFullscreen() {
  try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen() } catch { /* Browser may decline. */ }
}

async function loadDeck() {
  if (!token.value || loading.value) return
  loading.value = true; error.value = ''
  try {
    const data = await api<{ meeting?: Meeting; deck?: Meeting; slides?: Slide[]; title?: string; settings?: AppSettings }>(`/api/present/${token.value}`)
    meeting.value = data.meeting ?? data.deck ?? null
    title.value = data.settings?.groupName || data.title || 'Song night'
    if (data.settings) {
      presenterFont.value = data.settings.defaultPresenterFont
      if (localStorage.getItem(settingsKey) === null) {
        textScale.value = data.settings.defaultTextScale
        repeatChorus.value = data.settings.defaultRepeatChorus
        showSlideCount.value = data.settings.defaultShowSlideCount
      }
    }
    slides.value = meeting.value ? expandedSlides(meeting.value, data.slides) : data.slides ?? []
    if (!slides.value.length) throw new Error('This meeting does not have a slide deck yet.')
    sessionStorage.setItem(cacheKey.value, JSON.stringify({ title: title.value, meeting: meeting.value, slides: slides.value }))
  } catch (caught) {
    const cached = sessionStorage.getItem(cacheKey.value)
    if (!cached) error.value = (caught as Error).message
    else {
      const data = JSON.parse(cached) as { title: string; meeting?: Meeting; slides: Slide[] }
      title.value = data.title; meeting.value = data.meeting ?? null; slides.value = meeting.value ? expandedSlides(meeting.value) : data.slides
    }
  } finally { loading.value = false }
}

function keydown(event: KeyboardEvent) {
  if (!activeSlide.value) return
  if ([' ', 'ArrowRight', 'ArrowDown'].includes(event.key)) { event.preventDefault(); changeSlide(1) }
  else if (['ArrowLeft', 'ArrowUp'].includes(event.key)) { event.preventDefault(); changeSlide(-1) }
  else if (event.key.toLowerCase() === 'f') void toggleFullscreen()
  else if (event.key === '-' || event.key === '_') adjustTextSize(-.05)
  else if (event.key === '=' || event.key === '+') adjustTextSize(.05)
  else if (event.key.toLowerCase() === 'c') { repeatChorus.value = !repeatChorus.value; rebuildSlides() }
}

watch([textScale, repeatChorus, showSlideCount], () => localStorage.setItem(settingsKey, JSON.stringify({ textScale: textScale.value, repeatChorus: repeatChorus.value, showSlideCount: showSlideCount.value })))
onMounted(() => {
  try {
    const saved = JSON.parse(localStorage.getItem(settingsKey) ?? '{}') as { textScale?: number; repeatChorus?: boolean; showSlideCount?: boolean }
    if (typeof saved.textScale === 'number') textScale.value = Math.min(1.35, Math.max(.75, saved.textScale))
    if (typeof saved.repeatChorus === 'boolean') repeatChorus.value = saved.repeatChorus
    if (typeof saved.showSlideCount === 'boolean') showSlideCount.value = saved.showSlideCount
  } catch { /* Defaults remain usable. */ }
  window.addEventListener('keydown', keydown); void loadDeck()
})
onBeforeUnmount(() => window.removeEventListener('keydown', keydown))
</script>

<template>
  <main class="presenter" @click="changeSlide(1)">
    <div v-if="loading" class="presenter-status">Loading the complete meeting deck…</div>
    <div v-else-if="error" class="presenter-status presenter-error"><p>{{ error }}</p><button class="button" @click.stop="loadDeck">Try again</button></div>
    <template v-else-if="activeSlide">
      <div class="presenter-heading">{{ title }}</div>
      <section class="slide" :class="[`slide-${activeSlide.kind}`, `presenter-font-${presenterFont}`]" :style="{ '--text-scale': textScale }">
        <p v-if="activeSlide.section" class="slide-section">{{ activeSlide.section }}</p>
        <h1 v-for="line in activeSlide.lines" :key="line">{{ line }}</h1>
      </section>
      <div class="presenter-controls" aria-label="Presenter controls" @click.stop>
        <span v-if="showSlideCount" class="presenter-count">{{ index + 1 }} / {{ slides.length }}</span>
        <button aria-label="Previous slide" :disabled="index === 0" @click="changeSlide(-1)">←</button>
        <button aria-label="Next slide" :disabled="index === slides.length - 1" @click="changeSlide(1)">→</button>
        <button title="Smaller text (−)" aria-label="Smaller text" @click="adjustTextSize(-.05)">A−</button>
        <button title="Larger text (+)" aria-label="Larger text" @click="adjustTextSize(.05)">A+</button>
        <button class="chorus-toggle" :class="{ active: repeatChorus }" title="Repeat chorus after every verse (C)" aria-label="Repeat chorus after every verse" @click="repeatChorus = !repeatChorus; rebuildSlides()">Ch</button>
        <button :class="{ active: showSlideCount }" title="Show slide count" aria-label="Toggle slide count" @click="showSlideCount = !showSlideCount">#</button>
        <button aria-label="Toggle full screen" @click="toggleFullscreen">⛶</button>
      </div>
    </template>
  </main>
</template>
