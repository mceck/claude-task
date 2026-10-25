import type { Role, User, UserWithTemporaryPassword } from '@claude-task/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Check, Copy, KeyRound, MoreHorizontal, Plus, UserCheck, UserX } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { errorMessage, patch, post } from '../api/client';
import { keys, useMe, useUsers } from '../api/queries';
import { ErrorText, Loading, useConfirm, UserAvatar } from '../components/common';
import { NotFoundPage } from './NotFoundPage';
import { PageHeader } from './ProjectsPage';

export function UsersPage() {
  const me = useMe();
  const users = useUsers();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [creating, setCreating] = useState(false);
  const [issued, setIssued] = useState<UserWithTemporaryPassword | null>(null);

  if (me.data?.role !== 'admin') return <NotFoundPage />;

  const update = async (user: User, body: Partial<Pick<User, 'role' | 'active'>>) => {
    try {
      await patch(`/users/${user.id}`, body);
      await qc.invalidateQueries({ queryKey: keys.users });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const reset = async (user: User) => {
    const ok = await confirm({
      title: `Reset ${user.displayName}’s password?`,
      description: 'They’ll be logged out everywhere and must choose a new password with the temporary one.',
      confirmLabel: 'Reset password',
      destructive: true,
    });
    if (!ok) return;
    try {
      setIssued(await post<UserWithTemporaryPassword>(`/users/${user.id}/reset-password`));
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const toggleActive = async (user: User) => {
    if (user.active) {
      const ok = await confirm({
        title: `Deactivate ${user.displayName}?`,
        description: 'They’re logged out right away and can’t log in again. Their comments and history stay.',
        confirmLabel: 'Deactivate',
        destructive: true,
      });
      if (!ok) return;
    }
    await update(user, { active: !user.active });
  };

  return (
    <div className="mx-auto max-w-5xl px-8 py-8">
      <PageHeader title="Users" description="Admins manage users, agents, credentials and secrets. Members do everything else.">
        <Button onClick={() => setCreating(true)}>
          <Plus /> New user
        </Button>
      </PageHeader>
      {users.isPending ? (
        <Loading />
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Name</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.data?.map((u) => (
                <TableRow key={u.id} className={u.active ? '' : 'opacity-50'}>
                  <TableCell className="pl-4">
                    <div className="flex items-center gap-3">
                      <UserAvatar user={u} size="md" />
                      <div>
                        <p className="font-medium">{u.displayName}</p>
                        <p className="text-xs text-muted-foreground">{u.email}</p>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Select value={u.role} onValueChange={(role) => update(u, { role: role as Role })}>
                      <SelectTrigger size="sm" className="w-28" aria-label={`Role of ${u.displayName}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="member">Member</SelectItem>
                        <SelectItem value="admin">Admin</SelectItem>
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>
                    {!u.active ? (
                      <Badge variant="outline">Deactivated</Badge>
                    ) : u.mustChangePassword ? (
                      <Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 text-amber-500">
                        Invited
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 text-emerald-500">
                        Active
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${u.displayName}`}>
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => reset(u)}>
                          <KeyRound /> Reset password
                        </DropdownMenuItem>
                        <DropdownMenuItem variant={u.active ? 'destructive' : 'default'} onSelect={() => toggleActive(u)}>
                          {u.active ? <UserX /> : <UserCheck />} {u.active ? 'Deactivate' : 'Reactivate'}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <CreateUserDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(r) => {
          setCreating(false);
          setIssued(r);
          void qc.invalidateQueries({ queryKey: keys.users });
        }}
      />
      <TemporaryPasswordDialog issued={issued} onClose={() => setIssued(null)} />
    </div>
  );
}

function TemporaryPasswordDialog({ issued, onClose }: { issued: UserWithTemporaryPassword | null; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(issued!.temporaryPassword);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <Dialog open={!!issued} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Temporary password</DialogTitle>
          <DialogDescription>
            Share it with {issued?.user.displayName} ({issued?.user.email}). They’ll change it at first login. It won’t be shown again.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2 rounded-lg border bg-muted/50 p-2 pl-3">
          <code className="flex-1 font-mono text-sm">{issued?.temporaryPassword}</code>
          <Button variant="ghost" size="icon-sm" onClick={copy} aria-label="Copy password">
            {copied ? <Check className="text-emerald-500" /> : <Copy />}
          </Button>
        </div>
        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CreateUserDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (r: UserWithTemporaryPassword) => void;
}) {
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<Role>('member');
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      onCreated(await post<UserWithTemporaryPassword>('/users', { email, displayName, role }));
      setEmail('');
      setDisplayName('');
      setRole('member');
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>New user</DialogTitle>
            <DialogDescription>They get a temporary password to change at first login.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="user-name">Name</Label>
            <Input id="user-name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} required autoFocus />
          </div>
          <div className="space-y-2">
            <Label htmlFor="user-email">Email</Label>
            <Input id="user-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div className="space-y-2">
            <Label>Role</Label>
            <Select value={role} onValueChange={(r) => setRole(r as Role)}>
              <SelectTrigger className="w-full" aria-label="Role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="member">Member</SelectItem>
                <SelectItem value="admin">Admin</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <ErrorText>{error}</ErrorText>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit">Create user</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
