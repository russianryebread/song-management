<script setup lang="ts">
import { computed, ref } from 'vue'
const props = defineProps<{ modelValue: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
const overlay = ref<HTMLElement>()
const lines = computed(() => props.modelValue.split('\n').map(text => ({
  text,
  kind: /^\s*\[[^\]\r\n]+\]\s*$/.test(text) ? 'section' : text.trim() === '|||' ? 'break' : '',
})))
function sync(event: Event) {
  const input = event.target as HTMLTextAreaElement
  if (overlay.value) { overlay.value.scrollTop = input.scrollTop; overlay.value.scrollLeft = input.scrollLeft }
}
</script>

<template>
  <div class="lyrics-editor">
    <pre ref="overlay" aria-hidden="true"><template v-for="(line, index) in lines" :key="index"><span :class="line.kind">{{ line.text }}</span>{{ '\n' }}</template></pre>
    <textarea :value="modelValue" aria-label="Lyrics" rows="20" wrap="off" spellcheck="false"
      placeholder="[verse 1]&#10;One displayed line per row&#10;|||&#10;A forced new slide"
      @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)" @scroll="sync" />
  </div>
</template>

<style scoped>
.lyrics-editor { position: relative; width: 100%; }
.lyrics-editor pre, .lyrics-editor textarea {
  margin: 0; padding: 12px; border: 1px solid transparent; border-radius: 8px;
  font: 14px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  letter-spacing: normal; tab-size: 4; white-space: pre; box-sizing: border-box;
}
.lyrics-editor pre { position: absolute; inset: 0; overflow: hidden; pointer-events: none; color: #263445; }
.lyrics-editor textarea { position: relative; display: block; width: 100%; resize: vertical; overflow: auto; background: transparent; color: transparent; caret-color: #263445; border-color: #cbd5e1; }
.lyrics-editor textarea::placeholder { color: #738094; }
.section { color: #166d83; }
.break { color: #a45a16; }
@media (forced-colors: active) {
  .lyrics-editor pre { display: none; }
  .lyrics-editor textarea { color: CanvasText; caret-color: CanvasText; }
}
</style>
