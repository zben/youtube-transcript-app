/**
 * Drop-in `fetch` for YouTube, sent over a raw TLS socket instead of Worker `fetch`.
 *
 * Why: Worker `fetch` egress (`2a06:98c0:3600::103`, measured 2026-11-12) is distrusted by
 * YouTube — the watch page 429s and innertube answers `LOGIN_REQUIRED` — while outbound TCP from
 * `cloudflare:sockets` comes from a different prefix that YouTube still serves ASR caption tracks
 * to. Pointing `connect()` at the real host means TLS carries the correct SNI, which is the part
 * a proxied tunnel could not do (workerd fixes SNI at `connect()` time; `startTls()` cannot
 * override it).
 *
 * Scope is deliberately narrow: only `youtube.com`/`youtu.be` hosts are diverted, everything else
 * (Gemini included) goes through the platform `fetch`, and any socket failure falls back to it.
 */
import { connect } from 'cloudflare:sockets';
import { logger } from './logger.js';

type Bytes = Uint8Array<ArrayBufferLike>;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const DEFAULT_TIMEOUT_MS = 25_000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_REDIRECTS = 3;

const TRUSTED_HOSTS = ['youtube.com', 'youtu.be'];

function hostNeedsSocket(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return TRUSTED_HOSTS.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  } catch {
    return false;
  }
}

