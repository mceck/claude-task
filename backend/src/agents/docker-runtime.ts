import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_IMAGE, agentProfilePath } from '@claude-task/shared';
import type { InstalledPlugin } from '@claude-task/shared';
import Docker from 'dockerode';
import { pack } from 'tar-stream';
import type { AgentsConfig } from '../config';
import { SERVICE_DATA_DIR, containerName, noDockerCleanupCounts, serviceVolumeName, volumeName, workerImageRepo } from './runtime';
import { profileArchive } from './skill-files';
import type { BuildResult, ContainerInfo, ContainerSpec, DockerCleanupInput, DockerCleanupReport, ProfileSpec, WorkerRuntime } from './runtime';

const AGENT_HOME = '/home/agent';
/** Labels the resources of one Installation, so Installations sharing a Docker host stay apart. */
const INSTALLATION_LABEL = 'claude-task.installation';
const WORKER_LABEL = 'claude-task.worker';
/** Set by every stage of the Base Image recipe: Worker Images and Build intermediates inherit it. */
const PLATFORM_LABEL = 'claude-task.platform';

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
export class DockerRuntime implements WorkerRuntime {
  private readonly docker: Docker;
  private readonly baseDockerfile: string;
  private readonly baseScripts: Record<string, Buffer>;
  private readonly runner: { dir: string; files: string[] };
  /** Base Image versions by Claude Code version; one fingerprinting sees the same sources. */
  private readonly baseVersions = new Map<string, string>();

  constructor(
    private readonly config: AgentsConfig,
    private readonly installationId: string,
    paths = defaultPaths(),
    docker?: Docker,
  ) {
    this.docker = docker ?? new Docker({ socketPath: config.dockerSocket });
    this.baseDockerfile = readFileSync(paths.baseDockerfile, 'utf8');
    this.baseScripts = Object.fromEntries(['install-services.sh', 'entrypoint.sh', 'minio-shim.sh'].map((name) => [
      `agent-base/${name}`, readFileSync(path.join(path.dirname(paths.baseDockerfile), name)),
    ]));
    this.runner = { dir: paths.runnerDir, files: runnerFiles(paths.runnerDir) };
  }

  async ping(): Promise<void> { await this.docker.ping(); }

  /** The Platform Version: the Claude Code version plus a fingerprint of the recipe and Runner sources. */
  baseVersionFor(claudeCodeVersion: string): string {
    let baseVersion = this.baseVersions.get(claudeCodeVersion);
    if (!baseVersion) {
      const h = createHash('sha256').update(claudeCodeVersion).update('\0').update(this.baseDockerfile);
      for (const [name, content] of Object.entries(this.baseScripts)) h.update('\0').update(name).update('\0').update(content);
      for (const f of this.runner.files) h.update('\0').update(f).update('\0').update(readFileSync(path.join(this.runner.dir, f)));
      baseVersion = `${claudeCodeVersion}-${h.digest('hex').slice(0, 12)}`;
      this.baseVersions.set(claudeCodeVersion, baseVersion);
    }
    return baseVersion;
  }

  async ensureBaseImage(claudeCodeVersion: string, onLog: (chunk: string) => void): Promise<void> {
    const baseVersion = this.baseVersionFor(claudeCodeVersion);
    const tag = `${BASE_IMAGE}:${baseVersion}`;
    if (await this.imageExists(tag)) return;
    onLog(`Building ${tag} (Claude Code ${claudeCodeVersion})…\n`);
    const files: Record<string, Buffer | string> = { Dockerfile: this.baseDockerfile, ...this.baseScripts };
    for (const f of this.runner.files) files[path.posix.join('runner', f.split(path.sep).join('/'))] = readFileSync(path.join(this.runner.dir, f));
    await this.build(files, { t: tag, buildargs: { CLAUDE_CODE_VERSION: claudeCodeVersion, RUNNER_VERSION: baseVersion } }, onLog);
    await this.docker.getImage(tag).tag({ repo: BASE_IMAGE, tag: 'latest' });
  }

  async buildWorkerImage(input: { workerId: string; buildId: string; dockerfile: string }, onLog: (chunk: string) => void): Promise<BuildResult> {
    const imageTag = `${workerImageRepo(input.workerId)}:${input.buildId.slice(0, 12)}`;
    await this.build({ Dockerfile: input.dockerfile }, { t: imageTag, labels: this.labels(input.workerId) }, onLog);
    const info = await this.docker.getImage(imageTag).inspect();
    return { imageTag, user: info.Config?.User ?? '' };
  }

