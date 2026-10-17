/** Domain types shared by server, client and the benchmark. */

export interface MediaItem {
  id: string;
  title: string;
  year: number;
  categories: string[];
  /** Approximate length in seconds. A UI hint only; the real length comes from the <video> element. */
  durationSec: number;
  description: string;
  src: string;
  rating: number;
  /** CSS gradient used as a poster placeholder (keeps the catalog free of hot-linked images). */
  tint: [string, string];
}

/**
 * Authoritative playback state.
 *
 * The position at server time `T` is:
 *   paused  -> pos
 *   playing -> pos + max(0, T - anchor) / 1000
 *
 * `anchor` may lie in the *future* (scheduled start) so every client begins
 * playback at the same wall-clock instant regardless of message delay.
 */
export interface PlaybackState {
  /** Strictly increasing per room. Clients ignore any state with seq <= the one they hold. */
  seq: number;
  mediaId: string | null;
  status: 'playing' | 'paused';
  /** Media position (seconds) at `anchor`. */
  pos: number;
  /** Server epoch ms at which `pos` is true. */
  anchor: number;
  /** True while the server auto-paused the room because somebody is buffering. */
  hold: boolean;
  /** Member id that caused this transition (null = server). */
  by: string | null;
}

export interface Member {
  id: string;
  name: string;
  color: string;
  joinedAt: number;
  connected: boolean;
  buffering: boolean;
  isHost: boolean;
}

export interface ChatMessage {
  id: string;
  from: string | null;
  name: string;
  text: string;
  ts: number;
  /** Media position (seconds) of the sender when the message was written. Powers Spoiler Shield. */
  at: number;
  mediaId: string | null;
  system?: boolean;
}

export interface QueueItem {
  id: string;
  mediaId: string;
  addedBy: string;
}

export interface PollOption {
  id: string;
  label: string;
  votes: string[];
}

export interface Poll {
  id: string;
  question: string;
  options: PollOption[];
  createdBy: string;
  open: boolean;
  createdAt: number;
}

/** A "Moment": a timestamped bookmark the room can vote on. */
export interface Marker {
  id: string;
  mediaId: string;
  at: number;
  label: string;
  by: string;
  votes: string[];
}

export interface HeatBucket {
  /** Bucket start in seconds. */
  t: number;
  n: number;
}

export interface ReelState {
  active: boolean;
  idx: number;
  total: number;
}

export interface RoomSettings {
  controls: 'everyone' | 'host';
}

export interface RoomSnapshot {
  code: string;
  hostId: string | null;
  settings: RoomSettings;
  state: PlaybackState;
  members: Member[];
  chat: ChatMessage[];
  queue: QueueItem[];
  polls: Poll[];
  markers: Marker[];
  heat: HeatBucket[];
  reel: ReelState;
  serverNow: number;
}

/** Position (seconds) the room *should* be at, at the given server time. */
export function expectedPosition(state: PlaybackState, serverNow: number): number {
  if (state.status !== 'playing') return state.pos;
  return state.pos + Math.max(0, serverNow - state.anchor) / 1000;
}
