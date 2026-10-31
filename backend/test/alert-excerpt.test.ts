import { describe, expect, it } from 'vitest';
import { alertExcerpt } from '../src/notifications/excerpt';

const id = '0f8fad5b-d9cb-469f-a165-70867728950e';

describe('Alert excerpt', () => {
  it.each([
    ['plain text', 'Done, tests are green.', 0, 'Done, tests are green.'],
    ['emphasis and headings', '## Summary\n\nThe **fix** is _in_.', 0, 'Summary The fix is in.'],
    ['links keep their text', 'See [the PR](https://example.com/pr/1) now', 0, 'See the PR now'],
    ['mentions read as @Name', `[@Marco](/users/${id}) can you review?`, 0, '@Marco can you review?'],
    ['code blocks are left out', 'Run this:\n\n```sh\nrm -rf /\n```\n\nthen check.', 0, 'Run this: then check.'],
    ['inline code keeps its text', 'Edited `src/auth.ts` only', 0, 'Edited src/auth.ts only'],
    ['images are left out', 'Look ![screenshot](https://x/y.png) here', 0, 'Look here'],
    ['lists and quotes flatten', '- one\n- two\n\n> quoted', 0, 'one two quoted'],
    ['whitespace collapses', 'a   \n\n\n  b\tc', 0, 'a b c'],
    ['attachments only', '', 2, '📎 2 files'],
    ['one attachment', '', 1, '📎 1 file'],
    ['text and attachments', 'Here are the logs', 3, 'Here are the logs 📎 3 files'],
  ])('%s', (_name, body, files, expected) => {
    expect(alertExcerpt(body, files)).toBe(expected);
  });

  it('cuts at 200 characters on a word boundary with an ellipsis', () => {
    const body = `${'word '.repeat(60)}end`;
    const out = alertExcerpt(body, 0);
    expect(out.length).toBeLessThanOrEqual(201);
    expect(out.endsWith('word…')).toBe(true);
  });

  it('cuts a single long word at 200 characters', () => {
    expect(alertExcerpt('x'.repeat(300), 0)).toBe(`${'x'.repeat(200)}…`);
  });

  it('keeps the attachment count after a cut text', () => {
    expect(alertExcerpt('y'.repeat(300), 1)).toBe(`${'y'.repeat(200)}… 📎 1 file`);
  });

  it('is empty for a Comment with neither text nor files', () => {
    expect(alertExcerpt('```\ncode only\n```', 0)).toBe('');
  });
});
