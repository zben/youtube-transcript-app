import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeHtmlEntities, extractVideoId } from '../src/utils/youtube.js';
import { extractSectionFromSummary, isValidYoutubeId, parse5W1HJson } from '../src/utils/section.js';
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


const chapteredSummary = [
  '# 对话安德森',
  '',
  '## 一、AI 收入爆发',
  'Marc: 这些是价值数万亿美元的问题。',
  '### 子议题：定价',
  'Ben: 分发优势让产品立刻触达全球。',
  '',
  '## 二、单位成本曲线',
  'Chris: GPU 供给改善后成本会持续下降。'
].join('\n');

test('extractSectionFromSummary returns the whole chapter body and stops at the next chapter', async () => {
  const section = extractSectionFromSummary(chapteredSummary, '## 一、 AI 收入爆发');

  assert.match(section, /^## 一、AI 收入爆发/);
  assert.ok(section.includes('价值数万亿美元的问题'), 'the body must come along with the heading');
  assert.ok(section.includes('分发优势'), '### sub-headings stay inside their chapter');
  assert.ok(!section.includes('单位成本曲线'), 'must stop before the next ## heading');

  assert.ok(extractSectionFromSummary(chapteredSummary, '二、单位成本曲线').endsWith('成本会持续下降。'), 'last chapter runs to EOF');
  assert.equal(extractSectionFromSummary(chapteredSummary, '不存在的章节'), '');
  assert.equal(extractSectionFromSummary(chapteredSummary, '##'), '');
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
