import { checkAgentDockerfile, chatCommands, parseDotenv, pinAgentBase } from '@claude-task/shared';
import { describe, expect, it } from 'vitest';

describe('shared utilities', () => {
  it('ignores comments inside Dockerfile continuations', () => {
    const dockerfile = 'FROM claude-task/agent-base \\\n# pinned by the platform\n  AS base\nUSER agent';
    expect(checkAgentDockerfile(dockerfile)).toEqual({ ok: true, fromIndex: 0 });
    const pinned = pinAgentBase(dockerfile, 'test-1', ['postgres']);
    expect(checkAgentDockerfile(pinned)).toEqual({ ok: true, fromIndex: 0 });
    expect(pinned.indexOf('AS base')).toBeLessThan(pinned.indexOf('USER root'));
    expect(pinned).toContain('FROM claude-task/agent-base:test-1');
  });

  it('pins the complete FROM across blank lines and repeated comments before installing services', () => {
    const source = 'ARG BUILD=1\nFROM --platform=linux/amd64 claude-task/agent-base \\\n\n# a comment\n# another one\n AS base\nRUN echo custom\nUSER agent';
    const pinned = pinAgentBase(source, 'test-2', []);
    expect(checkAgentDockerfile(pinned)).toEqual({ ok: true, fromIndex: 1 });
    expect(pinned.indexOf('AS base')).toBeLessThan(pinned.indexOf('USER root'));
    expect(pinned.indexOf('claude-task-install-services')).toBeLessThan(pinned.indexOf('RUN echo custom'));
  });

  it('does not offer inherited object names as Claude commands', () => {
    expect(chatCommands(['toString', 'constructor'], [])).toEqual([]);
  });

  it('offers skill names that start with an underscore or dash', () => {
    const commands = chatCommands(null, [
      { name: '_lint', description: 'Lint' },
      { name: '-check', description: 'Check' },
    ]);
    expect(commands.filter((c) => c.kind === 'skill').map((c) => c.name).sort()).toEqual(['-check', '_lint']);
  });

  it("gives a project skill's name to the Agent's skill of the same name", () => {
    const commands = chatCommands(null, [{ name: 'deploy', description: 'Agent deploy' }], [
      { name: 'deploy', description: 'Project deploy' },
      { name: 'compact', description: 'Project compact' },
    ]);
    expect(commands.filter((c) => c.kind === 'skill')).toEqual([
      { name: 'compact', description: 'Project compact', kind: 'skill' },
      { name: 'deploy', description: 'Agent deploy', kind: 'skill' },
    ]);
  });

  it('preserves spaces at the end of a line inside a multiline quoted value', () => {
    expect(parseDotenv('FOO="a  \nb"')).toEqual({ ok: true, entries: [{ name: 'FOO', value: 'a  \nb' }] });
  });
});
