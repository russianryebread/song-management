import { Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { normalizeLyricsDraft, validateSectionedLyrics, type LyricSlide } from './shared/lyrics'

export type Bindings = {
  DB: D1Database
  ASSETS?: { fetch(request: Request | string): Promise<Response> }
  ADMIN_PASSWORD?: string
  ADMIN_EMAIL?: string
  SESSION_DAYS?: string
  AI?: AiBinding
}

type Variables = { userId: string }
type App = Hono<{ Bindings: Bindings; Variables: Variables }>
type JsonRecord = Record<string, unknown>
type AiBinding = { run(model: string, inputs: Record<string, unknown>): Promise<unknown> }

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()
const encoder = new TextEncoder()
const sessionCookie = 'song_session'
const day = 86_400_000

function jsonError(c: any, message: string, status?: 400 | 401 | 404 | 409 | 422 | 501) {
  return c.json({ error: message }, status)
}

function stringField(value: unknown, field: string, { required = false, max = 20_000 } = {}): string | null {
  if (value == null) return required ? null : ''
  if (typeof value !== 'string') return null
  const result = value.trim()
  if ((required && !result) || result.length > max) return null
  return result
}

async function readJson(c: any): Promise<JsonRecord | null> {
  try {
    const body = await c.req.json()
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null
  } catch {
    return null
  }
}

function id(): string {
  return crypto.randomUUID()
}

function token(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value))
  return Array.from(new Uint8Array(digest), (part) => part.toString(16).padStart(2, '0')).join('')
}

// PBKDF2 is available in Workers Web Crypto and keeps bootstrap authentication self-contained.
async function passwordHash(password: string, salt = token()): Promise<string> {
  const baseKey = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: encoder.encode(salt), iterations: 310_000 },
    baseKey,
    256,
  )
  const encoded = btoa(String.fromCharCode(...new Uint8Array(bits)))
  return `pbkdf2-sha256$310000$${salt}$${encoded}`
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algorithm, iterations, salt, expected] = stored.split('$')
  if (algorithm !== 'pbkdf2-sha256' || iterations !== '310000' || !salt || !expected) return false
  const actual = await passwordHash(password, salt)
  return timingSafeEqual(actual, stored)
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let difference = 0
  for (let index = 0; index < a.length; index++) difference |= a.charCodeAt(index) ^ b.charCodeAt(index)
  return difference === 0
}

async function currentUser(c: any): Promise<string | null> {
  const sessionToken = getCookie(c, sessionCookie)
  if (!sessionToken) return null
  const hash = await sha256(sessionToken)
  const result = await c.env.DB.prepare(
    'SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > ? LIMIT 1',
  ).bind(hash, new Date().toISOString()).first() as { user_id: string } | null
  return result?.user_id ?? null
}

async function requireAuth(c: any, next: () => Promise<void>) {
  const userId = await currentUser(c)
  if (!userId) return jsonError(c, 'Authentication required.', 401)
  c.set('userId', userId)
  await next()
}

function serializeSong(row: any) {
  return {
    id: row.id,
    hymnNumber: row.hymn_number,
    title: row.title,
    sourceUrl: row.source_url,
    lyricsSourceName: row.lyrics_source_name,
    lyricsFormat: row.lyrics_format,
    lyricsText: row.lyrics_text,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    useCount: Number(row.use_count ?? 0),
    lastUsed: row.last_used_at ?? null,
    last_used: row.last_used_at ?? null,
  }
}

function parseLines(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4 || value.some((line) => typeof line !== 'string' || !line.trim())) return null
  return value.map((line) => line.trim())
}

function normalizeTitle(title: string): string {
  return title.toLocaleLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
}

function songDedupeKey(title: string, hymnNumber: string | null): string {
  return `${hymnNumber ?? ''}|${normalizeTitle(title)}`
}

function words(text: string): string[] {
  return text.toLocaleLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').match(/[a-z0-9]+/g) ?? []
}

