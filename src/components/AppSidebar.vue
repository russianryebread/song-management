<script setup lang="ts">
type Page = 'dashboard' | 'library' | 'meetings' | 'history' | 'settings'

defineProps<{ page: Page; groupName: string }>()
const emit = defineEmits<{ navigate: [page: Page]; logout: [] }>()
</script>

<template>
  <aside class="sidebar">
    <div class="brand"><span>♪</span><div><strong>Songbook</strong><small>{{ groupName }}</small></div></div>
    <nav aria-label="Main navigation">
      <button :class="{ active: page === 'dashboard' }" @click="emit('navigate', 'dashboard')">Dashboard</button>
      <button :class="{ active: page === 'library' }" @click="emit('navigate', 'library')">Song library</button>
      <button :class="{ active: page === 'meetings' }" @click="emit('navigate', 'meetings')">Meetings</button>
      <button :class="{ active: page === 'history' }" @click="emit('navigate', 'history')">Meeting History</button>
      <button :class="{ active: page === 'settings' }" @click="emit('navigate', 'settings')">Settings</button>
    </nav>
    <button class="logout" @click="emit('logout')">Sign out</button>
  </aside>
</template>
