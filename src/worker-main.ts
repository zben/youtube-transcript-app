import { createApp } from './app.js';
import { D1Repository, type D1DatabaseLike } from './repositories/d1.js';
import { configureLogger } from './utils/logger.js';
import { withSocketEgress } from './utils/socket-fetch.js';

// YouTube distrusts Worker `fetch` egress but still serves ASR captions to the `cloudflare:sockets`
// prefix, so YouTube calls are diverted there once per isolate. Imported only by this entry, because
// `cloudflare:sockets` does not exist under Node.
globalThis.fetch = withSocketEgress(globalThis.fetch);

export interface Env {
  DB: D1DatabaseLike;
  ASSETS: { fetch: (request: Request) => Promise<Response> };
  GEMINI_API_KEY?: string;
  DEBUG?: string;
}

// Routes owned by the Worker; everything else is served from the static assets bundle.
const WORKER_FIRST_PREFIXES = ['/api/', '/summary/', '/video/'];

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    configureLogger({ debug: env.DEBUG === 'true' });

    const { pathname } = new URL(request.url);
    if (!WORKER_FIRST_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
      return env.ASSETS.fetch(request);
    }

    const app = createApp({
      repo: new D1Repository(env.DB),
      geminiApiKey: env.GEMINI_API_KEY,
      spaHtmlResponse: () =>
        env.ASSETS.fetch(new Request(new URL('/index.html', request.url).toString(), { method: 'GET' })),
      waitUntil: (promise) => ctx.waitUntil(promise)
    });

    return app.fetch(request, env, ctx);
  }
} satisfies ExportedHandler<Env>;
