import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { FakeRepository } from './helpers/fake-repo.js';

function makeApp(repo: FakeRepository) {
  return createApp({
    repo,
    geminiApiKey: 'test-key',
    spaHtmlResponse: () => new Response('<html>spa</html>', { headers: { 'Content-Type': 'text/html' } })
  });
}

const post = (app: ReturnType<typeof makeApp>, path: string, body: unknown) =>
  app.fetch(new Request(`http://localhost${path}`, { method: 'POST', body: JSON.stringify(body) }));

test('GET /api/summary/:videoId returns cached summary plus all stored 5W1H', async () => {
  const repo = new FakeRepository();
  const app = makeApp(repo);

  const res = await app.fetch(new Request('http://localhost/api/summary/xRh2sVcNXQ8'));
  const data = (await res.json()) as any;

  assert.equal(res.status, 200);
  assert.equal(data.exists, true);
  assert.equal(data.videoId, 'xRh2sVcNXQ8');
  assert.match(data.summaryMarkdown, /对话安德森/);
  assert.ok(Array.isArray(data.fiveWoneHList));
});

test('GET /api/summary/:videoId reports exists:false for an unknown video', async () => {
  const app = makeApp(new FakeRepository({ empty: true }));
  const res = await app.fetch(new Request('http://localhost/api/summary/fffffffffff'));
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as any).exists, false);
});

test('GET /api/summary/:videoId rejects a malformed id with a classified error', async () => {
  const app = makeApp(new FakeRepository());
  const res = await app.fetch(new Request('http://localhost/api/summary/not-an-id'));
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as any).code, 'INVALID_URL');
});

test('POST /api/5w1h serves a stored row without touching the summary or the model', async () => {
  const repo = new FakeRepository();
  repo.fiveWoneH.push({
    id: 'row-1',
    video_id: 'uuid-xRh2sVcNXQ8',
    chapter_heading: 'AI 收入爆发',
    who: 'Marc Andreessen',
    what: 'AI 收入曲线',
    when: '当前',
    where: '消费与企业市场',
    why: '快速触达',
    how: '订阅与 token 计费'
  });

  const res = await post(makeApp(repo), '/api/5w1h', {
    videoId: 'xRh2sVcNXQ8',
    sectionHeading: '## 一、 AI 收入爆发！'
  });
  const data = (await res.json()) as any;

  assert.equal(res.status, 200);
  assert.equal(data.data.who, 'Marc Andreessen');
  assert.equal(repo.touched('getSummary'), false, 'fuzzy cache hit must not re-read the summary');
  assert.equal(repo.touched('save5W1H'), false);
});

test('POST /api/5w1h asks for a summary first when the video was never summarized', async () => {
  const repo = new FakeRepository({ summary: null });
  const res = await post(makeApp(repo), '/api/5w1h', {
    videoId: 'xRh2sVcNXQ8',
    sectionHeading: '任意章节'
  });
  const data = (await res.json()) as any;

  assert.equal(res.status, 404);
  assert.match(data.error, /尚未生成完整总结/);
  assert.ok(data.debug.requestId, 'error payload must carry a requestId for log correlation');
});

test('POST /api/5w1h is rejected before any database read when parameters are missing', async () => {
  const repo = new FakeRepository();
  const res = await post(makeApp(repo), '/api/5w1h', { videoId: 'xRh2sVcNXQ8' });

  assert.equal(res.status, 400);
  assert.equal(repo.touched('getVideoByYoutubeId'), false);
});

test('POST /api/summarize-stream validates the url before opening the SSE stream', async () => {
  const repo = new FakeRepository({ empty: true });
  const res = await post(makeApp(repo), '/api/summarize-stream', { url: 'https://vimeo.com/123' });

  assert.equal(res.status, 400);
  assert.match(res.headers.get('Content-Type') || '', /application\/json/);
  assert.equal(((await res.json()) as any).code, 'INVALID_URL');
});

test('unknown /api routes return a classified 404 instead of the SPA shell', async () => {
  const app = makeApp(new FakeRepository());
  const res = await app.fetch(new Request('http://localhost/api/nope'));
  assert.equal(res.status, 404);
  assert.equal(((await res.json()) as any).code, 'INVALID_INPUT');
});

test('/summary/:videoId deep links hand back the SPA shell only for valid ids', async () => {
  const app = makeApp(new FakeRepository());

  const ok = await app.fetch(new Request('http://localhost/summary/xRh2sVcNXQ8'));
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /spa/);

  const bad = await app.fetch(new Request('http://localhost/summary/../../etc'));
  assert.equal(bad.status, 404);
});

test('clearing a video reports how many rows went away, and is idempotent', async () => {
  const repo = new FakeRepository();
  repo.transcripts.set('uuid-xRh2sVcNXQ8', 'lots of text');

  const first = await post(makeApp(repo), '/api/video/xRh2sVcNXQ8/clear', {});
  const firstBody = (await first.json()) as any;
  assert.equal(first.status, 200);
  assert.equal(firstBody.counts.chapter5w1h, 0);
  assert.equal(repo.summaries.size, 0);

  const second = await post(makeApp(repo), '/api/video/xRh2sVcNXQ8/clear', {});
  assert.equal(second.status, 404);
  assert.equal(((await second.json()) as any).code, 'VIDEO_NOT_FOUND');
});
