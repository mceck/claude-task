import type { Task, VoiceRoom } from '@claude-task/shared';
import { useQuery } from '@tanstack/react-query';
import { Headphones, HeadphoneOff, Mic, MicOff, PhoneOff, Radio, RotateCw, X } from 'lucide-react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { get } from '../api/client';
import { voice, VoiceJoinError, useVoice } from '../lib/voice';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Alert, AlertDescription } from './ui/alert';
import { useConfirm } from './common';

export function VoiceRoomPanel({ task }: { task: Pick<Task, 'id' | 'key'> }) {
  const state = useVoice();
  const confirm = useConfirm();
  const room = useQuery({ queryKey: ['voice', task.id], queryFn: () => get<{ room: VoiceRoom }>(`/tasks/${task.id}/voice`) });
  const snapshot = state.room?.taskId === task.id ? state.room : room.data?.room;
  const active = state.room?.taskId === task.id;
  const join = async () => {
    let replace = state.participantId ?? undefined;
    if (replace && !await confirm({ title: 'Transfer voice participation?', description: `Leave ${state.room?.taskKey} and join ${task.key}?`, confirmLabel: 'Transfer' })) return;
    try { await voice.join(task.id, replace); }
    catch (error) {
      if (error instanceof VoiceJoinError && error.current) {
        if (!await confirm({ title: 'Transfer voice participation?', description: `You are in ${error.current.taskKey} on another device or tab. Move voice here?`, confirmLabel: 'Transfer' })) return;
        replace = error.current.participantId;
        try { await voice.join(task.id, replace); } catch (err) { toast.error(err instanceof Error ? err.message : 'Could not join voice'); }
      } else toast.error(error instanceof Error ? error.message : 'Could not join voice');
    }
  };
  return <section aria-label="Task Voice Room" className="flex shrink-0 flex-wrap items-center gap-3 border-b px-5 py-2">
    <Radio className="size-4 text-muted-foreground" />
    <span className="text-sm font-medium">Voice Room</span>
    <Badge variant="secondary">{snapshot?.participants.length ?? 0}/6</Badge>
    <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{snapshot?.participants.map((p) => `${p.user.displayName}${p.muted ? ' (muted)' : ''}`).join(', ') || (room.isError ? 'Room unavailable. Try again.' : 'Join to talk about this Task')}</span>
    <Button size="xs" variant={active ? 'secondary' : 'outline'} disabled={state.joining || active || room.isPending || room.isError} onClick={() => void join()}>
      <Headphones data-icon="inline-start" />{active ? 'In voice' : state.joining ? 'Joining…' : 'Join voice'}
    </Button>
  </section>;
}

export function VoiceBar() {
  const state = useVoice();
  if (!state.room && !state.error && !state.joining) return null;
  return <section aria-label="Voice controls" className="flex shrink-0 flex-col gap-2 border-t bg-card px-4 py-3">
    {state.error && <Alert variant="destructive"><AlertDescription className="flex items-center justify-between gap-3">
      {state.error}<Button variant="ghost" size="icon-xs" aria-label="Dismiss voice notice" onClick={() => voice.dismissError()}><X /></Button>
    </AlertDescription></Alert>}
    {state.joining && <p className="text-sm text-muted-foreground" role="status">Joining Voice Room…</p>}
    {state.room && <>
      <div className="flex flex-wrap items-center gap-2">
        <Radio className="size-4 text-muted-foreground" />
        <Link to={`/t/${state.room.taskKey}`} className="text-sm font-medium hover:underline">Voice · {state.room.taskKey}</Link>
        <span className="mr-auto text-xs text-muted-foreground">{state.room.participants.length}/6</span>
        <Button size="xs" variant={state.muted ? 'secondary' : 'outline'} aria-pressed={state.muted} onClick={() => voice.mute()} aria-label={state.muted ? 'Unmute microphone' : 'Mute microphone'}>{state.muted ? <MicOff /> : <Mic />}{state.muted ? 'Unmute' : 'Mute'}</Button>
        <Button size="xs" variant={state.deafened ? 'secondary' : 'outline'} aria-pressed={state.deafened} onClick={() => voice.deafen()} aria-label={state.deafened ? 'Enable incoming audio' : 'Silence incoming audio'}>{state.deafened ? <HeadphoneOff /> : <Headphones />}{state.deafened ? 'Listen' : 'Silence'}</Button>
        <Button size="xs" variant="destructive" onClick={() => voice.leave()}><PhoneOff />Leave voice</Button>
      </div>
      <div className="flex flex-wrap gap-2" aria-label="Voice participants">
        {state.room.participants.map((p) => <div key={p.id} className="flex items-center gap-1.5 text-xs" data-voice-participant={p.id}>
          {p.muted ? <MicOff className="size-3 text-muted-foreground" /> : <Mic className="size-3 text-muted-foreground" />}
          <span>{p.user.displayName}{p.id === state.participantId ? ' (you)' : ''}</span>
          {p.id !== state.participantId && <>
            <Badge variant={state.links[p.id] === 'unavailable' ? 'destructive' : 'secondary'}>{state.links[p.id] ?? 'connecting'}</Badge>
            {state.links[p.id] === 'unavailable' && <Button size="icon-xs" variant="ghost" aria-label={`Retry connection to ${p.user.displayName}`} onClick={() => voice.retry(p.id)}><RotateCw /></Button>}
          </>}
        </div>)}
      </div>
      {Object.values(state.links).includes('unavailable') && <p className="text-xs text-destructive" role="status">Some people cannot hear you. An audio connection could not be established. Retry or try another network.</p>}
      {state.playbackBlocked && <Button variant="outline" size="xs" onClick={() => void voice.resumeAudio()}>Enable voice playback</Button>}
    </>}
  </section>;
}
