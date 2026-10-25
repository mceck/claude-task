import { transliterate } from 'transliteration';
/** Stable ASCII names; accents and common Latin letters are transliterated, never locale-dependent. */
export function gitSlug(text: string, limit = 40): string {
  return transliterate(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, limit)
    .replace(/-+$/g, '');
}
export function taskBranch(key: string, title: string): string {
  const slug = gitSlug(title);
  return `task/${key.toLowerCase()}${slug ? `-${slug}` : ''}`;
}
