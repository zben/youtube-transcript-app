import { YoutubeTranscript } from 'youtube-transcript';
import { retryWithBackoff, isYouTubeRetryable } from './retry.js';
import { AppError, classifyError } from './errors.js';
import { logger, LogContext } from './logger.js';

export function extractVideoId(input: string): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) {
    return trimmed;
  }
  const patterns = [
    /(?:https?:\/\/)?(?:www\.)?youtube\.com\/watch\?(?:.*&)?v=([a-zA-Z0-9_-]{11})/,
    /(?:https?:\/\/)?youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /(?:https?:\/\/)?(?:www\.)?youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
    /(?:https?:\/\/)?(?:www\.)?youtube\.com\/live\/([a-zA-Z0-9_-]{11})/,
    /(?:https?:\/\/)?(?:www\.)?youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/
  ];
  for (const regex of patterns) {
    const match = trimmed.match(regex);
    if (match && match[1]) {
      return match[1];
    }
  }
  return null;
}

export function decodeHtmlEntities(str: string): string {
  if (!str) return '';
  return str
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(dec));
}

export interface VideoMetadata {
  title: string;
  description: string;
  author: string;
}

export async function fetchYoutubeMetadata(
  videoId: string,
  context?: LogContext
): Promise<VideoMetadata> {
  const opContext: LogContext = { ...context, videoId, stage: 'fetch_metadata' };

  try {
    return await retryWithBackoff(
      async (attempt) => {
        logger.debug(`Fetching YouTube page metadata (attempt ${attempt})...`, opContext);
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 12000);

        try {
          const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
            signal: controller.signal,
            headers: {
              'User-Agent':
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              'Accept-Language': 'en-US,en;q=0.9'
            }
          });

          if (!res.ok) {
            logger.warn(`YouTube page fetch returned HTTP ${res.status}`, opContext);
            return { title: '', description: '', author: '' };
          }

          const html = await res.text();

          let title = '';
          const titleMatch = html.match(/<title>([^<]+)<\/title>/);
          if (titleMatch) {
            title = decodeHtmlEntities(titleMatch[1].replace(/\s*-\s*YouTube\s*$/, '').trim());
          }

          let description = '';
          const descMatch = html.match(/"shortDescription":"((?:[^"\\]|\\.)*)"/);
          if (descMatch) {
            try {
              description = JSON.parse(`"${descMatch[1]}"`);
            } catch {
              description = descMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
            }
          } else {
            const metaMatch = html.match(/<meta\s+name="description"\s+content="([^"]*)"/i);
            if (metaMatch) description = decodeHtmlEntities(metaMatch[1]);
          }

          let author = '';
          const authorMatch = html.match(/"author":"([^"]+)"/);
          if (authorMatch) {
            author = decodeHtmlEntities(authorMatch[1]);
          }

          return { title, description, author };
        } finally {
          clearTimeout(timeoutId);
        }
      },
      {
        maxAttempts: 2,
        initialDelayMs: 800,
        retryable: isYouTubeRetryable,
        context: opContext
      }
    );
  } catch (err: any) {
    logger.warn(`Metadata fetch failed, falling back to empty metadata: ${err?.message || err}`, opContext);
    return { title: '', description: '', author: '' };
  }
}

export async function fetchTranscriptWithRetry(
  videoId: string,
  context?: LogContext
): Promise<string> {
  const opContext: LogContext = { ...context, videoId, stage: 'fetch_transcript' };

  try {
    const rawTranscript = await retryWithBackoff(
      async (attempt) => {
        logger.info(`Fetching transcript from YouTube (attempt ${attempt})...`, opContext);

        // 1. First try English language subtitle
        try {
          const res = await YoutubeTranscript.fetchTranscript(videoId, { lang: 'en' });
          if (res && res.length > 0) return res;
        } catch (firstErr: any) {
          logger.debug(`Transcript with lang=en failed: ${firstErr?.message || firstErr}. Trying default transcript...`, opContext);
        }

        // 2. Fall back to default transcript (native language of video)
        const resDefault = await YoutubeTranscript.fetchTranscript(videoId);
        return resDefault;
      },
      {
        maxAttempts: 3,
        initialDelayMs: 1200,
        maxDelayMs: 6000,
        backoffFactor: 2,
        retryable: (err) => {
          // If transcript is explicitly disabled or video unavailable, don't retry!
          const name = err?.name || '';
          const msg = (err?.message || '').toLowerCase();
          if (
            name.includes('YoutubeTranscriptDisabled') ||
            name.includes('YoutubeTranscriptVideoUnavailable') ||
            name.includes('YoutubeTranscriptNotAvailable') ||
            msg.includes('transcript is disabled') ||
            msg.includes('video is unavailable')
          ) {
            return false;
          }
          return isYouTubeRetryable(err);
        },
        context: opContext
      }
    );

    if (!rawTranscript || rawTranscript.length === 0) {
      throw new AppError({
        code: 'NO_TRANSCRIPT',
        statusCode: 422,
        userMessage: '未能获取到该视频的字幕内容（视频未开启字幕或无可用字幕轨道）。',
        videoId: opContext.videoId,
        requestId: opContext.requestId,
        stage: 'fetch_transcript'
      });
    }

    const plainText = rawTranscript
      .map((item) => (item.text || '').trim())
      .filter(Boolean)
      .join(' ');

    if (!plainText || plainText.length < 10) {
      throw new AppError({
        code: 'NO_TRANSCRIPT',
        statusCode: 422,
        userMessage: '获取到的字幕内容为空或过短，无法生成有效总结。',
        videoId: opContext.videoId,
        requestId: opContext.requestId,
        stage: 'fetch_transcript'
      });
    }

    logger.info(`Successfully fetched transcript (${plainText.length} chars)`, opContext);
    return plainText;
  } catch (err: any) {
    throw classifyError(err, opContext);
  }
}
