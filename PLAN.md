# Song Management Platform Plan

## Outcome

Build a small, single-admin web app for choosing songs for a men's-group meeting,
maintaining the song library, preserving a complete usage history, and displaying
large, readable lyric slides on a projector.

The first release should be deliberately focused: one leader account, one group,
one projector view, and no collaborative or public-facing features.

## Product decisions

- **Song records are editable.** Lyrics can be changed whenever needed. The
  enduring history is which song was sung on which date, its use count, and its
  previous-use dates.
- **Lyrics may be found from trusted sources.** The leader can ask the app to look
  up a song only from a configured whitelist, beginning with `hymnary.org`, then
  review and approve the returned text before it is saved or formatted.
- **AI assists; it does not publish blindly.** It turns reviewed lyric text into
  a small, readable song-text format. A deterministic parser makes the slide
  chunks, after which the leader can review the result and add explicit breaks.
- **Lyrics use one canonical plain-text format.** It is easy to edit by hand, easy
  for an LLM to produce, and parsed identically by the Worker and Vue client.
- **The projector is a separate, minimal route.** It exposes only the selected
  meeting's approved slides, with no administration controls or song-library data.
- **Presentations are self-contained once opened.** Before entering full-screen,
  the browser downloads every slide for the selected meeting, then advances locally
  without making additional network requests.

## Proposed stack

| Area | Choice | Reason |
| --- | --- | --- |
| UI | Vue 3, Vite, TypeScript, and Tailwind CSS | A compact, responsive single-page app with familiar state and interaction patterns. |
| App/API | A single Cloudflare Worker serving static assets and `/api/*` | Keeps Vue, authentication, APIs, and deployment together. |
| Persistence | Cloudflare D1 | Relational history, ordered meeting selections, and saved slide snapshots fit SQLite well. |
| AI lookup and formatting | A trusted-source lookup tool plus Cloudflare Workers AI with JSON mode | Finds a reviewable lyric draft from approved sources, then returns constrained slide data. |
| Authentication | One password-protected admin account, secure HTTP-only session cookie | Meets the single-leader requirement without adding a full identity system. |

Use the current Cloudflare-supported small instruction model at implementation time
(initially evaluate `llama-3.1-8b-instruct-fast`). JSON-mode output must still be
validated server-side, because model compliance is not guaranteed.

## Presentation reliability

Opening a presenter route fetches the complete deck in one request. Vue waits for
the full response, stores it in the presenter's in-memory state (and the current
browser session), then enables full-screen and slide controls. Next/previous never
fetches a new slide. If the connection drops after the deck has loaded, the current
presentation continues normally; a page reload or opening a different deck still
needs a connection.

## Core screens and flow

1. **Login** — password form; authenticated users land on the dashboard.
2. **Dashboard** — next/draft meeting, recent meetings, and quick song search.
3. **Song library** — search by title or hymn number; filter by never used, least
   recently used, and recently used; show last-used date and total uses.
4. **Song editor** — title, optional hymn number, source URL, tags, raw lyrics,
   and a `Find lyrics` button. It shows candidates from trusted sources with their
   source link and status, then saves only the leader-approved text. `Format slides`
   previews the parser's reusable slide draft; editing the song text or adding a
   slide-break directive updates the preview.
5. **Meeting editor** — create a dated meeting; add songs from search; show each
   song's number of previous uses and the latest dates; drag to order songs;
   generate/reuse reviewed slides; make meeting-specific slide edits; publish when
   ready.
6. **Presenter** — a dark full-screen view with one high-contrast slide at a time.
   The controls stay intentionally small and consistent: Space, Right Arrow, or a
   click advances; Left Arrow goes back; `F` toggles full-screen; Escape exits it.
   Large previous/next buttons are available when a mouse or touch screen is used.
   A discrete slide count may be hidden.
7. **Meeting history** — chronological meeting list with its songs and a link to
   reopen the saved projector deck.

## Data model

Use ISO-8601 text timestamps and dates. IDs can be UUID text values generated in
the Worker. Foreign keys are enabled in each D1 connection/migration.