function onlyUsesSourceWords(candidate: string, source: string): boolean {
  const lyricOnly = (text: string) => text.split(/\r?\n/).filter((line) => !/^\s*(?:\[[^\]]+\]|\|\|\|)\s*$/.test(line)).join('\n')
  const counts = (text: string) => words(text).reduce((result, word) => {
    result.set(word, (result.get(word) ?? 0) + 1)
    return result
  }, new Map<string, number>())
  const candidateCounts = counts(lyricOnly(candidate))
  const sourceCounts = counts(lyricOnly(source))
  if (candidateCounts.size !== sourceCounts.size) return false
  return [...sourceCounts].every(([word, count]) => candidateCounts.get(word) === count)
}

async function formatLyricsWithAi(ai: AiBinding | undefined, title: string, sourceText: string): Promise<string | null> {
  if (!ai) return null
  const prompt = `Convert the supplied lyrics into the sectioned-v1 song format. Return ONLY the formatted plain text.\n\nRules:\n- Do not add, remove, or change lyric words.\n- Use [verse 1], [chorus 1], [bridge], etc. for clear sections.\n- Preserve original lyric line breaks where practical.\n- A standalone ||| may force a slide break, but use it sparingly.\n- No explanatory prose or Markdown fences.\n- The parser displays at most four lines per slide.\n\nTitle: ${title}\n\nLyrics:\n${sourceText}`
  try {
    const result = await ai.run('@cf/meta/llama-3.1-8b-instruct-fast', {
      messages: [
        { role: 'system', content: 'You format hymn lyrics precisely and never invent text.' },
        { role: 'user', content: prompt },
      ],
      max_tokens: 4096,
    }) as { response?: string }
    const text = result.response?.replace(/^```(?:text)?\s*/i, '').replace(/\s*```$/, '').trim()
    if (!text || !onlyUsesSourceWords(text, sourceText)) return null
    const validation = validateSectionedLyrics(text, title)
    return validation.errors.length ? null : text
  } catch {
    // Formatting remains usable when Workers AI is disabled, unavailable, or rate-limited.
    return null
  }
}

