import { z } from 'zod';
import type {
  ChatMessage,
  HeatBucket,
  Marker,
  Member,
  PlaybackState,
  Poll,
  QueueItem,
  ReelState,
  RoomSettings,
  RoomSnapshot,
} from './types';

export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0, 1
export const ROOM_CODE_LENGTH = 6;
export const ROOM_CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;

export const REACTION_EMOJI = ['🔥', '😂', '😮', '😢', '❤️', '👏', '🍿', '💀'] as const;

export const LIMITS = {
  name: 24,
  chat: 500,
  label: 60,
  pollOptionsMin: 2,
  pollOptionsMax: 6,
  queue: 50,
  markersPerMedia: 50,
  polls: 20,
  chatHistory: 100,
  heatBucketSec: 5,
} as const;

const name = z.string().trim().min(1).max(LIMITS.name);
const pos = z.number().finite().min(0).max(100_000);
const id = z.string().min(1).max(64);
const cid = z.string().max(64).optional();
const base = z.number().int().optional();

/** Every message a client may send. Anything else is rejected before it touches room state. */
export const ClientMsgSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('create'), name }),
  z.object({
    t: z.literal('join'),
    code: z.string().trim().toUpperCase().regex(ROOM_CODE_RE),
    name,
    resume: z.string().max(400).optional(),
  }),
  z.object({ t: z.literal('leave') }),
  z.object({ t: z.literal('ping'), c0: z.number().finite() }),

  z.object({ t: z.literal('play'), pos, base, cid }),
  z.object({ t: z.literal('pause'), pos, base, cid }),
  z.object({ t: z.literal('seek'), pos, base, cid }),
  z.object({ t: z.literal('setMedia'), mediaId: id }),
  z.object({ t: z.literal('buffering'), on: z.boolean() }),
  z.object({ t: z.literal('ended'), mediaId: id }),
  z.object({ t: z.literal('drift'), driftMs: z.number().finite().min(-3_600_000).max(3_600_000), rttMs: z.number().finite().min(0).max(60_000) }),

  z.object({ t: z.literal('chat'), text: z.string().trim().min(1).max(LIMITS.chat), at: pos.optional() }),
  z.object({ t: z.literal('react'), emoji: z.enum(REACTION_EMOJI) }),

  z.object({ t: z.literal('queueAdd'), mediaId: id }),
  z.object({ t: z.literal('queueRemove'), itemId: id }),
  z.object({ t: z.literal('queueMove'), itemId: id, dir: z.enum(['up', 'down']) }),
  z.object({ t: z.literal('playNext') }),

  z.object({
    t: z.literal('pollCreate'),
    question: z.string().trim().min(1).max(120),
    options: z.array(z.string().trim().min(1).max(LIMITS.label)).min(LIMITS.pollOptionsMin).max(LIMITS.pollOptionsMax),
  }),
  z.object({ t: z.literal('pollVote'), pollId: id, optionId: id }),
  z.object({ t: z.literal('pollClose'), pollId: id }),

  z.object({ t: z.literal('transferHost'), to: id }),
  z.object({ t: z.literal('settings'), controls: z.enum(['everyone', 'host']) }),

  z.object({ t: z.literal('markerAdd'), label: z.string().trim().min(1).max(LIMITS.label) }),
  z.object({ t: z.literal('markerVote'), markerId: id }),
  z.object({ t: z.literal('markerRemove'), markerId: id }),
  z.object({ t: z.literal('reel'), on: z.boolean() }),
]);

export type ClientMsg = z.infer<typeof ClientMsgSchema>;

export interface HealthEntry {
  id: string;
  driftMs: number;
  rttMs: number;
}

export type ServerMsg =
  | { t: 'joined'; you: string; resume: string; snapshot: RoomSnapshot }
  | { t: 'pong'; c0: number; s: number }
  | { t: 'state'; state: PlaybackState; cid?: string; s: number }
  | { t: 'members'; members: Member[]; hostId: string | null }
  | { t: 'settings'; settings: RoomSettings }
  | { t: 'chat'; msg: ChatMessage }
  | { t: 'react'; emoji: string; from: string; name: string; at: number }
  | { t: 'queue'; queue: QueueItem[] }
  | { t: 'polls'; polls: Poll[] }
  | { t: 'markers'; markers: Marker[] }
  | { t: 'heat'; mediaId: string | null; buckets: HeatBucket[] }
  | { t: 'reel'; reel: ReelState }
  | { t: 'health'; maxAbsDriftMs: number; members: HealthEntry[] }
  | { t: 'error'; code: string; message: string };
