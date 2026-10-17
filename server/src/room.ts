import { randomBytes } from 'node:crypto';
import {
  LIMITS,
  expectedPosition,
  type ChatMessage,
  type ClientMsg,
  type HeatBucket,
  type MediaItem,
  type Marker,
  type Member,
  type PlaybackState,
  type Poll,
  type QueueItem,
  type ReelState,
  type RoomSettings,
  type RoomSnapshot,
  type ServerMsg,
} from '@couchbeam/shared';

/** Transport-agnostic connection handle: lets the room logic be unit-tested without sockets. */
export interface Conn {
  send(msg: ServerMsg): void;
  close(code?: number, reason?: string): void;
}

export interface RoomDeps {
  now: () => number;
  getMedia: (id: string) => MediaItem | undefined;
  sign: (memberId: string, code: string) => string;
  verify: (token: string, code: string) => string | null;
  maxMembers: number;
  graceMs: number;
  playLeadMs: number;
  emptyTtlMs: number;
}

interface MemberRec {
  id: string;
  name: string;
  color: string;
  joinedAt: number;
  conn: Conn | null;
  disconnectedAt: number | null;
  buffering: boolean;
  bufferingSince: number;
  driftMs: number | null;
  rttMs: number | null;
  windows: Map<string, { start: number; n: number }>;
}

type ReelInternal = ReelState & { clips: number[]; nextAt: number };

const PALETTE = ['#f2b441', '#5ec2b7', '#e86f68', '#8f9cf2', '#b6d86a', '#e58bd0', '#6fb7ee', '#f08a4b', '#a58be8', '#7bd6a0', '#e8c96a', '#d0827a'];

/** Two commands whose targets differ by less than this are treated as the same intent (simultaneous clicks). */
const DEDUPE_SEC = 0.4;
/** A buffering member can hold the room for at most this long, then the room moves on without them. */
const MAX_HOLD_MS = 8000;
const REEL_CLIP_SEC = 8;
const REEL_PREROLL_SEC = 2;
const REEL_MAX_CLIPS = 8;

export const newId = (bytes = 6): string => randomBytes(bytes).toString('base64url');

const clean = (s: string, max: number): string =>
  // eslint-disable-next-line no-control-regex
  s.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);

export class Room {
  readonly createdAt: number;
  lastActive: number;
  state: PlaybackState;
  settings: RoomSettings = { controls: 'everyone' };
  hostId: string | null = null;

  private members = new Map<string, MemberRec>();
  private chat: ChatMessage[] = [];
  private queue: QueueItem[] = [];
  private polls: Poll[] = [];
  private markers: Marker[] = [];
  private heat = new Map<string, Map<number, number>>();
  private heatDirty = false;
  private reel: ReelInternal = { active: false, idx: 0, total: 0, clips: [], nextAt: 0 };
  private lastHealthAt = 0;
  private lastHeatAt = 0;
  private mediaSeq = 0;
  private endedKey = '';
  private colorIdx = 0;
  private emptySince: number | null = null;

  constructor(
    readonly code: string,
    private readonly deps: RoomDeps,
  ) {
    this.createdAt = deps.now();
    this.lastActive = this.createdAt;
    this.state = { seq: 0, mediaId: null, status: 'paused', pos: 0, anchor: this.createdAt, hold: false, by: null };
  }

  // ───────────────────────── introspection ─────────────────────────

  get memberCount(): number {
    return this.members.size;
  }

  get connectedCount(): number {
    let n = 0;
    for (const m of this.members.values()) if (m.conn) n++;
    return n;
  }

  expectedPos(now = this.deps.now()): number {
    return expectedPosition(this.state, now);
  }

  publicMembers(): Member[] {
    return [...this.members.values()]
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map((m) => ({
        id: m.id,
        name: m.name,
        color: m.color,
        joinedAt: m.joinedAt,
        connected: m.conn !== null,
        buffering: m.buffering,
        isHost: m.id === this.hostId,
      }));
  }

