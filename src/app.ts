import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { GoogleGenAI } from '@google/genai/web';
import type { VideoRepository } from './repositories/types.js';
import { logger } from './utils/logger.js';
import { retryWithBackoff, isGeminiRetryable } from './utils/retry.js';
import { AppError, classifyError } from './utils/errors.js';
import { extractVideoId, fetchYoutubeMetadata, fetchTranscriptWithRetry } from './utils/youtube.js';
import { buildSummaryPrompt, buildFiveW1HPrompt, MAX_INSTRUCTION_CHARS } from './prompts.js';
import { extractSectionFromSummary, parse5W1HJson, isValidYoutubeId } from './utils/section.js';

export interface AppDeps {
  repo: VideoRepository;
  geminiApiKey?: string;
  geminiModel?: string;
  /** Serves the SPA shell (public/index.html) for /summary/:id and /video/:id deep links. */
  spaHtmlResponse: () => Response | Promise<Response>;
  /** Keeps a Worker isolate alive for background work such as persisting a partial summary. */
  waitUntil?: (promise: Promise<unknown>) => void;
}

const DEFAULT_MODEL = 'gemini-3.8-flash';

/** Empty string means "no custom requirement"; over-long requests are truncated rather than rejected. */
function normalizeInstruction(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, MAX_INSTRUCTION_CHARS) : '';
}

/**
 * Markdown the browser is currently showing. Used as 5W1H context when it is a customized,
 * non-stored view; capped so a crafted client cannot stream an unbounded prompt body.
 */
const MAX_SOURCE_MARKDOWN_CHARS = 200_000;
function normalizeSourceMarkdown(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, MAX_SOURCE_MARKDOWN_CHARS) : '';
}

