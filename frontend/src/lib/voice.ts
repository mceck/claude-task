import { VOICE_CONNECT_TIMEOUT_MS } from '@claude-task/shared';
import type { VoiceRoom, VoiceServerMessage, VoiceSignal, VoiceIceConfiguration } from '@claude-task/shared';
import { useSyncExternalStore } from 'react';
import { realtime } from './realtime';

type LinkState = 'connecting' | 'connected' | 'unavailable';
interface VoiceState {
  room: VoiceRoom | null;
  participantId: string | null;
  joining: boolean;
  muted: boolean;
  deafened: boolean;
  links: Record<string, LinkState>;
  playbackBlocked: boolean;
  error: string | null;
}
interface Peer {
  id: string;
  pc?: RTCPeerConnection;
  exchangeId?: string;
  audio?: HTMLAudioElement;
  timer?: ReturnType<typeof setTimeout>;
  queue: Promise<void>;
  candidates: Extract<VoiceSignal, { type: 'candidate' }>[];
}
export class VoiceJoinError extends Error {
  constructor(message: string, readonly current?: { participantId: string; taskKey: string }) { super(message); }
}

/** Lives above routing: navigating between Tasks never owns microphone lifetime. */
class VoiceController {
  private state: VoiceState = { room: null, participantId: null, joining: false, muted: false, deafened: false, links: {}, playbackBlocked: false, error: null };
  private readonly listeners = new Set<() => void>();
  private readonly peers = new Map<string, Peer>();
  private stream?: MediaStream;
  private pendingStream?: MediaStream;
  private iceServers: RTCIceServer[] = [];
  private iceTimer?: ReturnType<typeof setTimeout>;
  private pending?: { requestId: string; resolve: (message: Extract<VoiceServerMessage, { type: 'voice.joined' }>) => void; reject: (error: Error) => void };
  private epoch = 0;

