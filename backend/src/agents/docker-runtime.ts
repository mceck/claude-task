import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_IMAGE } from '@claude-task/shared';
import type { InstalledPlugin } from '@claude-task/shared';
import Docker from 'dockerode';
import { pack } from 'tar-stream';
import type { AgentsConfig } from '../config';
import { agentImageRepo, containerName, volumeName } from './runtime';
import { skillArchive } from './skill-files';
import type { AgentRuntime, BuildResult, ContainerInfo, ContainerSpec } from './runtime';

const AGENT_HOME = '/home/agent';

/** Where the Base Image's Dockerfile and the Runner sources live, in dev and in the production image. */
function defaultPaths(): { baseDockerfile: string; runnerDir: string } {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dev = here.endsWith(path.join('src', 'agents'));
  const backendDir = path.resolve(here, dev ? '../..' : '..');
  return {
    baseDockerfile: process.env.AGENT_BASE_DOCKERFILE ?? path.join(backendDir, 'agent-base', 'Dockerfile'),
    runnerDir: process.env.RUNNER_SOURCE_DIR ?? path.resolve(backendDir, dev ? '../runner' : 'runner'),
  };
}

/** Runner sources that go into the build context (tests and docs stay out). */
function runnerFiles(dir: string, rel = ''): string[] {
  return readdirSync(path.join(dir, rel))
    .sort()
    .flatMap((name) => {
      const r = path.join(rel, name);
      if (statSync(path.join(dir, r)).isDirectory()) return name === 'test' ? [] : runnerFiles(dir, r);
      return /\.(go|mod|sum)$/.test(name) && !name.endsWith('_test.go') ? [r] : [];
    });
}

/** Talks to the host's Docker daemon over its socket (dockerode). */
export class DockerRuntime implements AgentRuntime {
  readonly baseVersion: string;
  private readonly docker: Docker;
  private readonly baseDockerfile: string;
  private readonly runner: { dir: string; files: string[] };

  constructor(private readonly config: AgentsConfig, paths = defaultPaths()) {
    this.docker = new Docker({ socketPath: config.dockerSocket });
    this.baseDockerfile = readFileSync(paths.baseDockerfile, 'utf8');
    this.runner = { dir: paths.runnerDir, files: runnerFiles(paths.runnerDir) };
    // The platform version: pinned CLI + Base Image recipe + Runner sources.
    const h = createHash('sha256').update(config.claudeCodeVersion).update('\0').update(this.baseDockerfile);
    for (const f of this.runner.files) h.update('\0').update(f).update('\0').update(readFileSync(path.join(this.runner.dir, f)));
    this.baseVersion = `${config.claudeCodeVersion}-${h.digest('hex').slice(0, 12)}`;
  }

  async ensureBaseImage(onLog: (chunk: string) => void): Promise<void> {
    const tag = `${BASE_IMAGE}:${this.baseVersion}`;
    if (await this.imageExists(tag)) return;
    onLog(`Building ${tag} (Claude Code ${this.config.claudeCodeVersion})…\n`);
    const files: Record<string, Buffer | string> = { Dockerfile: this.baseDockerfile };
    for (const f of this.runner.files) files[path.posix.join('runner', f.split(path.sep).join('/'))] = readFileSync(path.join(this.runner.dir, f));
    await this.build(files, { t: tag, buildargs: { CLAUDE_CODE_VERSION: this.config.claudeCodeVersion, RUNNER_VERSION: this.baseVersion } }, onLog);
    await this.docker.getImage(tag).tag({ repo: BASE_IMAGE, tag: 'latest' });
  }

  async buildAgentImage(input: { agentId: string; buildId: string; dockerfile: string }, onLog: (chunk: string) => void): Promise<BuildResult> {
    const imageTag = `${agentImageRepo(input.agentId)}:${input.buildId.slice(0, 12)}`;
    await this.build({ Dockerfile: input.dockerfile }, { t: imageTag, labels: { 'claude-task.agent': input.agentId } }, onLog);
    const info = await this.docker.getImage(imageTag).inspect();
    return { imageTag, user: info.Config?.User ?? '' };
  }

  async createContainer(agentId: string, spec: ContainerSpec): Promise<void> {
    await this.removeContainer(agentId);
    await this.docker.createVolume({ Name: volumeName(agentId), Labels: { 'claude-task.agent': agentId } }).catch(ignore(409));
    const container = await this.docker.createContainer({
      name: containerName(agentId),
      Image: spec.image,
      Env: Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
      Labels: { 'claude-task.agent': agentId },
      HostConfig: {
        RestartPolicy: { Name: 'unless-stopped' },
        Binds: [`${volumeName(agentId)}:${AGENT_HOME}`],
        NetworkMode: this.config.network ?? 'bridge',
        // So `host.docker.internal` reaches a backend running on the host (Linux needs this).
        ExtraHosts: ['host.docker.internal:host-gateway'],
        ...(spec.cpuLimit ? { NanoCpus: Math.round(spec.cpuLimit * 1e9) } : {}),
        ...(spec.memoryMb ? { Memory: spec.memoryMb * 1024 * 1024 } : {}),
      },
    });
    await container.start();
    await this.pruneImages(agentId, spec.image);
  }