  async createContainer(workerId: string, slot: number, spec: ContainerSpec): Promise<void> {
    await this.removeContainer(workerId, slot);
    const labels = this.labels(workerId);
    const network = spec.network === undefined ? this.config.network : spec.network;
    if (network && network !== 'bridge') {
      try { await this.docker.getNetwork(network).inspect(); }
      catch (err) {
        if ((err as { statusCode?: number }).statusCode !== 404) throw err;
        await this.docker.createNetwork({ Name: network, Labels: { [INSTALLATION_LABEL]: this.installationId } }).catch(ignore(409));
      }
    }
    await this.docker.createVolume({ Name: volumeName(workerId), Labels: labels }).catch(ignore(409));
    await this.docker.createVolume({ Name: serviceVolumeName(workerId, slot), Labels: { ...labels, 'claude-task.slot': String(slot) } }).catch(ignore(409));
    const container = await this.docker.createContainer({
      name: containerName(workerId, slot),
      Image: spec.image,
      Env: Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
      Labels: { ...labels, 'claude-task.slot': String(slot) },
      HostConfig: {
        RestartPolicy: { Name: 'unless-stopped' },
        // The home is shared by every Worker Container of the Worker; service data belongs to the slot.
        Binds: [`${volumeName(workerId)}:${AGENT_HOME}`, `${serviceVolumeName(workerId, slot)}:${SERVICE_DATA_DIR}`],
        NetworkMode: network ?? 'bridge',
        // So `host.docker.internal` reaches a backend running on the host (Linux needs this).
        ExtraHosts: ['host.docker.internal:host-gateway'],
        ...(spec.cpuLimit ? { NanoCpus: Math.round(spec.cpuLimit * 1e9) } : {}),
        ...(spec.memoryMb ? { Memory: spec.memoryMb * 1024 * 1024 } : {}),
      },
    });
    await container.start();
    await this.removeUnusedImages(workerId, spec.image);
  }

  async restartContainer(workerId: string, slot: number): Promise<void> {
    await this.docker.getContainer(containerName(workerId, slot)).restart();
  }

  async stopContainer(workerId: string, slot: number): Promise<void> {
    await this.docker.getContainer(containerName(workerId, slot)).stop({ t: 10 }).catch((err: unknown) => {
      if (![304, 404].includes((err as { statusCode?: number }).statusCode ?? 0)) throw err;
    });
  }

  async configureProfile(workerId: string, slot: number, profile: ProfileSpec): Promise<void> {
    const container = this.docker.getContainer(containerName(workerId, slot));
    const { archive, script } = await profileArchive(profile.agentId, profile.revision, profile.skills);
    await container.putArchive(archive, { path: AGENT_HOME });
    const result = await execIn(container, ['/bin/bash', '-c', script]);
    if (result.exitCode !== 0) throw new Error(`${result.stderr}${result.stdout}`.trim() || 'Could not configure agent skills');
    await this.configurePlugins(container, profile.agentId, profile.plugins);
  }

