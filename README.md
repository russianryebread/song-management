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

The song library includes an editable **Allowed lookup sites** list. It begins with
`https://hymnary.org/` and `https://hymnal.net/`; add, edit, disable, or remove
sites there. To import lyrics, save a song with the specific trusted page in its
**Source URL**, choose **Find lyrics**, then **Use** the result. The imported text
is only a draft: review it and save it before it becomes part of the library.

You can also paste lyrics directly and choose **Format with AI**. The deterministic
fallback recognizes the numbered Hymnary and Hymnal.net styles, including
`Refrain:` labels and an unlabeled four-line refrain between numbered verses. It
writes the editable sectioned format and the viewer always limits lyric slides to
four lines.

## Deployment

Before deploying, put your real D1 `database_id` in the `DB` binding in
`wrangler.jsonc`, then set an initial secure password with
`wrangler secret put ADMIN_PASSWORD`. Apply migrations remotely before deployment:

```sh
npx wrangler d1 migrations apply song-management --remote
npm run deploy
```
