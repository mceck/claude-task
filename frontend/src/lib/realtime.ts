// The single WebSocket to the backend. Components subscribe to topics while mounted;
// events update the query caches. After a reconnect we refetch instead of replaying.
import { API_PREFIX } from '@claude-task/shared';
import type { ClientMessage, ServerMessage, Topic } from '@claude-task/shared';
import type { QueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { keys } from '../api/queries';
import { applyEvent, refreshTopic } from './cache';
import { applyLiveEvent, clearLiveTurns } from './live';
import { applyRunEvent, clearRuns } from './runs';

const LOGIN_ENDED = 4001;

class Realtime {
  private socket: WebSocket | null = null;
  private readonly counts = new Map<Topic, number>();
  private qc: QueryClient | null = null;
  private attempts = 0;
  private connectedOnce = false;
  private readonly messageListeners = new Set<(message: ServerMessage) => void>();
  private readonly disconnectListeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  start(qc: QueryClient): void {
    if (this.qc) return;
    this.qc = qc;
    this.connect();
  }

  stop(): void {
    for (const listener of this.disconnectListeners) listener();
    clearLiveTurns();
    clearRuns();
    this.qc = null;
    clearTimeout(this.timer);
    this.socket?.close();
    this.socket = null;
    this.connectedOnce = false;
  }

  subscribe(topic: Topic): () => void {
    const n = this.counts.get(topic) ?? 0;
    this.counts.set(topic, n + 1);
    if (n === 0) this.send({ type: 'subscribe', topics: [topic] });
    return () => {
      const left = (this.counts.get(topic) ?? 1) - 1;
      if (left > 0) return void this.counts.set(topic, left);
      this.counts.delete(topic);
      this.send({ type: 'unsubscribe', topics: [topic] });
    };
  }

  onMessage(listener: (message: ServerMessage) => void): () => void {
    this.messageListeners.add(listener);
    return () => { this.messageListeners.delete(listener); };
  }

  onDisconnect(listener: () => void): () => void {
    this.disconnectListeners.add(listener);
    return () => { this.disconnectListeners.delete(listener); };
  }

  send(msg: ClientMessage): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(msg));
    return true;
  }

  private connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${proto}//${location.host}${API_PREFIX}/ws`);
    this.socket = socket;

    socket.onopen = () => {
      this.attempts = 0;
      if (this.counts.size > 0) this.send({ type: 'subscribe', topics: [...this.counts.keys()] });
      // Anything could have changed while we were away.
      if (this.connectedOnce) void this.qc?.invalidateQueries();
      this.connectedOnce = true;
    };
    socket.onmessage = (e) => {
      const msg = JSON.parse(e.data as string) as ServerMessage;
      if (!this.qc) return;
      for (const listener of this.messageListeners) listener(msg);
      if (msg.type === 'event') {
        applyEvent(this.qc, msg.event);
        applyLiveEvent(msg.event);
        applyRunEvent(msg.event);
      }
      // Events start flowing only now: refetch what may have changed between the query and the subscription.
      else if (msg.type === 'subscribed') for (const topic of msg.topics) refreshTopic(this.qc, topic);
    };
    socket.onclose = (e) => {
      if (this.socket !== socket || !this.qc) return;
      this.socket = null;
      for (const listener of this.disconnectListeners) listener();
      clearLiveTurns();
      clearRuns();
      // Logged out elsewhere, deactivated, or (when the handshake itself is refused) expired:
      // re-check the Login, so the app goes to /login instead of reconnecting forever.
      void this.qc.invalidateQueries({ queryKey: keys.me });
      if (e.code === LOGIN_ENDED) return;
      const delay = Math.min(30_000, 500 * 2 ** this.attempts++);
      this.timer = setTimeout(() => this.qc && this.connect(), delay);
    };
  }
}

export const realtime = new Realtime();

export function useTopic(topic: Topic | null): void {
  useEffect(() => (topic ? realtime.subscribe(topic) : undefined), [topic]);
}
