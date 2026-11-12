#!/usr/bin/env node
/**
 * Exports the local better-sqlite3 database (data/app.db) into a SQL file importable by D1:
 *
 *   node scripts/export-sqlite-to-d1.mjs                       # writes build/d1-seed.sql
 *   npx wrangler d1 execute youtube-transcript-d1 --local  --file=build/d1-seed.sql
 *   npx wrangler d1 execute youtube-transcript-d1 --remote --file=build/d1-seed.sql
 *
 * The source database is opened read-only, and nothing here deletes or overwrites remote work:
 * videos are upserted on youtube_id while every child row is INSERT OR IGNORE.
 *
 * Rows are keyed by youtube_id rather than by the local `videos.id`, because the two databases
 * mint their own UUIDs. A video generated on the Worker already has a videos row with a remote
 * UUID, so importing children under the local UUID would orphan them and the API (which resolves
 * youtube_id -> id first) would still report the video as unprocessed.
 *
 * D1 rejects statements larger than 100 KB (SQLITE_TOOBIG) and full transcripts exceed that, so
 * oversized text columns are split: the INSERT carries the first chunk and each following UPDATE
 * appends one more chunk, guarded by the exact character length the column must have at that
 * point. The guards make a re-import of an already-complete row a no-op instead of a double append.
 */
import Database from 'better-sqlite3';
import path from 'path';
import { mkdirSync } from 'fs';
import { writeFile } from 'fs/promises';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');
const dbPath = path.join(rootDir, 'data', 'app.db');
const outDir = path.join(rootDir, 'build');
const outFile = process.argv[2] ? path.resolve(process.argv[2]) : path.join(outDir, 'd1-seed.sql');

// D1's hard limit is 100 KB per statement; stay well under it.
const MAX_STATEMENT_BYTES = 90_000;

const tables = [
  {
    name: 'videos',
    columns: ['id', 'youtube_id', 'url', 'title', 'description', 'created_at'],
    // Keeps whatever id the target database already chose for this video.
    conflict: `ON CONFLICT(youtube_id) DO UPDATE SET
  url = excluded.url,
  title = COALESCE(excluded.title, videos.title),
  description = COALESCE(excluded.description, videos.description)`,
    keyColumns: ['youtube_id']
  },
  {
    name: 'transcripts',
    columns: ['video_id', 'plain_text', 'created_at'],
    videoIdColumn: 'video_id',
    keyColumns: ['video_id']
  },
  {
    name: 'summaries',
    columns: ['video_id', 'summary_markdown', 'created_at'],
    videoIdColumn: 'video_id',
    keyColumns: ['video_id']
  },
  {
    name: 'chapter_5w1h',
    columns: [
      'id',
      'video_id',
      'chapter_heading',
      'who',
      'what',
      'when_time',
      'where_place',
      'why',
      'how',
      'created_at'
    ],
    videoIdColumn: 'video_id',
    keyColumns: ['video_id', 'chapter_heading']
  }
];

function sqlLiteral(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
}

function byteLength(text) {
  return Buffer.byteLength(text, 'utf8');
}

/** Split on code point boundaries so SQLite's length() (characters) matches our guards. */
function chunkText(value, maxBytes) {
  const chunks = [];
  let current = '';
  let currentBytes = 0;

  for (const char of value) {
    const charBytes = byteLength(char) + (char.includes("'") ? 1 : 0);
    if (currentBytes + charBytes > maxBytes && current) {
      chunks.push(current);
      current = '';
      currentBytes = 0;
    }
    current += char;
    currentBytes += charBytes;
  }

  if (current || chunks.length === 0) chunks.push(current);
  return chunks;
}

const db = new Database(dbPath, { readonly: true, fileMustExist: true });

const youtubeIdByLocalVideoId = new Map(
  db.prepare('SELECT id, youtube_id FROM videos').all().map((row) => [row.id, row.youtube_id])
);