| Table | Essential fields | Purpose |
| --- | --- | --- |
| `users` | `id`, `email`, `password_hash`, `created_at` | One initial administrator; leaves room for another leader later. |
| `sessions` | `id`, `user_id`, `token_hash`, `expires_at`, `created_at` | Revocable, opaque login sessions. |
| `songs` | `id`, `hymn_number`, `title`, `source_url`, `lyrics_source_name`, `lyrics_format`, `lyrics_text`, `status`, `created_at`, `updated_at` | Canonical song library with its current editable, parser-ready lyrics. |
| `song_aliases` | `id`, `song_id`, `alias`, `normalized_alias` | Retains alternative capitalization/titles found in imported history. |
| `meetings` | `id`, `meeting_date`, `title`, `status`, `notes`, `created_at`, `updated_at` | A planned or past evening; `meeting_date` is unique for this group. |
| `meeting_songs` | `id`, `meeting_id`, `song_id`, `position` | Ordered selections; this table is the source for use counts and previous-use dates. |
| `meeting_slides` | `id`, `meeting_song_id`, `position`, `kind`, `section`, `lines_json` | The saved, editable projector deck for a particular meeting date. |
| `imports` | `id`, `source_name`, `imported_at`, `report_json` | Audit trail and reconciliation report for the supplied seed list. |

Indexes: unique `meetings(meeting_date)`, `meeting_songs(meeting_id, position)`,
`meeting_slides(meeting_song_id, position)`, `song_aliases(normalized_alias)`, and
indexes on `songs(hymn_number)` and normalized song titles.

## Seed-data import

The supplied list will be checked into the project as an import fixture and parsed
by a repeatable script/migration, not entered manually.

- Import the 45 dated entries as past meetings and their 135 selections as
  `meeting_songs`.
- Import the 10 `Unused` lines as library songs with no meeting association.
- Create catalog records from hymn number + title where present; retain the original
  spelling as an alias/source note.
- Preserve URLs (for example, the `simp.ly` and Hymnary references) as `source_url`.
- Generate a review report for ambiguous matches such as title/case/punctuation
  differences and `537` versus `538` for "My Hope is Built...". Do not silently
  merge uncertain records.
- The seed establishes usage history only. Lyrics and slides are added later through
  the editor, beginning with the songs planned for the next meeting.

## Trusted lyric lookup

The app will not give an AI model open web access. Instead, it supplies a
server-side `findTrustedLyrics(title, hymnNumber)` tool that can search and fetch
only configured providers. The first provider will be `hymnary.org`; additional
providers are explicit code/configuration additions, never user-entered domains.

1. The Worker calls the provider adapter and returns a short list of candidate pages.
2. The leader selects a candidate; the adapter fetches it, applies the site's
   availability/copyright rules, and extracts the permitted lyric text plus source
   URL.
3. Workers AI receives only that extracted source text and produces canonical song
   text with section labels and any useful explicit slide breaks.
4. The song editor displays the source link, editable canonical text, and parser
   slide preview for approval.
   Nothing is persisted or presented until the leader saves it.

If a source does not provide the lyrics or indicates a copyright restriction, the
app records the source link and asks the leader to supply licensed or authorized
text. It does not fabricate or bypass unavailable lyrics.

## Canonical lyric and slide format

Each song stores plain text in the `sectioned-v1` format. This is the only lyric
source that the LLM writes and that the client needs to parse.

```text
[verse 1]
Oh Lord my God
When I in awesome wonder
Consider all the worlds Thy hands have made
I see the stars

[chorus 1]
Then sings my soul
My Savior, God to thee
|||
How great Thou art
How great Thou art
```

Section headers use a bracketed label such as `[verse 1]`, `[chorus 1]`, or
`[bridge]`; they start a new section but are not lyric lines. A normal newline is
one displayed lyric line. The standalone `|||` directive means “start a new
slide”; it is never displayed. Blank lines are allowed for readability and ignored.

The parser begins a new slide at each section and then groups following lyric lines
into blocks of **at most four lines**. It honors `|||` before applying that
automatic four-line split. The title screen comes from the song title, not the lyric
text. One shared TypeScript parser module is used by the Worker and Vue client. It
returns simple slide objects:

`{ kind: 'title' | 'lyrics', section?: string, lines: string[] }`.