  snapshot(): RoomSnapshot {
    return {
      code: this.code,
      hostId: this.hostId,
      settings: this.settings,
      state: this.state,
      members: this.publicMembers(),
      chat: this.chat,
      queue: this.queue,
      polls: this.polls,
      markers: this.markersForCurrent(),
      heat: this.heatBuckets(this.state.mediaId),
      reel: this.publicReel(),
      serverNow: this.deps.now(),
    };
  }

  // ───────────────────────── membership ─────────────────────────

  join(conn: Conn, rawName: string, resume?: string): { memberId: string } | { error: string; message: string } {
    const now = this.deps.now();
    this.lastActive = now;
    this.emptySince = null;

    const resumedId = resume ? this.deps.verify(resume, this.code) : null;
    const existing = resumedId ? this.members.get(resumedId) : undefined;

    if (existing) {
      // Reattach to the same seat: identity, host role and votes survive a reconnect.
      const old = existing.conn;
      existing.conn = conn;
      existing.disconnectedAt = null;
      if (old && old !== conn) old.close(4000, 'replaced by newer connection');
      this.sendJoined(existing);
      this.broadcastMembers();
      return { memberId: existing.id };
    }

    if (this.members.size >= this.deps.maxMembers) {
      return { error: 'room_full', message: `This room is full (${this.deps.maxMembers} people).` };
    }

    const m: MemberRec = {
      id: newId(),
      name: clean(rawName, LIMITS.name) || 'Guest',
      color: PALETTE[this.colorIdx++ % PALETTE.length]!,
      joinedAt: now,
      conn,
      disconnectedAt: null,
      buffering: false,
      bufferingSince: 0,
      driftMs: null,
      rttMs: null,
      windows: new Map(),
    };
    this.members.set(m.id, m);
    if (!this.hostId) this.hostId = m.id;

    this.sendJoined(m);
    this.broadcastMembers();
    this.system(`${m.name} joined`);
    return { memberId: m.id };
  }

  private sendJoined(m: MemberRec): void {
    m.conn?.send({ t: 'joined', you: m.id, resume: this.deps.sign(m.id, this.code), snapshot: this.snapshot() });
  }

  /** Socket closed. Seat is kept for the grace period so refreshes and Wi-Fi blips are invisible. */
  detach(memberId: string, conn: Conn): void {
    const m = this.members.get(memberId);
    if (!m || m.conn !== conn) return; // a newer connection already took over
    m.conn = null;
    m.disconnectedAt = this.deps.now();
    m.buffering = false;
    this.broadcastMembers();
    if (this.connectedCount === 0) this.freeze();
    else this.evalHold();
  }

  leave(memberId: string): void {
    this.removeMember(memberId, true);
  }

  private removeMember(id: string, announce: boolean): void {
    const m = this.members.get(id);
    if (!m) return;
    this.members.delete(id);
    m.conn = null;
    if (announce) this.system(`${m.name} left`);
    if (this.hostId === id) this.electHost();
    if (this.members.size === 0) this.emptySince = this.deps.now();
    this.broadcastMembers();
    this.evalHold();
  }

  /** Oldest connected member inherits the room. */
  private electHost(): void {
    const all = [...this.members.values()].sort((a, b) => a.joinedAt - b.joinedAt);
    const next = all.find((x) => x.conn) ?? all[0] ?? null;
    this.hostId = next?.id ?? null;
    if (next) this.system(`${next.name} is now the host`);
  }

  /** Nobody is connected: stop the clock so the room resumes where it was left. */
  private freeze(): void {
    if (this.state.status === 'playing') {
      this.state = { ...this.state, seq: this.state.seq + 1, status: 'paused', pos: this.expectedPos(), anchor: this.deps.now(), hold: false, by: null };
    }
    this.stopReel(false);
  }

  // ───────────────────────── message dispatch ─────────────────────────

