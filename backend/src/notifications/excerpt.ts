import { fromMarkdown } from 'mdast-util-from-markdown';

type MarkdownNode = ReturnType<typeof fromMarkdown> | ReturnType<typeof fromMarkdown>['children'][number];

const MAX_LENGTH = 200;
/** Blocks whose words are separated from their neighbours. */
const BLOCKS = new Set(['paragraph', 'heading', 'listItem', 'blockquote', 'tableCell', 'break', 'thematicBreak']);

function plainText(node: MarkdownNode, out: string[]): void {
  switch (node.type) {
    case 'code':
    case 'image':
    case 'imageReference':
    case 'html':
    case 'definition':
      return;
    case 'text':
    case 'inlineCode':
      out.push(node.value);
      return;
  }
  if ('children' in node) for (const child of node.children) plainText(child, out);
  if (BLOCKS.has(node.type)) out.push(' ');
}

function cut(text: string): string {
  if (text.length <= MAX_LENGTH) return text;
  const head = text.slice(0, MAX_LENGTH + 1);
  const space = head.lastIndexOf(' ');
  return `${(space > 0 ? head.slice(0, space) : text.slice(0, MAX_LENGTH)).trimEnd()}…`;
}

/** A Comment as an Alert shows it: plain text, at most 200 characters, and how many files it carries. */
export function alertExcerpt(body: string, attachments: number): string {
  const out: string[] = [];
  plainText(fromMarkdown(body), out);
  const text = cut(out.join('').replace(/\s+/g, ' ').trim());
  const files = attachments > 0 ? `📎 ${attachments} ${attachments === 1 ? 'file' : 'files'}` : '';
  return [text, files].filter(Boolean).join(' ');
}
