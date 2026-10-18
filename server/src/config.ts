import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

export interface Config {
  nodeEnv: string;
  port: number;
  host: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error' | 'silent';
  sessionSecret: string;
  corsOrigins: string[];
  trustProxy: boolean;
  maxConnPerIp: number;
  maxMembersPerRoom: number;
  maxRooms: number;
  reconnectGraceMs: number;
  roomEmptyTtlMs: number;
  playLeadMs: number;
  clientDist: string | null;
}

/** Load .env from cwd or its parent (monorepo root) without any dependency. Never overrides real env vars. */
export function loadDotEnv(): void {
  for (const p of ['.env', '../.env']) {
    try {
      process.loadEnvFile(resolve(process.cwd(), p));
      return;
    } catch {
      /* file missing: fine */
    }
  }
}

function int(name: string, def: number, min = 0): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) throw new Error(`Invalid ${name}="${raw}" (expected a number >= ${min})`);
  return n;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  const prod = nodeEnv === 'production';

  let secret = process.env.SESSION_SECRET ?? '';
  const isDummy = secret.startsWith('change-me') || secret.length < 32;
  if (prod && isDummy) {
    throw new Error('SESSION_SECRET must be set to a random string of >= 32 chars in production (openssl rand -base64 48).');
  }
  if (isDummy) secret = randomBytes(32).toString('base64url');

  const level = (process.env.LOG_LEVEL ?? 'info') as Config['logLevel'];

  const cfg: Config = {
    nodeEnv,
    port: int('PORT', 8080, 0),
    host: process.env.HOST ?? '0.0.0.0',
    logLevel: ['debug', 'info', 'warn', 'error', 'silent'].includes(level) ? level : 'info',
    sessionSecret: secret,
    corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:5173,http://localhost:8080,http://127.0.0.1:5173,http://127.0.0.1:8080')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    trustProxy: process.env.TRUST_PROXY === 'true',
    maxConnPerIp: int('MAX_CONN_PER_IP', 100, 1),
    maxMembersPerRoom: int('MAX_MEMBERS_PER_ROOM', 50, 1),
    maxRooms: int('MAX_ROOMS', 500, 1),
    reconnectGraceMs: int('RECONNECT_GRACE_MS', 15_000),
    roomEmptyTtlMs: int('ROOM_EMPTY_TTL_MS', 300_000),
    playLeadMs: int('PLAY_LEAD_MS', 200),
    clientDist: process.env.CLIENT_DIST ? resolve(process.env.CLIENT_DIST) : null,
  };
  return { ...cfg, ...overrides };
}
