import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import { build } from 'esbuild'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'

const hymnalUrl = 'https://www.hymnal.net/en/hymn/h/3'
const verses = [
  ['Come, Thou Almighty King,', 'Help us Thy name to sing,', 'Help us to praise.', 'Father, all glorious,', 'O’er all victorious,', 'Come, and reign over us,', 'Ancient of Days.'],
  ['Come, Thou incarnate Word,', 'Gird on Thy mighty sword,', 'Our prayer attend:', 'Come, and Thy people bless,', 'And give Thy word success;', 'Spirit of holiness,', 'On us descend.'],
  ['Come, holy Comforter,', 'Thy sacred witness bear', 'In this glad hour:', 'Thou who Almighty art,', 'Now rule in every heart,', 'And ne’er from us depart,', 'Spirit of power.'],
  ['To Thee, great One in Three,', 'Eternal praises be', 'Hence evermore.', 'Thy sov’reign majesty', 'May we in glory see,', 'And to eternity', 'Love and adore.'],
]
const hymnalHtml = `<div class="hymn-content"><article class="js-stanzas">${verses.map((lines, index) => `
  <div data-type="verse" class="verse">
    <div class="verse-num"><span>${index + 1}</span></div>
    <div class="text-container">${lines.join('<br>').replaceAll('’', '&#8217;')}</div>
    <div class="chord-container hidden">${lines.join('<br>')}</div>
    <div class="chord-container repeat-chord-container hidden"><span class="chord">D</span>${lines[0]}</div>
  </div>`).join('')}</article><div>Sheet · About Numbered Notation</div></div>`

