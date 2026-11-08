import { HostsPanel } from '../components/Hosts';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { WORKERS_TOPIC } from '@claude-task/shared';
import type { Worker } from '@claude-task/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, Server } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { errorMessage, post } from '../api/client';
import { keys, useMe, useWorkers } from '../api/queries';
import { ErrorText, Loading } from '../components/common';
import { CleanupButton, LastCleanup } from '../components/Cleanup';
import { WorkerForm } from '../components/WorkerForm';
import { WorkerStateBadge, WorkerStateDot } from '../components/workers';
import { useTopic } from '../lib/realtime';
import { PageHeader } from './ProjectsPage';

export function WorkersPage() {
  const workers = useWorkers();
  const admin = useMe().data?.role === 'admin';
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  useTopic(WORKERS_TOPIC);
  return (
    <div className="mx-auto max-w-6xl px-8 py-8">
      <PageHeader title="Workers" description="Execution environments: the Docker containers where agents work on the tasks of their projects.">
        {admin && (
          <>
            <CleanupButton />
            <Button onClick={() => setCreating(true)}>
              <Plus /> New worker
            </Button>
          </>
        )}
      </PageHeader>
      <Tabs defaultValue="workers"><TabsList className="mb-5"><TabsTrigger value="workers">Workers</TabsTrigger><TabsTrigger value="hosts">Hosts</TabsTrigger></TabsList><TabsContent value="hosts"><HostsPanel /></TabsContent><TabsContent value="workers">
      {admin && <LastCleanup />}
      {workers.isPending ? (
        <Loading />
      ) : workers.error ? (
        <ErrorText>{errorMessage(workers.error)}</ErrorText>
      ) : !workers.data.length ? (
        <p className="rounded-xl border border-dashed p-12 text-center text-muted-foreground">
          No workers yet. {admin ? 'Create one before the first project.' : 'An admin creates one before the first project.'}
        </p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {workers.data.map((worker) => (
            <WorkerCard key={worker.id} worker={worker} />
          ))}
        </div>
      )}
      </TabsContent></Tabs>
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>New worker</DialogTitle>
            <DialogDescription>Its image builds right away; its containers start as work arrives.</DialogDescription>
          </DialogHeader>
          <WorkerForm
            onCreate={async (body) => {
              const { worker } = await post<{ worker: Worker }>('/workers', body);
              await qc.invalidateQueries({ queryKey: keys.workers });
              setCreating(false);
              navigate(`/workers/${worker.id}`);
            }}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}

function WorkerCard({ worker }: { worker: Worker }) {
  return (
    <Link to={`/workers/${worker.id}`} className="space-y-4 rounded-xl border bg-card p-5 transition-colors hover:border-primary/50">
      <div className="flex items-center gap-3">
        <span className="relative flex size-11 shrink-0 items-center justify-center rounded-lg border bg-muted/40">
          <Server className="size-5 text-muted-foreground" />
          <span className="absolute -right-0.5 -bottom-0.5">
            <WorkerStateDot worker={worker} />
          </span>
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-semibold">{worker.name}</h2>
          <p className="truncate text-sm text-muted-foreground">{worker.description || 'No description'}</p>
        </div>
        <WorkerStateBadge state={worker.state} />
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span aria-label="Containers">
          {worker.busy} busy · {worker.running} running / cap {worker.cap}
        </span>
        <span>Host: {worker.host.name}</span>
        <span>{worker.queueLength} queued</span>
        <span className="min-w-0 truncate">
          {worker.projects.length ? `Projects: ${worker.projects.map((p) => p.name).join(', ')}` : 'No projects'}
        </span>
      </div>
    </Link>
  );
}
