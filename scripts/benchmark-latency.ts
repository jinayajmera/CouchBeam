/**
 * Couchbeam latency & drift benchmark.
 *
 *   npm run bench                                   # embeds a server on a random port (loopback)
 *   npm run bench -- --clients 25 --commands 400    # bigger room
 *   npm run bench -- --delay 15 --jitter 10         # simulate ~15-25 ms one-way network
 *   npm run bench:remote -- ws://192.168.1.20:8080/ws   # against a server on your LAN
 *
 * What it measures
 *   1. Command propagation: sender stamps t_send, every OTHER client stamps t_recv when the matching
 *      authoritative `state` arrives. propagation = t_recv - t_send (true wall clock; all mock clients
 *      share one process, so there is no clock error in the measurement itself).
 *   2. Clock sync accuracy: each mock client runs with a random local clock skew of up to ±3 s and must
 *      recover server time with the same ClockSync class the browser uses.
 *   3. Steady-state drift: each client owns a *virtual player* with a deliberately wrong crystal
 *      (±0.3 % playback-speed error), random seek latency and a random initial offset, driven by the
 *      SAME computeCorrection() policy as the browser. We sample every 250 ms.
 *   4. Correctness under stress: simultaneous commands, reconnect with resume token, late join,
 *      buffering hold, host failover.
 *
 * Exit code is non-zero if any requirement is missed, so CI can gate on it.
 */
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import WebSocket from 'ws';
import {
  ClockSync,
  DRIFT,
  computeCorrection,
  expectedPosition,
  type PlaybackState,
  type ServerMsg,
} from '@couchbeam/shared';
import { startServer, type RunningServer } from '../server/src/server';

process.env.NODE_ENV ??= 'test';

// ───────────────────────── args ─────────────────────────
const argv = process.argv.slice(2);
const flag = (name: string, def: number): number => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? Number(argv[i + 1]) : def;
};
const sflag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const remoteUrl = sflag('url') ?? argv.find((a) => a.startsWith('ws://') || a.startsWith('wss://'));

const OPT = {
  clients: Math.max(2, flag('clients', 12)),
  commands: flag('commands', 300),
  intervalMs: flag('interval', 40),
  driftSeconds: flag('drift-seconds', 24),
  warmupSeconds: flag('warmup', 12),
  races: flag('races', 25),
  delayMs: flag('delay', 0),
  jitterMs: flag('jitter', 0),
  out: sflag('out') ?? 'benchmark-results.json',
};

const REQ = { propagationP95Ms: 250, driftMaxMs: 500, minClients: 10 };

// ───────────────────────── utils ─────────────────────────
/** True wall clock, ms. Shared by every mock client, so measurements are free of clock error. */
const T = (): number => performance.timeOrigin + performance.now();
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const rnd = (a: number, b: number): number => a + Math.random() * (b - a);

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;
}
function stats(values: number[]) {
  const s = [...values].sort((a, b) => a - b);
  const mean = s.reduce((x, y) => x + y, 0) / (s.length || 1);
  return { n: s.length, min: s[0] ?? NaN, mean, p50: pct(s, 50), p90: pct(s, 90), p95: pct(s, 95), p99: pct(s, 99), max: s[s.length - 1] ?? NaN };
}
const f = (n: number, d = 2): string => (Number.isFinite(n) ? n.toFixed(d) : 'n/a');

/**
 * FIFO "network pipe": adds delay + jitter but never reorders (TCP semantics).
 * One drain timer instead of one setTimeout per message: Node truncates timeout delays to whole
 * milliseconds, so independent timers can fire out of order when messages are < 1 ms apart.
 */
class Pipe {
  private q: { at: number; fn: () => void }[] = [];
  private timer: NodeJS.Timeout | undefined;
  private free = 0;
  constructor(private delay: number, private jitter: number) {}
  run(fn: () => void): void {
    if (!this.delay && !this.jitter) return fn();
    const at = Math.max(this.free, T() + this.delay + Math.random() * this.jitter);
    this.free = at;
    this.q.push({ at, fn });
    this.schedule();
  }
  private schedule(): void {
    if (this.timer || this.q.length === 0) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const now = T();
      while (this.q.length > 0 && this.q[0]!.at <= now + 0.5) this.q.shift()!.fn();
      this.schedule();
    }, Math.max(0, this.q[0]!.at - T()));
  }
}

