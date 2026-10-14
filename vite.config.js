import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { execFileSync } from 'node:child_process'

function buildCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return process.env.CF_PAGES_COMMIT_SHA || process.env.GITHUB_SHA || 'Unknown'
  }
}

export default defineConfig({
  plugins: [vue()],
  define: { __BUILD_COMMIT__: JSON.stringify(buildCommit()) },
  build: { outDir: 'dist', emptyOutDir: true },
})