  handle(memberId: string, msg: ClientMsg): void {
    const m = this.members.get(memberId);
    if (!m) return;
    this.lastActive = this.deps.now();

    switch (msg.t) {
      case 'play':
        return this.doPlay(m, msg.pos, msg.base, msg.cid);
      case 'pause':
        return this.doPause(m, msg.base, msg.cid);
      case 'seek':
        return this.doSeek(m, msg.pos, msg.base, msg.cid);
      case 'setMedia':
        return this.doSetMedia(m, msg.mediaId);
      case 'buffering':
        return this.doBuffering(m, msg.on);
      case 'ended':
        return this.doEnded(m, msg.mediaId);
      case 'drift':
        m.driftMs = msg.driftMs;
        m.rttMs = msg.rttMs;
        return;
      case 'chat':
        return this.doChat(m, msg.text, msg.at);
      case 'react':
        return this.doReact(m, msg.emoji);
      case 'queueAdd':
        return this.doQueueAdd(m, msg.mediaId);
      case 'queueRemove':
        return this.doQueueRemove(m, msg.itemId);
      case 'queueMove':
        return this.doQueueMove(m, msg.itemId, msg.dir);
      case 'playNext':
        if (!this.need(m)) return;
        if (!this.advance(m.id)) this.error(m, 'queue_empty', 'The queue is empty.');
        return;
      case 'pollCreate':
        return this.doPollCreate(m, msg.question, msg.options);
      case 'pollVote':
        return this.doPollVote(m, msg.pollId, msg.optionId);
      case 'pollClose':
        return this.doPollClose(m, msg.pollId);
      case 'transferHost':
        return this.doTransfer(m, msg.to);
      case 'settings':
        if (m.id !== this.hostId) return this.error(m, 'forbidden', 'Only the host can change room settings.');
        this.settings = { controls: msg.controls };
        this.broadcast({ t: 'settings', settings: this.settings });
        return;
      case 'markerAdd':
        return this.doMarkerAdd(m, msg.label);
      case 'markerVote':
        return this.doMarkerVote(m, msg.markerId);
      case 'markerRemove':
        return this.doMarkerRemove(m, msg.markerId);
      case 'reel':
        if (msg.on) return this.startReel(m);
        if (this.need(m)) this.stopReel(true);
        return;
      default:
        return;
    }
  }

  // ───────────────────────── playback ─────────────────────────

  private canControl(m: MemberRec): boolean {
    return this.settings.controls === 'everyone' || m.id === this.hostId;
  }

  private need(m: MemberRec): boolean {
    if (this.canControl(m)) return true;
    this.error(m, 'forbidden', 'Only the host can control playback in this room.');
    return false;
  }

  /** Apply a state transition. Every transition bumps `seq`; clients drop anything older than what they hold. */
  private commit(patch: Partial<PlaybackState>, by: string | null, cid?: string): void {
    this.state = { ...this.state, ...patch, seq: this.state.seq + 1, by };
    this.broadcast({ t: 'state', state: this.state, cid, s: this.deps.now() });
  }

  /**
   * Race guard #1: a command stamped with a `base` older than the last media change was issued against
   * a different video (somebody swapped movies while the click was in flight). Reject and resync the sender.
   */
  private stale(m: MemberRec, base: number | undefined, cid?: string): boolean {
    if (base === undefined || base >= this.mediaSeq) return false;
    m.conn?.send({ t: 'state', state: this.state, cid, s: this.deps.now() });
    return true;
  }

  private doPlay(m: MemberRec, pos: number, base?: number, cid?: string): void {
    if (!this.need(m) || this.stale(m, base, cid)) return;
    if (!this.state.mediaId) return this.error(m, 'no_media', 'Pick something to watch first.');
    this.stopReel(true);
    const now = this.deps.now();

    // Race guard #2: two people press Play together -> second one is a no-op, not a position jump.
    if (this.state.status === 'playing' && !this.state.hold && Math.abs(pos - this.expectedPos(now)) < DEDUPE_SEC) {
      m.conn?.send({ t: 'state', state: this.state, cid, s: now });
      return;
    }
    const target = this.state.status === 'paused' && Math.abs(pos - this.state.pos) < DEDUPE_SEC ? this.state.pos : pos;
    this.commit({ status: 'playing', hold: false, pos: target, anchor: now + this.deps.playLeadMs }, m.id, cid);
  }