  private async configurePlugins(container: Docker.Container, agentId: string, plugins: InstalledPlugin[]): Promise<void> {
    const profile = agentProfilePath(agentId);
    const env = [`CLAUDE_CONFIG_DIR=${AGENT_HOME}/${profile}`];
    // Arguments go straight to `claude` (no shell), so names and sources can't inject anything.
    const claude = async (...args: string[]) => {
      const { stdout, stderr } = await execIn(container, ['mise', 'exec', '--', 'claude', 'plugin', ...args], env);
      const line = stdout.trim().split('\n').pop() ?? '';
      try {
        return JSON.parse(line) as { outcome?: string; pluginId?: string; message?: string; failureCode?: string };
      } catch {
        throw new Error(`claude plugin ${args[0]} failed: ${(stderr || stdout).trim().slice(0, 500) || 'no output'}`);
      }
    };
    const statePath = `${profile}/${PLUGIN_STATE_FILE}`;
    const state = await execIn(container, ['cat', `${AGENT_HOME}/${statePath}`]);
    let managed: string[] = state.exitCode === 0 ? parseIds(state.stdout) : [];
    const listed = await execIn(container, ['mise', 'exec', '--', 'claude', 'plugin', 'list', '--json'], env);
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
      await container.putArchive(await stateArchive(statePath, managed), { path: AGENT_HOME });
    }
  }

  async removeContainer(workerId: string, slot: number): Promise<void> {
    await this.docker.getContainer(containerName(workerId, slot)).remove({ force: true }).catch(ignore(404));
  }

  async removeWorker(workerId: string): Promise<void> {
    const containers = await this.docker.listContainers({ all: true, filters: JSON.stringify({ label: [`${WORKER_LABEL}=${workerId}`] }) });
    for (const c of containers) await this.docker.getContainer(c.Id).remove({ force: true }).catch(ignore(404));
    await this.removeAllImages(workerId);
    const { Volumes } = await this.docker.listVolumes({ filters: JSON.stringify({ label: [`${WORKER_LABEL}=${workerId}`] }) });
    for (const v of Volumes ?? []) await this.docker.getVolume(v.Name).remove().catch(ignore(404));
  }

  async removeSlot(workerId: string, slot: number): Promise<void> {
    await this.removeContainer(workerId, slot);
    await this.docker.getVolume(serviceVolumeName(workerId, slot)).remove().catch(ignore(404));
  }

  async removeUnusedImages(workerId: string, keepTag: string): Promise<number> {
    const repo = workerImageRepo(workerId);
    const images = await this.docker.listImages({ filters: JSON.stringify({ reference: [repo] }) });
    let removed = 0;
    for (const image of images) {
      if (image.RepoTags?.includes(keepTag)) continue;
      // Unforced: Docker keeps an image a container still uses.
      for (const tag of image.RepoTags ?? []) {
        if (tag.startsWith(`${repo}:`) && (await this.docker.getImage(tag).remove().then(() => true, () => false))) removed++;
      }
    }
    return removed;
  }

  async removeOldBaseImages(keepClaudeCodeVersions: string[]): Promise<number> {
    const keep = new Set(keepClaudeCodeVersions.map((version) => `${BASE_IMAGE}:${this.baseVersionFor(version)}`));
    const keptIds = new Set<string>();
    for (const tag of keep) {
      const id = await this.docker.getImage(tag).inspect().then((i) => i.Id, () => null);
      if (id) keptIds.add(id);
    }
    const images = await this.docker.listImages({ filters: JSON.stringify({ reference: [BASE_IMAGE] }) });
    let removed = 0;
    for (const image of images) {
      for (const tag of image.RepoTags ?? []) {
        if (!tag.startsWith(`${BASE_IMAGE}:`) || keep.has(tag)) continue;
        const latest = tag === `${BASE_IMAGE}:latest`;
        if (latest && keptIds.has(image.Id)) continue;
        // Untagging leaves the layers that Worker Images still build on.
        const ok = await this.docker.getImage(tag).remove().then(() => true, () => false);
        if (ok && !latest) removed++;
      }
    }
    return removed;
  }

  async cleanup(input: DockerCleanupInput): Promise<DockerCleanupReport> {
    const removed = noDockerCleanupCounts();
    const errors: string[] = [];
    const attempt = async (what: string, fn: () => Promise<unknown>): Promise<boolean> => {
      try {
        await fn();
        return true;
      } catch (err) {
        if ((err as { statusCode?: number }).statusCode === 404) return false;
        errors.push(`${what}: ${(err as Error).message}`.slice(0, 500));
        return false;
      }
    };
    const before = await this.diskUsage();
    // Listed before the Workers are read: a Worker created meanwhile is known by then.
    const mine = JSON.stringify({ label: [`${INSTALLATION_LABEL}=${this.installationId}`] });
    const containers = await this.docker.listContainers({ all: true, filters: mine });
    const { Volumes } = await this.docker.listVolumes({ filters: mine });
    const images = await this.docker.listImages({ filters: mine });
    const known = await input.workers();
    const knownIds = new Set(known.map((w) => w.id));
    const orphan = (labels: Record<string, string> | null | undefined) => !!labels?.[WORKER_LABEL] && !knownIds.has(labels[WORKER_LABEL]);

    if (!input.anyBuilding) {
      await attempt('old base images', async () => (removed.baseImages = await this.removeOldBaseImages(known.map((w) => w.claudeCodeVersion))));
      await attempt('untagged images', async () => {
        const untagged = JSON.stringify({ dangling: ['true'], label: [PLATFORM_LABEL] });
        const dangling = await this.docker.listImages({ filters: untagged });
        await this.docker.pruneImages({ filters: untagged });
        const left = await this.docker.listImages({ filters: untagged });
        removed.danglingImages = Math.max(0, dangling.length - left.length);
      });
    }
    // Read again: a Build may have started or finished meanwhile, changing what the Worker needs.
    for (const worker of await input.workers()) {
      if (worker.building || !worker.imageTag) continue;
      await attempt(`images of worker ${worker.id}`, async () => (removed.workerImages += await this.removeUnusedImages(worker.id, worker.imageTag!)));
    }

    const removedVolumes: string[] = [];
    for (const c of containers.filter((c) => orphan(c.Labels))) {
      if (await attempt(`container ${c.Names?.[0] ?? c.Id}`, () => this.docker.getContainer(c.Id).remove({ force: true }))) removed.orphanContainers++;
    }
    for (const v of (Volumes ?? []).filter((v) => orphan(v.Labels))) {
      if (await attempt(`volume ${v.Name}`, () => this.docker.getVolume(v.Name).remove())) {
        removed.orphanVolumes++;
        removedVolumes.push(v.Name);
      }
    }
    for (const image of images.filter((i) => orphan(i.Labels))) {
      if (await attempt(`image ${image.RepoTags?.[0] ?? image.Id}`, () => this.docker.getImage(image.Id).remove({ force: true }))) removed.orphanImages++;
    }

    const after = await this.diskUsage();
    const layers = before && after ? Math.max(0, before.layers - after.layers) : 0;
    const volumes = removedVolumes.reduce((sum, name) => sum + (before?.volumes.get(name) ?? 0), 0);
    return { removed, reclaimedBytes: layers + volumes, errors };
  }

  /** Image layers and volume sizes, from Docker's disk usage; null when Docker can't tell. */
  private async diskUsage(): Promise<{ layers: number; volumes: Map<string, number> } | null> {
    try {
      const df = (await this.docker.df()) as { LayersSize?: number; Volumes?: { Name: string; UsageData?: { Size?: number } }[] };
      return {
        layers: df.LayersSize ?? 0,
        volumes: new Map((df.Volumes ?? []).map((v) => [v.Name, Math.max(0, v.UsageData?.Size ?? 0)])),
      };
    } catch {
      return null;
    }
  }

  private labels(workerId: string): Record<string, string> {
    return { [INSTALLATION_LABEL]: this.installationId, [WORKER_LABEL]: workerId };
  }

  async inspect(workerId: string, slot: number): Promise<ContainerInfo> {
    try {
      const info = await this.docker.getContainer(containerName(workerId, slot)).inspect();
      return { state: info.State.Status, image: info.Config.Image };
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 404) return { state: 'missing', image: null };
      throw err;
    }
  }

  async logs(workerId: string, slot: number, tail: number): Promise<string> {
    try {
      const raw = (await this.docker.getContainer(containerName(workerId, slot)).logs({ stdout: true, stderr: true, tail, follow: false })) as Buffer;
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

  /** Every image of a deleted Worker. */
  private async removeAllImages(workerId: string): Promise<void> {
    const images = await this.docker.listImages({ filters: JSON.stringify({ reference: [workerImageRepo(workerId)] }) });
    for (const image of images) await this.docker.getImage(image.Id).remove({ force: true }).catch(() => {});
  }
}

function ignore(status: number) {
  return (err: unknown) => {
    if ((err as { statusCode?: number }).statusCode !== status) throw err;
  };
}

/** The plugin IDs the platform installed in a profile, so it never uninstalls one installed by hand. */
const PLUGIN_STATE_FILE = '.claude-task/plugins.json';
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

async function stateArchive(statePath: string, ids: string[]): Promise<Buffer> {
  const tar = pack();
  const chunks: Buffer[] = [];
  tar.on('data', (chunk) => chunks.push(Buffer.from(chunk as Uint8Array)));
  const done = new Promise<void>((resolve, reject) => {
    tar.on('end', resolve);
    tar.on('error', reject);
  });
  const parts = statePath.split('/').slice(0, -1);
  for (let i = 1; i <= parts.length; i++) tar.entry({ name: parts.slice(0, i).join('/'), type: 'directory', uid: 1000, gid: 1000, mode: 0o755 });
  tar.entry({ name: statePath, uid: 1000, gid: 1000, mode: 0o644 }, JSON.stringify(ids));
  tar.finalize();
  await done;
  return Buffer.concat(chunks);
}

/** Runs a command as the agent user, without a shell; stdout and stderr stay apart. */
async function execIn(container: Docker.Container, cmd: string[], env: string[] = []): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const exec = await container.exec({
    Cmd: cmd,
    User: 'agent',
    WorkingDir: AGENT_HOME,
    // Execs inherit the container's env: blank the Runner token for the code they run (plugins).
    Env: [`HOME=${AGENT_HOME}`, 'GIT_TERMINAL_PROMPT=0', 'CLAUDE_TASK_RUNNER_TOKEN=', ...env],
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
