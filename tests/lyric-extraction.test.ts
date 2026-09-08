import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import { build } from 'esbuild'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'

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
            return app.fetch(request, { DB });
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
    assert.equal(defaults.find((source: any) => source.id === 'trusted-hymnal-net').lyricsSelector, '.hymn-content')
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
