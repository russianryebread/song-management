# Seed history

`wed-night-songs.txt` is the supplied source fixture. Regenerate the D1 seed SQL
and the human-review report after changing it:

```sh
node scripts/import-wed-night-songs.mjs
```

Apply the schema first, then the generated seed locally:

```sh
npx wrangler d1 execute song-management --local --file migrations/0001_initial.sql
npx wrangler d1 execute song-management --local --file data/wed-night-songs.seed.sql
```

The importer does not make uncertain merges. Read
`wed-night-songs.review.json` before deciding how to reconcile its listed title or
hymn-number conflicts.
