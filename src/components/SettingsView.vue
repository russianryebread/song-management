<script setup lang="ts">
import type { AppSettings, UserAccount } from '../api'

defineProps<{
  settings: AppSettings
  users: UserAccount[]
  currentUserId?: string
  busy: boolean
}>()
const emit = defineEmits<{
  save: []
  addUser: [value: { email: string; password: string }]
  removeUser: [user: UserAccount]
}>()

function submitNewUser(event: Event) {
  const form = event.currentTarget as HTMLFormElement
  const data = new FormData(form)
  emit('addUser', { email: String(data.get('email') ?? ''), password: String(data.get('password') ?? '') })
  form.reset()
}
</script>

<template>
  <header class="page-header"><div><p class="eyebrow">SETTINGS</p><h1>Songbook settings</h1><p class="muted">Set the group identity, projector defaults, and administrator access.</p></div></header>
  <div class="settings-grid">
    <form class="card form-card" @submit.prevent="emit('save')">
      <div><p class="eyebrow">GENERAL</p><h2>Default experience</h2></div>
      <label>Group name <input v-model="settings.groupName" maxlength="100" required /></label>
      <label>Default lyric size <input v-model.number="settings.defaultTextScale" type="range" min="0.75" max="1.35" step="0.05" /><small>{{ Math.round(settings.defaultTextScale * 100) }}%</small></label>
      <label>Projector font
        <select v-model="settings.defaultPresenterFont">
          <option value="libre-baskerville">Libre Baskerville</option>
          <option value="inter">Inter</option>
          <option value="raleway">Raleway</option>
        </select>
      </label>
      <label class="toggle-row"><input v-model="settings.defaultRepeatChorus" type="checkbox" /> Repeat each song’s chorus after every verse</label>
      <label class="toggle-row"><input v-model="settings.defaultShowSlideCount" type="checkbox" /> Show slide count in the presenter</label>
      <button class="button" :disabled="busy">Save settings</button>
    </form>
    <section class="card form-card">
      <div><p class="eyebrow">USERS</p><h2>Administrators</h2></div>
      <ul class="user-list"><li v-for="user in users" :key="user.id"><div><strong>{{ user.email }}</strong><small>Administrator account</small></div><button class="text-button" :disabled="user.id === currentUserId" @click="emit('removeUser', user)">{{ user.id === currentUserId ? 'Current user' : 'Remove' }}</button></li></ul>
      <form class="new-user-form" @submit.prevent="submitNewUser">
        <label>Email <input name="email" type="email" required /></label>
        <label>Temporary password <input name="password" type="password" minlength="12" required /></label>
        <button class="secondary-button" :disabled="busy">Add administrator</button>
      </form>
    </section>
  </div>
</template>