The LLM must preserve lyric words, retain or add useful section headers, and insert
`|||` only when it improves a slide break. The Worker validates the format:
recognized headers, no empty slides, a maximum of four lyric lines, and every lyric
word drawn from the approved source. Invalid output remains an editable draft.

The canonical text remains the authority. The current song can be edited and
reparsed at any time; saving a meeting deck stores the resulting slides for that
date without a second, AI-specific slide format.

## Authentication and authorization

- Store the initial administrator password as a slow, salted Web Crypto-derived
  hash; never retain a clear-text password in D1 or client code.
- On success, issue a random opaque session token in a `Secure`, `HttpOnly`,
  `SameSite=Lax` cookie. Store only its hash in `sessions`; expire after a limited
  lifetime and support logout by deleting it.
- Require an authenticated session for every `/api/*` route except login, logout,
  and a tightly scoped published-deck read endpoint.
- Give each published projector deck a high-entropy view token in its URL. The
  projector route has read-only access to just that deck, so a projector computer
  need not receive the admin cookie.
- Keep the password/bootstrap value and cookie-signing key in Cloudflare secrets.

## API outline

- `POST /api/login`, `POST /api/logout`, `GET /api/session`
- `GET|POST /api/songs`, `GET|PATCH|DELETE /api/songs/:id`
- `POST /api/songs/:id/find-lyrics`, `POST /api/songs/:id/use-lyric-candidate`,
  `POST /api/songs/:id/format-text`, `POST /api/songs/:id/preview-slides`,
  `GET /api/songs/:id/history`
- `GET|POST /api/meetings`, `GET|PATCH /api/meetings/:id`
- `POST /api/meetings/:id/songs`, `PATCH|DELETE /api/meeting-songs/:id`
- `POST /api/meetings/:id/slides/regenerate`, `PATCH /api/meeting-slides/:id`
- `POST /api/meetings/:id/publish`, `GET /api/present/:viewToken`

Endpoints return JSON. Every database query uses bound parameters. Meeting
creation/copying of slides uses a D1 batch so selected songs and the deck save
atomically.

## Delivery sequence

### Phase 1 — Foundation

1. Scaffold Vue/Vite/TypeScript/Tailwind and the Worker deployment configuration.
2. Create D1 migrations, local development setup, typed API helpers, and the
   password/session authentication flow.
3. Add a repeatable parser plus import review output for the supplied seed data.

**Acceptance:** the app runs locally; the admin can log in; imported meetings and
song history are visible and correct after a spot-check.

### Phase 2 — Library and planning

1. Build search, usage statistics, unused/recent filters, and song editor.
2. Build meeting creation, song selection/reordering, and history views.
3. Parse canonical song text into an editable, saved meeting slide deck.

**Acceptance:** a leader can plan a new date, select songs while seeing prior use,
and reopen the same meeting without losing its ordering or choices.

### Phase 3 — Slides and presentation

1. Add the Workers AI canonical-text endpoint, strict parser validation, and slide
   preview controls.
2. Build the projector route, full-deck preload/cache, and keyboard/full-screen
   behavior.
3. Add publish/unpublish behavior and view-token rotation.

**Acceptance:** a published meeting opens on a second display; slides are readable,
navigable by keyboard, and exactly match the saved meeting version.

### Phase 4 — Quality and deployment

1. Test import normalization, authentication guards, slide validation, usage-count
   queries, ordering, saved meeting decks, and presentation navigation.
2. Run a presentation reliability test: load a complete deck, disable the network,
   and advance through every slide without a request failure.
3. Test at the actual projector resolution and adjust typography/line limits.
4. Deploy the Worker, D1 database, secrets, and production migrations; document
   backup/export and recovery steps.

## Explicitly deferred

- Multiple groups/organizations, roles, and collaboration.
- Live remote-control synchronization between the leader's phone and projector.
- Unrestricted lyric scraping, licensing management, chord charts, audio, and CCLI
  reporting. Trusted-source lookup remains in scope.
- Attendance, announcements, or a broader church-management system.

## Initial login decision

Implement the custom single-password login described above. It keeps this
single-leader app self-contained and avoids Cloudflare Access setup.
