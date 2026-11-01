// The Task Tools' text search. Words, not phrases: every word must appear, and the comparison is
// a case-insensitive substring with accents left as typed. The same rule serves Tasks and Comments.

/** The distinct words of a query, lowercased and capped so one query cannot build a huge condition. */
export function searchWords(text: string): string[] {
  const words = text.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return [...new Set(words)].slice(0, 20);
}

/** A `%word%` pattern for `like ... escape '!'`, with the escape character, `%` and `_` taken literally. */
export function likePattern(word: string): string {
  return `%${word.replace(/[!%_]/g, (c) => `!${c}`)}%`;
}

/** A snippet of a Comment body around the first match of any word, cut at about `size` characters. */
export function snippetAround(body: string, words: string[], size = 250): string {
  if (body.length <= size) return body;
  const lower = body.toLowerCase();
  const found = words
    .map((word) => lower.indexOf(word))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];
  const start = Math.max(0, Math.min(found ?? 0, body.length - size));
  const cut = body.slice(start, start + size);
  return `${start > 0 ? '…' : ''}${cut}${start + size < body.length ? '…' : ''}`;
}
