import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeHtmlEntities, extractVideoId } from '../src/utils/youtube.js';
import { isValidYoutubeId, parse5W1HJson } from '../src/utils/section.js';
import { matchFiveW1H } from '../src/repositories/heading.js';

const clean = { who: 'Marc', what: 'AI 经济学', when: '当下', where: 'SaaS', why: '分发', how: '订阅' };

test('extractVideoId accepts every link shape users paste, and nothing else', async () => {
  const id = 'xRh2sVcNXQ8';
  for (const input of [
    id,
    `https://www.youtube.com/watch?v=${id}`,
    `https://youtu.be/${id}`,
    `https://m.youtube.com/watch?list=PL123&v=${id}`,
    `https://www.youtube.com/shorts/${id}`,
    `https://www.youtube.com/live/${id}`,
    `  https://www.youtube.com/embed/${id}?t=1s  `
  ]) {
    assert.equal(extractVideoId(input), id, input);
  }

  for (const input of ['', '   ', 'hello', 'https://vimeo.com/123', 'https://youtube.com/watch?v=short', id + 'x']) {
    assert.equal(extractVideoId(input), null, JSON.stringify(input));
  }

  assert.ok(isValidYoutubeId(id));
  assert.ok(!isValidYoutubeId('../../etc'));
});

test('decodeHtmlEntities unwinds the entities YouTube embeds in titles', async () => {
  assert.equal(decodeHtmlEntities("Marc Andreessen&#39;s Outlook &amp; AI"), "Marc Andreessen's Outlook & AI");
  assert.equal(decodeHtmlEntities('&lt;tag&gt;'), '<tag>');
  assert.equal(decodeHtmlEntities(''), '');
});

test('parse5W1HJson survives the formats Gemini actually returns', async () => {
  assert.deepEqual(parse5W1HJson(JSON.stringify(clean)), clean);
  assert.deepEqual(parse5W1HJson('```json\n' + JSON.stringify(clean) + '\n```'), clean);
  assert.deepEqual(parse5W1HJson('以下是结果：\n' + JSON.stringify(clean) + '\n希望有帮助'), clean);
  assert.equal(parse5W1HJson('{"who":"Marc","what":"x","when":"y","where":"z","why":"w","how":"v",}').how, 'v');
});

test('parse5W1HJson rejects what must be retried, and fills gaps the UI cannot render', async () => {
  assert.throws(() => parse5W1HJson(''), /为空/);
  assert.throws(() => parse5W1HJson('I cannot help with that'), /JSON/);
  assert.throws(() => parse5W1HJson(JSON.stringify({ who: 'Marc', what: 'x', how: 'y' })), /缺少核心 5W1H 字段/);
  assert.equal(parse5W1HJson(JSON.stringify({ ...clean, who: '' })).who, '核心人物');
});

test('matchFiveW1H reuses stored rows across heading rewrites', async () => {
  const records = [
    { id: '1', video_id: 'v1', chapter_heading: '智能经济：收入爆发与成本塌陷', who: 'a', what: 'b', when: 'c', where: 'd', why: 'e', how: 'f' }
  ];

  assert.equal(matchFiveW1H(records, '智能经济：收入爆发与成本塌陷'), records[0], 'exact');
  assert.equal(matchFiveW1H(records, '## 一、 智能经济：收入爆发与成本塌陷'), records[0], 'numbered prefix');
  assert.equal(matchFiveW1H(records, '智能经济-收入爆发与成本塌陷'), records[0], 'punctuation drift');
  assert.equal(matchFiveW1H(records, '智能经济'), records[0], 'containment');
  assert.equal(matchFiveW1H(records, '不相关章节'), undefined);
});