// ───────────────────────── mock client ─────────────────────────
class Mock {
  ws!: WebSocket;
  id = '';
  resume = '';
  code = '';
  state: PlaybackState | null = null;
  hostId: string | null = null;
  memberCount = 0;
  memberList: { id: string; joinedAt: number; connected: boolean }[] = [];
  clock = new ClockSync();
  readonly skewMs = rnd(-3000, 3000);
  readonly ppm = rnd(-3000, 3000); // ±0.3 % wrong crystal
  readonly recv = new Map<string, number>(); // cid -> true recv time
  readonly states: PlaybackState[] = [];
  joinedAt = 0;
  private up: Pipe;
  private down: Pipe;
  private joinedResolve?: () => void;
  private joinedReject?: (e: Error) => void;

  // virtual player
  vpos = 0;
  vrate = 1;
  private lastTick = 0;
  private stallUntil = 0;
  playerOn = false;
  hardSeeks = 0;
  private tickTimer?: NodeJS.Timeout;

  constructor(readonly url: string, readonly name: string) {
    this.up = new Pipe(OPT.delayMs, OPT.jitterMs);
    this.down = new Pipe(OPT.delayMs, OPT.jitterMs);
  }

  localNow(): number {
    return T() + this.skewMs;
  }
  serverNow(): number {
    return this.clock.serverNow(this.localNow());
  }

  send(msg: object): void {
    this.up.run(() => this.ws.readyState === WebSocket.OPEN && this.ws.send(JSON.stringify(msg)));
  }

  async open(): Promise<void> {
    this.ws = new WebSocket(this.url);
    this.ws.on('message', (d) => {
      const raw = d.toString();
      this.down.run(() => this.handle(JSON.parse(raw) as ServerMsg));
    });
    await new Promise<void>((ok, bad) => {
      this.ws.once('open', () => ok());
      this.ws.once('error', bad);
    });
    // Same clock burst the browser client does: 8 samples, 40 ms apart.
    for (let i = 0; i < 8; i++) {
      this.send({ t: 'ping', c0: this.localNow() });
      await sleep(40);
    }
    await sleep(30 + (OPT.delayMs + OPT.jitterMs) * 2);
  }

  private waitJoined(): Promise<void> {
    return new Promise((ok, bad) => {
      const timer = setTimeout(() => bad(new Error(`${this.name}: no "joined" within 5 s`)), 5000);
      this.joinedResolve = () => {
        clearTimeout(timer);
        ok();
      };
      this.joinedReject = (e) => {
        clearTimeout(timer);
        bad(e);
      };
    });
  }

  async create(): Promise<void> {
    await this.open();
    const joined = this.waitJoined();
    this.send({ t: 'create', name: this.name });
    await joined;
  }

  async join(code: string, resume?: string): Promise<void> {
    await this.open();
    const joined = this.waitJoined();
    this.send({ t: 'join', code, name: this.name, resume });
    await joined;
  }

  private handle(msg: ServerMsg): void {
    const tr = T();
    switch (msg.t) {
      case 'pong':
        this.clock.addSample(msg.c0, msg.s, this.localNow());
        break;
      case 'joined':
        this.id = msg.you;
        this.resume = msg.resume;
        this.code = msg.snapshot.code;
        this.state = msg.snapshot.state;
        this.hostId = msg.snapshot.hostId;
        this.memberCount = msg.snapshot.members.length;
        this.memberList = msg.snapshot.members;
        this.joinedAt = tr;
        this.joinedResolve?.();
        break;
      case 'state':
        if (msg.cid && !this.recv.has(msg.cid)) this.recv.set(msg.cid, tr);
        if (!this.state || msg.state.seq > this.state.seq) {
          this.state = msg.state;
          this.states.push(msg.state);
        }
        break;
      case 'error':
        this.joinedReject?.(new Error(`${this.name}: server error ${msg.code}: ${msg.message}`));
        break;
      case 'members':
        this.hostId = msg.hostId;
        this.memberCount = msg.members.filter((m) => m.connected).length;
        this.memberList = msg.members;
        break;
      default:
        break;
    }
  }