  private doPause(m: MemberRec, base?: number, cid?: string): void {
    if (!this.need(m) || this.stale(m, base, cid)) return;
    this.stopReel(true);
    const now = this.deps.now();

    if (this.state.status === 'paused' && !this.state.hold) {
      m.conn?.send({ t: 'state', state: this.state, cid, s: now }); // already paused
      return;
    }
    // Use the server's own idea of "now" as the pause point, not the (possibly drifting) client's.
    this.commit({ status: 'paused', hold: false, pos: this.expectedPos(now), anchor: now }, m.id, cid);
  }

  private doSeek(m: MemberRec, pos: number, base?: number, cid?: string): void {
    if (!this.need(m) || this.stale(m, base, cid)) return;
    if (!this.state.mediaId) return;
    this.stopReel(true);
    const now = this.deps.now();
    const running = this.state.status === 'playing' && !this.state.hold;
    this.commit({ pos, anchor: running ? now + this.deps.playLeadMs : now }, m.id, cid);
  }

  private doSetMedia(m: MemberRec, mediaId: string, autoplay = false): void {
    if (!this.need(m)) return;
    this.applyMedia(mediaId, m.id, autoplay);
  }

  private applyMedia(mediaId: string, by: string | null, autoplay: boolean): boolean {
    const media = this.deps.getMedia(mediaId);
    if (!media) {
      if (by) this.members.get(by)?.conn?.send({ t: 'error', code: 'unknown_media', message: 'That title is not in the catalog.' });
      return false;
    }
    this.stopReel(false);
    const now = this.deps.now();
    this.commit(
      { mediaId, status: autoplay ? 'playing' : 'paused', pos: 0, anchor: autoplay ? now + this.deps.playLeadMs : now, hold: false },
      by,
    );
    this.mediaSeq = this.state.seq;
    this.endedKey = '';
    this.system(`Now showing: ${media.title}`);
    this.broadcast({ t: 'markers', markers: this.markersForCurrent() });
    this.broadcast({ t: 'heat', mediaId, buckets: this.heatBuckets(mediaId) });
    return true;
  }

  /** Move to the next queue item (autoplay). Returns false when the queue is empty. */
  private advance(by: string | null): boolean {
    const next = this.queue.shift();
    if (!next) return false;
    this.broadcast({ t: 'queue', queue: this.queue });
    return this.applyMedia(next.mediaId, by, true);
  }

  private doEnded(m: MemberRec, mediaId: string): void {
    if (this.state.mediaId !== mediaId || !this.canControl(m)) return;
    const key = `${mediaId}#${this.mediaSeq}`;
    if (this.endedKey === key) return; // several clients report the end at once; act once
    this.endedKey = key;
    if (!this.advance(null)) {
      this.commit({ status: 'paused', hold: false, pos: this.state.pos, anchor: this.deps.now() }, null);
    }
  }

  // ───────────────────────── buffering hold ─────────────────────────

  private doBuffering(m: MemberRec, on: boolean): void {
    if (m.buffering === on) return;
    m.buffering = on;
    m.bufferingSince = on ? this.deps.now() : 0;
    this.broadcastMembers();
    this.evalHold();
  }

  /**
   * If anybody is stalled, pause everyone at the same spot (hold) and resume together, with a scheduled
   * start, once the last stalled member recovers. A stalled member can block for at most MAX_HOLD_MS.
   */
  private evalHold(): void {
    const now = this.deps.now();
    let blocking = 0;
    for (const m of this.members.values()) {
      if (m.conn && m.buffering && now - m.bufferingSince < MAX_HOLD_MS) blocking++;
    }
    if (blocking > 0 && this.state.status === 'playing' && !this.state.hold) {
      this.commit({ status: 'paused', hold: true, pos: this.expectedPos(now), anchor: now }, null);
    } else if (blocking === 0 && this.state.hold) {
      this.commit({ status: 'playing', hold: false, anchor: now + this.deps.playLeadMs }, null);
    }
  }

  // ───────────────────────── chat & reactions ─────────────────────────

