import type { MeResponse } from '@claude-task/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { errorMessage, post } from '../api/client';
import { keys, useMe } from '../api/queries';
import { ErrorText } from '../components/common';
import { AuthShell } from './LoginPage';

export function ChangePasswordPage() {
  const me = useMe();
  const forced = me.data?.mustChangePassword ?? false;
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const qc = useQueryClient();
  const navigate = useNavigate();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (next !== confirm) return setError('The new passwords don’t match');
    try {
      const { user } = await post<MeResponse>('/auth/password', { currentPassword: current, newPassword: next });
      qc.setQueryData(keys.me, user);
      toast.success('Password changed', { description: forced ? undefined : 'Your other sessions were logged out.' });
      navigate('/', { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <AuthShell
      title={forced ? 'Choose your password' : 'Change password'}
      subtitle={forced ? 'You’re using a temporary password. Pick your own to continue.' : undefined}
    >
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="current">{forced ? 'Temporary password' : 'Current password'}</Label>
          <Input id="current" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
        </div>
        <div className="space-y-2">
          <Label htmlFor="new">New password (at least 8 characters)</Label>
          <Input id="new" type="password" autoComplete="new-password" minLength={8} value={next} onChange={(e) => setNext(e.target.value)} required />
        </div>
        <div className="space-y-2">
          <Label htmlFor="confirm">Confirm new password</Label>
          <Input id="confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        </div>
        <ErrorText>{error}</ErrorText>
        <div className="flex gap-2">
          {!forced && (
            <Button type="button" variant="outline" size="lg" className="flex-1" onClick={() => navigate(-1)}>
              Cancel
            </Button>
          )}
          <Button type="submit" size="lg" className="flex-1">
            Change password
          </Button>
        </div>
      </form>
    </AuthShell>
  );
}