async function insertSlides(db: D1Database, meetingSongId: string, slides: LyricSlide[]): Promise<void> {
  const now = new Date().toISOString()
  const statements = slides.map((slide, position) =>
    db.prepare(
      'INSERT INTO meeting_slides (id, meeting_song_id, position, kind, section, lines_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(id(), meetingSongId, position, slide.kind, slide.section ?? null, JSON.stringify(slide.lines), now, now),
  )
  if (statements.length) await db.batch(statements)
}

async function songById(db: D1Database, songId: string) {
  return db.prepare(
    `SELECT s.*, COUNT(ms.id) AS use_count, MAX(m.meeting_date) AS last_used_at
     FROM songs s
     LEFT JOIN meeting_songs ms ON ms.song_id = s.id
     LEFT JOIN meetings m ON m.id = ms.meeting_id
     WHERE s.id = ?
     GROUP BY s.id`,
  ).bind(songId).first<any>()
}

async function slidesForSong(db: D1Database, meetingSongId: string, song: any): Promise<LyricSlide[]> {
  const parsed = validateSectionedLyrics(song.lyrics_text ?? '', song.title)
  if (parsed.errors.length) throw new Error(`Cannot generate slides: ${parsed.errors.join(' ')}`)
  await db.prepare('DELETE FROM meeting_slides WHERE meeting_song_id = ?').bind(meetingSongId).run()
  await insertSlides(db, meetingSongId, parsed.slides)
  return parsed.slides
}

async function assembleDeck(db: D1Database, meeting: any) {
  const rows = await db.prepare(
    `SELECT ms.id AS meeting_song_id, ms.position AS song_position, s.id AS song_id, s.title,
            s.hymn_number, sl.id AS slide_id, sl.position AS slide_position, sl.kind, sl.section, sl.lines_json
     FROM meeting_songs ms
     JOIN songs s ON s.id = ms.song_id
     LEFT JOIN meeting_slides sl ON sl.meeting_song_id = ms.id
     WHERE ms.meeting_id = ?
     ORDER BY ms.position ASC, sl.position ASC`,
  ).bind(meeting.id).all<any>()

  const songs = new Map<string, any>()
  for (const row of rows.results) {
    let song = songs.get(row.meeting_song_id)
    if (!song) {
      song = {
        id: row.song_id,
        songId: row.song_id,
        meetingSongId: row.meeting_song_id,
        meeting_song_id: row.meeting_song_id,
        title: row.title,
        hymnNumber: row.hymn_number,
        hymn_number: row.hymn_number,
        position: row.song_position,
        slides: [],
      }
      songs.set(row.meeting_song_id, song)
    }
    if (row.slide_id) {
      let lines: string[] = []
      try { lines = JSON.parse(row.lines_json) } catch { /* malformed historic row is omitted */ }
      if (Array.isArray(lines)) song.slides.push({ id: row.slide_id, position: row.slide_position, kind: row.kind, section: row.section, lines })
    }
  }
  return {
    id: meeting.id,
    date: meeting.meeting_date,
    meetingDate: meeting.meeting_date,
    meeting_date: meeting.meeting_date,
    title: meeting.title,
    notes: meeting.notes,
    status: meeting.status,
    viewToken: meeting.view_token ?? null,
    view_token: meeting.view_token ?? null,
    songs: Array.from(songs.values()),
  }
}

app.post('/api/login', async (c) => {
  const body = await readJson(c)
  const password = stringField(body?.password, 'password', { required: true, max: 1_000 })
  if (!password) return jsonError(c, 'A password is required.')

  let user = await c.env.DB.prepare('SELECT id, email, password_hash FROM users LIMIT 1').first<any>()
  if (!user) {
    if (!c.env.ADMIN_PASSWORD || !timingSafeEqual(password, c.env.ADMIN_PASSWORD)) return jsonError(c, 'Invalid email or password.', 401)
    user = { id: id(), email: c.env.ADMIN_EMAIL || 'admin@local', password_hash: await passwordHash(password) }
    await c.env.DB.prepare('INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)').bind(user.id, user.email, user.password_hash, new Date().toISOString()).run()
  } else if (!(await verifyPassword(password, user.password_hash))) {
    return jsonError(c, 'Invalid email or password.', 401)
  }

  const rawToken = token()
  const expiresAt = new Date(Date.now() + Math.max(1, Number(c.env.SESSION_DAYS ?? 14)) * day).toISOString()
  await c.env.DB.prepare(
    'INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
  ).bind(id(), user.id, await sha256(rawToken), expiresAt, new Date().toISOString()).run()
  setCookie(c, sessionCookie, rawToken, {
    httpOnly: true,
    // Wrangler's local HTTP server cannot retain a Secure cookie; deployed origins always can.
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax',
    path: '/',
    expires: new Date(expiresAt),
  })
  return c.json({ user: { id: user.id, email: user.email }, expiresAt })
})

app.post('/api/logout', async (c) => {
  const rawToken = getCookie(c, sessionCookie)
  if (rawToken) await c.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(rawToken)).run()
  deleteCookie(c, sessionCookie, { path: '/' })
  return c.body(null, 204)
})

app.get('/api/session', requireAuth, async (c) => {
  const user = await c.env.DB.prepare('SELECT id, email FROM users WHERE id = ?').bind(c.get('userId')).first<{ id: string; email: string }>()
  return c.json({ authenticated: true, email: user?.email ?? null, user })
})

app.use('/api/*', async (c, next) => {
  // The projector URL is deliberately bearer-token scoped so a second display
  // never needs the admin's session cookie. Login/logout are also public.
  if (/^\/api\/(?:login|logout|present\/)/.test(new URL(c.req.url).pathname)) return next()
  return requireAuth(c, next)
})

