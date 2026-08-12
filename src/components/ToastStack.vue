<script setup lang="ts">
defineProps<{ notice: string; error: string }>()
const emit = defineEmits<{ clearNotice: []; clearError: [] }>()
</script>

<template>
  <div class="toast-stack" aria-live="polite">
    <div v-if="error" class="toast toast-error"><span>{{ error }}</span><button @click="emit('clearError')">×</button></div>
    <div v-if="notice" class="toast"><span>{{ notice }}</span><button @click="emit('clearNotice')">×</button></div>
  </div>
</template>
