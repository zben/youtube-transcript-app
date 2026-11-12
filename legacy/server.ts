import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';
import crypto from 'crypto';
import { setGlobalDispatcher, EnvHttpProxyAgent } from 'undici';
import { dbService } from './db.js';
import { logger, LogContext } from './utils/logger.js';
import { retryWithBackoff, isGeminiRetryable } from './utils/retry.js';
import { AppError, classifyError } from './utils/errors.js';
import { extractVideoId, fetchYoutubeMetadata, fetchTranscriptWithRetry } from './utils/youtube.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY) {
  const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  logger.info(`Using proxy from environment: ${proxyUrl}`, { stage: 'init' });
  setGlobalDispatcher(
    new EnvHttpProxyAgent({
      connect: { timeout: 60_000 },
      headersTimeout: 180_000,
      bodyTimeout: 180_000
    })
  );
}

const app = express();
const PORT = process.env.PORT || 3030;

app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, '../public')));

// Request logging middleware
app.use((req: Request, _res: Response, next: NextFunction) => {
  const requestId = (req.headers['x-request-id'] as string) || crypto.randomUUID().slice(0, 8);
  req.headers['x-request-id'] = requestId;
  if (!req.path.startsWith('/public') && !req.path.endsWith('.css') && !req.path.endsWith('.js')) {
    logger.debug(`${req.method} ${req.path}`, { requestId });
  }
  next();
});

// Few-Shot Prompt calibrated precisely to the user's gold standard
const SUMMARY_PROMPT = `你是一位世界顶尖的科技商业战略特稿记者与对话速记主编。
任务：请结合提供的【视频官方背景、简介、嘉宾名单与时间戳章节】以及【全文字幕】，提炼出一份极高信息密度的【中文深度对话总结】。

### 核心规则与结构规范：

1. 【发言人精准识别（极重要）】：
   - 必须严格结合视频官方简介中指出的真实主持人、嘉宾和演讲者名单（如 Marc Andreessen, Ben Horowitz, Chris Dixon, Erik Torenberg, Jen Kha 等），识别每一句发言的真实人物。
   - 严禁脑补不存在或通用的虚拟名字（如随意用通用名代替实际嘉宾）。如果有多位嘉宾，必须按各自背景和对话语境进行准确区分。

2. 【章节划分准则（极重要）】：
   - 如果视频官方简介提供了 Timestamps（时间戳大纲），请【高度参考并对齐官方时间戳章节的主旨】来组织二级标题 ##，保证大纲与视频创作者的官方主题划分完全一致。
   - 如果官方简介没有提供时间戳，则根据对话论点自主划分 8-10 个宏观大主题。
   - 严禁在章节标题中添加多余的破折号“---”。

3. 【格式与排版层次】：
   - 页面最开始使用唯一的单井号 # 输出一个高屋建瓴的总标题，例如：
     # 对话安德森：AI革命的万亿美金之问
   - 二级标题 ## 表示宏观大主题，例如：
     ## 技术革命渊源：八十年计算范式重构与硅谷进化论
   - 三级标题 ### 表示大主题下的子议题（每个大主题包含 2-4 个子议题），例如：
     ### AI公司的收入增长与产品演变
   - 子议题下方展开具体的问答，严格按以下颗粒度提炼：
     - 提问部分精简为一针见血的核心问题：
       Erik: 面对AI带来的重大战略和经济疑问，公司与风投机构的应对策略有何不同？
     - 回答部分分段阐述，去除口癖和寒暄，完整保留回答者深刻的逻辑、数据、商业洞察与判断：
       Marc: 这些是价值数万亿美元的问题，目前还没有定论...
   - 严禁出现空章节，严禁使用“---”分割线。文字表达干练、准确、深刻。`;

