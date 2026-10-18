import { beforeEach, describe, expect, it } from 'vitest';
import { getMedia, type ServerMsg } from '@couchbeam/shared';
import { Room, type Conn } from '../src/room';
import { signResume, verifyResume } from '../src/manager';

class FakeConn implements Conn {
  msgs: ServerMsg[] = [];
  closed = false;
  send(m: ServerMsg) { this.msgs.push(m); }
  close() { this.closed = true; }
  last<T extends ServerMsg['t']>(t: T) { return [...this.msgs].reverse().find((m) => m.t === t) as Extract<ServerMsg, { t: T }> | undefined; }
}

const SECRET = 'test-secret-test-secret-test-secret-123';
let clock = 1_000_000;
const now = () => clock;

function mkRoom(opts: Partial<{ maxMembers: number }> = {}) {
  return new Room('ABC234', {
    now,
    getMedia,
    sign: (id, code) => signResume(SECRET, id, code, clock),
    verify: (tok, code) => verifyResume(SECRET, tok, code, clock),
    maxMembers: opts.maxMembers ?? 50,
    graceMs: 15_000,
    playLeadMs: 200,
    emptyTtlMs: 300_000,
  });
}

function join(room: Room, name: string) {
  const conn = new FakeConn();
  const r = room.join(conn, name);
  if ('error' in r) throw new Error(r.error);
  return { conn, id: r.memberId };
}

beforeEach(() => { clock = 1_000_000; });

describe('membership & host', () => {
  it('first joiner is host; later joiners are not', () => {
    const room = mkRoom();
    const a = join(room, 'Ana');
    join(room, 'Ben');
    expect(room.hostId).toBe(a.id);
  });

  it('late joiner receives a full snapshot including current playback', () => {
    const room = mkRoom();
    const a = join(room, 'Ana');
    room.handle(a.id, { t: 'setMedia', mediaId: 'sintel' });
    room.handle(a.id, { t: 'play', pos: 0 });
    clock += 5000;
    const b = join(room, 'Ben');
    const snap = b.conn.last('joined')!.snapshot;
    expect(snap.state.mediaId).toBe('sintel');
    expect(snap.state.status).toBe('playing');
    expect(room.expectedPos()).toBeCloseTo(4.8, 1); // 5 s minus the 200 ms scheduled lead
  });

  it('enforces the member cap', () => {
    const room = mkRoom({ maxMembers: 2 });
    join(room, 'a'); join(room, 'b');
    const r = room.join(new FakeConn(), 'c');
    expect('error' in r && r.error).toBe('room_full');
  });

  it('transfers host explicitly, and refuses non-hosts', () => {
    const room = mkRoom();
    const a = join(room, 'Ana'); const b = join(room, 'Ben');
    room.handle(b.id, { t: 'transferHost', to: b.id });
    expect(room.hostId).toBe(a.id);
    room.handle(a.id, { t: 'transferHost', to: b.id });
    expect(room.hostId).toBe(b.id);
  });

  it('keeps host through a short drop, then elects the oldest connected member after grace', () => {
    const room = mkRoom();
    const a = join(room, 'Ana'); const b = join(room, 'Ben'); join(room, 'Cy');
    room.detach(a.id, a.conn);
    clock += 5000; room.sweep();
    expect(room.hostId).toBe(a.id); // still within grace
    clock += 11_000; room.sweep();
    expect(room.hostId).toBe(b.id); // Ben joined before Cy
    expect(room.memberCount).toBe(2);
  });

  it('resume token restores the same seat (and host role) and closes the stale socket', () => {
    const room = mkRoom();
    const a = join(room, 'Ana');
    const token = a.conn.last('joined')!.resume;
    room.detach(a.id, a.conn);
    clock += 3000;
    const fresh = new FakeConn();
    const r = room.join(fresh, 'Ana', token);
    expect('memberId' in r && r.memberId).toBe(a.id);
    expect(room.hostId).toBe(a.id);
    expect(room.memberCount).toBe(1);
  });

  it('rejects forged, foreign-room and expired resume tokens', () => {
    const room = mkRoom();
    const a = join(room, 'Ana');
    const good = a.conn.last('joined')!.resume;
    expect(verifyResume(SECRET, good + 'x', 'ABC234', clock)).toBeNull();
    expect(verifyResume(SECRET, good, 'ZZZZZZ', clock)).toBeNull();
    expect(verifyResume(SECRET, good, 'ABC234', clock + 25 * 3600 * 1000)).toBeNull();
    expect(verifyResume('other-secret-other-secret-other-1234', good, 'ABC234', clock)).toBeNull();
  });

  it('freezes playback when everyone disconnects', () => {
    const room = mkRoom();
    const a = join(room, 'Ana');
    room.handle(a.id, { t: 'setMedia', mediaId: 'sintel' });
    room.handle(a.id, { t: 'play', pos: 0 });
    clock += 10_200;
    room.detach(a.id, a.conn);
    expect(room.state.status).toBe('paused');
    expect(room.state.pos).toBeCloseTo(10, 1);
  });
});

