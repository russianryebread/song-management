import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import app, { onlyUsesSourceWords, formatLyricsWithAi, fetchTrustedText } from '../src/worker'
import { normalizeLyricsDraft, validateSectionedLyrics } from '../src/shared/lyrics'

function fixture() {
  const sqlite = new DatabaseSync(':memory:')
  for (const file of readdirSync('migrations').sort()) sqlite.exec(readFileSync(`migrations/${file}`, 'utf8'))
  sqlite.exec("INSERT INTO users VALUES ('admin', 'test@example.org', '', '2026-01-01')")
  sqlite.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?)').run('session', 'admin', createHash('sha256').update('test').digest('hex'), '2099-01-01', '2026-01-01')
  const insert = sqlite.prepare("INSERT INTO songs (id, title, normalized_title, dedupe_key, hymn_number, lyrics_text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, '', '')")
  for (let i = 0; i < 270; i++) insert.run(`song-${i}`, `Song ${String(i).padStart(3, '0')}`, `song ${String(i).padStart(3, '0')}`, `key-${i}`, String(i), i === 269 ? '[verse 1]\nUnique river of hope' : i % 2 ? '[verse 1]\nA lyric line' : '')
  sqlite.exec("INSERT INTO meetings VALUES ('historic', '2020-01-01', 'History', 'past', '', NULL, NULL, '', '')")
  sqlite.exec("INSERT INTO meeting_songs VALUES ('ms', 'historic', 'song-269', 0, '')")
  sqlite.exec("INSERT INTO meeting_slides VALUES ('slide1', 'ms', 0, 'title', NULL, '[\"Title\"]', '', '')")
  sqlite.exec("INSERT INTO meeting_slides VALUES ('slide2', 'ms', 1, 'lyrics', NULL, '[\"Lyrics\"]', '', '')")
  const DB = { prepare(sql: string) {
    let values: any[] = []
    const statement = { bind(...args: any[]) { values = args; return statement }, async first() { return sqlite.prepare(sql).get(...values) ?? null }, async all() { return { results: sqlite.prepare(sql).all(...values) } }, async run() { return { meta: { changes: sqlite.prepare(sql).run(...values).changes } } } }
    return statement
  }, async batch(statements: any[]) { return Promise.all(statements.map(s => s.run())) } }
  async function request(path: string, body?: object) {
    const response = await app.request(`http://localhost${path}`, { method: body ? 'POST' : 'GET', headers: { Cookie: 'song_session=test', 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }, { DB } as any)
    return { status: response.status, body: await response.json() as any }
  }
  return { sqlite, request }
}

test('full-library search, usage filters, lyrics filters, sorting and page bounds', async () => {
  const { sqlite, request } = fixture()
  try {
    const search = await request('/api/songs?q=hope%20river')
    assert.equal(search.body.total, 1)
    assert.equal(search.body.songs[0].id, 'song-269')
    assert.equal((await request('/api/songs?filter=used')).body.total, 1)
    assert.equal((await request('/api/songs?filter=unused')).body.total, 269)
    assert.equal((await request('/api/songs?filter=recent')).body.total, 1)
    assert.equal((await request('/api/songs?lyrics=missing')).body.total, 135)
    assert.equal((await request('/api/songs?q=%25')).body.total, 0)
    assert.equal((await request('/api/songs?sort=number')).body.songs[2].hymnNumber, '2')
    const last = await request('/api/songs?page=999&pageSize=25')
    assert.equal(last.body.page, 11)
    assert.equal(last.body.songs.length, 20)
  } finally { sqlite.close() }
})

test('historic meeting usage matches library, without multiplying counts by slides', async () => {
  const { sqlite, request } = fixture()
  try {
    const meeting = (await request('/api/meetings/historic')).body
    const song = (await request('/api/songs/song-269')).body.song
    assert.equal(meeting.songs[0].useCount, 1)
    assert.equal(meeting.songs[0].lastUsed, '2020-01-01')
    assert.equal(meeting.songs[0].useCount, song.useCount)
    assert.equal(meeting.songs[0].slides.length, 2)
  } finally { sqlite.close() }
})

test('lookup accepts the unsaved editor URL and explains missing or disabled sources', async () => {
  const { sqlite, request } = fixture()
  try {
    const result = await request('/api/songs/song-269/find-lyrics', { sourceUrl: 'https://www.hymnary.org/text/example' })
    assert.equal(result.body.candidates.length, 1)
    assert.equal(result.body.candidates[0].sourceUrl, 'https://www.hymnary.org/text/example')
    assert.match((await request('/api/songs/song-269/find-lyrics', {})).body.message, /direct song page/)
    sqlite.exec('UPDATE trusted_sources SET enabled = 0')
    assert.match((await request('/api/songs/song-269/find-lyrics', { sourceUrl: 'https://hymnary.org/text/example' })).body.message, /No lookup sites are enabled/)
  } finally { sqlite.close() }
})

test('unsaved songs format without requiring a song ID', async () => {
  const { sqlite, request } = fixture()
  try {
    const result = await request('/api/format-text', { title: 'Draft', sourceText: 'Verse 1:\nFirst line\nSecond line\n\nChorus:\nSing again' })
    assert.equal(result.status, 200)
    assert.equal(result.body.provider, 'deterministic-draft')
    assert.match(result.body.lyricsText, /\[chorus\]/)
    assert.deepEqual(validateSectionedLyrics(result.body.lyricsText).errors, [])
  } finally { sqlite.close() }
})

test('formatting preserves order, repeated words, non-Latin words, and explicit sections', async () => {
  const source = 'Verse 1:\nHello hello world\nПривет мир\n\nChorus:\nSing again'
  const formatted = normalizeLyricsDraft(source)
  assert.ok(onlyUsesSourceWords(formatted, source))
  assert.ok(!onlyUsesSourceWords(formatted.replace('Hello hello world', 'world Hello hello'), source))
  assert.ok(!onlyUsesSourceWords(formatted.replace('Привет', 'Пока'), source))
  assert.ok(!onlyUsesSourceWords(formatted.replace('Hello hello', 'Hello'), source))
  assert.equal(await formatLyricsWithAi({ run: async () => ({ response: formatted }) }, 'Title', source), formatted)
  assert.equal(await formatLyricsWithAi({ run: async () => ({ response: '[verse]\nInvented lyrics' }) }, 'Title', source), null)
  assert.equal(await formatLyricsWithAi({ run: async () => { throw new Error('unavailable') } }, 'Title', source), null)
})

test('fallback keeps eight-line verses intact and cleans redundant slide breaks', () => {
  const source = '1. One\nTwo\nThree\nFour\nFive\nSix\nSeven\nEight'
  assert.ok(!normalizeLyricsDraft(source).includes('chorus'))
  assert.ok(normalizeLyricsDraft('Chorus of angels sing').includes('Chorus of angels sing'))
  assert.ok(normalizeLyricsDraft('1234 people sing').includes('1234 people sing'))
  assert.deepEqual(validateSectionedLyrics(normalizeLyricsDraft('[verse 1]\na\nb\nc\nd\n|||\ne')).errors, [])
})

test('lookup checks redirects before fetching a disallowed destination', async () => {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => { calls++; return new Response(null, { status: 302, headers: { location: 'https://unapproved.example/lyrics' } }) }
  try {
    await assert.rejects(fetchTrustedText('https://hymnary.org/text/example', [{ id: 'h', name: 'Hymnary', base_url: 'https://hymnary.org', enabled: 1, lyrics_selector: '#at_fulltext' }]), /not enabled/)
    assert.equal(calls, 1)
  } finally { globalThis.fetch = original }
})