app.get('/api/songs', async (c) => {
  const q = (c.req.query('q') ?? '').trim().slice(0, 120)
  const filter = c.req.query('filter') ?? 'all'
  const orderBy = filter === 'least-used' ? 'use_count ASC, last_used_at ASC, s.title COLLATE NOCASE ASC'
    : filter === 'recent' ? 'last_used_at DESC, s.title COLLATE NOCASE ASC'
      : 's.title COLLATE NOCASE ASC'
  const where = q ? 'WHERE (s.title LIKE ? OR s.hymn_number LIKE ?)' : ''
  const having = filter === 'unused' ? 'HAVING COUNT(ms.id) = 0' : ''
  const query = `SELECT s.*, COUNT(ms.id) AS use_count, MAX(m.meeting_date) AS last_used_at
    FROM songs s LEFT JOIN meeting_songs ms ON ms.song_id = s.id LEFT JOIN meetings m ON m.id = ms.meeting_id
    ${where} GROUP BY s.id ${having} ORDER BY ${orderBy} LIMIT 250`
  const statement = c.env.DB.prepare(query)
  const rows = q ? await statement.bind(`%${q}%`, `%${q}%`).all<any>() : await statement.all<any>()
  return c.json({ songs: rows.results.map(serializeSong) })
})

app.post('/api/songs', async (c) => {
  const body = await readJson(c)
  const title = stringField(body?.title, 'title', { required: true, max: 300 })
  if (!title) return jsonError(c, 'A song title is required.')
  const hymnNumber = stringField(body?.hymnNumber, 'hymnNumber', { max: 50 })
  const sourceUrl = stringField(body?.sourceUrl, 'sourceUrl', { max: 2_000 })
  const lyricsText = stringField(body?.lyricsText, 'lyricsText', { max: 50_000 })
  if (hymnNumber === null || sourceUrl === null || lyricsText === null) return jsonError(c, 'One or more fields are invalid.')
  if (lyricsText) {
    const validation = validateSectionedLyrics(lyricsText, title)
    if (validation.errors.length) return c.json({ error: 'Lyrics are invalid.', details: validation.errors }, 422)
  }
  const songId = id()
  const now = new Date().toISOString()
  await c.env.DB.prepare(
    `INSERT INTO songs (id, hymn_number, title, normalized_title, dedupe_key, source_url, lyrics_source_name, lyrics_format, lyrics_text, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'sectioned-v1', ?, 'active', ?, ?)`,
  ).bind(songId, hymnNumber || null, title, normalizeTitle(title), songDedupeKey(title, hymnNumber || null), sourceUrl || null, sourceUrl ? 'manual' : null, lyricsText || '', now, now).run()
  return c.json({ song: serializeSong(await songById(c.env.DB, songId)) }, 201)
})

app.get('/api/songs/:id', async (c) => {
  const song = await songById(c.env.DB, c.req.param('id'))
  return song ? c.json({ song: serializeSong(song) }) : jsonError(c, 'Song not found.', 404)
})

app.patch('/api/songs/:id', async (c) => {
  const existing = await songById(c.env.DB, c.req.param('id'))
  if (!existing) return jsonError(c, 'Song not found.', 404)
  const body = await readJson(c)
  if (!body) return jsonError(c, 'Expected a JSON object.')
  const title = body.title === undefined ? existing.title : stringField(body.title, 'title', { required: true, max: 300 })
  const hymnNumber = body.hymnNumber === undefined ? existing.hymn_number : stringField(body.hymnNumber, 'hymnNumber', { max: 50 })
  const sourceUrl = body.sourceUrl === undefined ? existing.source_url : stringField(body.sourceUrl, 'sourceUrl', { max: 2_000 })
  const lyricsText = body.lyricsText === undefined ? existing.lyrics_text : stringField(body.lyricsText, 'lyricsText', { max: 50_000 })
  if (!title || hymnNumber === null || sourceUrl === null || lyricsText === null) return jsonError(c, 'One or more fields are invalid.')
  if (lyricsText) {
    const validation = validateSectionedLyrics(lyricsText, title)
    if (validation.errors.length) return c.json({ error: 'Lyrics are invalid.', details: validation.errors }, 422)
  }
  await c.env.DB.prepare(
    `UPDATE songs SET title = ?, hymn_number = ?, normalized_title = ?, dedupe_key = ?, source_url = ?, lyrics_source_name = ?, lyrics_format = 'sectioned-v1', lyrics_text = ?, updated_at = ? WHERE id = ?`,
  ).bind(title, hymnNumber || null, normalizeTitle(title), songDedupeKey(title, hymnNumber || null), sourceUrl || null, sourceUrl ? (body.lyricsSourceName ?? existing.lyrics_source_name ?? 'manual') : null, lyricsText || '', new Date().toISOString(), existing.id).run()
  return c.json({ song: serializeSong(await songById(c.env.DB, existing.id)) })
})