describe('playback state machine', () => {
  it('seq strictly increases and every client sees the same state', () => {
    const room = mkRoom();
    const a = join(room, 'Ana'); const b = join(room, 'Ben');
    room.handle(a.id, { t: 'setMedia', mediaId: 'sintel' });
    room.handle(a.id, { t: 'play', pos: 0 });
    room.handle(b.id, { t: 'seek', pos: 120 });
    room.handle(a.id, { t: 'pause', pos: 0 });
    const seqs = (c: FakeConn) => c.msgs.filter((m) => m.t === 'state').map((m) => (m as any).state.seq);
    expect(seqs(a.conn)).toEqual(seqs(b.conn));
    const s = seqs(a.conn);
    expect([...s].sort((x, y) => x - y)).toEqual(s);
    expect(new Set(s).size).toBe(s.length);
  });

  it('schedules play in the future so all clients start together', () => {
    const room = mkRoom();
    const a = join(room, 'Ana');
    room.handle(a.id, { t: 'setMedia', mediaId: 'sintel' });
    room.handle(a.id, { t: 'play', pos: 30 });
    expect(room.state.anchor).toBe(clock + 200);
    expect(room.expectedPos()).toBe(30);
    clock += 1200;
    expect(room.expectedPos()).toBeCloseTo(31, 6);
  });

  it('pause uses the server clock, not the (drifting) client position', () => {
    const room = mkRoom();
    const a = join(room, 'Ana');
    room.handle(a.id, { t: 'setMedia', mediaId: 'sintel' });
    room.handle(a.id, { t: 'play', pos: 0 });
    clock += 4200;
    room.handle(a.id, { t: 'pause', pos: 0 });
    expect(room.state.pos).toBeCloseTo(4, 1);
  });

  it('race: simultaneous Play clicks do not move the playhead', () => {
    const room = mkRoom();
    const a = join(room, 'Ana'); const b = join(room, 'Ben');
    room.handle(a.id, { t: 'setMedia', mediaId: 'sintel' });
    room.handle(a.id, { t: 'play', pos: 10 });
    const seq = room.state.seq;
    room.handle(b.id, { t: 'play', pos: 10.05 });
    expect(room.state.seq).toBe(seq);
    expect(b.conn.last('state')!.state.seq).toBe(seq); // sender is re-synced, others untouched
  });

  it('race: simultaneous Pause clicks collapse into one transition', () => {
    const room = mkRoom();
    const a = join(room, 'Ana'); const b = join(room, 'Ben');
    room.handle(a.id, { t: 'setMedia', mediaId: 'sintel' });
    room.handle(a.id, { t: 'play', pos: 0 });
    clock += 3000;
    room.handle(a.id, { t: 'pause', pos: 0 });
    const seq = room.state.seq; const pos = room.state.pos;
    clock += 5;
    room.handle(b.id, { t: 'pause', pos: 0 });
    expect(room.state.seq).toBe(seq);
    expect(room.state.pos).toBe(pos);
  });

  it('race: a pause aimed at the previous movie is rejected as stale', () => {
    const room = mkRoom();
    const a = join(room, 'Ana'); const b = join(room, 'Ben');
    room.handle(a.id, { t: 'setMedia', mediaId: 'sintel' });
    room.handle(a.id, { t: 'play', pos: 0 });
    const seenByBen = room.state.seq;
    room.handle(a.id, { t: 'setMedia', mediaId: 'big-buck-bunny' }); // swaps while Ben's click is in flight
    room.handle(a.id, { t: 'play', pos: 0 });
    room.handle(b.id, { t: 'pause', pos: 0, base: seenByBen });
    expect(room.state.status).toBe('playing');
    expect(room.state.mediaId).toBe('big-buck-bunny');
  });

  it('race: concurrent seeks resolve last-writer-wins, identically for everyone', () => {
    const room = mkRoom();
    const a = join(room, 'Ana'); const b = join(room, 'Ben');
    room.handle(a.id, { t: 'setMedia', mediaId: 'sintel' });
    room.handle(a.id, { t: 'seek', pos: 100 });
    room.handle(b.id, { t: 'seek', pos: 200 });
    expect(a.conn.last('state')!.state.pos).toBe(200);
    expect(b.conn.last('state')!.state.pos).toBe(200);
  });

  it('host-only mode blocks guests from controlling playback', () => {
    const room = mkRoom();
    const a = join(room, 'Ana'); const b = join(room, 'Ben');
    room.handle(a.id, { t: 'setMedia', mediaId: 'sintel' });
    room.handle(a.id, { t: 'settings', controls: 'host' });
    const seq = room.state.seq;
    room.handle(b.id, { t: 'play', pos: 0 });
    expect(room.state.seq).toBe(seq);
    expect(b.conn.last('error')!.code).toBe('forbidden');
  });

  it('cannot play with nothing selected', () => {
    const room = mkRoom();
    const a = join(room, 'Ana');
    room.handle(a.id, { t: 'play', pos: 0 });
    expect(a.conn.last('error')!.code).toBe('no_media');
  });
});

