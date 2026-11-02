import { agentTopic } from '@claude-task/shared';
import type { Agent, Job } from '@claude-task/shared';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { del, errorMessage, patch, post } from '../api/client';
import { keys, useAgent, useJob, useJobs, useMe, useUsage } from '../api/queries';
import { AgentAvatar, AgentStateBadge, formatCost, formatDuration, formatTokens } from '../components/agents';
import { AgentForm, applyAvatarChange } from '../components/AgentForm';
import { ErrorText, Loading, LogView, Time, useConfirm } from '../components/common';
import { useTopic } from '../lib/realtime';
import { NotFoundPage } from './NotFoundPage';

const ACTIVE_JOB_STATES: Job['state'][] = ['dispatched', 'running', 'finishing'];

export function AgentPage() {
  const { agentId } = useParams();
  const query = useAgent(agentId);
  useTopic(agentId ? agentTopic(agentId) : null);
  if (query.isPending) return <Loading className="h-full" />;
  if (!query.data)
    return query.error && (query.error as { status?: number }).status !== 404 ? (
      <ErrorText>{errorMessage(query.error)}</ErrorText>
    ) : (
      <NotFoundPage what="Agent" />
    );
  return <AgentDetail key={query.data.id} agent={query.data} />;
}

function AgentDetail({ agent }: { agent: Agent }) {
  const admin = useMe().data?.role === 'admin';
  const qc = useQueryClient();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState('work');
  const refresh = async () => {
    await Promise.all([keys.agents, keys.agent(agent.id)].map((key) => qc.invalidateQueries({ queryKey: key })));
  };
  const remove = async () => {
    if (
      !(await confirm({
        title: `Delete ${agent.name}?`,
        description: 'Its past jobs keep its name. Unassign it from open tasks, wikis and schedules first.',
        confirmLabel: 'Delete agent',
        destructive: true,
      }))
    )
      return;
    try {
      await del(`/agents/${agent.id}`);
      await qc.invalidateQueries({ queryKey: keys.agents });
      navigate('/agents');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  return (
    <div className="mx-auto max-w-5xl space-y-6 px-8 py-8">
      <Button asChild variant="ghost" size="sm">
        <Link to="/agents">
          <ArrowLeft /> Agents
        </Link>
      </Button>
      <header className="flex flex-wrap items-center gap-4">
        <AgentAvatar agent={agent} size="lg" state={agent.state} />
        <div className="flex-1">
          <h1 className="text-2xl font-semibold tracking-tight">{agent.name}</h1>
          <p className="text-sm text-muted-foreground">{agent.description}</p>
        </div>
        <AgentStateBadge state={agent.state} activeJobs={agent.activeJobs} />
      </header>
      <div className="flex flex-wrap items-center gap-4 rounded-xl border bg-card p-4 text-sm">
        <span>Credential: {agent.credentialName}</span>
        <span>
          {agent.activeJobs} active {agent.activeJobs === 1 ? 'job' : 'jobs'}
        </span>
        {agent.lastActivityAt && (
          <span className="text-muted-foreground">
            Active <Time iso={agent.lastActivityAt} />
          </span>
        )}
        {agent.extensionsPending && <p role="status" className="w-full text-muted-foreground">Skill, MCP and plugin changes apply on each worker before the agent’s next job there.</p>}
        {agent.extensionErrors.length > 0 && (
          <ul aria-label="Extension errors" className="w-full space-y-1">
            {agent.extensionErrors.map((e) => (
              <li key={e.workerId} role="alert" className="text-destructive">
                <Link className="font-medium underline" to={`/workers/${e.workerId}`}>
                  {e.workerName}
                </Link>
                : {e.error}
              </li>
            ))}
          </ul>
        )}
        {admin && (
          <div className="flex w-full flex-wrap gap-2 border-t pt-3">
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const result = await post<{ agent: Agent }>(`/agents/${agent.id}/duplicate`, {});
                  await refresh();
                  navigate(`/agents/${result.agent.id}`);
                } catch (err) {
                  toast.error(errorMessage(err));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Duplicate
            </Button>
            <Button variant="ghost" size="sm" className="ml-auto text-destructive" onClick={remove}>
              Delete
            </Button>
          </div>
        )}
      </div>
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="mb-4">
          <TabsTrigger value="work">Jobs</TabsTrigger>
          <TabsTrigger value="usage">Usage</TabsTrigger>
          {admin && <TabsTrigger value="config">Configuration</TabsTrigger>}
        </TabsList>
        <TabsContent value="work">
          <JobsPanel agentId={agent.id} />
        </TabsContent>
        <TabsContent value="usage">
          <UsagePanel agentId={agent.id} />
        </TabsContent>
        {admin && (
          <TabsContent value="config">
            <div className="rounded-xl border bg-card p-5">
              <AgentForm
                key={agent.id}
                agent={agent}
                onUpdate={async (body, avatar) => {
                  if (Object.keys(body).length) await patch(`/agents/${agent.id}`, body);
                  await applyAvatarChange(agent.id, avatar);
                  await refresh();
                }}
              />
            </div>
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}

/** Where a Job runs: "Worker · slot 2". */
function placement(job: Job): string {
  if (!job.workerName) return 'No worker';
  return job.slot ? `${job.workerName} · slot ${job.slot}` : job.workerName;
}

function JobsPanel({ agentId }: { agentId: string }) {
  const query = useJobs(agentId);
  const [selected, setSelected] = useState<string | null>(null);
  const job = useJob(selected);
  const active = (query.data ?? []).filter((j) => ACTIVE_JOB_STATES.includes(j.state));
  return (
    <section className="space-y-3">
      <h2 className="font-semibold">Active jobs</h2>
      {query.data && !active.length ? (
        <p className="text-sm text-muted-foreground">No job running right now.</p>
      ) : (
        <ul aria-label="Active jobs" className="divide-y rounded-lg border border-emerald-500/30">
          {active.map((j) => (
            <li key={j.id} className="flex items-center gap-3 bg-emerald-500/5 p-3 text-sm">
              <Link className="min-w-0 flex-1 truncate" to={`/t/${j.task.key}`}>
                <b>{j.task.key}</b> · {j.task.title}
              </Link>
              {j.workerId ? (
                <Link className="text-xs text-muted-foreground underline" to={`/workers/${j.workerId}`}>
                  {placement(j)}
                </Link>
              ) : (
                <span className="text-xs text-muted-foreground">{placement(j)}</span>
              )}
              <span className="text-xs">{j.state}</span>
            </li>
          ))}
        </ul>
      )}
      <h2 className="pt-3 font-semibold">Recent jobs</h2>
      {query.isPending ? (
        <Loading />
      ) : query.error ? (
        <ErrorText>{errorMessage(query.error)}</ErrorText>
      ) : !query.data.length ? (
        <p className="text-sm text-muted-foreground">No jobs yet.</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {query.data.map((j) => (
            <li key={j.id} className="flex items-center gap-3 p-3 text-sm">
              <Link className="font-mono text-xs underline" to={`/t/${j.task.key}`}>
                {j.task.key}
              </Link>
              <span>{j.state}</span>
              <span className="text-xs text-muted-foreground">{placement(j)}</span>
              <span className="text-xs text-muted-foreground">
                {j.turns} turns · {formatCost(j.usage.costUsd)} · <Time iso={j.createdAt} />
              </span>
              <Button variant="ghost" size="xs" className="ml-auto" onClick={() => setSelected(j.id)}>
                Details
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Dialog open={!!selected} onOpenChange={(open) => !open && setSelected(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Job details</DialogTitle>
            <DialogDescription>Setup output and process diagnostics.</DialogDescription>
          </DialogHeader>
          {job.isPending ? (
            <Loading />
          ) : job.error ? (
            <ErrorText>{errorMessage(job.error)}</ErrorText>
          ) : (
            job.data && (
              <div className="space-y-3">
                <p className="text-sm">
                  {job.data.task.key} · {job.data.state} · {placement(job.data)} · Claude {job.data.claudeVersion ?? 'unknown'}
                  {job.data.startedAt && job.data.finishedAt && ` · ${formatDuration(Date.parse(job.data.finishedAt) - Date.parse(job.data.startedAt))}`}
                </p>
                {job.data.error && (
                  <ErrorText>
                    {job.data.failureStage}: {job.data.error}
                  </ErrorText>
                )}
                <h3 className="text-sm font-medium">Setup script</h3>
                <LogView>{job.data.setupOutput}</LogView>
                <h3 className="text-sm font-medium">Stderr</h3>
                <LogView>{job.data.stderr}</LogView>
              </div>
            )
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}

function UsagePanel({ agentId }: { agentId: string }) {
  const query = useUsage(agentId);
  if (query.isPending) return <Loading />;
  if (query.error) return <ErrorText>{errorMessage(query.error)}</ErrorText>;
  const usage = query.data;
  const tokens = (r: typeof usage.total) => formatTokens(r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheCreationTokens);
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-3 gap-3">
        {[
          ['Estimated cost', formatCost(usage.total.costUsd)],
          ['Tokens', tokens(usage.total)],
          ['Turns', usage.total.turns],
        ].map(([label, value]) => (
          <div key={label} className="rounded-xl border bg-card p-4">
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="mt-1 text-2xl font-semibold">{value}</p>
          </div>
        ))}
      </div>
      {(
        [
          ['Per day (last 30 days, UTC)', usage.byDay],
          ['Per task', usage.byTask],
        ] as const
      ).map(([title, rows]) => (
        <section key={title}>
          <h2 className="mb-3 font-semibold">{title}</h2>
          {rows.length ? (
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr>
                  <th className="p-2">{title.startsWith('Per day') ? 'Day' : 'Task'}</th>
                  <th>Turns</th>
                  <th>Tokens</th>
                  <th>Estimated cost</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key} className="border-t">
                    <td className="p-2">
                      {'taskId' in r && r.key !== 'deleted' ? (
                        <Link className="underline" to={`/t/${r.key}`}>
                          {r.key}
                        </Link>
                      ) : (
                        r.key
                      )}
                    </td>
                    <td>{r.turns}</td>
                    <td>{tokens(r)}</td>
                    <td>{formatCost(r.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-sm text-muted-foreground">No usage yet.</p>
          )}
        </section>
      ))}
      <section>
        <h2 className="mb-3 font-semibold">Latest rate-limit status</h2>
        {usage.rateLimit ? (
          <>
            <p className="mb-2 text-xs text-muted-foreground">
              <Time iso={usage.rateLimit.observedAt} />
            </p>
            <LogView>{JSON.stringify(usage.rateLimit.info, null, 2)}</LogView>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">No rate-limit observations yet.</p>
        )}
      </section>
    </div>
  );
}
