export type ErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_URL'
  | 'VIDEO_UNAVAILABLE'
  | 'NO_TRANSCRIPT'
  | 'TRANSCRIPT_DISABLED'
  | 'YOUTUBE_RATE_LIMIT'
  | 'YOUTUBE_NETWORK_ERROR'
  | 'AI_API_KEY_MISSING'
  | 'AI_API_KEY_INVALID'
  | 'AI_RATE_LIMIT'
  | 'AI_SERVICE_UNAVAILABLE'
  | 'AI_PARSE_ERROR'
  | 'DATABASE_ERROR'
  | 'TIMEOUT_ERROR'
  | 'CLIENT_ABORT'
  | 'INTERNAL_SERVER_ERROR';

export interface DebugInfo {
  timestamp: string;
  requestId?: string;
  videoId?: string;
  stage?: string;
  originalName?: string;
  originalMessage?: string;
  stackSnippet?: string;
  attempts?: number;
  statusCode?: number;
  rawDetails?: any;
}

export class AppError extends Error {
  public readonly code: ErrorCode;
  public readonly statusCode: number;
  public readonly userMessage: string;
  public readonly retryable: boolean;
  public readonly debugInfo: DebugInfo;

  constructor(options: {
    code: ErrorCode;
    statusCode?: number;
    userMessage: string;
    message?: string;
    retryable?: boolean;
    cause?: any;
    requestId?: string;
    videoId?: string;
    stage?: string;
    attempts?: number;
    rawDetails?: any;
  }) {
    super(options.message || options.userMessage);
    this.name = 'AppError';
    this.code = options.code;
    this.statusCode = options.statusCode || 500;
    this.userMessage = options.userMessage;
    this.retryable = options.retryable ?? false;

    const stack = options.cause instanceof Error ? options.cause.stack : this.stack;
    const stackSnippet = stack ? stack.split('\n').slice(0, 4).join('\n') : undefined;

    this.debugInfo = {
      timestamp: new Date().toISOString(),
      requestId: options.requestId,
      videoId: options.videoId,
      stage: options.stage,
      originalName: options.cause?.name || this.name,
      originalMessage: options.cause?.message || options.message || this.message,
      stackSnippet,
      attempts: options.attempts,
      statusCode: this.statusCode,
      rawDetails: options.rawDetails
    };
  }

  toJSON() {
    return {
      error: this.userMessage,
      code: this.code,
      retryable: this.retryable,
      debug: this.debugInfo
    };
  }
}

/**
 * Maps arbitrary runtime errors from YouTube, Google GenAI, SQLite, or network into AppError.
 */
