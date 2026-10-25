import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_IMAGE } from '@claude-task/shared';
import Docker from 'dockerode';
import { pack } from 'tar-stream';
import type { AgentsConfig } from '../config';
import { agentImageRepo, containerName, volumeName } from './runtime';
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
