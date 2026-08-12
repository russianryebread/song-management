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