export function classifyError(err: any, context?: { requestId?: string; videoId?: string; stage?: string; attempts?: number }): AppError {
  if (err instanceof AppError) {
    return err;
  }

  const rawMessage = err?.message || String(err || '未知错误');
  const lowerMsg = rawMessage.toLowerCase();
  const name = err?.name || '';
  const status = Number(err?.status || err?.statusCode || 0);

  // 1. YouTube Transcript Specific Errors
  if (name.includes('YoutubeTranscriptDisabled') || lowerMsg.includes('transcript is disabled')) {
    return new AppError({
      code: 'TRANSCRIPT_DISABLED',
      statusCode: 422,
      userMessage: '该视频已被创作者关闭或禁用了字幕功能，无法提取文字内容。',
      cause: err,
      retryable: false,
      ...context
    });
  }

  if (name.includes('YoutubeTranscriptVideoUnavailable') || lowerMsg.includes('video is unavailable') || lowerMsg.includes('private video')) {
    return new AppError({
      code: 'VIDEO_UNAVAILABLE',
      statusCode: 404,
      userMessage: '该 YouTube 视频无法访问，可能已被删除、设为私享或存在地区版权限制。',
      cause: err,
      retryable: false,
      ...context
    });
  }

  if (name.includes('YoutubeTranscriptNotAvailable') || lowerMsg.includes('could not find captions') || lowerMsg.includes('no transcript')) {
    return new AppError({
      code: 'NO_TRANSCRIPT',
      statusCode: 422,
      userMessage: '未在该视频中找到字幕（创作者未上传字幕且 YouTube 未生成自动字幕）。请尝试选择带有字幕的视频。',
      cause: err,
      retryable: false,
      ...context
    });
  }

  if (name.includes('YoutubeTranscriptTooManyRequest') || (lowerMsg.includes('too many requests') && context?.stage?.includes('youtube'))) {
    return new AppError({
      code: 'YOUTUBE_RATE_LIMIT',
      statusCode: 429,
      userMessage: 'YouTube 请求频次受限 (429 Too Many Requests)，可能当前 IP 触发了 YouTube 防刷限制。系统已自动重试多次，请稍后再试或配置代理。',
      cause: err,
      retryable: true,
      ...context
    });
  }

  // 2. Gemini / AI Errors
  if (status === 401 || status === 403 || lowerMsg.includes('api_key_invalid') || lowerMsg.includes('permission_denied') || lowerMsg.includes('unauthenticated')) {
    return new AppError({
      code: 'AI_API_KEY_INVALID',
      statusCode: 403,
      userMessage: 'Gemini API 密钥无效或权限不足，请在服务端 .env 中核对 GEMINI_API_KEY。',
      cause: err,
      retryable: false,
      ...context
    });
  }

  if (status === 429 || lowerMsg.includes('resource_exhausted') || lowerMsg.includes('quota') || lowerMsg.includes('rate limit')) {
    return new AppError({
      code: 'AI_RATE_LIMIT',
      statusCode: 429,
      userMessage: 'Gemini AI API 当前调用过于频繁或超出配额限制 (429 Rate Limit)。系统已自动尝试回退与重试，请稍候片刻再试。',
      cause: err,
      retryable: true,
      ...context
    });
  }

  if (status === 500 || status === 502 || status === 503 || status === 504 || lowerMsg.includes('overloaded') || lowerMsg.includes('unavailable')) {
    return new AppError({
      code: 'AI_SERVICE_UNAVAILABLE',
      statusCode: 503,
      userMessage: 'Gemini AI 服务暂时不可用或内部繁忙 (503/500)。系统已尝试重试，请稍后刷新重试。',
      cause: err,
      retryable: true,
      ...context
    });
  }

  // 3. Network / Timeout Errors
  if (
    lowerMsg.includes('timeout') ||
    lowerMsg.includes('econnreset') ||
    lowerMsg.includes('und_err_connect_timeout') ||
    name === 'TimeoutError'
  ) {
    return new AppError({
      code: 'TIMEOUT_ERROR',
      statusCode: 504,
      userMessage: '连接外部服务超时。可能是网络延迟过高或代理响应缓慢，请检查网络后重试。',
      cause: err,
      retryable: true,
      ...context
    });
  }

  if (lowerMsg.includes('fetch failed') || lowerMsg.includes('econnrefused') || lowerMsg.includes('enotfound')) {
    return new AppError({
      code: 'YOUTUBE_NETWORK_ERROR',
      statusCode: 502,
      userMessage: '无法连接到远程服务 (Fetch Failed)。请检查网络连接及代理设置 (HTTP_PROXY / HTTPS_PROXY)。',
      cause: err,
      retryable: true,
      ...context
    });
  }

  // 4. SQLite / DB Errors
  if (name.includes('Sqlite') || lowerMsg.includes('sqlite') || lowerMsg.includes('database')) {
    return new AppError({
      code: 'DATABASE_ERROR',
      statusCode: 500,
      userMessage: '本地数据库读写异常，请检查数据目录读写权限或并发锁状态。',
      cause: err,
      retryable: true,
      ...context
    });
  }

  // 5. Default Fallback
  return new AppError({
    code: 'INTERNAL_SERVER_ERROR',
    statusCode: 500,
    userMessage: `处理请求时发生未知错误: ${rawMessage}`,
    cause: err,
    retryable: true,
    ...context
  });
}