describe('buffering hold', () => {
  it('pauses everyone when someone stalls and resumes together when they recover', () => {
    const room = mkRoom();
    const a = join(room, 'Ana'); const b = join(room, 'Ben');
    room.handle(a.id, { t: 'setMedia', mediaId: 'sintel' });
    room.handle(a.id, { t: 'play', pos: 0 });
    clock += 3200;
    room.handle(b.id, { t: 'buffering', on: true });
    expect(room.state).toMatchObject({ status: 'paused', hold: true });
    expect(room.state.pos).toBeCloseTo(3, 1);
    clock += 1000;
    room.handle(b.id, { t: 'buffering', on: false });
    expect(room.state).toMatchObject({ status: 'playing', hold: false });
    expect(room.state.pos).toBeCloseTo(3, 1); // nobody lost their place
  });

  it('a stuck buffering member cannot hold the room hostage', () => {
    const room = mkRoom();
    const a = join(room, 'Ana'); const b = join(room, 'Ben');
    room.handle(a.id, { t: 'setMedia', mediaId: 'sintel' });
    room.handle(a.id, { t: 'play', pos: 0 });
    room.handle(b.id, { t: 'buffering', on: true });
    expect(room.state.hold).toBe(true);
    clock += 9000;
    room.tick();
    expect(room.state).toMatchObject({ status: 'playing', hold: false });
  });

  it('an explicit pause during a hold is never auto-resumed', () => {
    const room = mkRoom();
    const a = join(room, 'Ana'); const b = join(room, 'Ben');
    room.handle(a.id, { t: 'setMedia', mediaId: 'sintel' });
    room.handle(a.id, { t: 'play', pos: 0 });
    room.handle(b.id, { t: 'buffering', on: true });
    room.handle(a.id, { t: 'pause', pos: 0 });
    room.handle(b.id, { t: 'buffering', on: false });
    expect(room.state.status).toBe('paused');
  });
});

