import type { FiveWOneHRecord } from './types.js';

function cleanHeading(heading: string): string {
  return heading
    .replace(/^[#\s一二三四五六七八九十\d.、-]+/, '')
    .replace(/[：:\s\-_—·]/g, '')
    .toLowerCase();
}

/**
 * Fuzzy chapter matching shared by the SQLite and D1 repositories: a stored 5W1H row is reused
 * when its heading and the requested one normalize to each other or one contains the other.
 */
export function matchFiveW1H(
  records: FiveWOneHRecord[],
  chapterHeading: string
): FiveWOneHRecord | undefined {
  const exact = records.find((item) => item.chapter_heading === chapterHeading);
  if (exact) return exact;

  const cleanTarget = cleanHeading(chapterHeading);
  if (!cleanTarget) return undefined;

  for (const item of records) {
    const cleanDbHeading = cleanHeading(item.chapter_heading);
    if (
      cleanDbHeading === cleanTarget ||
      cleanDbHeading.includes(cleanTarget) ||
      cleanTarget.includes(cleanDbHeading)
    ) {
      return item;
    }
  }
  return undefined;
}
