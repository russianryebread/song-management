import { createRouter, createWebHistory } from 'vue-router'

const EmptyRoute = { template: '<div />' }

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'dashboard', component: EmptyRoute },
    { path: '/library', name: 'library', component: EmptyRoute },
    { path: '/library/new', name: 'song-new', component: EmptyRoute },
    { path: '/library/:songId', name: 'song-edit', component: EmptyRoute },
    { path: '/meetings', name: 'meetings', component: EmptyRoute },
    { path: '/meetings/:meetingId', name: 'meeting-edit', component: EmptyRoute },
    { path: '/history', name: 'history', component: EmptyRoute },
    { path: '/settings', name: 'settings', component: EmptyRoute },
    { path: '/present/:viewToken', name: 'presenter', component: EmptyRoute },
  ],
})
