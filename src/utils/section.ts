import type { FiveW1HData } from '../repositories/types.js';

export function isValidYoutubeId(value: string): boolean {
  return /^[a-zA-Z0-9_-]{11}$/.test(value);
}

/** Helper to locate a specific chapter inside the summaryMarkdown the user is looking at */
export function extractSectionFromSummary(summaryMarkdown: string, heading: string): string {
  const cleanHeading = heading.replace(/^[#\s一二三四五六七八九十\d.、-]+/, '').trim();
  if (!cleanHeading) return '';
  const escaped = cleanHeading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Stop at the next `##` heading, not at the end of the heading line: with the `m` flag `$`
  // would match there and the lazy quantifier would return the heading alone.
  const regex = new RegExp(`##\\s+.*?${escaped}[\\s\\S]*?(?=\\n\\s*##\\s|(?![\\s\\S]))`, 'm');
  const match = summaryMarkdown.match(regex);
  if (match) {
    return match[0].trim();
  }
  return '';
}

/** Clean and safely parse JSON returned by LLM, handling Markdown code fences or extra wrapping */
export function parse5W1HJson(rawText: string): FiveW1HData {
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
