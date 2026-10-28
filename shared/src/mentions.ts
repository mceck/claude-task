/** Stable Markdown links identify Users independently of their display name. */
export const userMentionPath = (id: string): string => `/users/${id}`;
export const isUserMentionPath = (url: string): boolean => /^\/users\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(url);

/** A fresh @ token at a word boundary; email addresses remain ordinary text. */
export function mentionToken(text: string, caret: number): { start: number; query: string } | null {
  if (caret < 0 || caret > text.length) return null;
  const match = /(?:^|\s)@([^\s@\[\]()]*)$/.exec(text.slice(0, caret));
  return match ? { start: caret - match[1]!.length - 1, query: match[1]!.toLowerCase() } : null;
}
