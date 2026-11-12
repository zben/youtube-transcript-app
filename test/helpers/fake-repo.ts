import type {
  DeleteVideoDataResult,
  FiveW1HData,
  FiveWOneHRecord,
  VideoRecord,
  VideoRepository
} from '../../src/repositories/types.js';
import { matchFiveW1H } from '../../src/repositories/heading.js';

export interface FakeVideo {
  id: string;
  youtube_id: string;
  url: string;
  title: string | null;
  description: string | null;
  created_at: string;
}

/**
 * In-memory VideoRepository that mirrors the real ones' key behaviour (youtube_id -> internal id
 * resolution, fuzzy chapter matching, upsert-on-conflict) and records which methods were touched,
 * so a test can assert that a cache hit never reaches for the transcript or the model.
 */
export class FakeRepository implements VideoRepository {
  videos: FakeVideo[] = [];
  readonly transcripts = new Map<string, string>();
  readonly summaries = new Map<string, string>();
  fiveWoneH: FiveWOneHRecord[] = [];
  readonly calls: Record<string, number> = {};

  /**
   * `empty` seeds nothing (unknown video). `summary: null` seeds the video row but no summaries
   * row, which is exactly the state that makes /api/5w1h fail with "尚未生成完整总结".
   */
  constructor(options?: { empty?: boolean; summary?: string | null; fiveWoneH?: FiveWOneHRecord[] }) {
    if (options?.empty) return;
    this.seed('xRh2sVcNXQ8', {
      title: 'Marc Andreessen Interview',
      description: 'Host: Erik Torenberg. Guest: Marc Andreessen.',
      summary:
        options?.summary === null
          ? undefined
          : options?.summary ??
            '# 对话安德森\n\n## 一、AI 收入爆发\n\nMarc: ...\n\n## 二、成本塌陷\n\nMarc: ...',
      fiveWoneH: options?.fiveWoneH ?? []
    });
  }

  seed(
    youtubeId: string,
    data: { id?: string; title?: string; description?: string; summary?: string; fiveWoneH?: FiveWOneHRecord[] }
  ): string {
    const id = data.id ?? `uuid-${youtubeId}`;
    this.videos.push({
      id,
      youtube_id: youtubeId,
      url: `https://www.youtube.com/watch?v=${youtubeId}`,
      title: data.title ?? null,
      description: data.description ?? null,
      created_at: '2026-11-12 00:00:00'
    });
    if (data.summary) this.summaries.set(id, data.summary);
    for (const record of data.fiveWoneH ?? []) this.fiveWoneH.push(record);
    return id;
  }

  private mark(method: string): void {
    this.calls[method] = (this.calls[method] ?? 0) + 1;
  }

  touched(method: string): boolean {
    return (this.calls[method] ?? 0) > 0;
  }

  async getVideoByYoutubeId(youtubeId: string): Promise<VideoRecord | undefined> {
    this.mark('getVideoByYoutubeId');
    return this.videos.find((item) => item.youtube_id === youtubeId);
  }

  async upsertVideo(
    id: string,
    youtubeId: string,
    url: string,
    title?: string,
    description?: string
  ): Promise<void> {
    this.mark('upsertVideo');
    const existing = this.videos.find((item) => item.youtube_id === youtubeId);
    if (existing) {
      existing.url = url;
      existing.title = title ?? existing.title;
      existing.description = description ?? existing.description;
      return;
    }
    this.videos.push({
      id,
      youtube_id: youtubeId,
      url,
      title: title ?? null,
      description: description ?? null,
      created_at: '2026-11-12 00:00:00'
    });
  }

  async getTranscript(videoId: string): Promise<string | undefined> {
    this.mark('getTranscript');
    return this.transcripts.get(videoId);
  }

  async saveTranscript(videoId: string, plainText: string): Promise<void> {
    this.mark('saveTranscript');
    this.transcripts.set(videoId, plainText);
  }

  async getSummary(videoId: string): Promise<string | undefined> {
    this.mark('getSummary');
    return this.summaries.get(videoId);
  }

  async saveSummary(videoId: string, summaryMarkdown: string): Promise<void> {
    this.mark('saveSummary');
    this.summaries.set(videoId, summaryMarkdown);
  }

  async get5W1H(videoId: string, chapterHeading: string): Promise<FiveWOneHRecord | undefined> {
    this.mark('get5W1H');
    return matchFiveW1H(
      this.fiveWoneH.filter((item) => item.video_id === videoId),
      chapterHeading
    );
  }

  async save5W1H(id: string, videoId: string, chapterHeading: string, data: FiveW1HData): Promise<void> {
    this.mark('save5W1H');
    const existing = this.fiveWoneH.find(
      (item) => item.video_id === videoId && item.chapter_heading === chapterHeading
    );
    if (existing) {
      Object.assign(existing, data);
      return;
    }
    this.fiveWoneH.push({ id, video_id: videoId, chapter_heading: chapterHeading, ...data });
  }

  async getAll5W1HForVideo(videoId: string): Promise<FiveWOneHRecord[]> {
    this.mark('getAll5W1HForVideo');
    return this.fiveWoneH.filter((item) => item.video_id === videoId);
  }

  async deleteVideoData(youtubeId: string): Promise<DeleteVideoDataResult> {
    this.mark('deleteVideoData');
    const video = this.videos.find((item) => item.youtube_id === youtubeId);
    if (!video) {
      return { deleted: false, counts: { transcript: 0, summary: 0, chapter5w1h: 0 } };
    }
    const chapter5w1h = this.fiveWoneH.filter((item) => item.video_id === video.id).length;
    this.fiveWoneH = this.fiveWoneH.filter((item) => item.video_id !== video.id);
    this.summaries.delete(video.id);
    this.transcripts.delete(video.id);
    this.videos = this.videos.filter((item) => item.id !== video.id);
    return { deleted: true, videoId: video.id, counts: { transcript: 1, summary: 1, chapter5w1h } };
  }
}
