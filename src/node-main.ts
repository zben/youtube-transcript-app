import path from 'path';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { serve } from '@hono/node-server';
import { setGlobalDispatcher, EnvHttpProxyAgent } from 'undici';
import { createApp } from './app.js';
import { SqliteRepository } from './repositories/sqlite.js';
import { logger, configureLogger } from './utils/logger.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

configureLogger({ debug: !!process.env.DEBUG || process.env.NODE_ENV !== 'production' });

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

const PUBLIC_DIR = path.join(__dirname, '../public');
const DATA_DIR = path.join(__dirname, '../data');
const PORT = Number(process.env.PORT || 3030);

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

async function readPublicFile(relativePath: string): Promise<{ body: Buffer; contentType: string } | null> {
  const resolved = path.normalize(path.join(PUBLIC_DIR, relativePath));
  if (resolved !== PUBLIC_DIR && !resolved.startsWith(PUBLIC_DIR + path.sep)) return null;

  try {
    const body = await readFile(resolved);
    const contentType = MIME_TYPES[path.extname(resolved).toLowerCase()] || 'application/octet-stream';
    return { body, contentType };
  } catch {
    return null;
  }
}

const indexHtmlResponse = async (): Promise<Response> => {
  const file = await readPublicFile('index.html');
  if (!file) {
    return new Response('public/index.html is missing', { status: 500 });
  }
  return new Response(new Uint8Array(file.body), {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }
  });
};

async function serveStaticAsset(pathname: string): Promise<Response | null> {
  if (pathname.startsWith('/api/')) return null;

  const relative = decodeURIComponent(pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, ''));
  const file = await readPublicFile(relative);
  if (!file) return null;

  return new Response(new Uint8Array(file.body), {
    headers: { 'Content-Type': file.contentType, 'Cache-Control': 'no-cache' }
  });
}

const app = createApp({
  repo: new SqliteRepository(DATA_DIR),
  geminiApiKey: process.env.GEMINI_API_KEY,
  spaHtmlResponse: indexHtmlResponse
});

const fetchHandler = async (request: Request): Promise<Response> => {
  const { pathname } = new URL(request.url);
  return (await serveStaticAsset(pathname)) ?? app.fetch(request);
};

serve({ fetch: fetchHandler, port: PORT }, () => {
  console.log(`\n======================================================`);
  console.log(`🚀 YouTube Transcript App Ready: http://localhost:${PORT}`);
  console.log(`   Port: ${PORT} | Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`======================================================\n`);
});
