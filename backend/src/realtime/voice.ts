import { randomUUID } from 'node:crypto';
import { VOICE_ROOM_LIMIT, taskTopic } from '@claude-task/shared';
import type { VoiceCommand, VoiceParticipant, VoiceRoom, VoiceServerMessage, VoiceIceConfiguration } from '@claude-task/shared';
import type { WebSocket } from 'ws';

interface Participation { socket: WebSocket; participant: VoiceParticipant; taskId: string }

/** Transient membership; mutations are synchronous after Task validation. */
export class VoiceRooms {
  private readonly byUser = new Map<string, Participation>();
  private readonly bySocket = new Map<WebSocket, Participation>();
  private readonly rooms = new Map<string, VoiceRoom>();
  constructor(private readonly publish: (topic: ReturnType<typeof taskTopic>, event: { type: 'voice.room'; room: VoiceRoom }) => void) {}

  snapshot(task: { id: string; key: string }): VoiceRoom {
    return this.rooms.get(task.id) ?? { taskId: task.id, taskKey: task.key, participants: [] };
  }

  join(socket: WebSocket, user: VoiceParticipant['user'], task: { id: string; key: string }, command: Extract<VoiceCommand, { type: 'voice.join' }>, ice: VoiceIceConfiguration): void {
    const old = this.byUser.get(user.id);
    if (old && command.replace !== old.participant.id) {
      this.send(socket, { type: 'voice.error', requestId: command.requestId, code: 'already_joined', message: `You are already in ${this.rooms.get(old.taskId)!.taskKey}. Transfer your voice participation?`, current: { participantId: old.participant.id, taskKey: this.rooms.get(old.taskId)!.taskKey } });
      return;
    }
    if (command.replace && old?.participant.id !== command.replace) {
      this.send(socket, { type: 'voice.error', requestId: command.requestId, code: 'stale', message: 'Voice participation changed. Join again to confirm the current transfer.' });
      return;
    }
    const room = this.snapshot(task);
    const others = room.participants.filter((p) => p.user.id !== user.id);
    if (others.length >= VOICE_ROOM_LIMIT) {
      this.send(socket, { type: 'voice.error', requestId: command.requestId, code: 'full', message: 'This Voice Room is full (6 people).' });
      return;
    }
    if (old) this.remove(old, 'transferred');
    const participant: VoiceParticipant = { id: randomUUID(), user: { id: user.id, displayName: user.displayName }, muted: false };
    const participation = { socket, participant, taskId: task.id };
    this.byUser.set(user.id, participation);
    this.bySocket.set(socket, participation);
    this.rooms.set(task.id, { ...room, participants: [...others, participant] });
    this.send(socket, { type: 'voice.joined', requestId: command.requestId, participantId: participant.id, room: this.rooms.get(task.id)!, ...ice });
    this.broadcast(task.id);
  }

  refresh(socket: WebSocket, participantId: string, ice: VoiceIceConfiguration): void {
    if (this.current(socket, participantId)) this.send(socket, { type: 'voice.ice', participantId, ...ice });
  }

  private current(socket: WebSocket, participantId: string): Participation | undefined {
    const current = this.bySocket.get(socket);
    if (!current || current.participant.id !== participantId) {
      this.send(socket, { type: 'voice.error', code: 'stale', message: 'This voice participation has ended.' });
      return undefined;
    }
    return current;
  }

  command(socket: WebSocket, command: Exclude<VoiceCommand, { type: 'voice.join' | 'voice.ice' }>): void {
    const current = this.current(socket, command.participantId);
    if (!current) return;
    if (command.type === 'voice.leave') return this.remove(current, 'left');
    if (command.type === 'voice.mute') {
      current.participant.muted = command.muted;
      this.broadcast(current.taskId);
      return;
    }
    const target = [...this.byUser.values()].find((p) => p.participant.id === command.targetId);
    if (!target || target === current || target.taskId !== current.taskId) {
      this.send(socket, { type: 'voice.error', code: 'stale', message: 'The other participant is no longer in this room.' });
      return;
    }
    this.send(target.socket, { type: 'voice.signal', fromId: current.participant.id, toId: target.participant.id, signal: command.signal });
  }

  disconnect(socket: WebSocket): void {
    const current = this.bySocket.get(socket);
    if (current) this.remove(current, 'disconnected');
  }

  deleteTask(taskId: string): void {
    for (const current of [...this.byUser.values()]) if (current.taskId === taskId) this.remove(current, 'task_deleted');
  }

  private remove(current: Participation, reason: Extract<VoiceServerMessage, { type: 'voice.left' }>['reason']): void {
    this.byUser.delete(current.participant.user.id);
    this.bySocket.delete(current.socket);
    const room = this.rooms.get(current.taskId)!;
    this.rooms.set(current.taskId, { ...room, participants: room.participants.filter((p) => p.id !== current.participant.id) });
    this.send(current.socket, { type: 'voice.left', participantId: current.participant.id, reason });
    this.broadcast(current.taskId);
    if (this.rooms.get(current.taskId)!.participants.length === 0) this.rooms.delete(current.taskId);
  }

  private broadcast(taskId: string): void {
    const room = this.rooms.get(taskId)!;
    const message = { type: 'voice.room' as const, room };
    for (const current of this.byUser.values()) if (current.taskId === taskId) this.send(current.socket, message);
    this.publish(taskTopic(taskId), message);
  }

  private send(socket: WebSocket, message: VoiceServerMessage): void {
    if (socket.readyState === socket.OPEN && socket.bufferedAmount < 1024 * 1024) socket.send(JSON.stringify(message));
    else if (socket.bufferedAmount >= 1024 * 1024) socket.terminate();
  }
}
