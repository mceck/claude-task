import type { Host, HostConnection } from '@claude-task/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router';
import { Copy, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, errorMessage, patch, post } from '../api/client';
import { keys, useHosts, useMe } from '../api/queries';
import { ErrorText, Loading, Time, useConfirm } from './common';
import { StateDot } from './agents';
import { formatBytes } from './Cleanup';

export function HostsPanel() {
  const hosts = useHosts();
  const admin = useMe().data?.role === 'admin';
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [dialog, setDialog] = useState<Host | 'create' | null>(null);
  const [connection, setConnection] = useState<HostConnection | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: keys.hosts });
  const close = () => {
    setDialog(null);
    setConnection(null);
  };
  const rotate = async (host: Host) => {
    if (
      !(await confirm({
        title: 'Regenerate Host Token?',
        description: 'The connected Controller will be disconnected. Start it again with the new token.',
        confirmLabel: 'Regenerate token',
      }))
    )
      return;
    setBusy(true);
    setError('');
    try {
      setConnection(await post<HostConnection>(`/hosts/${host.id}/token`));
      setDialog(host);
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (host: Host) => {
    if (
      !(await confirm({
        title: `Delete ${host.name}?`,
        description:
          host.state === 'disconnected'
            ? 'The Controller is disconnected: containers, volumes and images stay on the machine and must be removed by hand'
            : 'The containers, volumes and images of this installation will be removed from the machine.',
        confirmLabel: 'Delete host',
        destructive: true,
      }))
    )
      return;
    setBusy(true);
    setError('');
    try {
      await api('DELETE', `/hosts/${host.id}`);
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-4">
      {admin && (
        <Button className="self-end" onClick={() => setDialog('create')}>
          <Plus data-icon="inline-start" />
          Add host
        </Button>
      )}
      <ErrorText>{error}</ErrorText>
      {hosts.isPending ? (
        <Loading />
      ) : hosts.error ? (
        <ErrorText>{errorMessage(hosts.error)}</ErrorText>
      ) : (
        <Table aria-label="Hosts">
          <TableHeader>
            <TableRow>
              <TableHead>Host</TableHead>
              <TableHead>Machine</TableHead>
              <TableHead>Versions</TableHead>
              <TableHead>Workers</TableHead>
              <TableHead>Last contact</TableHead>
              {admin && <TableHead>Actions</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {hosts.data.map((host) => (
              <TableRow key={host.id}>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <StateDot state={host.state === 'connected' ? 'connected' : 'offline'} />
                    <strong>{host.name}</strong>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {host.kind} · {host.state}
                  </p>
                  {host.description && <p>{host.description}</p>}
                  {host.error && <ErrorText>{host.error}</ErrorText>}
                </TableCell>
                <TableCell>
                  {[host.os, host.architecture].filter(Boolean).join(' · ') || '—'}
                  <p className="text-xs text-muted-foreground">
                    {host.cpus === null ? '—' : `${host.cpus} CPUs`} · {host.memoryBytes === null ? '—' : formatBytes(host.memoryBytes)}
                  </p>
                </TableCell>
                <TableCell>
                  <p>Controller {host.controllerVersion ?? '—'}</p>
                  <p>Docker {host.dockerVersion ?? '—'}</p>
                </TableCell>
                <TableCell>
                  <div className="flex flex-col gap-1">
                    {host.workers.map((w) => (
                      <Link key={w.id} to={`/workers/${w.id}`} className="underline">
                        {w.name}
                      </Link>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">{host.runningContainers} running containers</p>
                </TableCell>
                <TableCell>
                  {host.disconnectedAt || host.connectedAt ? (
                    <Time iso={host.state === 'connected' ? host.connectedAt! : (host.disconnectedAt ?? host.connectedAt!)} />
                  ) : (
                    'Never'
                  )}
                </TableCell>
                {admin && (
                  <TableCell>
                    {host.kind === 'remote' && (
                      <div className="flex flex-wrap gap-1">
                        <Button variant="ghost" size="sm" onClick={() => setDialog(host)}>
                          Edit
                        </Button>
                        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void rotate(host)}>
                          Regenerate token
                        </Button>
                        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void remove(host)}>
                          Delete
                        </Button>
                      </div>
                    )}
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open) close();
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{connection ? 'Connect the machine' : dialog === 'create' ? 'Add host' : 'Edit host'}</DialogTitle>
            <DialogDescription>
              {connection
                ? 'Build and start the Controller from a clone at the backend’s version.'
                : 'The Controller connects from the machine without opening an inbound port.'}
            </DialogDescription>
          </DialogHeader>
          {connection ? (
            <div className="flex flex-col gap-4">
              <p>This token is shown only once</p>
              <Input aria-label="Host Token" value={connection.token} readOnly />
              {connection.commands.map((command, i) => (
                <div key={i} className="flex flex-col gap-2">
                  <pre
                    aria-label={`Connect command ${i + 1}`}
                    className="overflow-auto rounded border p-3 font-mono text-xs whitespace-pre-wrap break-all"
                  >
                    {command}
                  </pre>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      void navigator.clipboard.writeText(command).catch((err) => setError(errorMessage(err)));
                    }}
                  >
                    <Copy data-icon="inline-start" />
                    Copy command {i + 1}
                  </Button>
                </div>
              ))}
              <Button onClick={close}>Close</Button>
            </div>
          ) : (
            dialog && (
              <HostForm
                host={dialog === 'create' ? undefined : dialog}
                onSaved={async (result) => {
                  await refresh();
                  if ('token' in result) setConnection(result);
                  else close();
                }}
              />
            )
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function HostForm({ host, onSaved }: { host?: Host; onSaved: (result: HostConnection | { host: Host }) => Promise<void> }) {
  const [name, setName] = useState(host?.name ?? '');
  const [description, setDescription] = useState(host?.description ?? '');
  const [url, setUrl] = useState(host?.backendUrlOverride ?? '');
  const [insecure, setInsecure] = useState(host?.allowInsecure ?? false);
  const [network, setNetwork] = useState(host?.network ?? '');
  const [error, setError] = useState(''),
    [saving, setSaving] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    const body = { name, description, backendUrlOverride: url || null, allowInsecure: insecure, network: network || null };
    try {
      await onSaved(host ? await patch<{ host: Host }>(`/hosts/${host.id}`, body) : await post<HostConnection>('/hosts', body));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };
  return (
    <form onSubmit={submit}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="host-name">Host name</FieldLabel>
          <Input id="host-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />
        </Field>
        <Field>
          <FieldLabel htmlFor="host-description">Description</FieldLabel>
          <Textarea id="host-description" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} />
        </Field>
        <Field>
          <FieldLabel htmlFor="host-url">Backend URL override</FieldLabel>
          <Input id="host-url" type="url" placeholder="Use the Controller’s URL" value={url} onChange={(e) => setUrl(e.target.value)} />
        </Field>
        <Field orientation="horizontal">
          <Checkbox id="host-insecure" checked={insecure} onCheckedChange={(value) => setInsecure(value === true)} />
          <FieldLabel htmlFor="host-insecure">Allow insecure connections</FieldLabel>
        </Field>
        <Field>
          <FieldLabel htmlFor="host-network">Docker network</FieldLabel>
          <Input
            id="host-network"
            value={network}
            onChange={(e) => setNetwork(e.target.value)}
            maxLength={128}
            placeholder="Default bridge"
          />
        </Field>
        <ErrorText>{error}</ErrorText>
        <Button type="submit" disabled={saving}>
          {host ? 'Save' : 'Add host'}
        </Button>
      </FieldGroup>
    </form>
  );
}
