import { ClockSync, type ClientMsg, type RoomSnapshot, type ServerMsg } from '@couchbeam/shared';

export type ConnStatus = 'idle' | 'connecting' | 'open' | 'reconnecting';

export interface HealthMap {
  maxAbsDriftMs: number;
  byId: Record<string, { driftMs: number; rttMs: number }>;
}

export interface RoomData extends Omit<RoomSnapshot, 'serverNow'> {
  you: string;
  health: HealthMap;
}

export interface ClientSnapshot {
  status: ConnStatus;
  room: RoomData | null;
  /** Fatal, user-facing error (bad code, full room...). */
  error: string | null;
  /** Transient, non-fatal notice. */
  toast: { id: number; text: string } | null;
}

export interface ReactEvent {
  emoji: string;
  from: string;
  name: string;
}

export type Intent =
  | { kind: 'create'; name: string }
  | { kind: 'join'; code: string; name: string; resume?: string };

const SESSION_KEY = 'couchbeam:session';
const FATAL = new Set(['no_such_room', 'room_full', 'server_full']);

/** Back to the plain address, so a dead room's invite link is not left in the address bar. */
function resetUrl(): void {
  try {
    if (location.pathname !== '/') history.replaceState(null, '', '/');
  } catch {
    /* ignore */
  }
}

/** High-resolution wall clock (ms). Date.now() is only 1 ms resolution and can step; this cannot. */
export const localNow = (): number => performance.timeOrigin + performance.now();

interface SavedSession {
  code: string;
  name: string;
  resume: string;
}

export function loadSession(): SavedSession | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as SavedSession) : null;
  } catch {
    return null;
  }
}

/**
 * Owns the socket. Framework-free so the sync engine, the React tree and (in spirit) the
 * benchmark's mock clients all share the same protocol behaviour:
 *  - clock sync burst on connect, then a slow cadence
 *  - transparent reconnect with exponential backoff + jitter and a signed resume token
 *  - snapshot on (re)join => late joiners and reconnects use the same code path
 *  - states older than the one we hold are dropped (seq guard)
 */
export class RoomClient {
  readonly clock = new ClockSync();

  private ws: WebSocket | null = null;
  private snap: ClientSnapshot = { status: 'idle', room: null, error: null, toast: null };
  private subs = new Set<() => void>();
  private reactSubs = new Set<(e: ReactEvent) => void>();
  private intent: Intent | null = null;
  private code: string | null = null;
  private name = '';
  private resume: string | null = null;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private intentional = false;
  private cmdN = 0;
  private toastN = 0;

  // ───────── React external-store plumbing ─────────
  subscribe = (fn: () => void): (() => void) => {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  };
  getSnapshot = (): ClientSnapshot => this.snap;

  onReact(fn: (e: ReactEvent) => void): () => void {
    this.reactSubs.add(fn);
    return () => this.reactSubs.delete(fn);
  }

  private set(patch: Partial<ClientSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    for (const s of this.subs) s();
  }

  private patchRoom(fn: (r: RoomData) => RoomData): void {
    if (this.snap.room) this.set({ room: fn(this.snap.room) });
  }

  private toast(text: string): void {
    this.set({ toast: { id: ++this.toastN, text } });
  }

  get room(): RoomData | null {
    return this.snap.room;
  }

  serverNow(): number {
    return this.clock.serverNow(localNow());
  }

  // ───────── lifecycle ─────────
  connect(intent: Intent): void {
    this.disconnect(false);
    this.intentional = false;
    this.intent = intent;
    this.name = intent.name;
    this.code = intent.kind === 'join' ? intent.code : null;
    this.resume = intent.kind === 'join' ? (intent.resume ?? null) : null;
    this.set({ status: 'connecting', error: null });
    this.open();
  }

