import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, getMedia } from '@couchbeam/shared';
import type { Config } from './config';
import { Room, type RoomDeps } from './room';

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

const b64 = (b: Buffer | string): string => Buffer.from(b).toString('base64url');

/** Signed, expiring reconnect token: base64url(memberId.code.exp).hmac */
export function signResume(secret: string, memberId: string, code: string, now: number): string {
  const payload = b64(`${memberId}.${code}.${now + TOKEN_TTL_MS}`);
  const sig = b64(createHmac('sha256', secret).update(payload).digest());
  return `${payload}.${sig}`;
}

export function verifyResume(secret: string, token: string, code: string, now: number): string | null {
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = createHmac('sha256', secret).update(payload).digest();
  let given: Buffer;
  try {
    given = Buffer.from(sig, 'base64url');
  } catch {
    return null;
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const [memberId, tokenCode, exp] = Buffer.from(payload, 'base64url').toString().split('.');
  if (!memberId || tokenCode !== code || Number(exp) < now) return null;
  return memberId;
}

export class RoomManager {
  readonly rooms = new Map<string, Room>();
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly cfg: Pick<Config, 'sessionSecret' | 'maxRooms' | 'maxMembersPerRoom' | 'reconnectGraceMs' | 'playLeadMs' | 'roomEmptyTtlMs'>,
    private readonly now: () => number = Date.now,
  ) {}

  private deps(): RoomDeps {
    return {
      now: this.now,
      getMedia,
      sign: (id, code) => signResume(this.cfg.sessionSecret, id, code, this.now()),
      verify: (token, code) => verifyResume(this.cfg.sessionSecret, token, code, this.now()),
      maxMembers: this.cfg.maxMembersPerRoom,
      graceMs: this.cfg.reconnectGraceMs,
      playLeadMs: this.cfg.playLeadMs,
      emptyTtlMs: this.cfg.roomEmptyTtlMs,
    };
  }

  /** 6 chars from a 32-symbol alphabet (no I/O/0/1): 32^6 ≈ 1.07e9 codes, drawn with a CSPRNG. */
  private newCode(): string {
    for (let attempt = 0; attempt < 20; attempt++) {
      let code = '';
      for (let i = 0; i < ROOM_CODE_LENGTH; i++) code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
      if (!this.rooms.has(code)) return code;
    }
    throw new Error('could not allocate a room code');
  }

  create(): Room | null {
    if (this.rooms.size >= this.cfg.maxRooms) return null;
    const room = new Room(this.newCode(), this.deps());
    this.rooms.set(room.code, room);
    return room;
  }

  get(code: string): Room | undefined {
    return this.rooms.get(code);
  }

  tick(): void {
    const now = this.now();
    for (const room of this.rooms.values()) room.tick(now);
  }

  sweep(): void {
    const now = this.now();
    for (const [code, room] of this.rooms) if (room.sweep(now)) this.rooms.delete(code);
  }

  connectionCount(): number {
    let n = 0;
    for (const r of this.rooms.values()) n += r.connectedCount;
    return n;
  }

  start(): void {
    this.timers.push(setInterval(() => this.tick(), 250), setInterval(() => this.sweep(), 1000));
    for (const t of this.timers) t.unref();
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }
}