  async restartContainer(agentId: string): Promise<void> {
    await this.docker.getContainer(containerName(agentId)).restart();
  }

  async configureSkills(agentId: string, revision: number, skills: import('@claude-task/shared').InstalledSkill[]): Promise<void> {
    const { archive, script } = await skillArchive(revision, skills);
    const container = this.docker.getContainer(containerName(agentId));
    await container.putArchive(archive, { path: AGENT_HOME });
    const exec = await container.exec({ Cmd: ['/bin/bash', '-c', script], User: 'agent', AttachStdout: true, AttachStderr: true });
    const stream = await exec.start({ hijack: true, stdin: false });
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const result = await exec.inspect();
    if (result.ExitCode !== 0) throw new Error(demux(Buffer.concat(chunks)).trim() || 'Could not configure agent skills');
  }

  async configurePlugins(agentId: string, plugins: InstalledPlugin[]): Promise<void> {
    const container = this.docker.getContainer(containerName(agentId));
    // Arguments go straight to `claude` (no shell), so names and sources can't inject anything.
    const claude = async (...args: string[]) => {
      const { stdout, stderr } = await execIn(container, ['claude', 'plugin', ...args]);
      const line = stdout.trim().split('\n').pop() ?? '';
      try {
        return JSON.parse(line) as { outcome?: string; pluginId?: string; message?: string; failureCode?: string };
      } catch {
        throw new Error(`claude plugin ${args[0]} failed: ${(stderr || stdout).trim().slice(0, 500) || 'no output'}`);
      }
    };
    const state = await execIn(container, ['cat', PLUGIN_STATE]);
    let managed: string[] = state.exitCode === 0 ? parseIds(state.stdout) : [];
    const listed = await execIn(container, ['claude', 'plugin', 'list', '--json']);
    if (listed.exitCode !== 0) throw new Error(`claude plugin list failed: ${(listed.stderr || listed.stdout).trim().slice(0, 500)}`);
    const unmanaged = new Set(parseIds(listed.stdout, 'id').filter((id) => !managed.includes(id)));
    const wanted = new Set<string>();
    try {
      for (const plugin of plugins) {
        const result = await claude('install', plugin.name, ...(plugin.source ? ['--marketplace', plugin.source] : []), '--json');
        if (result.outcome !== 'ok' || !result.pluginId) throw new Error(`Plugin ${plugin.name}: ${result.message ?? 'install failed'}`);
        wanted.add(result.pluginId);
        if (!unmanaged.has(result.pluginId) && !managed.includes(result.pluginId)) managed.push(result.pluginId);
      }
      // Best effort: an unreachable marketplace keeps the installed version.
      for (const marketplace of new Set([...wanted].map((id) => id.slice(id.indexOf('@') + 1)))) await claude('marketplace', 'update', marketplace, '--json').catch(() => {});
      for (const id of wanted) await claude('update', id, '--json').catch(() => {});
      for (const id of managed.filter((id) => !wanted.has(id))) {
        const result = await claude('uninstall', id, '--json');
        if (result.outcome !== 'ok' && result.failureCode !== 'not_installed') throw new Error(`Plugin ${id}: ${result.message ?? 'uninstall failed'}`);
        managed = managed.filter((m) => m !== id);
      }
    } finally {
      await container.putArchive(await stateArchive(managed), { path: AGENT_HOME });
    }
  }

  async removeAgent(agentId: string): Promise<void> {
    await this.removeContainer(agentId);
    await this.pruneImages(agentId, null);
    await this.docker.getVolume(volumeName(agentId)).remove().catch(ignore(404));
  }