  disconnect(sendLeave = true): void {
    this.intentional = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.pingTimer);
    if (sendLeave) this.send({ t: 'leave' });
    this.ws?.close();
    this.ws = null;
    if (sendLeave) {
      resetUrl();
      try {
        sessionStorage.removeItem(SESSION_KEY);
      } catch {
        /* storage unavailable */
      }
      this.code = null;
      this.resume = null;
      this.set({ status: 'idle', room: null });
    }
  }

  private open(): void {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      // Clock burst: 8 quick samples so the filter has something to pick the lowest RTT from.
      for (let i = 0; i < 8; i++) setTimeout(() => this.ping(), i * 60);
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => this.ping(), 4000);

      if (this.code) this.send({ t: 'join', code: this.code, name: this.name, resume: this.resume ?? undefined });
      else if (this.intent?.kind === 'create') this.send({ t: 'create', name: this.name });
    };

    ws.onmessage = (ev) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(String(ev.data)) as ServerMsg;
      } catch {
        return;
      }
      this.onMessage(msg);
    };

    ws.onclose = () => {
      clearInterval(this.pingTimer);
      if (this.intentional || this.ws !== ws) return;
      if (this.snap.room) this.set({ status: 'reconnecting' });
      else if (this.attempt >= 2) {
        // Never got in after several tries: tell the user instead of spinning forever.
        this.set({ status: 'connecting', error: "Can't reach the server. Check that it is running (npm run dev) or, on a hosted site, that CORS_ORIGINS matches this address. Still retrying…" });
      } else this.set({ status: 'connecting' });
      const delay = Math.min(5000, 400 * 2 ** this.attempt++) * (0.7 + Math.random() * 0.6);
      this.retryTimer = setTimeout(() => this.open(), delay);
    };
    ws.onerror = () => ws.close();
  }

  private ping(): void {
    this.send({ t: 'ping', c0: localNow() });
  }

  send(msg: ClientMsg): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  /** Playback commands carry a client command id (latency tracing) and the last seq we saw (stale-command guard). */
  command(kind: 'play' | 'pause' | 'seek', pos: number): string {
    const cid = `${this.snap.room?.you ?? 'x'}-${++this.cmdN}`;
    this.send({ t: kind, pos, base: this.snap.room?.state.seq, cid });
    return cid;
  }

  // ───────── inbound ─────────
  private onMessage(msg: ServerMsg): void {
    switch (msg.t) {
      case 'pong':
        this.clock.addSample(msg.c0, msg.s, localNow());
        return;

      case 'joined': {
        this.code = msg.snapshot.code;
        this.resume = msg.resume;
        try {
          sessionStorage.setItem(SESSION_KEY, JSON.stringify({ code: this.code, name: this.name, resume: msg.resume } satisfies SavedSession));
        } catch {
          /* storage unavailable */
        }
        if (location.pathname !== `/r/${this.code}`) history.replaceState(null, '', `/r/${this.code}`);
        const { serverNow: _ignored, ...rest } = msg.snapshot;
        void _ignored;
        this.set({ status: 'open', error: null, room: { ...rest, you: msg.you, health: { maxAbsDriftMs: 0, byId: {} } } });
        return;
      }

      case 'state':
        // Seq guard: never let an older state overwrite a newer one (reordering, duplicate resync replies).
        this.patchRoom((r) => (msg.state.seq > r.state.seq ? { ...r, state: msg.state } : r));
        return;

      case 'members':
        this.patchRoom((r) => ({ ...r, members: msg.members, hostId: msg.hostId }));
        return;
      case 'settings':
        this.patchRoom((r) => ({ ...r, settings: msg.settings }));
        return;
      case 'chat':
        this.patchRoom((r) => ({ ...r, chat: [...r.chat, msg.msg].slice(-200) }));
        return;
      case 'queue':
        this.patchRoom((r) => ({ ...r, queue: msg.queue }));
        return;
      case 'polls':
        this.patchRoom((r) => ({ ...r, polls: msg.polls }));
        return;
      case 'markers':
        this.patchRoom((r) => ({ ...r, markers: msg.markers }));
        return;
      case 'heat':
        this.patchRoom((r) => (msg.mediaId === r.state.mediaId ? { ...r, heat: msg.buckets } : r));
        return;
      case 'reel':
        this.patchRoom((r) => ({ ...r, reel: msg.reel }));
        return;
      case 'health':
        this.patchRoom((r) => ({
          ...r,
          health: { maxAbsDriftMs: msg.maxAbsDriftMs, byId: Object.fromEntries(msg.members.map((m) => [m.id, { driftMs: m.driftMs, rttMs: m.rttMs }])) },
        }));
        return;

      case 'react':
        for (const s of this.reactSubs) s({ emoji: msg.emoji, from: msg.from, name: msg.name });
        return;

      case 'error':
        if (FATAL.has(msg.code)) {
          this.intentional = true;
          this.ws?.close();
          resetUrl();
          try {
            sessionStorage.removeItem(SESSION_KEY);
          } catch {
            /* storage unavailable */
          }
          this.code = null;
          this.set({ status: 'idle', room: null, error: msg.message });
        } else {
          this.toast(msg.message);
        }
        return;
    }
  }
}
