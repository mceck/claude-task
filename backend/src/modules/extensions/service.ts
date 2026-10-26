import type { McpServer, McpValue, SaveMcpServerBody, Skill } from '@claude-task/shared';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import type { AppContext } from '../../context';
import type { Executor } from '../../db/client';
import { agentMcpServers, agents, agentSkills, mcpServers, skills } from '../../db/schema';
import type { StoredMcpValue } from '../../db/schema';
import { badRequest } from '../../errors';
import { last4 } from '../../secrets';

export function serializeSkill(row: typeof skills.$inferSelect): Skill {
  const { files, ...rest } = row;
  return { ...rest, fileCount: files.length, updatedAt: row.updatedAt.toISOString() };
}
function publicValues(values: Record<string, StoredMcpValue>): Record<string, McpValue> {
  return Object.fromEntries(
    Object.entries(values).map(([k, v]) => [k, { value: v.ciphertext ? null : v.value, secret: !!v.ciphertext, last4: v.last4 }]),
  );
}
export function serializeMcp(row: typeof mcpServers.$inferSelect): McpServer {
  return { ...row, headers: publicValues(row.headers), env: publicValues(row.env), updatedAt: row.updatedAt.toISOString() };
}
export function storeMcpValues(
  ctx: AppContext,
  values: NonNullable<SaveMcpServerBody['env']>,
  before: Record<string, StoredMcpValue> = {},
): Record<string, StoredMcpValue> {
  return Object.fromEntries(
    Object.entries(values).map(([key, v]) => {
      if (v.secret && v.value === null) {
        if (!before[key]?.ciphertext) throw badRequest(`Missing secret value for ${key}`);
        return [key, before[key]];
      }
      if (v.value === null) throw badRequest(`Missing value for ${key}`);
      return [
        key,
        v.secret
          ? { value: null, ciphertext: ctx.config.secrets.encrypt(v.value), last4: last4(v.value) }
          : { value: v.value, ciphertext: null, last4: null },
      ];
    }),
  );
}
export async function agentExtensions(db: Executor, agentId: string) {
  const skillRows = await db
    .select({ skill: skills })
    .from(agentSkills)
    .innerJoin(skills, eq(skills.id, agentSkills.skillId))
    .where(eq(agentSkills.agentId, agentId))
    .orderBy(asc(skills.name));
  const serverRows = await db
    .select({ server: mcpServers })
    .from(agentMcpServers)
    .innerJoin(mcpServers, eq(mcpServers.id, agentMcpServers.mcpServerId))
    .where(eq(agentMcpServers.agentId, agentId))
    .orderBy(asc(mcpServers.name));
  return { skills: skillRows.map((r) => r.skill), mcpServers: serverRows.map((r) => r.server) };
}
export async function setAssignments(db: Executor, agentId: string, skillIds?: string[], mcpServerIds?: string[]): Promise<void> {
  if (skillIds !== undefined) {
    await db.delete(agentSkills).where(eq(agentSkills.agentId, agentId));
    if (skillIds.length) await db.insert(agentSkills).values(skillIds.map((skillId) => ({ agentId, skillId })));
  }
  if (mcpServerIds !== undefined) {
    await db.delete(agentMcpServers).where(eq(agentMcpServers.agentId, agentId));
    if (mcpServerIds.length) await db.insert(agentMcpServers).values(mcpServerIds.map((mcpServerId) => ({ agentId, mcpServerId })));
  }
  if (skillIds !== undefined || mcpServerIds !== undefined) await invalidateExtensions(db, [agentId]);
}
export async function invalidateExtensions(db: Executor, ids: string[]): Promise<void> {
  if (ids.length)
    await db
      .update(agents)
      .set({ extensionsRevision: sql`${agents.extensionsRevision} + 1`, extensionsError: null, updatedAt: new Date() })
      .where(inArray(agents.id, [...new Set(ids)]));
}
export function resolvedMcp(ctx: AppContext, rows: (typeof mcpServers.$inferSelect)[]): Record<string, unknown> {
  const decode = (values: Record<string, StoredMcpValue>) =>
    Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.ciphertext ? ctx.config.secrets.decrypt(v.ciphertext) : v.value!]));
  return Object.fromEntries(
    rows.map((row) => [
      row.name,
      row.type === 'stdio'
        ? { type: 'stdio', command: row.command, args: row.args, env: decode(row.env) }
        : { type: row.type, url: row.url, headers: decode(row.headers) },
    ]),
  );
}