  async inspect(agentId: string): Promise<ContainerInfo> {
    try {
      const info = await this.docker.getContainer(containerName(agentId)).inspect();
      return { state: info.State.Status, image: info.Config.Image };
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 404) return { state: 'missing', image: null };
      throw err;
    }
  }

  async logs(agentId: string, tail: number): Promise<string> {
    try {
      const raw = (await this.docker.getContainer(containerName(agentId)).logs({ stdout: true, stderr: true, tail, follow: false })) as Buffer;
      return demux(raw);
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 404) return '';
      throw err;
    }
  }

  private async imageExists(tag: string): Promise<boolean> {
    try {
      await this.docker.getImage(tag).inspect();
      return true;
    } catch {
      return false;
    }
  }

  private async build(files: Record<string, Buffer | string>, opts: Record<string, unknown>, onLog: (chunk: string) => void): Promise<void> {
    const tar = pack();
    for (const [name, content] of Object.entries(files)) tar.entry({ name }, content);
    tar.finalize();
    const stream = await this.docker.buildImage(tar as unknown as NodeJS.ReadableStream, { ...opts, rm: true, forcerm: true });
    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(
        stream,
        (err: Error | null, output: { error?: string }[]) => {
          const failed = err?.message ?? output?.find((o) => o.error)?.error;
          if (failed) reject(new Error(failed));
          else resolve();
        },
        (event: { stream?: string; status?: string; error?: string }) => {
          if (event.stream) onLog(event.stream);
          else if (event.status) onLog(`${event.status}\n`);
          if (event.error) onLog(`${event.error}\n`);
        },
      );
    });
  }

  private async removeContainer(agentId: string): Promise<void> {
    await this.docker.getContainer(containerName(agentId)).remove({ force: true }).catch(ignore(404));
  }

  /** Old images of the Agent, except the one in use. */
  private async pruneImages(agentId: string, keep: string | null): Promise<void> {
    const images = await this.docker.listImages({ filters: JSON.stringify({ reference: [agentImageRepo(agentId)] }) });
    for (const image of images) {
      if (keep && image.RepoTags?.includes(keep)) continue;
      await this.docker.getImage(image.Id).remove({ force: !keep }).catch(() => {});
    }
  }
}

function ignore(status: number) {
  return (err: unknown) => {
    if ((err as { statusCode?: number }).statusCode !== status) throw err;
  };
}

/** Docker multiplexes stdout and stderr in 8-byte-header frames when there's no TTY. */
/** The plugin IDs the platform installed, so it never uninstalls one installed by hand. */
const PLUGIN_STATE_DIR = '.local/share/claude-task';
const PLUGIN_STATE = `${AGENT_HOME}/${PLUGIN_STATE_DIR}/plugins.json`;
const PLUGIN_COMMAND_TIMEOUT_MS = 5 * 60_000;

function parseIds(json: string, key?: string): string[] {
  try {
    const value = JSON.parse(json) as unknown;
    if (!Array.isArray(value)) return [];
    return value.map((v) => (key ? (v as Record<string, unknown>)?.[key] : v)).filter((v): v is string => typeof v === 'string');
  } catch {
    return [];
  }
}

async function stateArchive(ids: string[]): Promise<Buffer> {
  const tar = pack();
  const chunks: Buffer[] = [];
  tar.on('data', (chunk) => chunks.push(Buffer.from(chunk as Uint8Array)));
  const done = new Promise<void>((resolve, reject) => {
    tar.on('end', resolve);
    tar.on('error', reject);
  });
  const parts = PLUGIN_STATE_DIR.split('/');
  for (let i = 1; i <= parts.length; i++) tar.entry({ name: parts.slice(0, i).join('/'), type: 'directory', uid: 1000, gid: 1000, mode: 0o755 });
  tar.entry({ name: `${PLUGIN_STATE_DIR}/plugins.json`, uid: 1000, gid: 1000, mode: 0o644 }, JSON.stringify(ids));
  tar.finalize();
  await done;
  return Buffer.concat(chunks);
}

/** Runs a command as the agent user, without a shell; stdout and stderr stay apart. */
async function execIn(container: Docker.Container, cmd: string[]): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const exec = await container.exec({
    Cmd: cmd,
    User: 'agent',
    WorkingDir: AGENT_HOME,
    Env: [`HOME=${AGENT_HOME}`, 'GIT_TERMINAL_PROMPT=0'],
    AttachStdout: true,
    AttachStderr: true,
  });
  const run = async () => {
    const stream = await exec.start({ hijack: true, stdin: false });
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    return demuxStreams(Buffer.concat(chunks));
  };
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${cmd.slice(0, 3).join(' ')} timed out`)), PLUGIN_COMMAND_TIMEOUT_MS);
  });
  try {
    const output = await Promise.race([run(), timeout]);
    return { exitCode: (await exec.inspect()).ExitCode, ...output };
  } finally {
    clearTimeout(timer);
  }
}

function demuxStreams(buf: Buffer): { stdout: string; stderr: string } {
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  let i = 0;
  while (i + 8 <= buf.length) {
    const size = buf.readUInt32BE(i + 4);
    (buf[i] === 2 ? err : out).push(buf.subarray(i + 8, i + 8 + size));
    i += 8 + size;
  }
  return i === 0 ? { stdout: buf.toString('utf8'), stderr: '' } : { stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') };
}

function demux(buf: Buffer): string {
  const out: Buffer[] = [];
  let i = 0;
  while (i + 8 <= buf.length) {
    const size = buf.readUInt32BE(i + 4);
    out.push(buf.subarray(i + 8, i + 8 + size));
    i += 8 + size;
  }
  return i === 0 ? buf.toString('utf8') : Buffer.concat(out).toString('utf8');
}
