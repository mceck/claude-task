import { matchCommands } from '@claude-task/shared';
import { expect, it } from 'vitest';

const names = (q: string, list: string[]) => matchCommands(list.map((name) => ({ name })), q).map((c) => c.name);

it('finds a name by a word inside it, most relevant first', () => {
  const list = ['ciao_come_va', 'commit', 'welcome', 'come', 'comet'];
  expect(names('come', list)).toEqual(['come', 'comet', 'ciao_come_va', 'welcome']);
  expect(names('COM', list)).toEqual(['commit', 'come', 'comet', 'ciao_come_va', 'welcome']);
  expect(names('zzz', list)).toEqual([]);
  expect(names('', list)).toEqual(list);
  expect(names('skill', ['plugin:skill', 'skills'])).toEqual(['skills', 'plugin:skill']);
});