describe('queue, polls, chat', () => {
  it('auto-advances the queue exactly once even if every client reports the end', () => {
    const room = mkRoom();
    const a = join(room, 'Ana'); const b = join(room, 'Ben');
    room.handle(a.id, { t: 'setMedia', mediaId: 'for-bigger-fun' });
    room.handle(a.id, { t: 'queueAdd', mediaId: 'sintel' });
    room.handle(a.id, { t: 'queueAdd', mediaId: 'big-buck-bunny' });
    room.handle(a.id, { t: 'ended', mediaId: 'for-bigger-fun' });
    room.handle(b.id, { t: 'ended', mediaId: 'for-bigger-fun' });
    expect(room.state.mediaId).toBe('sintel');
    expect(room.state.status).toBe('playing');
    expect(room.snapshot().queue.map((q) => q.mediaId)).toEqual(['big-buck-bunny']);
  });

  it('when a title ends with an empty queue the room parks at the end, not at the last play/seek position', () => {
    const room = mkRoom();
    const a = join(room, 'Ana');
    room.handle(a.id, { t: 'setMedia', mediaId: 'for-bigger-fun' }); // 60 s
    room.handle(a.id, { t: 'play', pos: 0 });
    room.handle(a.id, { t: 'seek', pos: 10 });
    clock += 70_000; // played well past the end
    room.handle(a.id, { t: 'ended', mediaId: 'for-bigger-fun' });
    expect(room.state.status).toBe('paused');
    expect(room.state.pos).toBe(60); // clamped to the title length, never back at 10
  });

  it('polls: one changeable vote per member, closeable by creator/host only', () => {
    const room = mkRoom();
    const a = join(room, 'Ana'); const b = join(room, 'Ben'); const c = join(room, 'Cy');
    room.handle(b.id, { t: 'pollCreate', question: 'Next?', options: ['Sintel', 'Bunny'] });
    const poll = room.snapshot().polls[0]!;
    room.handle(a.id, { t: 'pollVote', pollId: poll.id, optionId: 'o1' });
    room.handle(a.id, { t: 'pollVote', pollId: poll.id, optionId: 'o2' });
    room.handle(c.id, { t: 'pollVote', pollId: poll.id, optionId: 'o2' });
    const p = room.snapshot().polls[0]!;
    expect(p.options[0]!.votes).toHaveLength(0);
    expect(p.options[1]!.votes).toHaveLength(2);
    room.handle(c.id, { t: 'pollClose', pollId: poll.id });
    expect(room.snapshot().polls[0]!.open).toBe(true);
    room.handle(a.id, { t: 'pollClose', pollId: poll.id }); // host
    expect(room.snapshot().polls[0]!.open).toBe(false);
  });

  it('rate-limits chat floods', () => {
    const room = mkRoom();
    const a = join(room, 'Ana');
    for (let i = 0; i < 20; i++) room.handle(a.id, { t: 'chat', text: `m${i}` });
    const userMsgs = room.snapshot().chat.filter((m) => !m.system);
    expect(userMsgs.length).toBe(6);
    expect(a.conn.last('error')!.code).toBe('rate_limited');
  });

  it('strips control characters from names and chat', () => {
    const room = mkRoom();
    const a = join(room, 'A\u0000n\u0007a');
    room.handle(a.id, { t: 'chat', text: 'hi\u0000 there' });
    expect(room.snapshot().members[0]!.name).toBe('Ana');
    expect(room.snapshot().chat.at(-1)!.text).toBe('hi there');
  });
});

