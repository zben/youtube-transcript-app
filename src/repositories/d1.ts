import type {
  DeleteVideoDataResult,
  FiveW1HData,
  FiveWOneHRecord,
  VideoRecord,
  VideoRepository
} from './types.js';
import { matchFiveW1H } from './heading.js';

// Structural subset of the Cloudflare D1 binding types, so this module also typechecks in the
// Node build where @cloudflare/workers-types globals are not included.
export interface D1ResultMeta {
  changes?: number;
}

export interface D1Result<T> {
  results: T[];
  meta?: D1ResultMeta;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(column?: string): Promise<T | null>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatement;
  batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

const FIVE_W_ONE_H_SELECT = `
  SELECT id, video_id, chapter_heading, who, what, when_time as 'when', where_place as 'where', why, how
  FROM chapter_5w1h
`;

export class D1Repository implements VideoRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  async getVideoByYoutubeId(youtubeId: string): Promise<VideoRecord | undefined> {
    const row = await this.db
      .prepare('SELECT * FROM videos WHERE youtube_id = ?')
      .bind(youtubeId)
      .first<VideoRecord>();
    return row ?? undefined;
  }

  async upsertVideo(
    id: string,
    youtubeId: string,
    url: string,
    title?: string,
    description?: string
  ): Promise<void> {
    await this.db
      .prepare(`
        INSERT INTO videos (id, youtube_id, url, title, description)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(youtube_id) DO UPDATE SET
          url = excluded.url,
          title = COALESCE(excluded.title, videos.title),
          description = COALESCE(excluded.description, videos.description)
      `)
      .bind(id, youtubeId, url, title || null, description || null)
      .run();
  }

  async getTranscript(videoId: string): Promise<string | undefined> {
    const row = await this.db
      .prepare('SELECT plain_text FROM transcripts WHERE video_id = ?')
      .bind(videoId)
      .first<{ plain_text: string }>();
    return row?.plain_text;
  }

  async saveTranscript(videoId: string, plainText: string): Promise<void> {
    await this.db
      .prepare(`
        INSERT INTO transcripts (video_id, plain_text)
        VALUES (?, ?)
        ON CONFLICT(video_id) DO UPDATE SET plain_text = excluded.plain_text
      `)
      .bind(videoId, plainText)
      .run();
  }

  async getSummary(videoId: string): Promise<string | undefined> {
    const row = await this.db
      .prepare('SELECT summary_markdown FROM summaries WHERE video_id = ?')
      .bind(videoId)
      .first<{ summary_markdown: string }>();
    return row?.summary_markdown;
  }

  async saveSummary(videoId: string, summaryMarkdown: string): Promise<void> {
    await this.db
      .prepare(`
        INSERT INTO summaries (video_id, summary_markdown)
        VALUES (?, ?)
        ON CONFLICT(video_id) DO UPDATE SET summary_markdown = excluded.summary_markdown
      `)
      .bind(videoId, summaryMarkdown)
      .run();
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
    await this.db
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
      .bind(
        id,
        videoId,
        chapterHeading,
        data.who,
        data.what,
        data.when,
        data.where,
        data.why,
        data.how
      )
      .run();
  }

  async getAll5W1HForVideo(videoId: string): Promise<FiveWOneHRecord[]> {
    const { results } = await this.db
      .prepare(`${FIVE_W_ONE_H_SELECT} WHERE video_id = ? ORDER BY created_at ASC`)
      .bind(videoId)
      .all<FiveWOneHRecord>();
    return results ?? [];
  }

  async deleteVideoData(youtubeId: string): Promise<DeleteVideoDataResult> {
    const video = await this.getVideoByYoutubeId(youtubeId);
    if (!video) {
      return { deleted: false, counts: { transcript: 0, summary: 0, chapter5w1h: 0 } };
    }

    // batch() runs the statements in a single transaction; children first because of FKs.
    const [chapter5w1h, summary, transcript] = await this.db.batch([
      this.db.prepare('DELETE FROM chapter_5w1h WHERE video_id = ?').bind(video.id),
      this.db.prepare('DELETE FROM summaries WHERE video_id = ?').bind(video.id),
      this.db.prepare('DELETE FROM transcripts WHERE video_id = ?').bind(video.id),
      this.db.prepare('DELETE FROM videos WHERE id = ?').bind(video.id)
    ]);

    return {
      deleted: true,
      videoId: video.id,
      counts: {
        chapter5w1h: chapter5w1h?.meta?.changes ?? 0,
        summary: summary?.meta?.changes ?? 0,
        transcript: transcript?.meta?.changes ?? 0
      }
    };
  }
}
