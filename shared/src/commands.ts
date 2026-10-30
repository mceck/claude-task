import type { SkillCommand } from './extensions';

export interface ChatCommand extends SkillCommand {
  kind: 'skill' | 'claude' | 'mcp';
}

// These replace/exit the managed conversation, or change settings that the Agent form owns.
const UNAVAILABLE = new Set([
  'clear',
  'reset',
  'new',
  'resume',
  'continue',
  'branch',
  'fork',
  'exit',
  'quit',
  'background',
  'bg',
  'remote-control',
  'rc',
  'model',
  'effort',
  'config',
  'settings',
  'permissions',
  'allowed-tools',
  'fast',
]);
const DESCRIPTIONS: Record<string, string> = {
  compact: 'Summarize conversation history; optionally add focus instructions.',
  context: 'Inspect the context window.',
  usage: 'Show usage for this conversation.',
  cost: 'Show conversation costs.',
  help: 'List available Claude commands.',
  status: 'Inspect the Claude session.',
  mcp: 'Inspect MCP server connections.',
  init: 'Create project instructions in CLAUDE.md.',
  diff: 'Inspect code changes.',
  'code-review': 'Review changes for correctness.',
  review: 'Review code changes.',
  'security-review': 'Review changes for security problems.',
  simplify: 'Improve recently changed code.',
  debug: 'Investigate a runtime problem.',
  verify: 'Verify project changes.',
  'reload-skills': 'Refresh available skills.',
  'reload-plugins': 'Refresh loaded plugins.',
  plan: 'Plan a task before making changes.',
  rename: 'Set the conversation name.',
};
/** The runtime reports every interactive built-in and bundled skill too; only curated ones, plugin (`a:b`) and MCP prompts are offered. */
function offered(name: string): boolean {
  return Object.hasOwn(DESCRIPTIONS, name) || name.includes(':') || name.startsWith('mcp__');
}
export function commandName(body: string): string | null {
  // Skills may start with `_` or `-`; only their directory name is restricted.
  const match = /^\/([a-zA-Z0-9_-][a-zA-Z0-9_:-]{0,127})(?:\s|$)/.exec(body);
  return match && !UNAVAILABLE.has(match[1]!) ? match[1]! : null;
}
/** An absent runtime list uses only the documented basic noninteractive commands. */
export function chatCommands(runtime: string[] | null, skills: SkillCommand[]): ChatCommand[] {
  const result = new Map<string, ChatCommand>();
  for (const name of runtime ?? ['compact', 'context', 'usage']) {
    if (commandName(`/${name}`) !== name || !offered(name)) continue;
    result.set(name, {
      name,
      description: DESCRIPTIONS[name] ?? 'Run this Claude command.',
      kind: name.startsWith('mcp__') ? 'mcp' : 'claude',
    });
  }
  for (const skill of skills) if (commandName(`/${skill.name}`) === skill.name) result.set(skill.name, { ...skill, kind: 'skill' });
  return [...result.values()].sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'skill' ? -1 : b.kind === 'skill' ? 1 : a.kind.localeCompare(b.kind),
  );
}
