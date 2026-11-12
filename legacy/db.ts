import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Store database in a local data directory (Cloudflare D1 SQLite compatible)
const dataDir = path.join(__dirname, '../data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'app.db');
export const db = new Database(dbPath);

// Enable WAL mode for high performance and set busy timeout for concurrency
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.pragma('synchronous = NORMAL');

// Initialize schema (Standard SQLite DDL matching Cloudflare D1 exactly)
db.exec(`
  CREATE TABLE IF NOT EXISTS videos (
    id TEXT PRIMARY KEY,
    youtube_id TEXT UNIQUE NOT NULL,
    url TEXT NOT NULL,
    title TEXT,
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS transcripts (
    video_id TEXT PRIMARY KEY,
    plain_text TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (video_id) REFERENCES videos(id)
  );

  CREATE TABLE IF NOT EXISTS summaries (
    video_id TEXT PRIMARY KEY,
    summary_markdown TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (video_id) REFERENCES videos(id)
  );

  CREATE TABLE IF NOT EXISTS chapter_5w1h (
    id TEXT PRIMARY KEY,
    video_id TEXT NOT NULL,
    chapter_heading TEXT NOT NULL,
    who TEXT NOT NULL,
    what TEXT NOT NULL,
    when_time TEXT NOT NULL,
    where_place TEXT NOT NULL,
    why TEXT NOT NULL,
    how TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(video_id, chapter_heading),
    FOREIGN KEY (video_id) REFERENCES videos(id)
  );
`);

// Migration safety: ensure description column exists if table was created earlier
try {
  db.exec('ALTER TABLE videos ADD COLUMN description TEXT;');
} catch {}

export interface VideoRecord {
  id: string;
  youtube_id: string;
  url: string;
  title: string | null;
  description: string | null;
  created_at: string;
}

export interface FiveWOneHRecord {
  id: string;
  video_id: string;
  chapter_heading: string;
  who: string;
  what: string;
  when: string;
  where: string;
  why: string;
  how: string;
}

export const dbService = {
  getVideoByYoutubeId(youtubeId: string): VideoRecord | undefined {
    return db.prepare('SELECT * FROM videos WHERE youtube_id = ?').get(youtubeId) as VideoRecord | undefined;
  },

  upsertVideo(id: string, youtubeId: string, url: string, title?: string, description?: string): void {
    db.prepare(`
      INSERT INTO videos (id, youtube_id, url, title, description) 
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(youtube_id) DO UPDATE SET 
        url = excluded.url, 
        title = COALESCE(excluded.title, videos.title),
        description = COALESCE(excluded.description, videos.description)
    `).run(id, youtubeId, url, title || null, description || null);
  },

  getTranscript(videoId: string): string | undefined {
    const row = db.prepare('SELECT plain_text FROM transcripts WHERE video_id = ?').get(videoId) as { plain_text: string } | undefined;
    return row?.plain_text;
  },

  saveTranscript(videoId: string, plainText: string): void {
    db.prepare(`
      INSERT INTO transcripts (video_id, plain_text) 
      VALUES (?, ?)
      ON CONFLICT(video_id) DO UPDATE SET plain_text = excluded.plain_text
    `).run(videoId, plainText);
  },

  getSummary(videoId: string): string | undefined {
    const row = db.prepare('SELECT summary_markdown FROM summaries WHERE video_id = ?').get(videoId) as { summary_markdown: string } | undefined;
    return row?.summary_markdown;
  },

  saveSummary(videoId: string, summaryMarkdown: string): void {
    db.prepare(`
      INSERT INTO summaries (video_id, summary_markdown) 
      VALUES (?, ?)
      ON CONFLICT(video_id) DO UPDATE SET summary_markdown = excluded.summary_markdown
    `).run(videoId, summaryMarkdown);
  },

  get5W1H(videoId: string, chapterHeading: string): FiveWOneHRecord | undefined {
    // 1. Try exact match
    const exact = db.prepare(`
      SELECT id, video_id, chapter_heading, who, what, when_time as 'when', where_place as 'where', why, how
      FROM chapter_5w1h 
      WHERE video_id = ? AND chapter_heading = ?
    `).get(videoId, chapterHeading) as FiveWOneHRecord | undefined;
    if (exact) return exact;

    // 2. Fallback: match normalized headings across all stored 5W1H for this video
    const cleanTarget = chapterHeading
      .replace(/^[#\s一二三四五六七八九十\d.、-]+/, '')
      .replace(/[：:\s\-_—·]/g, '')
      .toLowerCase();
    
    if (!cleanTarget) return undefined;

    const all = this.getAll5W1HForVideo(videoId);
    for (const item of all) {
      const cleanDbHeading = item.chapter_heading
        .replace(/^[#\s一二三四五六七八九十\d.、-]+/, '')
        .replace(/[：:\s\-_—·]/g, '')
        .toLowerCase();
      if (cleanDbHeading === cleanTarget || cleanDbHeading.includes(cleanTarget) || cleanTarget.includes(cleanDbHeading)) {
        return item;
      }
    }
    return undefined;
  },

  save5W1H(id: string, videoId: string, chapterHeading: string, data: { who: string; what: string; when: string; where: string; why: string; how: string }): void {
    db.prepare(`
      INSERT INTO chapter_5w1h (id, video_id, chapter_heading, who, what, when_time, where_place, why, how)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(video_id, chapter_heading) DO UPDATE SET
        who = excluded.who,
        what = excluded.what,
        when_time = excluded.when_time,
        where_place = excluded.where_place,
        why = excluded.why,
        how = excluded.how
    `).run(id, videoId, chapterHeading, data.who, data.what, data.when, data.where, data.why, data.how);
  },

  getAll5W1HForVideo(videoId: string): FiveWOneHRecord[] {
    return db.prepare(`
      SELECT id, video_id, chapter_heading, who, what, when_time as 'when', where_place as 'where', why, how
      FROM chapter_5w1h 
      WHERE video_id = ?
      ORDER BY created_at ASC
    `).all(videoId) as FiveWOneHRecord[];
  },

  deleteVideoData(youtubeId: string): { deleted: boolean; videoId?: string; counts: { transcript: number; summary: number; chapter5w1h: number } } {
    const video = this.getVideoByYoutubeId(youtubeId);
    if (!video) {
      return { deleted: false, counts: { transcript: 0, summary: 0, chapter5w1h: 0 } };
    }

    const deleteTx = db.transaction(() => {
      const c5 = db.prepare('DELETE FROM chapter_5w1h WHERE video_id = ?').run(video.id).changes;
      const sm = db.prepare('DELETE FROM summaries WHERE video_id = ?').run(video.id).changes;
      const tr = db.prepare('DELETE FROM transcripts WHERE video_id = ?').run(video.id).changes;
      db.prepare('DELETE FROM videos WHERE id = ?').run(video.id);
      return { transcript: tr, summary: sm, chapter5w1h: c5 };
    });

    const counts = deleteTx();
    return { deleted: true, videoId: video.id, counts };
  }
};
