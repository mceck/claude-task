import { z } from 'zod';

export interface SkillCommand {
  name: string;
  description: string;
}
export interface Skill extends SkillCommand {
  id: string;
  source: string;
  userInvocable: boolean;
  fileCount: number;
  contentHash: string;
  updatedAt: string;
}
export interface SkillFile {
  path: string;
  content: string;
  executable: boolean;
}
export interface InstalledSkill {
  name: string;
  files: SkillFile[];
}

const source = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .refine((s) => !s.startsWith('-') && !/[\x00-\x1f]/.test(s), 'Invalid skill source');
export const importSkillsBody = z.strictObject({
  source,
  skills: z
    .array(
      z
        .string()
        .trim()
        .min(1)
        .max(100)
        .refine((s) => !s.startsWith('-') && !/[\x00-\x1f]/.test(s), 'Invalid skill name'),
    )
    .min(1)
    .max(100)
    .default(['*']),
});
export type ImportSkillsBody = z.input<typeof importSkillsBody>;

/** Plugins install from remote marketplaces only: a local path would point into the Agent Container. */
const REMOTE_SOURCE = /^(?:https:\/\/[^\s@]+|git@[A-Za-z0-9.-]+:[^\s]+|[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*)$/;
const PLUGIN_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;
export const savePluginBody = z
  .strictObject({
    /** `plugin` with a marketplace source, or `plugin@marketplace` for a marketplace Claude Code already knows. */
    name: z.string().trim().max(130),
    source: z.string().trim().max(2000).default(''),
    description: z.string().max(2000).default(''),
  })
  .superRefine((v, ctx) => {
    const [plugin, marketplace, ...rest] = v.name.split('@');
    const valid = PLUGIN_NAME.test(plugin!) && !rest.length && (marketplace === undefined ? !!v.source : PLUGIN_NAME.test(marketplace) && !v.source);
    if (!valid) ctx.addIssue({ code: 'custom', path: ['name'], message: 'Use plugin with a marketplace source, or plugin@marketplace without one' });
    if (v.source && !REMOTE_SOURCE.test(v.source))
      ctx.addIssue({ code: 'custom', path: ['source'], message: 'Use owner/repo, an HTTPS URL without credentials or a Git SSH URL' });
  });
export type SavePluginBody = z.input<typeof savePluginBody>;
export interface Plugin {
  id: string;
  name: string;
  /** The marketplace it installs from; empty when `name` is `plugin@marketplace`. */
  source: string;
  description: string;
  updatedAt: string;
}
export interface InstalledPlugin {
  name: string;
  source: string;
}

/** A null secret value on update retains the existing value of that key. */
export const mcpValueBody = z.strictObject({ value: z.string().max(16_000).nullable(), secret: z.boolean().default(false) });
export interface McpValue {
  value: string | null;
  secret: boolean;
  last4: string | null;
}
const values = z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,99}$/), mcpValueBody);
export const saveMcpServerBody = z
  .strictObject({
    name: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,64}$/)
      .refine((s) => s !== 'claude-task', 'claude-task is reserved'),
    description: z.string().max(2000).default(''),
    type: z.enum(['http', 'sse', 'stdio']),
    url: z.string().max(2000).default(''),
    command: z.string().max(2000).default(''),
    args: z.array(z.string().max(4000)).max(100).default([]),
    headers: values.default({}),
    env: values.default({}),
  })
  .superRefine((v, ctx) => {
    if (v.type === 'stdio') {
      if (!v.command.trim() || v.command.includes('\0'))
        ctx.addIssue({ code: 'custom', path: ['command'], message: 'Command is required' });
      if (Object.keys(v.headers).length || v.url) ctx.addIssue({ code: 'custom', message: 'stdio uses command, args and env' });
    } else {
      if (!z.url({ protocol: /^https?$/ }).safeParse(v.url).success || /^https?:\/\/[^/?#]*@/.test(v.url)) {
        ctx.addIssue({ code: 'custom', path: ['url'], message: 'An HTTP(S) URL without embedded credentials is required' });
      }
      if (v.command || v.args.length || Object.keys(v.env).length)
        ctx.addIssue({ code: 'custom', message: 'Remote servers use url and headers' });
    }
  });
export type SaveMcpServerBody = z.input<typeof saveMcpServerBody>;
export interface McpServer {
  id: string;
  name: string;
  description: string;
  type: 'http' | 'sse' | 'stdio';
  url: string;
  command: string;
  args: string[];
  headers: Record<string, McpValue>;
  env: Record<string, McpValue>;
  updatedAt: string;
}

/** Complete the slash token immediately before the caret, including within a sentence. */
export function skillToken(text: string, caret: number): { start: number; query: string } | null {
  if (caret < 0 || caret > text.length) return null;
  const m = /(?:^|\s)\/([a-zA-Z0-9_:-]*)$/.exec(text.slice(0, caret));
  return m ? { start: caret - m[1]!.length - 1, query: m[1]!.toLowerCase() } : null;
}
