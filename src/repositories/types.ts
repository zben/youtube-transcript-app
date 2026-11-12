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

export interface FiveW1HData {
  who: string;
  what: string;
  when: string;
  where: string;
  why: string;
  how: string;
}

export interface DeleteVideoDataResult {
  deleted: boolean;
  videoId?: string;
  counts: { transcript: number; summary: number; chapter5w1h: number };
}

export interface VideoRepository {
  getVideoByYoutubeId(youtubeId: string): Promise<VideoRecord | undefined>;
  upsertVideo(
    id: string,
    youtubeId: string,
    url: string,
    title?: string,
    description?: string
  ): Promise<void>;
  getTranscript(videoId: string): Promise<string | undefined>;
  saveTranscript(videoId: string, plainText: string): Promise<void>;
  getSummary(videoId: string): Promise<string | undefined>;
  saveSummary(videoId: string, summaryMarkdown: string): Promise<void>;
  get5W1H(videoId: string, chapterHeading: string): Promise<FiveWOneHRecord | undefined>;
  save5W1H(
    id: string,
    videoId: string,
    chapterHeading: string,
    data: FiveW1HData
  ): Promise<void>;
  getAll5W1HForVideo(videoId: string): Promise<FiveWOneHRecord[]>;
  deleteVideoData(youtubeId: string): Promise<DeleteVideoDataResult>;
}
