import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as Vue from 'vue'
import { compile } from '@vue/compiler-dom'
import { parseLyrics } from '../src/lyrics'
import { normalizeLyricsDraft, parseSectionedLyrics, validateSectionedLyrics } from '../src/shared/lyrics'

const lyricSlides = (text: string) => parseSectionedLyrics(text).slides.filter(slide => slide.kind === 'lyrics')

test('line endings and surrounding whitespace preserve individual lyric lines', () => {
  for (const newline of ['\n', '\r\n', '\r', '\u0085', '\u2028', '\u2029']) {
    const source = [' \t[verse 1]\u00a0', '  One\t two  ', '\tThree\u00a0', '四'].join(newline)
    assert.deepEqual(lyricSlides(source), [{ kind: 'lyrics', section: 'verse 1', lines: ['One\t two', 'Three', '四'] }])
    assert.deepEqual(parseLyrics(' Title ', source), parseSectionedLyrics(source, ' Title ').slides)
  }
})

test('blank stanzas, headings, and explicit breaks separate slides without empty slides', () => {
  for (const boundary of ['\n\n', '\n \t\u00a0\n', '\n\n\n', '\n|||\n', '\n|||\n|||\n']) {
    assert.deepEqual(lyricSlides(`\n|||\n[verse 1]\nOne\nTwo${boundary}Three\nFour\n|||\n\n`), [
      { kind: 'lyrics', section: 'verse 1', lines: ['One', 'Two'] },
      { kind: 'lyrics', section: 'verse 1', lines: ['Three', 'Four'] },
    ])
  }
  assert.deepEqual(lyricSlides('[verse 1]\nOne\n[chorus]\n[bridge]\nTwo'), [
    { kind: 'lyrics', section: 'verse 1', lines: ['One'] },
    { kind: 'lyrics', section: 'bridge', lines: ['Two'] },
  ])
})

test('automatic four-line splits and redundant boundaries preserve every occurrence in order', () => {
  for (let count = 1; count <= 33; count++) {
    const lines = Array.from({ length: count }, (_, i) => i % 3 === 0 ? 'Repeated lyric' : `Line ${i}`)
    for (const suffix of ['', '\n|||', '\n\n|||\n|||']) {
      const source = `[verse 1]\n${lines.join('\n')}${suffix}`
      const parsed = validateSectionedLyrics(source)
      assert.deepEqual(parsed.errors, [])
      assert.deepEqual(parsed.slides.flatMap(slide => slide.lines), lines)
      assert.equal(parsed.slides.length, Math.ceil(count / 4))
      assert.ok(parsed.slides.every(slide => slide.lines.length <= 4 && slide.section === 'verse 1'))
    }
  }
})

test('empty lyrics and malformed headers report errors without interpreting lyric punctuation', () => {
  for (const text of ['', ' \t\u00a0\n', '|||\n|||', '[verse 1]\n[chorus]']) {
    assert.deepEqual(validateSectionedLyrics(text).errors, ['Add at least one lyric line.'])
  }
  assert.match(validateSectionedLyrics('[  ]\nOne').errors[0], /section headers cannot be empty/)
  assert.deepEqual(lyricSlides('Love [forever]\n[unfinished\nSing ||| again')[0].lines, ['Love [forever]', '[unfinished', 'Sing ||| again'])
})

test('draft normalization and direct parsing agree on stanza boundaries', () => {
  for (let count = 1; count <= 12; count++) {
    const source = `[verse 1]\n${Array.from({ length: count }, (_, i) => `Line ${i}`).join('\n')}\n \t\nAgain\nAgain\n[chorus]\nSing`
    const normalized = normalizeLyricsDraft(source)
    assert.deepEqual(lyricSlides(normalized), lyricSlides(source))
    assert.equal(normalizeLyricsDraft(normalized), normalized)
  }
})

test('actual preview template updates repeated lines without stale or duplicated DOM nodes', async () => {
  // Exercise Vue reconciliation with the template used by the song editor.
  const source = readFileSync('src/App.vue', 'utf8')
  const template = source.match(/<div class="slide-thumbnails">[\s\S]*?<\/div>/)![0]
  const render = new Function('Vue', compile(template, { mode: 'function', prefixIdentifiers: true }).code)(Vue)
  type HostNode = { text: string; children: HostNode[]; parent?: HostNode }
  const node = (): HostNode => ({ text: '', children: [] })
  const renderer = Vue.createRenderer<HostNode, HostNode>({
    createElement: node, createText: text => ({ text, children: [] }), createComment: node,
    setText: (el, text) => { el.text = text }, setElementText: (el, text) => { el.text = text; el.children = [] },
    parentNode: el => el.parent ?? null,
    nextSibling: el => el.parent?.children[el.parent.children.indexOf(el) + 1] ?? null,
    patchProp() {},
    insert(el, parent, anchor) {
      if (el.parent) el.parent.children.splice(el.parent.children.indexOf(el), 1)
      const index = anchor ? parent.children.indexOf(anchor) : -1
      parent.children.splice(index < 0 ? parent.children.length : index, 0, el)
      el.parent = parent
    },
    remove(el) { if (el.parent) el.parent.children.splice(el.parent.children.indexOf(el), 1) },
  })
  const lyrics = Vue.ref('Again\nAgain\nEnd')
  const title = Vue.ref('Original')
  const root = node()
  const app = renderer.createApp({ setup: () => ({ slidePreview: Vue.computed(() => parseLyrics(title.value, lyrics.value)) }), render })
  app.mount(root)
  const texts = (el: HostNode): string[] => [el.text, ...el.children.flatMap(texts)].filter(Boolean)
  for (const next of ['Again\nEnd\nAgain\nAgain', 'End\nAgain', 'Again\nAgain\n\nEnd', 'One\r\nTwo']) {
    lyrics.value = next
    title.value = 'Updated'
    await Vue.nextTick()
    assert.deepEqual(texts(root), parseLyrics('Updated', next).flatMap(slide => slide.lines))
  }
  app.unmount()
})