app.delete('/api/songs/:id', async (c) => {
  const result = await c.env.DB.prepare('DELETE FROM songs WHERE id = ? AND NOT EXISTS (SELECT 1 FROM meeting_songs WHERE song_id = ?)').bind(c.req.param('id'), c.req.param('id')).run()
  if (!result.meta.changes) return jsonError(c, 'Song not found, or it is used in meeting history.', 409)
  return c.body(null, 204)
})

app.get('/api/songs/:id/history', async (c) => {
  const song = await songById(c.env.DB, c.req.param('id'))
  if (!song) return jsonError(c, 'Song not found.', 404)
  const rows = await c.env.DB.prepare(
    `SELECT m.id, m.meeting_date, m.title FROM meeting_songs ms JOIN meetings m ON m.id = ms.meeting_id
     WHERE ms.song_id = ? ORDER BY m.meeting_date DESC`,
  ).bind(song.id).all()
  return c.json({ song: serializeSong(song), meetings: rows.results })
})

app.post('/api/songs/:id/preview-slides', async (c) => {
  const song = await songById(c.env.DB, c.req.param('id'))
  if (!song) return jsonError(c, 'Song not found.', 404)
  const body = await readJson(c)
  const lyricsText = body?.lyricsText === undefined ? song.lyrics_text : stringField(body.lyricsText, 'lyricsText', { max: 50_000 })
  if (lyricsText === null) return jsonError(c, 'Lyrics must be text.')
  const parsed = validateSectionedLyrics(lyricsText ?? '', song.title)
  return parsed.errors.length ? c.json({ error: 'Lyrics are invalid.', details: parsed.errors }, 422) : c.json({ slides: parsed.slides })
})

app.post('/api/songs/:id/format-text', async (c) => {
  const song = await songById(c.env.DB, c.req.param('id'))
  if (!song) return jsonError(c, 'Song not found.', 404)
  const body = await readJson(c)
  const sourceText = stringField(body?.sourceText ?? body?.lyricsText, 'sourceText', { required: true, max: 50_000 })
  if (!sourceText) return jsonError(c, 'Source text is required.')
  // The model only receives leader-provided/approved text; its response is checked
  // against that source before it is ever returned to the editor.
  const lyricsText = await formatLyricsWithAi(c.env.AI, song.title, sourceText) ?? normalizeLyricsDraft(sourceText)
  const parsed = validateSectionedLyrics(lyricsText, song.title)
  return c.json({ lyricsText, slides: parsed.slides, provider: c.env.AI ? 'workers-ai-or-deterministic-fallback' : 'deterministic-draft', requiresReview: true })
})

app.post('/api/songs/:id/find-lyrics', async (c) => {
  const song = await songById(c.env.DB, c.req.param('id'))
  if (!song) return jsonError(c, 'Song not found.', 404)
  // Do not scrape arbitrary content. A licensed Hymnary adapter can later populate this response.
  const trustedSource = song.source_url?.startsWith('https://hymnary.org/') ? song.source_url : null
  return c.json({ candidates: trustedSource ? [{ id: trustedSource, title: song.title, sourceName: 'hymnary.org', sourceUrl: trustedSource, available: false, message: 'Review and paste authorized text; automatic importing is not configured.' }] : [], message: 'Trusted lyric lookup is not configured in this deployment. Add licensed text or a provider adapter.' })
})