function indexOfBytes(hay: Bytes, needle: Bytes, from = 0): number {
  outer: for (let i = from; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

const appendBytes = (a: Bytes, b: Bytes): Bytes => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
};

async function gunzip(bytes: Bytes): Promise<Bytes> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function dechunk(body: Bytes): Bytes {
  let out: Bytes = new Uint8Array(0);
  let cursor = 0;
  for (;;) {
    const lineEnd = indexOfBytes(body.subarray(cursor), textEncoder.encode('\r\n'));
    if (lineEnd < 0) break;
    const size = parseInt(textDecoder.decode(body.slice(cursor, cursor + lineEnd)).split(';')[0].trim(), 16);
    if (!Number.isFinite(size)) break;
    cursor += lineEnd + 2;
    if (size === 0) break;
    out = appendBytes(out, body.slice(cursor, cursor + size));
    cursor += size + 2;
  }
  return out;
}

async function withDeadline<T>(promise: Promise<T>, ms: number, label: string, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const aborts = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    if (signal) {
      onAbort = () => reject(new Error(`${label} aborted`));
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
  try {
    return await Promise.race([promise, aborts]);
  } finally {
    clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
}

async function socketGet(
  request: Request,
  timeoutMs: number
): Promise<{ status: number; headers: [string, string][]; body: Bytes }> {
  const target = new URL(request.url);
  if (target.protocol !== 'https:' || (target.port && target.port !== '443')) {
    throw new Error(`only https:443 is supported over a socket (${target.protocol}//${target.host})`);
  }

  const socket = connect({ hostname: target.hostname, port: 443 }, { secureTransport: 'on', allowHalfOpen: false });
  const reader = socket.readable.getReader();
  try {
    await withDeadline(socket.opened, timeoutMs, `connect ${target.hostname}`, request.signal);

    const writer = socket.writable.getWriter();
    // `Connection: close` means the body must be length-delimited, and a Request built from a body
    // does not carry content-length, so the innertube POST would arrive empty without this.
    const bodyBytes = request.method === 'GET' || request.method === 'HEAD' ? null : new Uint8Array(await request.arrayBuffer());
    const head =
      [...request.headers]
        .filter(([name]) => !/^content-length$/i.test(name))
        .map(([name, value]) => `${name}: ${value}\r\n`)
        .join('') + (bodyBytes ? `content-length: ${bodyBytes.byteLength}\r\n` : '');
    await writer.write(
      textEncoder.encode(
        `${request.method} ${target.pathname}${target.search} HTTP/1.1\r\n` +
          `Host: ${target.hostname}\r\nConnection: close\r\n${head}\r\n`
      )
    );
    if (bodyBytes && bodyBytes.byteLength > 0) await writer.write(bodyBytes);
    writer.releaseLock();

    let raw: Bytes = new Uint8Array(0);
    for (;;) {
      const { value, done } = await withDeadline(reader.read(), timeoutMs, `read ${target.hostname}`, request.signal);
      if (done) break;
      if (!value) continue;
      raw = appendBytes(raw, value);
      if (raw.length > MAX_BODY_BYTES) throw new Error(`response exceeded ${MAX_BODY_BYTES} bytes`);
    }

    const split = indexOfBytes(raw, textEncoder.encode('\r\n\r\n'));
    if (split < 0) throw new Error('response had no header terminator');
    const headText = textDecoder.decode(raw.slice(0, split));
    const status = Number(/HTTP\/[\d.]+\s+(\d{3})/.exec(headText)?.[1]);
    if (!Number.isInteger(status)) throw new Error(`unparsable status line: ${headText.slice(0, 60)}`);

    const headers: [string, string][] = [];
    for (const line of headText.split('\r\n').slice(1)) {
      const sep = line.indexOf(':');
      if (sep > 0) headers.push([line.slice(0, sep).trim(), line.slice(sep + 1).trim()]);
    }

    let body: Bytes = raw.slice(split + 4);
    const map = new Map(headers.map(([k, v]) => [k.toLowerCase(), v]));
    if ((map.get('transfer-encoding') || '').includes('chunked')) body = dechunk(body);
    if ((map.get('content-encoding') || '').includes('gzip')) body = await gunzip(body);

    return { status, headers, body };
  } finally {
    reader.releaseLock();
    await socket.close().catch(() => undefined);
  }
}

/** Same signature as `fetch`, so it can be installed in place of the platform implementation. */
export async function socketFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const base = input instanceof Request ? input : new Request(typeof input === 'string' ? input : String(input), init);
  const request = init ? new Request(base, init) : base;
  const timeoutMs = 25_000;

  let current = request;
  for (let hop = 0; ; hop++) {
    const { status, headers, body } = await socketGet(current, timeoutMs);
    const location = headers.find(([name]) => name.toLowerCase() === 'location')?.[1];

    if (location && status >= 300 && status < 400) {
      if (hop >= MAX_REDIRECTS) throw new Error('too many redirects');
      const next = new URL(location, current.url).toString();
      if (!hostNeedsSocket(next)) throw new Error(`redirect left the socket scope: ${next}`);
      current = new Request(next, { method: 'GET', headers: current.headers, signal: current.signal });
      continue;
    }

    const responseHeaders = new Headers(headers.filter(([name]) => !/^connection|transfer-encoding|content-length|content-encoding$/i.test(name)));
    // Hop-by-hop length/encoding headers are invalid once the body has been framed and inflated.
    const contentType = headers.find(([name]) => name.toLowerCase() === 'content-type')?.[1];
    if (contentType) responseHeaders.set('content-type', contentType);
    if (status === 204 || status === 304) return new Response(null, { status, headers: responseHeaders });
    return new Response(body as unknown as BodyInit, { status, headers: responseHeaders });
  }
}

/**
 * Wraps the platform `fetch`, diverting only YouTube hosts to the socket path. Kept as a wrapper
 * rather than a hard replacement so a socket regression degrades to today's behaviour instead of
 * breaking generation outright.
 */
export function withSocketEgress(platformFetch: typeof fetch): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let url: string;
    try {
      url = input instanceof Request ? input.url : String(input);
    } catch {
      return platformFetch(input as RequestInfo, init);
    }

    if (!hostNeedsSocket(url)) return platformFetch(input as RequestInfo, init);

    try {
      return await socketFetch(input, init);
    } catch (err: any) {
      logger.warn(`socket egress failed for ${url}: ${err?.message || err}; falling back to fetch`, {
        stage: 'socket_egress'
      });
      return platformFetch(input as RequestInfo, init);
    }
  };
}
