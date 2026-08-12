#!/usr/bin/env node

/**
 * Parse the supplied Markdown-ish history fixture into idempotent D1 seed SQL and
 * an import review report.  It deliberately merges only records with the exact
 * same hymn number and normalized title; likely variants stay distinct and are
 * listed for a human to review.
 *
 * Usage: node scripts/import-wed-night-songs.mjs
 * Outputs: data/wed-night-songs.seed.sql and data/wed-night-songs.review.json
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const scriptUrl = new URL('.', import.meta.url);
const rootUrl = new URL('../', scriptUrl);
const fixtureUrl = new URL('data/wed-night-songs.txt', rootUrl);
const sqlUrl = new URL('data/wed-night-songs.seed.sql', rootUrl);
const reportUrl = new URL('data/wed-night-songs.review.json', rootUrl);
const sourceName = 'wed-night-songs.txt';

function normalize(value) {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function stableId(namespace, value) {
  const hex = createHash('sha256').update(`${namespace}:${value}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function extractUrl(value) {
  const match = value.match(/\[[^\]]*\]\((https?:\/\/[^)]+)\)|\(?((?:https?:\/\/)[^)\s]+)\)?/i);
  return match ? (match[1] ?? match[2]) : null;
}

function cleanTitle(value) {
  return value
    .replace(/\s*\(\s*\[https?:\/\/[^\]]+\]\(https?:\/\/[^)]+\)\s*\)\s*/gi, ' ')
    .replace(/\s*\[https?:\/\/[^\]]+\]\(https?:\/\/[^)]+\)\s*/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseSong(line, location) {
  const text = line.replace(/^\s*-\s+/, '').trim();
  const url = extractUrl(text);
  const withoutUrl = cleanTitle(text);
  const numbered = withoutUrl.match(/^(\d+(?:\/\d+)?)\s+(.+)$/);
  const hymnNumber = numbered ? numbered[1] : null;
  const title = numbered ? numbered[2].trim() : withoutUrl;
  if (!title) throw new Error(`No song title at ${location}: ${line}`);
  return { hymnNumber, title, normalizedTitle: normalize(title), sourceUrl: url, location };
}

function parseFixture(raw) {
  const meetings = [];
  const unused = [];
  const ignoredLines = [];
  let mode = 'header';
  let currentMeeting = null;

  raw.split(/\r?\n/).forEach((line, index) => {
    const lineNumber = index + 1;
    const trimmed = line.trim();
    if (!trimmed || /^[-—]{2,}$/.test(trimmed)) return;
    if (trimmed === 'Wed Night Songs') return;
    if (trimmed === 'Unused') {
      mode = 'unused';
      currentMeeting = null;
      return;
    }
    if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(trimmed)) {
      mode = 'meeting';
      const [year, month, day] = trimmed.split('-');
      currentMeeting = { date: `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`, songs: [], line: lineNumber };
      meetings.push(currentMeeting);
      return;
    }
    if (/^-\s+/.test(trimmed)) {
      const song = parseSong(trimmed, `line ${lineNumber}`);
      if (mode === 'unused') unused.push(song);
      else if (mode === 'meeting' && currentMeeting) currentMeeting.songs.push(song);
      else ignoredLines.push({ line: lineNumber, value: line, reason: 'song outside a section' });
      return;
    }
    ignoredLines.push({ line: lineNumber, value: line, reason: 'unrecognized non-song line' });
  });

  return { meetings, unused, ignoredLines };
}

function makeReport(parsed, sourceSha) {
  const all = [...parsed.unused, ...parsed.meetings.flatMap((meeting) => meeting.songs)];
  const byDedupeKey = new Map();
  const byTitle = new Map();
  const byNumber = new Map();

  for (const song of all) {
    const key = `${song.hymnNumber ?? 'none'}:${song.normalizedTitle}`;
    byDedupeKey.set(key, [...(byDedupeKey.get(key) ?? []), song]);
    byTitle.set(song.normalizedTitle, [...(byTitle.get(song.normalizedTitle) ?? []), song]);
    if (song.hymnNumber) byNumber.set(song.hymnNumber, [...(byNumber.get(song.hymnNumber) ?? []), song]);
  }

  const variants = [];
  for (const [number, songs] of byNumber) {
    const titles = [...new Set(songs.map((song) => song.normalizedTitle))];
    if (titles.length > 1) variants.push({ type: 'same_hymn_number_different_title', hymnNumber: number, occurrences: songs });
  }
  for (const [title, songs] of byTitle) {
    const numbers = [...new Set(songs.map((song) => song.hymnNumber ?? 'none'))];
    if (numbers.length > 1) variants.push({ type: 'same_title_different_hymn_number', normalizedTitle: title, occurrences: songs });
  }

  return {
    sourceName,
    sourceSha256: sourceSha,
    summary: {
      meetings: parsed.meetings.length,
      meetingSelections: parsed.meetings.reduce((count, meeting) => count + meeting.songs.length, 0),
      unusedSongs: parsed.unused.length,
      distinctCatalogSongs: byDedupeKey.size,
      exactDuplicateOccurrences: [...byDedupeKey.values()].reduce((count, songs) => count + Math.max(0, songs.length - 1), 0),
      ambiguousGroups: variants.length,
    },
    ambiguities: variants,
    ignoredLines: parsed.ignoredLines,
    rules: [
      'Records merge only when hymn number and normalized title are both identical.',
      'Case, punctuation, and curly-apostrophe differences normalize to aliases on the same record.',
      'Different hymn numbers are never automatically merged, even when normalized titles match.',
      'Different normalized titles are never automatically merged, even when hymn numbers match.',
    ],
  };
}

