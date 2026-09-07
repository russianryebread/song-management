# Song Management

A small song-planning and projector app built with Vue, Tailwind-style CSS,
Cloudflare Workers, D1, and Workers AI.

## Local setup

1. Install packages: `npm install`
2. Create a Cloudflare D1 database: `npx wrangler d1 create song-management`
3. Replace `REPLACE_WITH_D1_DATABASE_ID` in `wrangler.jsonc` with its ID.
4. Copy `.dev.vars.example` to `.dev.vars` and choose secure local values.
5. Apply the database schema: `npm run db:migrate:local`
6. Import the supplied history: `npm run db:seed:local`
7. Run `npm run dev` for the Vue UI. Run `npx wrangler dev --persist-to=.wrangler/state`
   in another terminal to exercise the Worker API locally.

For production, build with `npm run build`, set `ADMIN_PASSWORD` and
`SESSION_SECRET` using `wrangler secret put`, apply migrations with
`wrangler d1 migrations apply song-management --remote`, then run `npm run deploy`.

The first presenter load gets the entire deck as one JSON response. Advancing slides
never requires the network, so a connection loss cannot interrupt an already-open
presentation.

The admin app uses browser-history routes, so these URLs can be bookmarked or
opened directly: `/library`, `/library/new`, `/library/:songId`, `/meetings`, and
`/meetings/:meetingId`. Deep links are served by the Worker’s SPA fallback and
return to the intended record after sign-in.

## Trusted lyric sources

Settings includes an editable **Allowed lookup sites** list. It begins with
`https://hymnary.org/` and `https://hymnal.net/`; add, edit, disable, or remove
sites there. The checkbox explicitly shows whether each site is enabled for lookup.
To import lyrics, enter the specific trusted page in a saved song’s **Source URL**,
choose **Find lyrics**, then **Use** the result. URL edits apply immediately, without
saving first. Lookup imports a direct page; it does not search entire websites. The imported text
is only a draft: review it and save it before it becomes part of the library.

You can also paste lyrics directly and choose **Format with AI**. The deterministic
fallback recognizes explicit numbered verses and section labels, preserves stanza
boundaries, and never guesses an unlabeled chorus. AI output must preserve lyric
word order and counts. If AI is unavailable or fails validation, the editor clearly
identifies basic formatting. Formatting also works before a new song is saved.
The viewer always limits lyric slides to four lines.

The library and meeting song picker share full-library search (title, number, and
lyrics), independent usage/lyrics filters, sorting, previews, and pagination.
Meetings lists active meetings above history; `/history` redirects to `/meetings`.
Usage counts include all linked meeting records, including drafts, consistently
in the library and meeting details.

Run `npm test` (Node 22.13+ for built-in SQLite) for API and lyric regressions, and
`npm run build` for type checking and the production frontend build.

## Deployment

Before deploying, put your real D1 `database_id` in the `DB` binding in
`wrangler.jsonc`, then set an initial secure password with
`wrangler secret put ADMIN_PASSWORD`. Apply migrations remotely before deployment:

```sh
npx wrangler d1 migrations apply song-management --remote
npm run deploy
```
