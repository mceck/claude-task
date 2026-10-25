import { AGENTS_TOPIC } from '@claude-task/shared';
import type { Agent } from '@claude-task/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { post, errorMessage } from '../api/client';
import { keys, useAgents, useMe } from '../api/queries';
import { AgentAvatar, AgentStateBadge } from '../components/agents';
import { AgentForm } from '../components/AgentForm';
import { ErrorText, Loading, Time } from '../components/common';
import { useTopic } from '../lib/realtime';
import { PageHeader } from './ProjectsPage';

export function AgentsPage() {
  const agents = useAgents();
  const me = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  useTopic(AGENTS_TOPIC);
  return (
    <div className="mx-auto max-w-6xl px-8 py-8">
      <PageHeader title="Agents" description="Reusable teammates, their current work and queued tasks.">
        {me.data?.role === 'admin' && (
          <Button onClick={() => setCreating(true)}>
            <Plus /> New agent
          </Button>
        )}
      </PageHeader>
      {agents.isPending ? (
        <Loading />
      ) : agents.error ? (
        <ErrorText>{errorMessage(agents.error)}</ErrorText>
      ) : !agents.data.length ? (
        <p className="rounded-xl border border-dashed p-12 text-center text-muted-foreground">
          No agents yet. An admin can create one to start working on tasks.
        </p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {agents.data.map((agent) => (
            <Link key={agent.id} to={`/agents/${agent.id}`} className="space-y-4 rounded-xl border bg-card p-5 transition-colors hover:border-primary/50">
              <div className="flex items-center gap-3">
                <AgentAvatar agent={agent} size="lg" state={agent.state} />
                <div className="min-w-0 flex-1">
                  <h2 className="truncate font-semibold">{agent.name}</h2>
                  <p className="truncate text-sm text-muted-foreground">{agent.description || agent.credentialName}</p>
                </div>
                <AgentStateBadge state={agent.state} />
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span>{agent.currentTask ? `Working on ${agent.currentTask.key}` : 'No current task'}</span>
                <span>{agent.queueLength} queued</span>
                <span>Credential: {agent.credentialName}</span>
                {agent.lastActivityAt && (
                  <span>
                    Active <Time iso={agent.lastActivityAt} />
                  </span>
                )}
              </div>
            </Link>
          ))}
        </div>
      )}
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>New agent</DialogTitle>
            <DialogDescription>Choose its identity, credential and environment.</DialogDescription>
          </DialogHeader>
          <AgentForm
            onSave={async (body) => {
              const { agent } = await post<{ agent: Agent }>('/agents', body);
              await qc.invalidateQueries({ queryKey: keys.agents });
              setCreating(false);
              navigate(`/agents/${agent.id}`);
            }}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}