  private allow(m: MemberRec, kind: string, max: number, perMs: number): boolean {
    const now = this.deps.now();
    const w = m.windows.get(kind);
    if (!w || now - w.start >= perMs) {
      m.windows.set(kind, { start: now, n: 1 });
      return true;
    }
    if (w.n >= max) return false;
    w.n++;
    return true;
  }

  private doChat(m: MemberRec, text: string, at?: number): void {
    if (!this.allow(m, 'chat', 6, 5000)) return this.error(m, 'rate_limited', 'Slow down a little.');
    const msg: ChatMessage = {
      id: newId(),
      from: m.id,
      name: m.name,
      text: clean(text, LIMITS.chat),
      ts: this.deps.now(),
      at: at ?? this.expectedPos(),
      mediaId: this.state.mediaId,
    };
    if (!msg.text) return;
    this.pushChat(msg);
  }

  private system(text: string): void {
    this.pushChat({ id: newId(), from: null, name: 'Couchbeam', text, ts: this.deps.now(), at: this.expectedPos(), mediaId: this.state.mediaId, system: true });
  }

  private pushChat(msg: ChatMessage): void {
    this.chat.push(msg);
    if (this.chat.length > LIMITS.chatHistory) this.chat.shift();
    this.broadcast({ t: 'chat', msg });
  }

  private doReact(m: MemberRec, emoji: string): void {
    if (!this.allow(m, 'react', 12, 2000)) return;
    const at = this.expectedPos();
    this.broadcast({ t: 'react', emoji, from: m.id, name: m.name, at });
    if (this.state.mediaId) {
      const bucket = Math.floor(at / LIMITS.heatBucketSec) * LIMITS.heatBucketSec;
      let map = this.heat.get(this.state.mediaId);
      if (!map) this.heat.set(this.state.mediaId, (map = new Map()));
      map.set(bucket, (map.get(bucket) ?? 0) + 1);
      this.heatDirty = true;
    }
  }

  private heatBuckets(mediaId: string | null): HeatBucket[] {
    const map = mediaId ? this.heat.get(mediaId) : undefined;
    if (!map) return [];
    return [...map.entries()].map(([t, n]) => ({ t, n })).sort((a, b) => a.t - b.t);
  }

  // ───────────────────────── queue ─────────────────────────

  private doQueueAdd(m: MemberRec, mediaId: string): void {
    if (!this.deps.getMedia(mediaId)) return this.error(m, 'unknown_media', 'That title is not in the catalog.');
    if (this.queue.length >= LIMITS.queue) return this.error(m, 'queue_full', 'The queue is full.');
    this.queue.push({ id: newId(), mediaId, addedBy: m.id });
    this.broadcast({ t: 'queue', queue: this.queue });
  }

  private doQueueRemove(m: MemberRec, itemId: string): void {
    const i = this.queue.findIndex((q) => q.id === itemId);
    if (i < 0) return;
    if (this.queue[i]!.addedBy !== m.id && !this.canControl(m)) return this.error(m, 'forbidden', 'You can only remove your own picks.');
    this.queue.splice(i, 1);
    this.broadcast({ t: 'queue', queue: this.queue });
  }