// 1. RESTful Summary Query Endpoint (For Page Refresh / Cache Hit)
app.get('/api/summary/:videoId', (req: Request, res: Response) => {
  const requestId = (req.headers['x-request-id'] as string) || crypto.randomUUID().slice(0, 8);
  const videoId = String(req.params.videoId || '').trim();
  const context: LogContext = { requestId, videoId, stage: 'query_summary' };

  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return res.status(400).json({
      error: '无效的 YouTube Video ID 格式',
      code: 'INVALID_URL',
      debug: { requestId, timestamp: new Date().toISOString() }
    });
  }

  try {
    const video = dbService.getVideoByYoutubeId(videoId);
    if (!video) {
      return res.json({ exists: false, videoId });
    }

    const summaryMarkdown = dbService.getSummary(video.id);
    if (!summaryMarkdown) {
      return res.json({ exists: false, video });
    }

    // Load all existing 5W1H entries for this video
    const fiveWoneHList = dbService.getAll5W1HForVideo(video.id);

    logger.debug(`Found cached summary in database (${summaryMarkdown.length} chars, ${fiveWoneHList.length} 5W1H items)`, context);

    return res.json({
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
    return res.status(classified.statusCode).json(classified.toJSON());
  }
});

// 2. Streaming Summary Endpoint (D1/SQLite Persistent with Retries & Hardened Error Handling)
app.post('/api/summarize-stream', async (req: Request, res: Response) => {
  const requestId = (req.headers['x-request-id'] as string) || crypto.randomUUID().slice(0, 8);
  const { url, forceRefresh } = req.body || {};

  if (!url || typeof url !== 'string' || !url.trim()) {
    const err = new AppError({
      code: 'INVALID_INPUT',
      statusCode: 400,
      userMessage: '请输入有效的 YouTube 视频链接或 11 位 Video ID。',
      requestId
    });
    return res.status(err.statusCode).json(err.toJSON());
  }

  const videoId = extractVideoId(url);
  if (!videoId) {
    const err = new AppError({
      code: 'INVALID_URL',
      statusCode: 400,
      userMessage: '无法识别输入的链接格式。请输入标准的 YouTube 视频链接或 11 位 ID。',
      requestId
    });
    return res.status(err.statusCode).json(err.toJSON());
  }

  const context: LogContext = { requestId, videoId, stage: 'summarize_stream' };
  logger.info(`Starting summarize request for video: ${videoId} (forceRefresh=${!!forceRefresh})`, context);

  const effectiveKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!effectiveKey) {
    const err = new AppError({
      code: 'AI_API_KEY_MISSING',
      statusCode: 500,
      userMessage: '服务端未配置 GEMINI_API_KEY 环境变量，请在 .env 中进行配置。',
      requestId,
      videoId
    });
    return res.status(err.statusCode).json(err.toJSON());
  }

  // Set SSE Headers
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  let clientDisconnected = false;
  res.on('close', () => {
    if (!res.writableEnded) {
      clientDisconnected = true;
      logger.info('Client aborted response connection prematurely', context);
    }
  });

  const sendEvent = (data: any) => {
    if (clientDisconnected || res.writableEnded) return;
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Initial handshake
  sendEvent({ status: 'connected', requestId, videoId });

  // Check Database Cache first unless forceRefresh requested
  const existingVideo = dbService.getVideoByYoutubeId(videoId);
  if (existingVideo && !forceRefresh) {
    const cachedSummary = dbService.getSummary(existingVideo.id);
    if (cachedSummary && cachedSummary.trim().length > 50) {
      logger.info(`Cache Hit: Returning stored summary for ${videoId}`, context);
      sendEvent({ status: 'ready', videoId, fromCache: true, title: existingVideo.title });
      sendEvent({ text: cachedSummary });
      res.write('data: [DONE]\n\n');
      return res.end();
    }
  }

  const videoUuid = existingVideo?.id || crypto.randomUUID();
  let fullMarkdown = '';

  try {
    // 1. Fetch Official Metadata (with retry and timeout)
    sendEvent({ status: 'fetching_transcript', message: '正在提取视频官方背景、演职员名单与时间戳章节...' });
    const meta = await fetchYoutubeMetadata(videoId, context);

    try {
      dbService.upsertVideo(videoUuid, videoId, `https://www.youtube.com/watch?v=${videoId}`, meta.title, meta.description);
    } catch (dbErr: any) {
      logger.warn('Failed to upsert video record in db (non-fatal)', context, dbErr);
    }

    if (clientDisconnected) return res.end();

    // 2. Fetch Transcript (with multi-language fallback and retries)
    sendEvent({ status: 'fetching_transcript', message: '正在从 YouTube 获取全文字幕与对话音轨...' });
    let plainText = dbService.getTranscript(videoUuid);

    if (!plainText) {
      plainText = await fetchTranscriptWithRetry(videoId, context);
      try {
        dbService.saveTranscript(videoUuid, plainText);
      } catch (dbErr: any) {
        logger.warn('Failed to cache transcript in db (non-fatal)', context, dbErr);
      }
    } else {
      logger.info(`Loaded transcript from database cache (${plainText.length} chars)`, context);
    }

    if (clientDisconnected) return res.end();

    sendEvent({ status: 'ready', videoId, title: meta.title, fromCache: false });

    // 3. Stream Gemini summary with retries on stream initiation
    const ai = new GoogleGenAI({ apiKey: effectiveKey });
    const modelName = 'gemini-3.8-flash';

    logger.info(`Calling Gemini model: ${modelName} (transcript length: ${plainText.length})...`, context);

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
          model: modelName,
          contents: [
            {
              role: 'user',
              parts: [
                { text: SUMMARY_PROMPT },
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

    sendEvent({ status: 'streaming', message: '正在通过 Gemini 3.8 Flash 实时流式提炼总结...' });

    // Read chunks from Gemini stream
    for await (const chunk of responseStream) {
      if (clientDisconnected) {
        logger.info('Client disconnected mid-stream. Halting chunk read.', context);
        break;
      }

      const text = chunk.text || '';
      if (text) {
        fullMarkdown += text;
        sendEvent({ text });
      }
    }

    // Persist full summary to SQLite if meaningful content was generated
    if (fullMarkdown && fullMarkdown.trim().length > 50) {
      try {
        dbService.saveSummary(videoUuid, fullMarkdown);
        logger.info(`Successfully persisted full summary to DB (${fullMarkdown.length} chars)`, context);
      } catch (dbErr: any) {
        logger.error('Failed to save summary to DB', dbErr, context);
      }
    }

    if (!clientDisconnected && !res.writableEnded) {
      res.write('data: [DONE]\n\n');
      res.end();
    }
  } catch (rawError: any) {
    logger.error('Error during summarize-stream execution', rawError, context);
    const appError = classifyError(rawError, context);

    // If partial summary was accumulated before error, persist it!
    if (fullMarkdown && fullMarkdown.trim().length > 100) {
      try {
        dbService.saveSummary(videoUuid, fullMarkdown);
        logger.warn(`Persisted partial summary (${fullMarkdown.length} chars) before error`, context);
      } catch {}
    }

    if (!clientDisconnected && !res.writableEnded) {
      sendEvent({
        ...appError.toJSON(),
        partialAvailable: fullMarkdown.trim().length > 50
      });
      res.end();
    }
  }
});

// Helper to locate a specific chapter inside the stored summaryMarkdown
function extractSectionFromSummary(summaryMarkdown: string, heading: string): string {
  const cleanHeading = heading.replace(/^[#\s一二三四五六七八九十\d.、-]+/, '').trim();
  const escaped = cleanHeading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`##\\s+.*?${escaped}[\\s\\S]*?(?=(?:^##\\s+)|$)`, 'm');
  const match = summaryMarkdown.match(regex);
  if (match) {
    return match[0].trim();
  }
  return '';
}

// Clean and safely parse JSON returned by LLM, handling Markdown code fences or extra wrapping
function parse5W1HJson(rawText: string): any {
  if (!rawText) throw new Error('AI 返回内容为空');

  let cleaned = rawText.trim();
  // Strip Markdown code fence if present
  const codeBlockMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (codeBlockMatch) {
    cleaned = codeBlockMatch[1].trim();
  }

  // Find boundaries of outer JSON object
  const startIdx = cleaned.indexOf('{');
  const endIdx = cleaned.lastIndexOf('}');
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    cleaned = cleaned.slice(startIdx, endIdx + 1);
  }

  // Remove potential trailing commas before closing braces
  cleaned = cleaned.replace(/,\s*([}\]])/g, '$1');

  const parsed = JSON.parse(cleaned);

  // Validate expected fields
  const fields = ['who', 'what', 'when', 'where', 'why', 'how'];
  const missing = fields.filter((f) => !parsed[f] || typeof parsed[f] !== 'string');
  if (missing.length > 2) {
    throw new Error(`JSON 缺少核心 5W1H 字段: ${missing.join(', ')}`);
  }

  return {
    who: String(parsed.who || '核心人物').trim(),
    what: String(parsed.what || '').trim(),
    when: String(parsed.when || '').trim(),
    where: String(parsed.where || '').trim(),
    why: String(parsed.why || '').trim(),
    how: String(parsed.how || '').trim()
  };
}

// 3. 5W1H Summary Endpoint: Robust Generation with Retries, Hardened Parsing & Error Reporting
app.post('/api/5w1h', async (req: Request, res: Response) => {
  const requestId = (req.headers['x-request-id'] as string) || crypto.randomUUID().slice(0, 8);
  const { videoId, sectionHeading } = req.body || {};

  if (!videoId || !sectionHeading) {
    const err = new AppError({
      code: 'INVALID_INPUT',
      statusCode: 400,
      userMessage: '缺少必要参数: videoId 或 sectionHeading。',
      requestId
    });
    return res.status(err.statusCode).json(err.toJSON());
  }

  const context: LogContext = { requestId, videoId, stage: '5w1h' };
  logger.info(`5W1H requested for section: "${sectionHeading}"`, context);

  try {
    const video = dbService.getVideoByYoutubeId(videoId);
    if (!video) {
      throw new AppError({
        code: 'VIDEO_UNAVAILABLE',
        statusCode: 404,
        userMessage: '未在本地数据库中找到该视频记录，请先生成总结。',
        ...context
      });
    }

    // 1. Check if 5W1H already persisted in D1/SQLite
    const cached5W1H = dbService.get5W1H(video.id, sectionHeading);
    if (cached5W1H) {
      logger.info(`5W1H Cache Hit for "${sectionHeading}"`, context);
      return res.json({
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

    // 2. Retrieve the stored summaryMarkdown
    const summaryMarkdown = dbService.getSummary(video.id);
    if (!summaryMarkdown) {
      throw new AppError({
        code: 'INVALID_INPUT',
        statusCode: 404,
        userMessage: '该视频尚未生成完整总结，请先生成总结后再提取 5W1H。',
        ...context
      });
    }

    const effectiveKey = (process.env.GEMINI_API_KEY || '').trim();
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

    const prompt = `你是一位高阶科技与商业分析师。
请严格基于服务端保存的【本次生成的对话总结】以及【视频官方背景与真实出场人物】，对章节【${sectionHeading}】进行极简明、高信息密度的 5W1H 归纳。

【视频官方背景与出场人物说明】
视频标题：${video.title || '未知'}
官方简介与嘉宾：${video.description ? video.description.slice(0, 800) : '未知'}

【本次生成的完整对话总结】
${summaryMarkdown}

【当前待归纳的目标章节内容】
${targetSection || `章节标题：${sectionHeading}`}

### 严格的精简输出范式（每项仅1-2句话，直击本质，言简意赅）：
例如：
Who: Mark Andreessen 与 Jen Kha
What: AI 行业的收入增长、商业模式、普及速度、定价方式和单位成本下降趋势。
When: 当前 AI 商业化早期，以及未来十年。
Where: 消费者 AI 市场、企业 AI 市场、云服务和数据中心基础设施领域。
Why: AI 可以依托已有互联网快速触达全球用户，并能为个人和企业直接创造效率提升、收入增长和成本优化等价值。
How: 通过消费者订阅、企业按需 token 计费和基于业务价值的变现方式获得收入；同时随着 GPU 和数据中心供给改善，单位成本下降会进一步扩大需求。

### 必须输出纯合法 JSON，不带任何 Markdown 代码块，字段：
{
  "who": "核心发言人/主体（必须使用真实人物姓名，如 Mark Andreessen、Ben Horowitz、Chris Dixon 或 Erik Torenberg，严禁使用虚构代称）",
  "what": "探讨的核心主题与商业/技术事件（1句话精炼）",
  "when": "涉及的时间阶段（1句话精炼）",
  "where": "涉及的市场或场景范围（1句话精炼）",
  "why": "背后的核心逻辑与原因（1-2句精炼）",
  "how": "具体的实现方式与商业策略（1-2句精炼）"
}`;

    // Call Gemini with retries and parse verification
    const parsedData = await retryWithBackoff(
      async (attempt) => {
        logger.debug(`Calling Gemini for 5W1H (attempt ${attempt})...`, context);
        const response = await ai.models.generateContent({
          model: 'gemini-3.8-flash',
          contents: prompt,
          config: {
            responseMimeType: 'application/json'
          }
        });

        const rawText = response.text || '';
        try {
          return parse5W1HJson(rawText);
        } catch (parseErr: any) {
          logger.warn(`Failed to parse 5W1H JSON response on attempt ${attempt}: ${parseErr.message}`, context, { rawSnippet: rawText.slice(0, 200) });
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

    // Persist into SQLite / D1
    const w5hId = crypto.randomUUID();
    try {
      dbService.save5W1H(w5hId, video.id, sectionHeading, parsedData);
      logger.info(`Successfully saved 5W1H for "${sectionHeading}"`, context);
    } catch (dbErr: any) {
      logger.warn('Failed to save 5W1H to db (non-fatal)', context, dbErr);
    }

    return res.json({
      sectionHeading,
      data: parsedData
    });
  } catch (err: any) {
    logger.error('Error in /api/5w1h', err, context);
    const appError = classifyError(err, context);
    return res.status(appError.statusCode).json(appError.toJSON());
  }
});

// 4. Delete / Clear Video Data Endpoint (Supports DELETE & POST /clear)
const handleClearVideoData = (req: Request, res: Response) => {
  const requestId = (req.headers['x-request-id'] as string) || crypto.randomUUID().slice(0, 8);
  const videoId = String(req.params.videoId || '').trim();
  const context: LogContext = { requestId, videoId, stage: 'delete_video' };

  logger.info(`Request to clear stored data for video: ${videoId}`, context);

  try {
    const result = dbService.deleteVideoData(videoId);
    if (!result.deleted) {
      return res.status(404).json({
        success: false,
        error: '未在本地数据库中找到该视频的数据记录。',
        code: 'VIDEO_NOT_FOUND',
        videoId
      });
    }

    logger.info(`Successfully cleared data for video ${videoId}`, context, result.counts);
    return res.json({
      success: true,
      message: `已清除该视频的所有本地数据（字幕、完整总结及 ${result.counts.chapter5w1h} 个 5W1H 章节分析）。`,
      videoId,
      counts: result.counts
    });
  } catch (err: any) {
    logger.error('Failed to delete video data', err, context);
    const classified = classifyError(err, context);
    return res.status(classified.statusCode).json(classified.toJSON());
  }
};

app.delete('/api/video/:videoId([a-zA-Z0-9_-]{11})', handleClearVideoData);
app.post('/api/video/:videoId([a-zA-Z0-9_-]{11})/clear', handleClearVideoData);

// 5. RESTful URL Support: /summary/:videoId and /video/:videoId serve index.html (SPA)
app.get(['/summary/:videoId([a-zA-Z0-9_-]{11})', '/video/:videoId([a-zA-Z0-9_-]{11})'], (_req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Global 404 Handler for API routes
app.all('/api/*', (req: Request, res: Response) => {
  const err = new AppError({
    code: 'INVALID_INPUT',
    statusCode: 404,
    userMessage: `未找到请求的接口路径: ${req.path}`,
    requestId: req.headers['x-request-id'] as string
  });
  res.status(404).json(err.toJSON());
});

// Global Error Handling Middleware
app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
  const requestId = req.headers['x-request-id'] as string;
  const appError = classifyError(err, { requestId, stage: 'express_unhandled' });
  logger.error('Unhandled express error', err, { requestId });
  res.status(appError.statusCode).json(appError.toJSON());
});

app.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`🚀 YouTube Transcript App Ready: http://localhost:${PORT}`);
  console.log(`   Port: ${PORT} | Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`======================================================\n`);
});