  // ───── virtual player: same policy as the browser's useSyncEngine ─────
  startPlayer(initialOffsetSec: number, truthNow: () => number): void {
    const st = this.state!;
    this.vpos = expectedPosition(st, truthNow()) + initialOffsetSec;
    this.vrate = 1;
    this.lastTick = T();
    this.playerOn = true;
    this.tickTimer = setInterval(() => this.tick(), 100);
  }
  stopPlayer(): void {
    this.playerOn = false;
    clearInterval(this.tickTimer);
  }
  /** Position extrapolated to wall time `t`, so sampling is not quantised to the 100 ms control tick. */
  posAt(t: number): number {
    const st = this.state;
    if (!st || !this.playerOn) return this.vpos;
    const playing = st.status === 'playing' && this.serverNow() >= st.anchor && t >= this.stallUntil;
    return this.vpos + (playing ? (this.vrate * (1 + this.ppm / 1e6) * (t - this.lastTick)) / 1000 : 0);
  }
  private tick(): void {
    const st = this.state;
    if (!st || !this.clock.synced) return;
    const t = T();
    this.vpos = this.posAt(t);
    this.lastTick = t;

    const now = this.serverNow();
    const expected = expectedPosition(st, now);
    const drift = this.vpos - expected;
    const shouldPlay = st.status === 'playing' && now >= st.anchor;

    if (!shouldPlay) {
      this.vrate = 1;
      if (computeCorrection(drift, false, 1).action === 'seek') this.vpos = expected;
      return;
    }
    const c = computeCorrection(drift, true, this.vrate);
    if (c.action === 'seek') {
      this.vpos = expected + DRIFT.seekLeadSec;
      this.vrate = 1;
      this.stallUntil = t + rnd(40, 160); // a real <video> stalls briefly while it seeks
      this.hardSeeks++;
    } else {
      this.vrate = c.rate;
    }
  }

  close(): void {
    this.stopPlayer();
    this.ws?.terminate();
  }
}