  private doQueueMove(m: MemberRec, itemId: string, dir: 'up' | 'down'): void {
    if (!this.need(m)) return;
    const i = this.queue.findIndex((q) => q.id === itemId);
    const j = dir === 'up' ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= this.queue.length) return;
    [this.queue[i], this.queue[j]] = [this.queue[j]!, this.queue[i]!];
    this.broadcast({ t: 'queue', queue: this.queue });
  }

  // ───────────────────────── polls ─────────────────────────

  private doPollCreate(m: MemberRec, question: string, options: string[]): void {
    if (!this.need(m)) return;
    const labels = [...new Set(options.map((o) => clean(o, LIMITS.label)).filter(Boolean))];
    const q = clean(question, 120);
    if (!q || labels.length < LIMITS.pollOptionsMin) return this.error(m, 'invalid', 'A poll needs a question and at least two different options.');
    if (this.polls.length >= LIMITS.polls) {
      const closed = this.polls.findIndex((p) => !p.open);
      if (closed < 0) return this.error(m, 'too_many_polls', 'Close a poll before starting another.');
      this.polls.splice(closed, 1);
    }
    this.polls.push({
      id: newId(),
      question: q,
      options: labels.map((label, i) => ({ id: `o${i + 1}`, label, votes: [] })),
      createdBy: m.id,
      open: true,
      createdAt: this.deps.now(),
    });
    this.broadcast({ t: 'polls', polls: this.polls });
  }

  private doPollVote(m: MemberRec, pollId: string, optionId: string): void {
    const poll = this.polls.find((p) => p.id === pollId);
    if (!poll || !poll.open) return;
    const opt = poll.options.find((o) => o.id === optionId);
    if (!opt) return;
    for (const o of poll.options) o.votes = o.votes.filter((v) => v !== m.id); // one vote, changeable
    opt.votes.push(m.id);
    this.broadcast({ t: 'polls', polls: this.polls });
  }

  private doPollClose(m: MemberRec, pollId: string): void {
    const poll = this.polls.find((p) => p.id === pollId);
    if (!poll || !poll.open) return;
    if (poll.createdBy !== m.id && m.id !== this.hostId) return this.error(m, 'forbidden', 'Only the poll creator or the host can close it.');
    poll.open = false;
    this.broadcast({ t: 'polls', polls: this.polls });
    const top = [...poll.options].sort((a, b) => b.votes.length - a.votes.length)[0];
    if (top && top.votes.length > 0) this.system(`Poll closed: "${poll.question}" → ${top.label} (${top.votes.length})`);
  }

  // ───────────────────────── host ─────────────────────────

  private doTransfer(m: MemberRec, to: string): void {
    if (m.id !== this.hostId) return this.error(m, 'forbidden', 'Only the host can hand over the room.');
    const target = this.members.get(to);
    if (!target || !target.conn) return this.error(m, 'not_found', 'That person is not connected.');
    this.hostId = target.id;
    this.system(`${m.name} handed the room to ${target.name}`);
    this.broadcastMembers();
  }

  // ───────────────────────── Moments (bonus) ─────────────────────────

  private markersForCurrent(): Marker[] {
    const id = this.state.mediaId;
    return this.markers.filter((k) => k.mediaId === id).sort((a, b) => a.at - b.at);
  }

  private doMarkerAdd(m: MemberRec, rawLabel: string): void {
    const mediaId = this.state.mediaId;
    if (!mediaId) return this.error(m, 'no_media', 'Nothing is playing.');
    if (!this.allow(m, 'marker', 6, 10_000)) return this.error(m, 'rate_limited', 'Slow down a little.');
    const label = clean(rawLabel, LIMITS.label);
    if (!label) return;
    const at = Math.round(this.expectedPos() * 10) / 10;

    // Pile-on: a Moment within 3 s of an existing one is a vote for it, not a duplicate.
    const near = this.markers.find((k) => k.mediaId === mediaId && Math.abs(k.at - at) <= 3);
    if (near) {
      if (!near.votes.includes(m.id)) near.votes.push(m.id);
    } else {
      if (this.markers.filter((k) => k.mediaId === mediaId).length >= LIMITS.markersPerMedia) {
        return this.error(m, 'too_many_markers', 'This title has the maximum number of Moments.');
      }
      this.markers.push({ id: newId(), mediaId, at, label, by: m.id, votes: [m.id] });
    }
    this.broadcast({ t: 'markers', markers: this.markersForCurrent() });
  }

  private doMarkerVote(m: MemberRec, markerId: string): void {
    const k = this.markers.find((x) => x.id === markerId);
    if (!k) return;
    k.votes = k.votes.includes(m.id) ? k.votes.filter((v) => v !== m.id) : [...k.votes, m.id];
    this.broadcast({ t: 'markers', markers: this.markersForCurrent() });
  }

  private doMarkerRemove(m: MemberRec, markerId: string): void {
    const i = this.markers.findIndex((x) => x.id === markerId);
    if (i < 0) return;
    if (this.markers[i]!.by !== m.id && m.id !== this.hostId) return this.error(m, 'forbidden', 'Only the author or the host can remove a Moment.');
    this.markers.splice(i, 1);
    this.broadcast({ t: 'markers', markers: this.markersForCurrent() });
  }

  /** Highlight reel: the room's top-voted Moments, replayed in story order as short synchronized clips. */
  private startReel(m: MemberRec): void {
    if (!this.need(m)) return;
    const top = this.markersForCurrent()
      .sort((a, b) => b.votes.length - a.votes.length || a.at - b.at)
      .slice(0, REEL_MAX_CLIPS)
      .sort((a, b) => a.at - b.at);
    if (top.length === 0) return this.error(m, 'no_moments', 'Add a few Moments first.');
    this.reel = { active: true, idx: -1, total: top.length, clips: top.map((k) => Math.max(0, k.at - REEL_PREROLL_SEC)), nextAt: 0 };
    this.stepReel(m.id);
  }

  private stepReel(by: string | null): void {
    const now = this.deps.now();
    this.reel.idx++;
    if (this.reel.idx >= this.reel.total) {
      this.reel.active = false;
      this.broadcast({ t: 'reel', reel: this.publicReel() });
      this.commit({ status: 'paused', hold: false, pos: this.expectedPos(now), anchor: now }, by);
      this.system('Highlight reel finished');
      return;
    }
    const start = this.reel.clips[this.reel.idx]!;
    this.reel.nextAt = now + this.deps.playLeadMs + (REEL_CLIP_SEC + REEL_PREROLL_SEC) * 1000;
    this.commit({ status: 'playing', hold: false, pos: start, anchor: now + this.deps.playLeadMs }, by);
    this.broadcast({ t: 'reel', reel: this.publicReel() });
  }

  private stopReel(announce: boolean): void {
    if (!this.reel.active) return;
    this.reel = { active: false, idx: 0, total: 0, clips: [], nextAt: 0 };
    if (announce) this.broadcast({ t: 'reel', reel: this.publicReel() });
  }

  private publicReel(): ReelState {
    return { active: this.reel.active, idx: this.reel.idx, total: this.reel.total };
  }

  // ───────────────────────── timers ─────────────────────────

  /** ~4 Hz: reel stepping, hold expiry, throttled heat + sync-health broadcasts. */
  tick(now = this.deps.now()): void {
    if (this.reel.active && now >= this.reel.nextAt) this.stepReel(null);
    if (this.state.hold) this.evalHold();

    if (this.heatDirty && now - this.lastHeatAt >= 1000) {
      this.heatDirty = false;
      this.lastHeatAt = now;
      this.broadcast({ t: 'heat', mediaId: this.state.mediaId, buckets: this.heatBuckets(this.state.mediaId) });
    }

    if (now - this.lastHealthAt >= 2000) {
      this.lastHealthAt = now;
      const entries = [...this.members.values()]
        .filter((m) => m.conn && m.driftMs !== null)
        .map((m) => ({ id: m.id, driftMs: Math.round(m.driftMs!), rttMs: Math.round(m.rttMs ?? 0) }));
      if (entries.length > 0) {
        this.broadcast({ t: 'health', maxAbsDriftMs: Math.max(...entries.map((e) => Math.abs(e.driftMs))), members: entries });
      }
    }
  }

  /** ~1 Hz: expire members whose grace period ran out. Returns true when the whole room can be deleted. */
  sweep(now = this.deps.now()): boolean {
    for (const m of [...this.members.values()]) {
      if (m.disconnectedAt !== null && now - m.disconnectedAt >= this.deps.graceMs) this.removeMember(m.id, true);
    }
    if (this.members.size === 0) {
      this.emptySince ??= now;
      return now - this.emptySince >= this.deps.emptyTtlMs;
    }
    return false;
  }

  // ───────────────────────── plumbing ─────────────────────────

  private broadcast(msg: ServerMsg): void {
    for (const m of this.members.values()) m.conn?.send(msg);
  }

  private broadcastMembers(): void {
    this.broadcast({ t: 'members', members: this.publicMembers(), hostId: this.hostId });
  }

  private error(m: MemberRec, code: string, message: string): void {
    m.conn?.send({ t: 'error', code, message });
  }
}