/** Resolve a local videos.id against whatever id the target database uses. */
function videoRef(localVideoId) {
  const youtubeId = youtubeIdByLocalVideoId.get(localVideoId);
  if (!youtubeId) {
    throw new Error(`Row references videos.id ${localVideoId}, which is not in the videos table.`);
  }
  return `(SELECT id FROM videos WHERE youtube_id = ${sqlLiteral(youtubeId)})`;
}

function literalForColumn(table, column, row) {
  if (table.videoIdColumn === column) return videoRef(row[column]);
  return sqlLiteral(row[column]);
}

function conditionForColumn(table, column, row) {
  return `${column} = ${literalForColumn(table, column, row)}`;
}

const lines = [
  '-- Generated from data/app.db by scripts/export-sqlite-to-d1.mjs',
  `-- Source: ${dbPath}`,
  ''
];

const stats = [];
let largestStatement = 0;
let chunkedRows = 0;

function emit(statement) {
  largestStatement = Math.max(largestStatement, byteLength(statement));
  if (byteLength(statement) > MAX_STATEMENT_BYTES) {
    throw new Error(
      `Generated a statement over ${MAX_STATEMENT_BYTES} bytes despite chunking: ${statement.slice(0, 120)}...`
    );
  }
  lines.push(statement);
}

for (const table of tables) {
  const rows = db.prepare(`SELECT ${table.columns.join(', ')} FROM ${table.name}`).all();
  stats.push(`${table.name}: ${rows.length} rows`);

  const insertTail = table.conflict ? `\n${table.conflict}` : '';

  for (const row of rows) {
    const values = table.columns.map((column) => literalForColumn(table, column, row)).join(', ');
    const fullInsert = `INSERT OR IGNORE INTO ${table.name} (${table.columns.join(', ')})\nVALUES (${values})${insertTail};`;

    if (byteLength(fullInsert) <= MAX_STATEMENT_BYTES) {
      emit(fullInsert);
      continue;
    }

    // The oversized value goes into the largest text column, split across statements.
    const target = table.columns
      .filter((column) => typeof row[column] === 'string')
      .reduce((a, b) => (String(row[a]).length >= String(row[b]).length ? a : b));

    const chunkedValues = table.columns
      .map((column) => (column === target ? "''" : literalForColumn(table, column, row)))
      .join(', ');
    const keyCondition = table.keyColumns.map((column) => conditionForColumn(table, column, row)).join(' AND ');

    emit(
      `INSERT OR IGNORE INTO ${table.name} (${table.columns.join(', ')})\nVALUES (${chunkedValues})${insertTail};`
    );

    // Reserve room for the UPDATE wrapper around each chunk.
    const overhead = byteLength(
      `UPDATE ${table.name} SET ${target} = ${target} || ''; WHERE video_id = (SELECT id FROM videos WHERE youtube_id = 'xxxxxxxxxxx') AND length(${target}) = 999999;`
    );
    const chunks = chunkText(String(row[target]), MAX_STATEMENT_BYTES - overhead);

    let appliedChars = 0;
    for (const chunk of chunks) {
      emit(
        `UPDATE ${table.name} SET ${target} = ${target} || ${sqlLiteral(chunk)} WHERE ${keyCondition} AND length(${target}) = ${appliedChars};`
      );
      appliedChars += [...chunk].length;
    }

    chunkedRows += 1;
  }
}

db.close();

if (stats[0].endsWith('0 rows')) {
  console.error(`Refusing to write an empty export: no rows found in ${dbPath}`);
  process.exit(1);
}

mkdirSync(path.dirname(outFile), { recursive: true });
await writeFile(outFile, lines.join('\n'), 'utf8');

console.log(stats.join(' | '));
console.log(`rows needing chunked inserts: ${chunkedRows}`);
console.log(`largest single statement: ${(largestStatement / 1024).toFixed(1)} KB`);
console.log(`statements: ${lines.length - 3}`);
console.log(`wrote ${outFile}`);