describe('Moments, heatmap, reel (bonus)', () => {
  function playing() {
    const room = mkRoom();
    const a = join(room, 'Ana'); const b = join(room, 'Ben');
    room.handle(a.id, { t: 'setMedia', mediaId: 'sintel' });
    room.handle(a.id, { t: 'play', pos: 100 });
    clock += 200;
    return { room, a, b };
  }

  it('stamps the Moment with the server position, not a client claim', () => {
    const { room, a } = playing();
    clock += 5000;
    room.handle(a.id, { t: 'markerAdd', label: 'Dragon!' });
    expect(room.snapshot().markers[0]!.at).toBeCloseTo(105, 0);
  });

  it('consolidates Moments within 3 s into votes (pile-on)', () => {
    const { room, a, b } = playing();
    clock += 5000;
    room.handle(a.id, { t: 'markerAdd', label: 'Dragon!' });
    clock += 1500;
    room.handle(b.id, { t: 'markerAdd', label: 'omg' });
    const ms = room.snapshot().markers;
    expect(ms).toHaveLength(1);
    expect(ms[0]!.votes).toHaveLength(2);
  });

  it('votes toggle and only author/host can remove', () => {
    const { room, a, b } = playing();
    room.handle(a.id, { t: 'markerAdd', label: 'x' });
    const k = room.snapshot().markers[0]!;
    room.handle(b.id, { t: 'markerVote', markerId: k.id });
    expect(room.snapshot().markers[0]!.votes).toHaveLength(2);
    room.handle(b.id, { t: 'markerVote', markerId: k.id });
    expect(room.snapshot().markers[0]!.votes).toHaveLength(1);
    room.handle(b.id, { t: 'markerRemove', markerId: k.id });
    expect(room.snapshot().markers).toHaveLength(1);
    room.handle(a.id, { t: 'markerRemove', markerId: k.id });
    expect(room.snapshot().markers).toHaveLength(0);
  });

  it('buckets reactions by video time', () => {
    const { room, a, b } = playing();
    clock += 2000;
    room.handle(a.id, { t: 'react', emoji: '🔥' });
    room.handle(b.id, { t: 'react', emoji: '😮' });
    clock += 10_000;
    room.handle(a.id, { t: 'react', emoji: '🔥' });
    const heat = room.snapshot().heat;
    expect(heat).toEqual([{ t: 100, n: 2 }, { t: 110, n: 1 }]);
  });

  it('highlight reel plays top Moments in story order, then stops', () => {
    const { room, a, b } = playing();
    // Moments at ~101 (1 vote), ~160 (2 votes), ~300 (1 vote)
    clock += 1000; room.handle(a.id, { t: 'markerAdd', label: 'early' });
    room.handle(a.id, { t: 'seek', pos: 160 }); clock += 200;
    room.handle(a.id, { t: 'markerAdd', label: 'best' });
    room.handle(b.id, { t: 'markerAdd', label: 'best too' });
    room.handle(a.id, { t: 'seek', pos: 300 }); clock += 200;
    room.handle(a.id, { t: 'markerAdd', label: 'late' });

    room.handle(a.id, { t: 'reel', on: true });
    expect(room.snapshot().reel).toMatchObject({ active: true, idx: 0, total: 3 });
    expect(room.state.pos).toBeCloseTo(99, 0);

    clock += 11_000; room.tick();
    expect(room.state.pos).toBeCloseTo(158, 0);
    clock += 11_000; room.tick();
    expect(room.state.pos).toBeCloseTo(298, 0);
    clock += 11_000; room.tick();
    expect(room.snapshot().reel.active).toBe(false);
    expect(room.state.status).toBe('paused');
  });

  it('manual control cancels the reel', () => {
    const { room, a } = playing();
    room.handle(a.id, { t: 'markerAdd', label: 'x' });
    room.handle(a.id, { t: 'reel', on: true });
    room.handle(a.id, { t: 'pause', pos: 0 });
    expect(room.snapshot().reel.active).toBe(false);
  });
});