app.post('/api/songs/:id/use-lyric-candidate', async (c) => {
  const song = await songById(c.env.DB, c.req.param('id'))
  if (!song) return jsonError(c, 'Song not found.', 404)
  return jsonError(c, 'Trusted lyric import is not configured. Review and paste authorized text instead.', 501)
})

app.get('/api/meetings', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT m.*, COUNT(ms.id) AS song_count FROM meetings m LEFT JOIN meeting_songs ms ON ms.meeting_id = m.id
     GROUP BY m.id ORDER BY m.meeting_date DESC`,
  ).all<any>()
  return c.json({ meetings: rows.results.map((m: any) => ({ id: m.id, date: m.meeting_date, meetingDate: m.meeting_date, meeting_date: m.meeting_date, title: m.title, status: m.status, notes: m.notes, songCount: Number(m.song_count), viewToken: m.view_token ?? null, view_token: m.view_token ?? null })) })
})

app.post('/api/meetings', async (c) => {
  const body = await readJson(c)
  const meetingDate = stringField(body?.meetingDate ?? body?.date, 'meetingDate', { required: true, max: 10 })
  const title = stringField(body?.title, 'title', { max: 300 })
  if (!meetingDate || !/^\d{4}-\d{2}-\d{2}$/.test(meetingDate) || title === null) return jsonError(c, 'A valid YYYY-MM-DD date is required.')
  const meetingId = id()
  const now = new Date().toISOString()
  try {
    await c.env.DB.prepare('INSERT INTO meetings (id, meeting_date, title, status, notes, created_at, updated_at) VALUES (?, ?, ?, \'draft\', \'\', ?, ?)').bind(meetingId, meetingDate, title || '', now, now).run()
  } catch (error) {
    return jsonError(c, 'A meeting already exists on that date.', 409)
  }
  const created = await c.env.DB.prepare('SELECT * FROM meetings WHERE id = ?').bind(meetingId).first<any>()
  return c.json({ id: created.id, meetingDate: created.meeting_date, meeting_date: created.meeting_date, title: created.title, notes: created.notes, status: created.status, songs: [] }, 201)
})

app.get('/api/meetings/:id', async (c) => {
  const meeting = await c.env.DB.prepare('SELECT * FROM meetings WHERE id = ?').bind(c.req.param('id')).first<any>()
  if (!meeting) return jsonError(c, 'Meeting not found.', 404)
  return c.json(await assembleDeck(c.env.DB, meeting))
})

app.patch('/api/meetings/:id', async (c) => {
  const meeting = await c.env.DB.prepare('SELECT * FROM meetings WHERE id = ?').bind(c.req.param('id')).first<any>()
  if (!meeting) return jsonError(c, 'Meeting not found.', 404)
  const body = await readJson(c)
  if (!body) return jsonError(c, 'Expected a JSON object.')
  const title = body.title === undefined ? meeting.title : stringField(body.title, 'title', { max: 300 })
  const notes = body.notes === undefined ? meeting.notes : stringField(body.notes, 'notes', { max: 5_000 })
  const status = body.status === undefined ? meeting.status : stringField(body.status, 'status', { max: 20 })
  const songOrder = body.songOrder
  if (title === null || notes === null || status === null || !['draft', 'published', 'past'].includes(status)) return jsonError(c, 'One or more fields are invalid.')
  if (songOrder !== undefined) {
    if (!Array.isArray(songOrder) || songOrder.some((value) => typeof value !== 'string')) return jsonError(c, 'songOrder must be an array of meeting-song IDs.')
    const existing = await c.env.DB.prepare('SELECT id FROM meeting_songs WHERE meeting_id = ? ORDER BY position').bind(meeting.id).all<{ id: string }>()
    const ids = existing.results.map((row: { id: string }) => row.id)
    if (songOrder.length !== ids.length || new Set(songOrder).size !== ids.length || songOrder.some((value) => !ids.includes(value))) return jsonError(c, 'songOrder must include every selected song exactly once.')
    await c.env.DB.prepare('UPDATE meeting_songs SET position = position + 1000000 WHERE meeting_id = ?').bind(meeting.id).run()
    await c.env.DB.batch(songOrder.map((meetingSongId: string, index: number) => c.env.DB.prepare('UPDATE meeting_songs SET position = ? WHERE id = ?').bind(index, meetingSongId)))
  }
  await c.env.DB.prepare('UPDATE meetings SET title = ?, notes = ?, status = ?, updated_at = ? WHERE id = ?').bind(title || '', notes || '', status, new Date().toISOString(), meeting.id).run()
  const updated = await c.env.DB.prepare('SELECT * FROM meetings WHERE id = ?').bind(meeting.id).first<any>()
  return c.json(await assembleDeck(c.env.DB, updated))
})

app.post('/api/meetings/:id/songs', async (c) => {
  const meeting = await c.env.DB.prepare('SELECT * FROM meetings WHERE id = ?').bind(c.req.param('id')).first<any>()
  if (!meeting) return jsonError(c, 'Meeting not found.', 404)
  const body = await readJson(c)
  const songId = stringField(body?.songId, 'songId', { required: true, max: 100 })
  if (!songId) return jsonError(c, 'songId is required.')
  const song = await songById(c.env.DB, songId)
  if (!song) return jsonError(c, 'Song not found.', 404)
  const parsed = validateSectionedLyrics(song.lyrics_text ?? '', song.title)
  if (parsed.errors.length) return c.json({ error: 'This song needs valid lyrics before it can be added.', details: parsed.errors }, 422)
  const max = await c.env.DB.prepare('SELECT COALESCE(MAX(position), -1) AS max_position FROM meeting_songs WHERE meeting_id = ?').bind(meeting.id).first<{ max_position: number }>()
  const meetingSongId = id()
  const now = new Date().toISOString()
  const statements = [
    c.env.DB.prepare('INSERT INTO meeting_songs (id, meeting_id, song_id, position, created_at) VALUES (?, ?, ?, ?, ?)').bind(meetingSongId, meeting.id, song.id, Number(max?.max_position ?? -1) + 1, now),
    ...parsed.slides.map((slide, position) => c.env.DB.prepare('INSERT INTO meeting_slides (id, meeting_song_id, position, kind, section, lines_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(id(), meetingSongId, position, slide.kind, slide.section ?? null, JSON.stringify(slide.lines), now, now)),
  ]
  await c.env.DB.batch(statements)
  const deck = await assembleDeck(c.env.DB, meeting)
  return c.json({ meeting: deck }, 201)
})

app.patch('/api/meeting-songs/:id', async (c) => {
  const meetingSong = await c.env.DB.prepare('SELECT * FROM meeting_songs WHERE id = ?').bind(c.req.param('id')).first<any>()
  if (!meetingSong) return jsonError(c, 'Meeting song not found.', 404)
  const body = await readJson(c)
  const requestedPosition = typeof body?.position === 'number' ? body.position : NaN
  if (!Number.isInteger(requestedPosition) || requestedPosition < 0) return jsonError(c, 'A non-negative integer position is required.')
  // Move all rows out of the target range before assigning their contiguous order.
  const peers = await c.env.DB.prepare('SELECT id FROM meeting_songs WHERE meeting_id = ? ORDER BY position').bind(meetingSong.meeting_id).all<{ id: string }>()
  const ordered = peers.results.filter((peer: { id: string }) => peer.id !== meetingSong.id)
  ordered.splice(Math.min(requestedPosition, ordered.length), 0, { id: meetingSong.id })
  await c.env.DB.prepare('UPDATE meeting_songs SET position = position + 1000000 WHERE meeting_id = ?').bind(meetingSong.meeting_id).run()
  await c.env.DB.batch(ordered.map((peer: { id: string }, index: number) => c.env.DB.prepare('UPDATE meeting_songs SET position = ? WHERE id = ?').bind(index, peer.id)))
  return c.json({ reordered: ordered.map((peer: { id: string }) => peer.id) })
})

app.delete('/api/meeting-songs/:id', async (c) => {
  const result = await c.env.DB.prepare('DELETE FROM meeting_songs WHERE id = ?').bind(c.req.param('id')).run()
  if (!result.meta.changes) return jsonError(c, 'Meeting song not found.', 404)
  return c.body(null, 204)
})

app.post('/api/meetings/:id/slides/regenerate', async (c) => {
  const meeting = await c.env.DB.prepare('SELECT * FROM meetings WHERE id = ?').bind(c.req.param('id')).first<any>()
  if (!meeting) return jsonError(c, 'Meeting not found.', 404)
  const rows = await c.env.DB.prepare(
    'SELECT ms.id AS meeting_song_id, s.* FROM meeting_songs ms JOIN songs s ON s.id = ms.song_id WHERE ms.meeting_id = ?',
  ).bind(meeting.id).all<any>()
  try {
    for (const row of rows.results) await slidesForSong(c.env.DB, row.meeting_song_id, row)
  } catch (error) {
    return jsonError(c, error instanceof Error ? error.message : 'Could not generate slides.', 422)
  }
  return c.json(await assembleDeck(c.env.DB, meeting))
})

app.patch('/api/meeting-slides/:id', async (c) => {
  const slide = await c.env.DB.prepare('SELECT * FROM meeting_slides WHERE id = ?').bind(c.req.param('id')).first<any>()
  if (!slide) return jsonError(c, 'Slide not found.', 404)
  const body = await readJson(c)
  if (!body) return jsonError(c, 'Expected a JSON object.')
  const kind = body.kind === undefined ? slide.kind : stringField(body.kind, 'kind', { required: true, max: 10 })
  const section = body.section === undefined ? slide.section : stringField(body.section, 'section', { max: 100 })
  const lines = body.lines === undefined ? JSON.parse(slide.lines_json) : parseLines(body.lines)
  if (!kind || !['title', 'lyrics'].includes(kind) || section === null || !lines || (kind === 'lyrics' && lines.length > 4)) return jsonError(c, 'The slide is invalid.')
  await c.env.DB.prepare('UPDATE meeting_slides SET kind = ?, section = ?, lines_json = ?, updated_at = ? WHERE id = ?').bind(kind, section || null, JSON.stringify(lines), new Date().toISOString(), slide.id).run()
  return c.json({ slide: { id: slide.id, kind, section: section || null, lines } })
})

app.post('/api/meetings/:id/publish', async (c) => {
  const meeting = await c.env.DB.prepare('SELECT * FROM meetings WHERE id = ?').bind(c.req.param('id')).first<any>()
  if (!meeting) return jsonError(c, 'Meeting not found.', 404)
  const deck = await assembleDeck(c.env.DB, meeting)
  if (!deck.songs.length || deck.songs.some((song: any) => !song.slides.length)) return jsonError(c, 'Add songs and slides before publishing.', 422)
  const viewToken = token()
  const now = new Date().toISOString()
  await c.env.DB.prepare('UPDATE meetings SET status = \'published\', view_token = ?, published_at = ?, updated_at = ? WHERE id = ?').bind(viewToken, now, now, meeting.id).run()
  return c.json({ viewToken, presenterPath: `/present/${viewToken}` })
})

app.get('/api/present/:viewToken', async (c) => {
  const meeting = await c.env.DB.prepare('SELECT * FROM meetings WHERE view_token = ? AND status = \'published\'').bind(c.req.param('viewToken')).first<any>()
  if (!meeting) return jsonError(c, 'Presentation not found.', 404)
  const deck = await assembleDeck(c.env.DB, meeting)
  const slides = deck.songs.flatMap((song: any) => song.slides)
  return c.json({ title: deck.title || 'Song night', meeting: deck, slides })
})

app.notFound(async (c) => c.env.ASSETS ? c.env.ASSETS.fetch(c.req.raw) : c.json({ error: 'Not found.' }, 404))

export default app