test('trusted lookup extracts hymn containers in the Workers HTML parser', async (t) => {
  const bundle = await build({
    stdin: {
      contents: `import app, { fetchTrustedText } from './src/worker';
        export default { async fetch(request, env) {
          if (new URL(request.url).pathname.startsWith('/api/')) {
            const DB = { prepare(sql) {
              let values = [];
              const query = async (mode) => {
                const response = await env.TEST_DB.fetch('https://db.test', { method: 'POST', body: JSON.stringify({ sql, values, mode }) });
                return response.json();
              };
              const statement = { bind(...args) { values = args; return statement },
                first() { return sql.includes('FROM sessions') ? Promise.resolve({ user_id: 'admin' }) : query('first') },
                all() { return query('all') }, run() { return query('run') } };
              return statement;
            } };
            globalThis.fetch = async (url) => {
              if (url !== ${JSON.stringify(hymnalUrl)}) throw new Error('Unexpected URL');
              return new Response(${JSON.stringify(hymnalHtml)}, { headers: { 'content-type': 'text/html' } });
            };
            return app.fetch(request, { DB, AI: { run: async () => ({ response: '[verse 1]\\nAncient of Days.' }) } });
          }
          const { url, pages } = await request.json();
          globalThis.fetch = async (url) => {
            const page = pages[url];
            return new Response(page.body ?? null, { status: page.status ?? 200,
              headers: { 'content-type': page.type ?? 'text/html', ...(page.location ? { location: page.location } : {}) } });
          };
          try {
            const sources = Object.entries(pages).map(([url, page]) => ({ id: url, name: url, base_url: url, enabled: 1, lyrics_selector: page.selector ?? '' }));
            return new Response(await fetchTrustedText(url, sources));
          } catch (error) { return new Response(error.message, { status: 422 }); }
        } };`,
      resolveDir: process.cwd(),
    },
    bundle: true, write: false, format: 'esm', platform: 'browser',
  })
  const sqlite = new DatabaseSync(':memory:')
  for (const file of readdirSync('migrations').sort()) sqlite.exec(readFileSync(`migrations/${file}`, 'utf8'))
  const runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-08-11',
    serviceBindings: { TEST_DB: async (request) => {
      const { sql, values, mode } = await request.json() as { sql: string; values: string[]; mode: string }
      const statement = sqlite.prepare(sql)
      const result = mode === 'first' ? statement.get(...values) ?? null
        : mode === 'all' ? { results: statement.all(...values) }
        : { meta: { changes: statement.run(...values).changes } }
      return new Response(JSON.stringify(result))
    } },
  }))
  t.after(() => sqlite.close())
  t.after(() => runtime.dispose())
  async function lookup(url: string, pages: Record<string, object>) {
    return runtime.dispatchFetch('https://test.example', { method: 'POST', body: JSON.stringify({ url, pages }) })
  }
  const lyrics = '<div>First <em>lovely</em> line<br>Second line &amp; joy &#8217;</div><p>Another verse of hope<br>Last line of the hymn</p>'
  const expected = 'First lovely line\nSecond line & joy ’\nAnother verse of hope\nLast line of the hymn'
  for (const [host, attribute, selector] of [
    ['hymnary.net', 'id="at_fulltext"', '#at_fulltext'],
    ['www.hymnary.org', "id='at_fulltext'", '#at_fulltext'],
    ['hymnallibrary.org', 'class="card hymn-main-card active"', '.hymn-main-card'],
    ['www.hymnal.net', 'class="hymn-content"', '.hymn-content'],
  ]) {
    await t.test(host, async () => {
      const url = `https://${host}/hymn/example`
      const body = `<nav>1. Browse songs and other navigation</nav><main ${attribute}>${lyrics}
        <script>unwanted script</script><style>unwanted style</style><!-- unwanted comment -->
        <div hidden><span>hidden controls</span></div><button>Copy lyrics</button></main>
        <footer>More songs, comments, and copyright information</footer>`
      const response = await lookup(url, { [url]: { body, selector } })
      assert.equal(response.status, 200)
      assert.equal(await response.text(), expected)
    })
  }
  const url = 'https://hymnal.net/hymn/example'
  for (const body of ['<main>1. Plenty of unrelated page content here</main>', '<div class="hymn-content"></div>']) {
    const response = await lookup(url, { [url]: { body, selector: '.hymn-content' } })
    assert.equal(response.status, 422)
    assert.match(await response.text(), /could not be found|No usable lyric/)
  }
  const redirected = await lookup('https://hymnary.org/start', {
    'https://hymnary.org/start': { status: 302, location: url },
    [url]: { selector: '.hymn-content', body: `<div class="hymn-content">${lyrics}</div><p>Outside text</p>` },
  })
  assert.equal(await redirected.text(), expected)
  const plain = '1. First line of the hymn\nSecond line of the hymn'
  assert.equal(await (await lookup(url, { [url]: { body: plain, type: 'text/plain' } })).text(), plain)
  const custom = 'https://custom.example/hymn'
  assert.equal(await (await lookup(custom, { [custom]: { selector: 'article > .lyrics', body: `<nav>Navigation</nav><article><div class="lyrics">${lyrics}</div></article><footer>Footer</footer>` } })).text(), expected)
  const other = 'https://other.example/hymn'
  assert.equal(await (await lookup(other, { [other]: { body: `<nav>Menu</nav><p>${plain}</p>` } })).text(), plain)
  await t.test('Hymnal.net imports every plain stanza without AI cleanup', async () => {
    const response = await runtime.dispatchFetch('https://test.example/api/use-lyric-candidate', {
      method: 'POST',
      headers: { Cookie: 'song_session=test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Come, Thou Almighty King', sourceUrl: hymnalUrl }),
    })
    assert.equal(response.status, 200)
    assert.equal((await response.json() as { lyricsText: string }).lyricsText,
      verses.map((lines, index) => `[verse ${index + 1}]\n${lines.join('\n')}`).join('\n'))
  })
  await t.test('Hymnal.net retains a labeled chorus and its repeated lines', async () => {
    const selector = sqlite.prepare("SELECT lyrics_selector FROM trusted_sources WHERE id = 'trusted-hymnal-net'").get()?.lyrics_selector
    const chorus = '<div class="text-container" data-label="Chorus">Sing again<br>Sing again</div>'
    const body = `<div class="hymn-content"><article class="js-stanzas">
      <div class="verse">${chorus}</div>
      <div class="verse js-duplicate-row hidden">${chorus}</div>
    </article></div>`
    const response = await lookup(hymnalUrl, { [hymnalUrl]: { body, selector } })
    assert.equal(response.status, 200)
    assert.equal(await response.text(), 'Chorus\nSing again\nSing again')
  })
  await t.test('selector settings persist, validate, clear, and survive enable changes', async () => {
    async function settings(path: string, method = 'GET', body?: object) {
      const response = await runtime.dispatchFetch(`https://test.example/api/trusted-sources${path}`, {
        method, headers: { Cookie: 'song_session=test', 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
      return { status: response.status, body: await response.json() as any }
    }
    const defaults = (await settings('')).body.sources
    assert.equal(defaults.find((source: any) => source.id === 'trusted-hymnary').lyricsSelector, '#at_fulltext')
    assert.match(defaults.find((source: any) => source.id === 'trusted-hymnal-net').lyricsSelector, /\.text-container$/)
    const created = await settings('', 'POST', { name: 'Custom', baseUrl: 'https://custom.example', lyricsSelector: '  article > .lyrics  ' })
    assert.equal(created.status, 201)
    assert.equal(created.body.source.lyricsSelector, 'article > .lyrics')
    const path = '/' + created.body.source.id
    const disabled = await settings(path, 'PATCH', { enabled: false })
    assert.equal(disabled.body.source.lyricsSelector, 'article > .lyrics')
    assert.equal(disabled.body.source.enabled, false)
    assert.equal((await settings(path, 'PATCH', { lyricsSelector: '#replacement' })).body.source.lyricsSelector, '#replacement')
    for (const lyricsSelector of ['div > > span', 42, 'x'.repeat(501)]) {
      assert.equal((await settings(path, 'PATCH', { lyricsSelector })).status, 400)
      assert.equal((await settings('', 'POST', { name: 'Bad', baseUrl: 'https://bad.example', lyricsSelector })).status, 400)
    }
    assert.equal((await settings('')).body.sources.find((source: any) => source.id === created.body.source.id).lyricsSelector, '#replacement')
    assert.equal((await settings(path, 'PATCH', { lyricsSelector: '' })).body.source.lyricsSelector, '')
    assert.equal(sqlite.prepare('SELECT lyrics_selector FROM trusted_sources WHERE id = ?').get(created.body.source.id)?.lyrics_selector, '')
    assert.equal((await settings('', 'POST', { name: 'Automatic', baseUrl: 'https://automatic.example' })).body.source.lyricsSelector, '')
  })
})
