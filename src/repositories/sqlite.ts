import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import type {
  DeleteVideoDataResult,
  FiveW1HData,
  FiveWOneHRecord,
  VideoRecord,
  VideoRepository
} from './types.js';
import { matchFiveW1H } from './heading.js';

const FIVE_W_ONE_H_SELECT = `
  SELECT id, video_id, chapter_heading, who, what, when_time as 'when', where_place as 'where', why, how
  FROM chapter_5w1h
`;

/**
 * Local (Node) repository backed by better-sqlite3. Statements are synchronous; they are wrapped
 * in Promises so routes can share one async code path with the D1 implementation.
 */
export class SqliteRepository implements VideoRepository {
  private readonly db: Database.Database;

  constructor(dataDir: string) {
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    this.db = new Database(path.join(dataDir, 'app.db'));
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('synchronous = NORMAL');

    this.db.exec(`
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

    // Migration safety: ensure description column exists if the table was created earlier
    try {
      this.db.exec('ALTER TABLE videos ADD COLUMN description TEXT;');
    } catch {}
  }

  async getVideoByYoutubeId(youtubeId: string): Promise<VideoRecord | undefined> {
    return this.db
      .prepare('SELECT * FROM videos WHERE youtube_id = ?')
      .get(youtubeId) as VideoRecord | undefined;
  }

  async upsertVideo(
    id: string,
    youtubeId: string,
    url: string,
    title?: string,
    description?: string
  ): Promise<void> {
    this.db
      .prepare(`
        INSERT INTO videos (id, youtube_id, url, title, description)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(youtube_id) DO UPDATE SET
          url = excluded.url,
          title = COALESCE(excluded.title, videos.title),
          description = COALESCE(excluded.description, videos.description)
      `)
      .run(id, youtubeId, url, title || null, description || null);
  }

  async getTranscript(videoId: string): Promise<string | undefined> {
    const row = this.db
      .prepare('SELECT plain_text FROM transcripts WHERE video_id = ?')
      .get(videoId) as { plain_text: string } | undefined;
    return row?.plain_text;
  }

  async saveTranscript(videoId: string, plainText: string): Promise<void> {
    this.db
      .prepare(`
        INSERT INTO transcripts (video_id, plain_text)
        VALUES (?, ?)
        ON CONFLICT(video_id) DO UPDATE SET plain_text = excluded.plain_text
      `)
      .run(videoId, plainText);
  }

  async getSummary(videoId: string): Promise<string | undefined> {
    const row = this.db
      .prepare('SELECT summary_markdown FROM summaries WHERE video_id = ?')
      .get(videoId) as { summary_markdown: string } | undefined;
    return row?.summary_markdown;
  }

  async saveSummary(videoId: string, summaryMarkdown: string): Promise<void> {
    this.db
      .prepare(`
        INSERT INTO summaries (video_id, summary_markdown)
        VALUES (?, ?)
        ON CONFLICT(video_id) DO UPDATE SET summary_markdown = excluded.summary_markdown
      `)
      .run(videoId, summaryMarkdown);
  }

  async get5W1H(videoId: string, chapterHeading: string): Promise<FiveWOneHRecord | undefined> {
    return matchFiveW1H(await this.getAll5W1HForVideo(videoId), chapterHeading);
  }

  async save5W1H(
    id: string,
    videoId: string,
    chapterHeading: string,
    data: FiveW1HData
  ): Promise<void> {
    this.db
      .prepare(`
        INSERT INTO chapter_5w1h (id, video_id, chapter_heading, who, what, when_time, where_place, why, how)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(video_id, chapter_heading) DO UPDATE SET
          who = excluded.who,
          what = excluded.what,
          when_time = excluded.when_time,
          where_place = excluded.where_place,
          why = excluded.why,
          how = excluded.how
      `)
      .run(id, videoId, chapterHeading, data.who, data.what, data.when, data.where, data.why, data.how);
  }

  async getAll5W1HForVideo(videoId: string): Promise<FiveWOneHRecord[]> {
    return this.db
      .prepare(`${FIVE_W_ONE_H_SELECT} WHERE video_id = ? ORDER BY created_at ASC`)
      .all(videoId) as FiveWOneHRecord[];
  }

  async deleteVideoData(youtubeId: string): Promise<DeleteVideoDataResult> {
    const video = await this.getVideoByYoutubeId(youtubeId);
    if (!video) {
      return { deleted: false, counts: { transcript: 0, summary: 0, chapter5w1h: 0 } };
    }

    const tx = this.db.transaction(() => {
      const chapter5w1h = this.db
        .prepare('DELETE FROM chapter_5w1h WHERE video_id = ?')
        .run(video.id).changes;
      const summary = this.db.prepare('DELETE FROM summaries WHERE video_id = ?').run(video.id)
        .changes;
      const transcript = this.db.prepare('DELETE FROM transcripts WHERE video_id = ?').run(video.id)
        .changes;
      this.db.prepare('DELETE FROM videos WHERE id = ?').run(video.id);
      return { transcript, summary, chapter5w1h };
    });

    return { deleted: true, videoId: video.id, counts: tx() };
  }
}
