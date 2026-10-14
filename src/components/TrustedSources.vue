<script setup lang="ts">
import type { TrustedSource } from '../api'

defineProps<{
  trustedSources: TrustedSource[]
  newTrustedSource: Pick<TrustedSource, 'name' | 'baseUrl' | 'lyricsSelector'>
}>()
const emit = defineEmits<{
  add: []
  save: [source: TrustedSource]
  toggle: [source: TrustedSource]
  remove: [source: TrustedSource]
}>()
</script>

<template>
<section class="card trusted-source-card">
    <div class="card-heading">
        <div>
            <p class="eyebrow">TRUSTED LYRIC SOURCES</p>
            <h2>Allowed lookup sites</h2>
        </div>
    </div>
    <p class="muted">Only page URLs from enabled sources can be fetched and auto-formatted.</p>
    <p class="muted" id="lyrics-selector-help">Set a lyrics CSS selector such as #at_fulltext or .hymn-content to import only that part of the page. Leave it blank for automatic extraction. If a selector does not match, lookup will ask you to paste the lyrics.</p>
    <ul class="trusted-source-list">
        <li v-for="source in trustedSources" :key="source.id">
            <div class="trusted-source-fields">
                <input
                    v-model="source.name"
                    aria-label="Source name"
                    @change="emit('save', source)"
                /><input
                    v-model="source.baseUrl"
                    type="url"
                    aria-label="Source URL"
                    @change="emit('save', source)"
                />
                <input
                    v-model="source.lyricsSelector"
                    class="lyrics-selector-input"
                    aria-label="Lyrics CSS selector"
                    aria-describedby="lyrics-selector-help"
                    placeholder="Lyrics CSS selector (optional)"
                    maxlength="500"
                    @change="emit('save', source)"
                />
            </div>
            <div class="row-actions">
                <label class="toggle-row"
                    ><input
                        type="checkbox"
                        :checked="source.enabled"
                        :aria-label="`Allow lookups from ${source.name}`"
                        @change="emit('toggle', source)"
                    />{{ source.enabled ? "Enabled for lookup" : "Disabled for lookup" }}</label
                ><button aria-label="Remove source" @click="emit('remove', source)">×</button>
            </div>
        </li>
    </ul>
    <form class="trusted-source-form" @submit.prevent="emit('add')">
        <input v-model="newTrustedSource.name" placeholder="Source name" /><input
            v-model="newTrustedSource.baseUrl"
            type="url"
            placeholder="https://example.org/"
        /><input
            v-model="newTrustedSource.lyricsSelector"
            aria-label="Lyrics CSS selector for new source"
            aria-describedby="lyrics-selector-help"
            placeholder="Lyrics CSS selector (optional)"
            maxlength="500"
        /><button class="secondary-button">Add source</button>
    </form>
</section>
</template>

<style scoped>
.trusted-source-card { margin-top: 1.25rem; }
</style>