// ───────────────────────── scenarios ─────────────────────────
interface Check {
  name: string;
  pass: boolean;
  detail: string;
}
const checks: Check[] = [];
const check = (name: string, pass: boolean, detail: string): void => {
  checks.push({ name, pass, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
};

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const end = T() + timeoutMs;
  while (T() < end) {
    if (cond()) return true;
    await sleep(2);
  }
  return cond();
}

function authoritative(clients: Mock[]): PlaybackState {
  return clients.map((c) => c.state!).reduce((a, b) => (b.seq > a.seq ? b : a));
}

async function main(): Promise<void> {
  console.log(`\nCouchbeam benchmark — ${OPT.clients} clients, ${OPT.commands} commands, drift run ${OPT.driftSeconds}s`);

  let server: RunningServer | null = null;
  let url = remoteUrl;
  const embedded = !remoteUrl;
  if (embedded) {
    server = await startServer({ port: 0, host: '127.0.0.1', logLevel: 'silent', reconnectGraceMs: 1500, maxMembersPerRoom: Math.max(50, OPT.clients + 5), sessionSecret: 'bench-secret-bench-secret-bench-secret-1' });
    url = `ws://127.0.0.1:${server.port}/ws`;
  }
  console.log(`target: ${embedded ? 'embedded server (loopback)' : url}  |  simulated one-way delay ${OPT.delayMs}±${OPT.jitterMs} ms\n`);

  // ── 1. Room setup ──
  console.log('[1] Room setup');
  const host = new Mock(url!, 'host');
  await host.create();
  const clients: Mock[] = [host];
  const joiners = Array.from({ length: OPT.clients - 1 }, (_, i) => new Mock(url!, `guest${i + 1}`));
  await Promise.all(joiners.map((c) => c.join(host.code)));
  clients.push(...joiners);
  await sleep(200);
  check('concurrent users in one room', clients.length >= REQ.minClients && clients.every((c) => c.id), `${clients.length} joined (requirement >= ${REQ.minClients})`);
  check('all clients agree on membership', clients.every((c) => c.memberCount === clients.length), `each sees ${clients.map((c) => c.memberCount).join(',')}`);

  // ── 2. Clock sync accuracy ──
  console.log('\n[2] Clock synchronisation (clients start with random ±3 s local skew)');
  // True server time == T() only when the server shares our process/clock.
  const clockErr = clients.map((c) => Math.abs(c.skewMs + c.clock.offset));
  const clockStats = stats(clockErr);
  if (embedded) {
    check('clock offset error', clockStats.p95 <= 20 + (OPT.delayMs + OPT.jitterMs), `p50 ${f(clockStats.p50)} ms, p95 ${f(clockStats.p95)} ms, max ${f(clockStats.max)} ms (bound = rtt/2)`);
  } else {
    console.log('  (skipped: needs a shared clock with the server; embedded mode only)');
  }

  // ── 3. Command propagation ──
  console.log(`\n[3] Command propagation (${OPT.commands} commands, one sender at a time, every client takes a turn)`);
  host.send({ t: 'setMedia', mediaId: 'sintel' });
  await waitFor(() => clients.every((c) => c.state?.mediaId === 'sintel'), 2000);
  host.send({ t: 'play', pos: 0, cid: 'warm' });
  await waitFor(() => clients.every((c) => c.recv.has('warm')), 2000);

  const prop: number[] = [];
  const echo: number[] = [];
  const perOp: Record<string, number[]> = { seek: [], pause: [], play: [] };
  let lost = 0;
  for (let i = 0; i < OPT.commands; i++) {
    const sender = clients[i % clients.length]!;
    const cid = `b${i}`;
    const status = authoritative(clients).status;
    let op: 'seek' | 'pause' | 'play' = 'seek';
    if (i % 4 === 3) op = status === 'playing' ? 'pause' : 'play';
    const pos = op === 'seek' ? rnd(5, 600) : (sender.state?.pos ?? 0);

    const tSend = T();
    sender.send({ t: op, pos, cid });
    const others = clients.filter((c) => c !== sender);
    const all = await waitFor(() => others.every((c) => c.recv.has(cid)) && sender.recv.has(cid), 2000);
    if (!all) lost += others.filter((c) => !c.recv.has(cid)).length;
    for (const c of others) {
      const tr = c.recv.get(cid);
      if (tr !== undefined) {
        prop.push(tr - tSend);
        perOp[op]!.push(tr - tSend);
      }
    }
    const e = sender.recv.get(cid);
    if (e !== undefined) echo.push(e - tSend);
    await sleep(OPT.intervalMs);
  }
  const P = stats(prop);
  const E = stats(echo);
  console.log(`  deliveries ${P.n}  lost ${lost}`);
  console.log(`  propagation (sender -> other clients), ms:  p50 ${f(P.p50)}   p90 ${f(P.p90)}   p95 ${f(P.p95)}   p99 ${f(P.p99)}   max ${f(P.max)}   mean ${f(P.mean)}`);
  console.log(`  sender echo (round trip), ms:               p50 ${f(E.p50)}   p90 ${f(E.p90)}   p95 ${f(E.p95)}   max ${f(E.max)}`);
  for (const [op, v] of Object.entries(perOp)) if (v.length) console.log(`    ${op.padEnd(5)} n=${String(v.length).padStart(5)}  p50 ${f(pct([...v].sort((a, b) => a - b), 50))}  p95 ${f(pct([...v].sort((a, b) => a - b), 95))}`);
  check('propagation p95', P.p95 <= REQ.propagationP95Ms, `${f(P.p95)} ms (requirement <= ${REQ.propagationP95Ms} ms)`);
  check('no lost command deliveries', lost === 0, `${lost} lost of ${P.n + lost}`);

  // ── 4. Steady-state drift ──
  console.log(`\n[4] Drift correction (virtual players: ±0.3 % wrong crystal, random seek stalls, random start offset up to ±1.2 s)`);
  host.send({ t: 'seek', pos: 30, cid: 'dstart1' });
  host.send({ t: 'play', pos: 30, cid: 'dstart2' });
  await waitFor(() => clients.every((c) => c.recv.has('dstart2') || c.state!.status === 'playing'), 2000);
  await sleep(300);
  const truth = (): number => (embedded ? T() : T() + clients.reduce((s, c) => s + c.skewMs + c.clock.offset, 0) / clients.length);
  const initial = clients.map(() => rnd(-1.2, 1.2));
  clients.forEach((c, i) => c.startPlayer(initial[i]!, truth));
  const initialMax = Math.max(...initial.map((x) => Math.abs(x * 1000)));

  const steady: number[] = [];
  const spreads: number[] = [];
  const allAbs: number[] = [];
  let convergedAt: number | null = null;
  let goodSince: number | null = null;
  const t0 = T();
  while (T() - t0 < OPT.driftSeconds * 1000) {
    await sleep(250);
    const t = T();
    const auth = authoritative(clients);
    const expected = expectedPosition(auth, truth());
    const drifts = clients.map((c) => (c.posAt(t) - expected) * 1000);
    const abs = drifts.map(Math.abs);
    allAbs.push(...abs);
    const elapsed = (t - t0) / 1000;
    if (Math.max(...abs) <= REQ.driftMaxMs) {
      goodSince ??= elapsed;
      if (convergedAt === null && elapsed - goodSince >= 2) convergedAt = goodSince;
    } else {
      goodSince = null;
      convergedAt = null;
    }
    if (elapsed >= OPT.warmupSeconds) {
      steady.push(...abs);
      const positions = clients.map((c) => c.posAt(t));
      spreads.push((Math.max(...positions) - Math.min(...positions)) * 1000);
    }
  }
  clients.forEach((c) => c.stopPlayer());
  const D = stats(steady);
  const S = stats(spreads);
  const hardSeeks = clients.reduce((s, c) => s + c.hardSeeks, 0);
  console.log(`  initial worst offset: ${f(initialMax, 0)} ms   converged (all < ${REQ.driftMaxMs} ms for 2 s) after: ${convergedAt === null ? 'never' : f(convergedAt, 1) + ' s'}   hard seeks: ${hardSeeks}`);
  console.log(`  steady-state |drift| vs authoritative time (t >= ${OPT.warmupSeconds}s), ms:  p50 ${f(D.p50)}   p95 ${f(D.p95)}   p99 ${f(D.p99)}   max ${f(D.max)}   (${D.n} samples)`);
  console.log(`  steady-state spread between clients (max-min position), ms:   p50 ${f(S.p50)}   p95 ${f(S.p95)}   max ${f(S.max)}`);
  check('steady-state drift', D.max <= REQ.driftMaxMs, `max ${f(D.max)} ms, p95 ${f(D.p95)} ms (requirement <= ${REQ.driftMaxMs} ms)`);
  check('inter-client spread', S.max <= REQ.driftMaxMs, `max ${f(S.max)} ms`);

  // ── 5. Simultaneous commands ──
  console.log(`\n[5] Race: every client fires a command in the same tick (${OPT.races} rounds)`);
  let inconsistent = 0;
  for (let r = 0; r < OPT.races; r++) {
    const before = authoritative(clients).seq;
    for (const c of clients) {
      const roll = Math.random();
      if (roll < 0.25) c.send({ t: 'pause', pos: 0 });
      else if (roll < 0.5) c.send({ t: 'play', pos: rnd(0, 300) });
      else c.send({ t: 'seek', pos: rnd(0, 600) });
    }
    await sleep(60 + (OPT.delayMs + OPT.jitterMs) * 3);
    await waitFor(() => new Set(clients.map((c) => c.state!.seq)).size === 1, 1500);
    const seqs = new Set(clients.map((c) => c.state!.seq));
    const poss = new Set(clients.map((c) => `${c.state!.status}|${c.state!.pos}|${c.state!.anchor}`));
    const serverState = server ? [...server.manager.rooms.values()][0]?.state : undefined;
    const matchesServer = !serverState || clients.every((c) => c.state!.seq === serverState.seq);
    if (seqs.size !== 1 || poss.size !== 1 || !matchesServer || authoritative(clients).seq < before) inconsistent++;
  }
  check('all clients converge to one state after simultaneous commands', inconsistent === 0, `${OPT.races - inconsistent}/${OPT.races} rounds fully consistent`);
  const seqMonotonic = clients.every((c) => c.states.every((s, i, a) => i === 0 || s.seq > a[i - 1]!.seq));
  check('state sequence numbers strictly increasing at every client', seqMonotonic, 'no reordering or duplicates applied');

  // ── 6. Buffering hold ──
  console.log('\n[6] Buffering hold');
  host.send({ t: 'play', pos: 40, cid: 'bh0' });
  await sleep(300 + OPT.delayMs * 4);
  const victim = clients[clients.length - 1]!;
  const tHold = T();
  victim.send({ t: 'buffering', on: true });
  const held = await waitFor(() => clients.every((c) => c.state!.hold && c.state!.status === 'paused'), 2000);
  const holdMs = T() - tHold;
  victim.send({ t: 'buffering', on: false });
  const resumed = await waitFor(() => clients.every((c) => !c.state!.hold && c.state!.status === 'playing'), 2000);
  check('room pauses for a stalled member and resumes together', held && resumed, `hold reached all clients in ${f(holdMs)} ms; resumed: ${resumed}`);

  // ── 7. Reconnect ──
  console.log('\n[7] Transient network drop + reconnect with resume token');
  const flaky = clients[3] ?? clients[1]!;
  const oldId = flaky.id;
  const token = flaky.resume;
  flaky.ws.terminate();
  await sleep(150);
  host.send({ t: 'seek', pos: 222, cid: 'during-outage' });
  await sleep(150 + OPT.delayMs * 2);
  const back = new Mock(url!, flaky.name);
  const tRe = T();
  await back.join(host.code, token);
  const reMs = T() - tRe;
  const sameSeat = back.id === oldId;
  const caughtUp = back.state!.seq === authoritative(clients.filter((c) => c !== flaky)).seq && Math.abs(back.state!.pos - 222) < 1;
  clients[clients.indexOf(flaky)] = back;
  check('reconnect keeps identity and recovers missed state', sameSeat && caughtUp, `same seat: ${sameSeat}, caught up on missed seek: ${caughtUp}, rejoined in ${f(reMs)} ms (incl. clock burst)`);
  await sleep(100);
  check('seat not duplicated', clients.every((c) => c.memberCount === OPT.clients), `members seen: ${[...new Set(clients.map((c) => c.memberCount))].join(',')}`);

  // ── 8. Late join ──
  console.log('\n[8] Late joiner during playback');
  host.send({ t: 'play', pos: 100, cid: 'lj0' });
  await sleep(1500 + OPT.delayMs * 4);
  const late = new Mock(url!, 'late');
  await late.join(host.code);
  late.startPlayer(0, truth);
  late.vpos = 0; // a fresh <video> starts at 0 -> the engine must hard-seek to the room
  const tJoin = T();
  const synced = await waitFor(() => Math.abs((late.posAt(T()) - expectedPosition(authoritative(clients), truth())) * 1000) <= REQ.driftMaxMs, 5000);
  const lateMs = T() - tJoin;
  late.stopPlayer();
  check('late joiner snaps to the room position', synced, `within ${REQ.driftMaxMs} ms after ${f(lateMs, 0)} ms (started 100 s behind)`);
  clients.push(late);

  // ── 9. Host failover (embedded: we control the grace period) ──
  if (embedded) {
    console.log('\n[9] Host failover');
    const oldHost = clients.find((c) => c.id === host.id)!;
    // Ground truth is the server's own join order (its member list is sorted by server-side joinedAt).
    const expectedNextId = oldHost.memberList.filter((m) => m.connected && m.id !== oldHost.id).sort((a, b) => a.joinedAt - b.joinedAt)[0]!.id;
    oldHost.ws.terminate();
    const survivors = clients.filter((c) => c !== oldHost);
    const tFail = T();
    const elected = await waitFor(() => survivors.every((c) => c.hostId === expectedNextId), 4000);
    check('host leaves -> oldest remaining member becomes host, everyone agrees', elected, `new host elected ${f(T() - tFail, 0)} ms after disconnect (grace 1500 ms)`);
    survivors[0]!.send({ t: 'pause', pos: 0 });
  }

  // ── report ──
  const failed = checks.filter((c) => !c.pass);
  console.log(`\n${failed.length === 0 ? 'ALL CHECKS PASSED' : `${failed.length} CHECK(S) FAILED`}  (${checks.length - failed.length}/${checks.length})`);

  const report = {
    generatedAt: new Date().toISOString(),
    environment: { node: process.version, platform: `${os.platform()} ${os.release()}`, cpu: os.cpus()[0]?.model, cores: os.cpus().length, mode: embedded ? 'embedded-loopback' : 'remote', url: embedded ? undefined : url },
    parameters: OPT,
    requirements: REQ,
    propagationMs: { ...P, lost },
    echoRttMs: E,
    clockOffsetErrorMs: embedded ? clockStats : null,
    drift: { initialWorstMs: initialMax, convergedAfterSec: convergedAt, hardSeeks, steadyAbsMs: D, spreadMs: S },
    checks,
    passed: failed.length === 0,
  };
  writeFileSync(OPT.out, JSON.stringify(report, null, 2));
  console.log(`report written to ${OPT.out}\n`);

  for (const c of clients) c.close();
  await server?.close();
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