function makeSql(parsed, report) {
  const all = [...parsed.unused, ...parsed.meetings.flatMap((meeting) => meeting.songs)];
  const catalog = new Map();
  for (const song of all) {
    const dedupeKey = `${song.hymnNumber ?? 'none'}:${song.normalizedTitle}`;
    const existing = catalog.get(dedupeKey);
    if (!existing) catalog.set(dedupeKey, { ...song, aliases: new Set([song.title]) });
    else {
      existing.aliases.add(song.title);
      if (!existing.sourceUrl && song.sourceUrl) existing.sourceUrl = song.sourceUrl;
    }
  }

  const createdAt = '2026-08-12T00:00:00.000Z';
  const lines = [
    '-- Generated by scripts/import-wed-night-songs.mjs. Do not hand-edit.',
    'PRAGMA foreign_keys = ON;',
  ];

  for (const [dedupeKey, song] of catalog) {
    const id = stableId('song', dedupeKey);
    lines.push(`INSERT INTO songs (id, hymn_number, title, normalized_title, dedupe_key, source_url, created_at, updated_at) VALUES (${sqlString(id)}, ${song.hymnNumber ? sqlString(song.hymnNumber) : 'NULL'}, ${sqlString(song.title)}, ${sqlString(song.normalizedTitle)}, ${sqlString(dedupeKey)}, ${song.sourceUrl ? sqlString(song.sourceUrl) : 'NULL'}, ${sqlString(createdAt)}, ${sqlString(createdAt)}) ON CONFLICT(dedupe_key) DO UPDATE SET source_url = COALESCE(songs.source_url, excluded.source_url), updated_at = excluded.updated_at;`);
    for (const alias of song.aliases) {
      const normalizedAlias = normalize(alias);
      const aliasId = stableId('song-alias', `${id}:${normalizedAlias}`);
      lines.push(`INSERT OR IGNORE INTO song_aliases (id, song_id, alias, normalized_alias, created_at) VALUES (${sqlString(aliasId)}, ${sqlString(id)}, ${sqlString(alias)}, ${sqlString(normalizedAlias)}, ${sqlString(createdAt)});`);
    }
  }

  for (const meeting of parsed.meetings) {
    const meetingId = stableId('meeting', meeting.date);
    lines.push(`INSERT OR IGNORE INTO meetings (id, meeting_date, status, created_at, updated_at) VALUES (${sqlString(meetingId)}, ${sqlString(meeting.date)}, 'past', ${sqlString(createdAt)}, ${sqlString(createdAt)});`);
    meeting.songs.forEach((song, position) => {
      const dedupeKey = `${song.hymnNumber ?? 'none'}:${song.normalizedTitle}`;
      const meetingSongId = stableId('meeting-song', `${meeting.date}:${position}:${dedupeKey}`);
      lines.push(`INSERT OR IGNORE INTO meeting_songs (id, meeting_id, song_id, position, created_at) VALUES (${sqlString(meetingSongId)}, ${sqlString(meetingId)}, ${sqlString(stableId('song', dedupeKey))}, ${position}, ${sqlString(createdAt)});`);
    });
  }

  const importId = stableId('import', sourceName);
  const reportJson = JSON.stringify(report);
  lines.push(`INSERT INTO imports (id, source_name, source_sha256, imported_at, report_json) VALUES (${sqlString(importId)}, ${sqlString(sourceName)}, ${sqlString(report.sourceSha256)}, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ${sqlString(reportJson)}) ON CONFLICT(source_name) DO UPDATE SET source_sha256 = excluded.source_sha256, imported_at = excluded.imported_at, report_json = excluded.report_json;`);
  lines.push('');
  return lines.join('\n');
}

const raw = await readFile(fixtureUrl, 'utf8');
const parsed = parseFixture(raw);
const sourceSha = createHash('sha256').update(raw).digest('hex');
const report = makeReport(parsed, sourceSha);
const sql = makeSql(parsed, report);
await writeFile(sqlUrl, sql);
await writeFile(reportUrl, `${JSON.stringify(report, null, 2)}\n`);

console.log(`Parsed ${report.summary.meetings} meetings, ${report.summary.meetingSelections} selections, and ${report.summary.unusedSongs} unused songs.`);
console.log(`Created ${report.summary.distinctCatalogSongs} catalog records; ${report.summary.ambiguousGroups} ambiguity groups need review.`);
console.log(`Wrote ${fileURLToPath(sqlUrl)} and ${fileURLToPath(reportUrl)}.`);