  constructor() {
    realtime.onMessage((message) => {
      if (message.type.startsWith('voice.')) this.message(message as VoiceServerMessage);
      if (message.type === 'event' && message.event.type === 'voice.room') this.room(message.event.room);
    });
    realtime.onDisconnect(() => {
      const active = !!this.state.participantId || this.state.joining;
      this.pending?.reject(new Error('Voice connection lost. Join the room again when connected.'));
      this.pending = undefined;
      this.epoch++;
      this.clear();
      if (active) this.update({ error: 'Voice connection lost. Join the room again when connected.' });
    });
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.state;
  private update(patch: Partial<VoiceState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  async join(taskId: string, replace?: string): Promise<void> {
    if (this.state.joining || this.state.room?.taskId === taskId) return;
    const epoch = ++this.epoch;
    this.update({ joining: true, error: null });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Voice needs HTTPS or localhost and a browser with microphone support.');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      if (epoch !== this.epoch) { stream.getTracks().forEach((track) => track.stop()); return; }
      this.pendingStream = stream;
      const requestId = crypto.randomUUID();
      const response = await new Promise<Extract<VoiceServerMessage, { type: 'voice.joined' }>>((resolve, reject) => {
        this.pending = { requestId, resolve, reject };
        timer = setTimeout(() => reject(new Error('Joining timed out. Check your connection and try again.')), 15_000);
        if (!realtime.send({ type: 'voice.join', requestId, taskId, ...(replace ? { replace } : {}) })) reject(new Error('Connect to the server before joining voice.'));
      });
      if (epoch !== this.epoch) { realtime.send({ type: 'voice.leave', participantId: response.participantId }); return; }
      this.clear(false);
      this.stream = stream;
      this.pendingStream = undefined;
      this.update({ participantId: response.participantId, room: response.room, error: null });
      this.configureIce(response);
      this.room(response.room);
      for (const track of stream.getAudioTracks()) track.onended = () => this.leave('Microphone disconnected. Join again to choose an available microphone.');
    } catch (error) {
      this.pendingStream?.getTracks().forEach((track) => track.stop());
      this.pendingStream = undefined;
      const message = error instanceof DOMException && error.name === 'NotAllowedError' ? 'Microphone access was denied. Allow it in your browser settings and try again.' : error instanceof Error ? error.message : 'Could not start the microphone.';
      this.update({ error: message });
      throw error instanceof VoiceJoinError ? error : new Error(message);
    } finally {
      clearTimeout(timer);
      if (epoch === this.epoch) { this.pending = undefined; this.update({ joining: false }); }
    }
  }

  leave(error: string | null = null) {
    if (this.state.participantId) realtime.send({ type: 'voice.leave', participantId: this.state.participantId });
    this.pending?.reject(new Error('Voice join cancelled.'));
    this.pending = undefined;
    this.epoch++;
    this.clear();
    this.update({ error });
  }
  mute() {
    if (!this.state.participantId) return;
    const muted = !this.state.muted;
    this.stream?.getAudioTracks().forEach((track) => { track.enabled = !muted; });
    this.update({ muted });
    realtime.send({ type: 'voice.mute', participantId: this.state.participantId, muted });
  }
  deafen() {
    const deafened = !this.state.deafened;
    for (const peer of this.peers.values()) if (peer.audio) peer.audio.muted = deafened;
    this.update({ deafened });
  }
  async resumeAudio() {
    this.update({ playbackBlocked: false });
    for (const peer of this.peers.values()) if (peer.audio) await peer.audio.play().catch(() => this.update({ playbackBlocked: true }));
  }
  dismissError() { this.update({ error: null }); }

  /** A Login ended: no microphone, room or error may carry into the next session. */
  reset() {
    this.pending?.reject(new Error('Voice join cancelled.'));
    this.pending = undefined;
    this.epoch++;
    this.clear();
    this.update({ error: null, joining: false });
  }

  retry(id: string) {
    const peer = this.peers.get(id);
    if (!peer || !this.state.participantId) return;
    this.enqueue(peer, async () => {
      this.resetPeer(peer);
      this.link(id, 'connecting');
      if (this.state.participantId! < id) await this.offer(peer);
      else this.signal(id, { type: 'retry' });
      this.timeout(peer);
    });
  }

  private message(message: VoiceServerMessage) {
    if (message.type === 'voice.joined') {
      if (this.pending?.requestId === message.requestId) this.pending.resolve(message);
      else realtime.send({ type: 'voice.leave', participantId: message.participantId });
    } else if (message.type === 'voice.ice' && message.participantId === this.state.participantId) {
      this.configureIce(message);
      for (const id of this.peers.keys()) this.retry(id);
    } else if (message.type === 'voice.error') {
      if (message.requestId && message.requestId === this.pending?.requestId) this.pending.reject(new VoiceJoinError(message.message, message.current));
    } else if (message.type === 'voice.left' && message.participantId === this.state.participantId) {
      this.clear(false);
      if (message.reason !== 'left') this.update({ error: message.reason === 'transferred' ? 'Voice moved to another Task or device.' : 'This Voice Room has ended.' });
    } else if (message.type === 'voice.room') this.room(message.room);
    else if (message.type === 'voice.signal' && message.toId === this.state.participantId) {
      const peer = this.peers.get(message.fromId);
      if (peer) this.enqueue(peer, () => this.receive(peer, message.signal));
    }
  }

  private configureIce(ice: VoiceIceConfiguration) {
    this.iceServers = ice.iceServers.map((server) => ({ ...server, urls: server.urls.filter((url) => /^(?:stun|turn)s?:/.test(url)) })).filter((server) => server.urls.length > 0);
    clearTimeout(this.iceTimer);
    if (!ice.iceExpiresAt) return;
    const participantId = this.state.participantId;
    const refresh = () => {
      if (!participantId || participantId !== this.state.participantId) return;
      realtime.send({ type: 'voice.ice', participantId });
      this.iceTimer = setTimeout(refresh, 30_000);
    };
    this.iceTimer = setTimeout(refresh, Math.max(1000, (Date.parse(ice.iceExpiresAt) - Date.now()) / 2));
  }

  private room(room: VoiceRoom) {
    if (room.taskId !== this.state.room?.taskId || !this.state.participantId) return;
    this.update({ room });
    const ids = new Set(room.participants.filter((p) => p.id !== this.state.participantId).map((p) => p.id));
    for (const [id, peer] of this.peers) if (!ids.has(id)) { this.resetPeer(peer); this.peers.delete(id); }
    for (const id of ids) if (!this.peers.has(id)) {
      const peer: Peer = { id, queue: Promise.resolve(), candidates: [] };
      this.peers.set(id, peer);
      this.link(id, 'connecting');
      this.timeout(peer);
      if (this.state.participantId < id) this.enqueue(peer, () => this.offer(peer));
    }
    this.update({ links: Object.fromEntries([...ids].map((id) => [id, this.state.links[id] ?? 'connecting'])) });
  }

  private signal(targetId: string, signal: VoiceSignal) {
    if (this.state.participantId) realtime.send({ type: 'voice.signal', participantId: this.state.participantId, targetId, signal });
  }
  private enqueue(peer: Peer, action: () => Promise<void>) {
    peer.queue = peer.queue.then(async () => { if (this.peers.get(peer.id) === peer && this.state.participantId) await action(); }).catch(() => this.link(peer.id, 'unavailable'));
  }
  private createConnection(peer: Peer, exchangeId: string): RTCPeerConnection {
    peer.exchangeId = exchangeId;
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    peer.pc = pc;
    for (const track of this.stream!.getAudioTracks()) pc.addTrack(track, this.stream!);
    pc.onicecandidate = ({ candidate }) => {
      if (candidate && peer.pc === pc) this.signal(peer.id, { type: 'candidate', exchangeId, candidate: candidate.candidate, sdpMid: candidate.sdpMid, sdpMLineIndex: candidate.sdpMLineIndex });
    };
    pc.ontrack = ({ track, streams }) => {
      if (peer.pc !== pc) return;
      const audio = peer.audio ?? document.createElement('audio');
      audio.dataset.voicePeer = peer.id;
      audio.autoplay = true;
      audio.muted = this.state.deafened;
      audio.srcObject = streams[0] ?? new MediaStream([track]);
      audio.hidden = true;
      if (!peer.audio) document.body.append(audio);
      peer.audio = audio;
      void audio.play().catch(() => this.update({ playbackBlocked: true }));
    };
    pc.onconnectionstatechange = () => {
      if (peer.pc !== pc) return;
      if (pc.connectionState === 'connected') { clearTimeout(peer.timer); this.link(peer.id, 'connected'); }
      else if (pc.connectionState === 'failed') this.link(peer.id, 'unavailable');
      else if (pc.connectionState === 'disconnected') { this.link(peer.id, 'connecting'); this.timeout(peer); }
    };
    return pc;
  }
  private async offer(peer: Peer) {
    this.resetPeer(peer);
    const exchangeId = crypto.randomUUID();
    const pc = this.createConnection(peer, exchangeId);
    await pc.setLocalDescription(await pc.createOffer());
    if (peer.pc === pc) this.signal(peer.id, { type: 'offer', exchangeId, sdp: pc.localDescription!.sdp });
    this.timeout(peer);
  }
  private async receive(peer: Peer, signal: VoiceSignal) {
    if (signal.type === 'retry') {
      if (this.state.participantId! < peer.id) await this.offer(peer);
      return;
    }
    if (signal.type === 'offer') {
      if (this.state.participantId! < peer.id) return;
      const waiting = peer.candidates.filter((c) => c.exchangeId === signal.exchangeId);
      this.resetPeer(peer);
      const pc = this.createConnection(peer, signal.exchangeId);
      await pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
      for (const candidate of waiting) await pc.addIceCandidate(candidate);
      await pc.setLocalDescription(await pc.createAnswer());
      this.signal(peer.id, { type: 'answer', exchangeId: signal.exchangeId, sdp: pc.localDescription!.sdp });
      this.timeout(peer);
    } else if (signal.type === 'answer') {
      if (signal.exchangeId !== peer.exchangeId || !peer.pc || peer.pc.signalingState !== 'have-local-offer') return;
      await peer.pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
      for (const candidate of peer.candidates.splice(0)) if (candidate.exchangeId === signal.exchangeId) await peer.pc.addIceCandidate(candidate);
    } else if (peer.exchangeId === signal.exchangeId && peer.pc?.remoteDescription) await peer.pc.addIceCandidate(signal);
    else if (peer.candidates.length < 64) peer.candidates.push(signal);
  }
  private timeout(peer: Peer) {
    clearTimeout(peer.timer);
    peer.timer = setTimeout(() => { if (this.peers.get(peer.id) === peer && peer.pc?.connectionState !== 'connected') this.link(peer.id, 'unavailable'); }, VOICE_CONNECT_TIMEOUT_MS);
  }
  private link(id: string, status: LinkState) { if (this.peers.has(id)) this.update({ links: { ...this.state.links, [id]: status } }); }
  private resetPeer(peer: Peer) {
    clearTimeout(peer.timer);
    if (peer.pc) { peer.pc.onconnectionstatechange = null; peer.pc.ontrack = null; peer.pc.onicecandidate = null; peer.pc.close(); }
    peer.pc = undefined;
    peer.exchangeId = undefined;
    peer.audio?.pause();
    if (peer.audio) peer.audio.srcObject = null;
    peer.audio?.remove();
    peer.audio = undefined;
    peer.candidates = [];
  }
  private clear(stopPending = true) {
    clearTimeout(this.iceTimer);
    for (const peer of this.peers.values()) this.resetPeer(peer);
    this.peers.clear();
    this.stream?.getTracks().forEach((track) => { track.onended = null; track.stop(); });
    this.stream = undefined;
    if (stopPending) { this.pendingStream?.getTracks().forEach((track) => track.stop()); this.pendingStream = undefined; }
    this.update({ room: null, participantId: null, muted: false, deafened: false, links: {}, playbackBlocked: false, joining: stopPending ? false : this.state.joining });
  }
}
export const voice = new VoiceController();
export const useVoice = () => useSyncExternalStore(voice.subscribe, voice.snapshot);