type AppEnv = { Variables: { requestId: string } };

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const { repo, geminiModel = DEFAULT_MODEL, spaHtmlResponse } = deps;
  const waitUntil = deps.waitUntil ?? ((promise: Promise<unknown>) => void promise);
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    const requestId = c.req.header('x-request-id') || crypto.randomUUID().slice(0, 8);
    c.set('requestId', requestId);
    if (!c.req.path.endsWith('.css') && !c.req.path.endsWith('.js')) {
      logger.debug(`${c.req.method} ${c.req.path}`, { requestId });
    }
    await next();
  });

  // 1. RESTful Summary Query Endpoint (For Page Refresh / Cache Hit)
  app.get('/api/summary/:videoId', async (c) => {
    const requestId = c.get('requestId');
    const videoId = String(c.req.param('videoId') || '').trim();
    const context = { requestId, videoId, stage: 'query_summary' };

    if (!isValidYoutubeId(videoId)) {
      return c.json(
        {
          error: '无效的 YouTube Video ID 格式',
          code: 'INVALID_URL',
          debug: { requestId, timestamp: new Date().toISOString() }
        },
        400
      );
    }

    try {
      const video = await repo.getVideoByYoutubeId(videoId);
      if (!video) {
        return c.json({ exists: false, videoId });
      }

      const summaryMarkdown = await repo.getSummary(video.id);
      if (!summaryMarkdown) {
        return c.json({ exists: false, video });
      }

      const fiveWoneHList = await repo.getAll5W1HForVideo(video.id);

      logger.debug(
        `Found cached summary in database (${summaryMarkdown.length} chars, ${fiveWoneHList.length} 5W1H items)`,
        context
      );

      return c.json({
        exists: true,
        videoId,
        internalId: video.id,
        title: video.title,
        summaryMarkdown,
        fiveWoneHList
      });
    } catch (err: any) {
      logger.error('Database query error in /api/summary/:videoId', err, context);
      const classified = classifyError(err, context);
      return c.json(classified.toJSON(), classified.statusCode as any);
    }
  });

  // 2. Streaming Summary Endpoint (D1/SQLite Persistent with Retries & Hardened Error Handling)
  app.post('/api/summarize-stream', async (c) => {
    const requestId = c.get('requestId');
    const payload = await c.req.json().catch(() => ({} as any));
    const url = payload?.url;
    const forceRefresh = payload?.forceRefresh;
    const instruction = normalizeInstruction(payload?.instruction);

    if (!url || typeof url !== 'string' || !url.trim()) {
      const err = new AppError({
        code: 'INVALID_INPUT',
        statusCode: 400,
        userMessage: '请输入有效的 YouTube 视频链接或 11 位 Video ID。',
        requestId
      });
      return c.json(err.toJSON(), err.statusCode as any);
    }

    const videoId = extractVideoId(url);
    if (!videoId) {
      const err = new AppError({
        code: 'INVALID_URL',
        statusCode: 400,
        userMessage: '无法识别输入的链接格式。请输入标准的 YouTube 视频链接或 11 位 ID。',
        requestId
      });
      return c.json(err.toJSON(), err.statusCode as any);
    }

    const context = { requestId, videoId, stage: 'summarize_stream' };
    logger.info(
      `Starting summarize request for video: ${videoId} (forceRefresh=${!!forceRefresh}, instruction=${instruction.length} chars)`,
      context
    );

    const effectiveKey = (deps.geminiApiKey || '').trim();
    if (!effectiveKey) {
      const err = new AppError({
        code: 'AI_API_KEY_MISSING',
        statusCode: 500,
        userMessage: '服务端未配置 GEMINI_API_KEY 环境变量，请在 .env 中进行配置。',
        requestId,
        videoId
      });
      return c.json(err.toJSON(), err.statusCode as any);
    }

    const response = streamSSE(c, async (stream) => {
      let clientAborted = false;
      stream.onAbort(() => {
        if (!clientAborted) {
          clientAborted = true;
          logger.info('Client aborted response connection prematurely', context);
        }
      });
      const isAborted = () => clientAborted || stream.aborted;

      const sendEvent = async (data: any) => {
        if (isAborted()) return;
        await stream.writeSSE({ data: JSON.stringify(data) });
      };
      const finishStream = async () => {
        if (!isAborted()) await stream.write('data: [DONE]\n\n');
      };

      // Initial handshake
      await sendEvent({ status: 'connected', requestId, videoId });

      // Check Database Cache first unless forceRefresh requested
      const existingVideo = await repo.getVideoByYoutubeId(videoId);
      const storedSummary = existingVideo ? await repo.getSummary(existingVideo.id) : undefined;
      const hasStoredSummary = !!storedSummary && storedSummary.trim().length > 50;

      if (existingVideo && !forceRefresh && !instruction && hasStoredSummary) {
        logger.info(`Cache Hit: Returning stored summary for ${videoId}`, context);
        await sendEvent({ status: 'ready', videoId, fromCache: true, title: existingVideo.title });
        await sendEvent({ text: storedSummary });
        await finishStream();
        return;
      }

      // Without an instruction the result is always the authoritative summary. With one, it is
      // only stored when the video has no summary at all — otherwise chapter 5W1H would have
      // nothing to work from, and a scoped one-off would still never overwrite an existing one.
      const persistResult = !instruction || !hasStoredSummary;

      if (instruction) {
        await sendEvent({
          status: 'fetching_transcript',
          persisted: persistResult,
          message: persistResult
            ? '正在按你的自定义要求生成（该视频尚无默认总结，本次结果将作为默认总结保存）...'
            : '正在按你的自定义要求生成（本次结果不写入数据库）...'
        });
      }

      const videoUuid = existingVideo?.id || crypto.randomUUID();
      let fullMarkdown = '';

      try {
        // 1. Fetch Official Metadata (with retry and timeout)
        await sendEvent({
          status: 'fetching_transcript',
          message: '正在提取视频官方背景、演职员名单与时间戳章节...'
        });
        const meta = await fetchYoutubeMetadata(videoId, context);

        try {
          await repo.upsertVideo(
            videoUuid,
            videoId,
            `https://www.youtube.com/watch?v=${videoId}`,
            meta.title,
            meta.description
          );
        } catch (dbErr: any) {
          logger.warn('Failed to upsert video record in db (non-fatal)', context, dbErr);
        }

        if (isAborted()) return;

        // 2. Fetch Transcript (with multi-language fallback and retries)
        await sendEvent({
          status: 'fetching_transcript',
          message: '正在从 YouTube 获取全文字幕与对话音轨...'
        });
        let plainText = await repo.getTranscript(videoUuid);

        if (!plainText) {
          plainText = await fetchTranscriptWithRetry(videoId, context);
          try {
            await repo.saveTranscript(videoUuid, plainText);
          } catch (dbErr: any) {
            logger.warn('Failed to cache transcript in db (non-fatal)', context, dbErr);
          }
        } else {
          logger.info(`Loaded transcript from database cache (${plainText.length} chars)`, context);
        }

        if (isAborted()) return;

        await sendEvent({ status: 'ready', videoId, title: meta.title, fromCache: false });

        // 3. Stream Gemini summary with retries on stream initiation
        const ai = new GoogleGenAI({ apiKey: effectiveKey });

        logger.info(`Calling Gemini model: ${geminiModel} (transcript length: ${plainText.length})...`, context);

        const metaContext = `
【视频官方背景信息与创作者说明】
视频标题：${meta.title || existingVideo?.title || '未知'}
频道/发布者：${meta.author || '未知'}
官方简介与说明（包含嘉宾名单、主题介绍与时间戳 Timestamps）：
${meta.description || existingVideo?.description || '无官方简介'}
`;

        const responseStream = await retryWithBackoff(
          async (attempt) => {
            logger.debug(`Initiating Gemini generateContentStream (attempt ${attempt})...`, context);
            return await ai.models.generateContentStream({
              model: geminiModel,
              contents: [
                {
                  role: 'user',
                  parts: [
                    { text: buildSummaryPrompt(instruction) },
                    { text: metaContext },
                    { text: `\n\n【完整对话全文字幕】\n${plainText}` }
                  ]
                }
              ]
            });
          },
          {
            maxAttempts: 3,
            initialDelayMs: 1500,
            maxDelayMs: 8000,
            backoffFactor: 2,
            retryable: isGeminiRetryable,
            context: { ...context, stage: 'gemini_stream_init' }
          }
        );

        await sendEvent({
          status: 'streaming',
          message: `正在通过 ${geminiModel} 实时流式提炼总结...`
        });

        // Read chunks from Gemini stream
        for await (const chunk of responseStream) {
          if (isAborted()) {
            logger.info('Client disconnected mid-stream. Halting chunk read.', context);
            break;
          }

          const text = chunk.text || '';
          if (text) {
            fullMarkdown += text;
            await sendEvent({ text });
          }
        }

        // Persist summary to the database if meaningful content was generated
        if (persistResult && fullMarkdown && fullMarkdown.trim().length > 50) {
          const saving = repo
            .saveSummary(videoUuid, fullMarkdown)
            .then(() => {
              logger.info(
                `Successfully persisted full summary to DB (${fullMarkdown.length} chars, ${
                  instruction ? 'customized run adopted as the default summary' : 'default summary'
                })`,
                context
              );
            })
            .catch((dbErr: any) => {
              logger.error('Failed to save summary to DB', dbErr, context);
            });
          if (isAborted()) waitUntil(saving);
          await saving;
        }

        await finishStream();
      } catch (rawError: any) {
        logger.error('Error during summarize-stream execution', rawError, context);
        const appError = classifyError(rawError, context);

        // If partial summary was accumulated before error, persist it!
        if (persistResult && fullMarkdown && fullMarkdown.trim().length > 100) {
          try {
            await repo.saveSummary(videoUuid, fullMarkdown);
            logger.warn(`Persisted partial summary (${fullMarkdown.length} chars) before error`, context);
          } catch {}
        }

        if (!isAborted()) {
          await stream.writeSSE({
            data: JSON.stringify({
              ...appError.toJSON(),
              partialAvailable: fullMarkdown.trim().length > 50
            })
          });
        }
      }
    });

    response.headers.set('Content-Type', 'text/event-stream; charset=utf-8');
    response.headers.set('Cache-Control', 'no-cache, no-transform');
    response.headers.set('X-Accel-Buffering', 'no');
    return response;
  });

  // 3. 5W1H Summary Endpoint: Robust Generation with Retries, Hardened Parsing & Error Reporting
  app.post('/api/5w1h', async (c) => {
    const requestId = c.get('requestId');
    const payload = await c.req.json().catch(() => ({} as any));
    const videoId = payload?.videoId;
    const sectionHeading = payload?.sectionHeading;
    // A customized view is not in the DB by design, so when the browser is showing one it has to
    // hand the text over. That makes the answer a one-off too: variant-derived rows must not be
    // keyed under the plain chapter heading, or the default view would inherit them.
    const sourceMarkdown = normalizeSourceMarkdown(payload?.sourceMarkdown);
    const oneOffView = sourceMarkdown.length > 50;

    if (!videoId || !sectionHeading) {
      const err = new AppError({
        code: 'INVALID_INPUT',
        statusCode: 400,
        userMessage: '缺少必要参数: videoId 或 sectionHeading。',
        requestId
      });
      return c.json(err.toJSON(), err.statusCode as any);
    }

    const context = { requestId, videoId, stage: '5w1h' };
    logger.info(`5W1H requested for section: "${sectionHeading}"`, context);

    try {
      const video = await repo.getVideoByYoutubeId(videoId);
      if (!video) {
        throw new AppError({
          code: 'VIDEO_UNAVAILABLE',
          statusCode: 404,
          userMessage: '未在本地数据库中找到该视频记录，请先生成总结。',
          ...context
        });
      }

      // 1. Check if 5W1H already persisted in D1/SQLite (meaningful only for the stored view)
      const cached5W1H = oneOffView ? undefined : await repo.get5W1H(video.id, sectionHeading);
      if (cached5W1H) {
        logger.info(`5W1H Cache Hit for "${sectionHeading}"`, context);
        return c.json({
          sectionHeading,
          data: {
            who: cached5W1H.who,
            what: cached5W1H.what,
            when: cached5W1H.when,
            where: cached5W1H.where,
            why: cached5W1H.why,
            how: cached5W1H.how
          }
        });
      }

      // 2. Basis: the customized text on screen takes priority, otherwise the stored summary
      const summaryMarkdown = oneOffView ? sourceMarkdown : await repo.getSummary(video.id);
      if (!summaryMarkdown) {
        throw new AppError({
          code: 'INVALID_INPUT',
          statusCode: 404,
          userMessage: '该视频尚未生成完整总结，请先生成总结后再提取 5W1H。',
          ...context
        });
      }

      const effectiveKey = (deps.geminiApiKey || '').trim();
      if (!effectiveKey) {
        throw new AppError({
          code: 'AI_API_KEY_MISSING',
          statusCode: 500,
          userMessage: '服务端未配置 GEMINI_API_KEY。',
          ...context
        });
      }

      const ai = new GoogleGenAI({ apiKey: effectiveKey });
      const targetSection = extractSectionFromSummary(summaryMarkdown, sectionHeading);

      const prompt = buildFiveW1HPrompt({
        sectionHeading,
        videoTitle: video.title || '未知',
        videoDescription: video.description ? video.description.slice(0, 800) : '未知',
        summaryMarkdown,
        targetSection: targetSection || `章节标题：${sectionHeading}`
      });

      // Call Gemini with retries and parse verification
      const parsedData = await retryWithBackoff(
        async (attempt) => {
          logger.debug(`Calling Gemini for 5W1H (attempt ${attempt})...`, context);
          const response = await ai.models.generateContent({
            model: geminiModel,
            contents: prompt,
            config: {
              responseMimeType: 'application/json'
            }
          });

          const rawText = response.text || '';
          try {
            return parse5W1HJson(rawText);
          } catch (parseErr: any) {
            logger.warn(`Failed to parse 5W1H JSON response on attempt ${attempt}: ${parseErr.message}`, context, {
              rawSnippet: rawText.slice(0, 200)
            });
            // If parse fails on earlier attempt, rethrow to trigger retry
            if (attempt < 2) {
              throw parseErr;
            }
            // On last attempt, throw classified AppError
            throw new AppError({
              code: 'AI_PARSE_ERROR',
              statusCode: 502,
              userMessage: `AI 总结生成的内容未能成功解析为规范的 5W1H 结构，请点击重试。`,
              cause: parseErr,
              rawDetails: { rawSnippet: rawText.slice(0, 300) },
              retryable: true,
              ...context
            });
          }
        },
        {
          maxAttempts: 3,
          initialDelayMs: 1200,
          maxDelayMs: 6000,
          backoffFactor: 2,
          retryable: isGeminiRetryable,
          context: { ...context, stage: 'gemini_5w1h' }
        }
      );

      // Persist into SQLite / D1 (a one-off answer about a customized view stays out of the table)
      const w5hId = crypto.randomUUID();
      if (oneOffView) {
        logger.info(`Skipped persisting one-off 5W1H for "${sectionHeading}" (customized view)`, context);
      } else {
        try {
          await repo.save5W1H(w5hId, video.id, sectionHeading, parsedData);
          logger.info(`Successfully saved 5W1H for "${sectionHeading}"`, context);
        } catch (dbErr: any) {
          logger.warn('Failed to save 5W1H to db (non-fatal)', context, dbErr);
        }
      }

      return c.json({
        sectionHeading,
        data: parsedData
      });
    } catch (err: any) {
      logger.error('Error in /api/5w1h', err, context);
      const appError = classifyError(err, context);
      return c.json(appError.toJSON(), appError.statusCode as any);
    }
  });

  // 4. Delete / Clear Video Data Endpoint (Supports DELETE & POST /clear)
  const handleClearVideoData = async (c: Context<AppEnv>) => {
    const requestId = c.get('requestId');
    const videoId = String(c.req.param('videoId') || '').trim();

    if (!isValidYoutubeId(videoId)) {
      const err = new AppError({
        code: 'INVALID_INPUT',
        statusCode: 404,
        userMessage: `未找到请求的接口路径: ${c.req.path}`,
        requestId
      });
      return c.json(err.toJSON(), 404);
    }

    const context = { requestId, videoId, stage: 'delete_video' };
    logger.info(`Request to clear stored data for video: ${videoId}`, context);

    try {
      const result = await repo.deleteVideoData(videoId);
      if (!result.deleted) {
        return c.json(
          {
            success: false,
            error: '未在本地数据库中找到该视频的数据记录。',
            code: 'VIDEO_NOT_FOUND',
            videoId
          },
          404
        );
      }

      logger.info(`Successfully cleared data for video ${videoId}`, context, result.counts);
      return c.json({
        success: true,
        message: `已清除该视频的所有本地数据（字幕、完整总结及 ${result.counts.chapter5w1h} 个 5W1H 章节分析）。`,
        videoId,
        counts: result.counts
      });
    } catch (err: any) {
      logger.error('Failed to delete video data', err, context);
      const classified = classifyError(err, context);
      return c.json(classified.toJSON(), classified.statusCode as any);
    }
  };

  app.delete('/api/video/:videoId', handleClearVideoData);
  app.post('/api/video/:videoId/clear', handleClearVideoData);

  // 5. RESTful URL Support: /summary/:videoId and /video/:videoId serve index.html (SPA)
  const spaHandler = (c: Context<AppEnv>) => {
    const videoId = c.req.param('videoId') || '';
    if (!isValidYoutubeId(videoId)) {
      return c.notFound();
    }
    return spaHtmlResponse();
  };
  app.get('/summary/:videoId', spaHandler);
  app.get('/video/:videoId', spaHandler);

  // Global 404 Handler for API routes
  app.all('/api/*', (c) => {
    const err = new AppError({
      code: 'INVALID_INPUT',
      statusCode: 404,
      userMessage: `未找到请求的接口路径: ${c.req.path}`,
      requestId: c.get('requestId')
    });
    return c.json(err.toJSON(), 404);
  });

  app.onError((rawError, c) => {
    const appError = classifyError(rawError, { requestId: c.get('requestId'), stage: 'unhandled' });
    logger.error('Unhandled error', rawError, { requestId: c.get('requestId') });
    return c.json(appError.toJSON(), appError.statusCode as any);
  });

  return app;
}
