// src/config.ts
import { randomBytes } from "crypto";
import { resolve } from "path";
function loadDotEnv() {
  for (const p of [".env", "../.env"]) {
    try {
      process.loadEnvFile(resolve(process.cwd(), p));
      return;
    } catch {
    }
  }
}
function int(name2, def, min = 0) {
  const raw = process.env[name2];
  if (raw === void 0 || raw === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) throw new Error(`Invalid ${name2}="${raw}" (expected a number >= ${min})`);
  return n;
}
function loadConfig(overrides = {}) {
  const nodeEnv = process.env.NODE_ENV ?? "development";
  const prod = nodeEnv === "production";
  let secret = process.env.SESSION_SECRET ?? "";
  const isDummy = secret.startsWith("change-me") || secret.length < 32;
  if (prod && isDummy) {
    throw new Error("SESSION_SECRET must be set to a random string of >= 32 chars in production (openssl rand -base64 48).");
  }
  if (isDummy) secret = randomBytes(32).toString("base64url");
  const level = process.env.LOG_LEVEL ?? "info";
  const cfg = {
    nodeEnv,
    port: int("PORT", 8080, 0),
    host: process.env.HOST ?? "0.0.0.0",
    logLevel: ["debug", "info", "warn", "error", "silent"].includes(level) ? level : "info",
    sessionSecret: secret,
    corsOrigins: (process.env.CORS_ORIGINS ?? "http://localhost:5173,http://localhost:8080,http://127.0.0.1:5173,http://127.0.0.1:8080").split(",").map((s) => s.trim()).filter(Boolean),
    trustProxy: process.env.TRUST_PROXY === "true",
    maxConnPerIp: int("MAX_CONN_PER_IP", 100, 1),
    maxMembersPerRoom: int("MAX_MEMBERS_PER_ROOM", 50, 1),
    maxRooms: int("MAX_ROOMS", 500, 1),
    reconnectGraceMs: int("RECONNECT_GRACE_MS", 15e3),
    roomEmptyTtlMs: int("ROOM_EMPTY_TTL_MS", 3e5),
    playLeadMs: int("PLAY_LEAD_MS", 200),
    clientDist: process.env.CLIENT_DIST ? resolve(process.env.CLIENT_DIST) : null
  };
  return { ...cfg, ...overrides };
}

// src/server.ts
import { createServer } from "http";
import { existsSync, createReadStream, statSync } from "fs";
import { extname, join, normalize as normalize2, resolve as resolve2, sep } from "path";
import { WebSocketServer, WebSocket } from "ws";

// ../shared/src/types.ts
function expectedPosition(state, serverNow) {
  if (state.status !== "playing") return state.pos;
  return state.pos + Math.max(0, serverNow - state.anchor) / 1e3;
}

// ../shared/src/protocol.ts
import { z } from "zod";
var ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
var ROOM_CODE_LENGTH = 6;
var ROOM_CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;
var REACTION_EMOJI = ["\u{1F525}", "\u{1F602}", "\u{1F62E}", "\u{1F622}", "\u2764\uFE0F", "\u{1F44F}", "\u{1F37F}", "\u{1F480}"];
var LIMITS = {
  name: 24,
  chat: 500,
  label: 60,
  pollOptionsMin: 2,
  pollOptionsMax: 6,
  queue: 50,
  markersPerMedia: 50,
  polls: 20,
  chatHistory: 100,
  heatBucketSec: 5
};
var name = z.string().trim().min(1).max(LIMITS.name);
var pos = z.number().finite().min(0).max(1e5);
var id = z.string().min(1).max(64);
var cid = z.string().max(64).optional();
var base = z.number().int().optional();
var ClientMsgSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("create"), name }),
  z.object({
    t: z.literal("join"),
    code: z.string().trim().toUpperCase().regex(ROOM_CODE_RE),
    name,
    resume: z.string().max(400).optional()
  }),
  z.object({ t: z.literal("leave") }),
  z.object({ t: z.literal("ping"), c0: z.number().finite() }),
  z.object({ t: z.literal("play"), pos, base, cid }),
  z.object({ t: z.literal("pause"), pos, base, cid }),
  z.object({ t: z.literal("seek"), pos, base, cid }),
  z.object({ t: z.literal("setMedia"), mediaId: id }),
  z.object({ t: z.literal("buffering"), on: z.boolean() }),
  z.object({ t: z.literal("ended"), mediaId: id }),
  z.object({ t: z.literal("drift"), driftMs: z.number().finite().min(-36e5).max(36e5), rttMs: z.number().finite().min(0).max(6e4) }),
  z.object({ t: z.literal("chat"), text: z.string().trim().min(1).max(LIMITS.chat), at: pos.optional() }),
  z.object({ t: z.literal("react"), emoji: z.enum(REACTION_EMOJI) }),
  z.object({ t: z.literal("queueAdd"), mediaId: id }),
  z.object({ t: z.literal("queueRemove"), itemId: id }),
  z.object({ t: z.literal("queueMove"), itemId: id, dir: z.enum(["up", "down"]) }),
  z.object({ t: z.literal("playNext") }),
  z.object({
    t: z.literal("pollCreate"),
    question: z.string().trim().min(1).max(120),
    options: z.array(z.string().trim().min(1).max(LIMITS.label)).min(LIMITS.pollOptionsMin).max(LIMITS.pollOptionsMax)
  }),
  z.object({ t: z.literal("pollVote"), pollId: id, optionId: id }),
  z.object({ t: z.literal("pollClose"), pollId: id }),
  z.object({ t: z.literal("transferHost"), to: id }),
  z.object({ t: z.literal("settings"), controls: z.enum(["everyone", "host"]) }),
  z.object({ t: z.literal("markerAdd"), label: z.string().trim().min(1).max(LIMITS.label) }),
  z.object({ t: z.literal("markerVote"), markerId: id }),
  z.object({ t: z.literal("markerRemove"), markerId: id }),
  z.object({ t: z.literal("reel"), on: z.boolean() })
]);

// ../shared/src/fuzzy.ts
function normalize(s) {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[b.length];
}
function isSubsequence(q, t) {
  let i = 0;
  for (let j = 0; j < t.length && i < q.length; j++) if (q[i] === t[j]) i++;
  return i === q.length;
}
function tokenScore(q, t) {
  if (t.startsWith(q)) return 1;
  if (t.includes(q)) return 0.8;
  const cand = Math.min(t.length, q.length + 1);
  const dist = Math.min(levenshtein(q, t), levenshtein(q, t.slice(0, cand)));
  const sim = 1 - dist / Math.max(q.length, cand);
  if (q.length >= 3 && sim >= 0.6) return 0.7 * sim;
  if (q.length >= 3 && isSubsequence(q, t)) return 0.4;
  return 0;
}
function fuzzyScore(query, text) {
  const q = normalize(query);
  if (!q) return 1;
  const qTokens = q.split(" ");
  const tTokens = normalize(text).split(" ").filter(Boolean);
  if (!tTokens.length) return 0;
  let total = 0;
  let missed = false;
  for (const qt of qTokens) {
    let best = 0;
    for (const tt of tTokens) best = Math.max(best, tokenScore(qt, tt));
    if (best === 0) missed = true;
    total += best;
  }
  const mean = total / qTokens.length;
  return missed ? mean * 0.5 : mean;
}
function fuzzySearch(items, query, textOf, threshold = 0.3) {
  if (!normalize(query)) return [...items];
  return items.map((item) => ({ item, score: fuzzyScore(query, textOf(item)) })).filter((x) => x.score >= threshold).sort((a, b) => b.score - a.score).map((x) => x.item);
}

// ../shared/src/catalog.ts
var G = "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample";
var CATALOG = [
  // Offline demo clips: served from this project (client/public/media), so they play with no internet access.
  // The on-screen timer makes it easy to SEE that every viewer is on the same frame.
  {
    id: "demo-sync-60",
    title: "Sync Test Card (60 s)",
    year: 2026,
    categories: ["Demo", "Short"],
    durationSec: 60,
    description: "Offline test card with a running timer. Plays with no internet, ideal for showing sync.",
    src: "/media/demo-sync-60.webm",
    rating: 8,
    tint: ["#1f6f8b", "#f2b441"]
  },
  {
    id: "demo-sync-30",
    title: "Sync Test Card (30 s)",
    year: 2026,
    categories: ["Demo", "Short"],
    durationSec: 30,
    description: "A 30 second offline test card with a running timer.",
    src: "/media/demo-sync-30.webm",
    rating: 7.9,
    tint: ["#6a3d9a", "#f2b441"]
  },
  {
    id: "demo-sync-15",
    title: "Sync Test Card (15 s)",
    year: 2026,
    categories: ["Demo", "Short"],
    durationSec: 15,
    description: "A 15 second offline test card. Great for showing a video ending and the queue advancing.",
    src: "/media/demo-sync-15.webm",
    rating: 7.8,
    tint: ["#3b7d3a", "#f2b441"]
  },
  {
    id: "big-buck-bunny",
    title: "Big Buck Bunny",
    year: 2008,
    categories: ["Animation", "Comedy", "Family"],
    durationSec: 596,
    description: "A gentle giant rabbit gets even with three bullying rodents.",
    src: `${G}/BigBuckBunny.mp4`,
    rating: 7.2,
    tint: ["#3b7d3a", "#d9b44a"]
  },
  {
    id: "sintel",
    title: "Sintel",
    year: 2010,
    categories: ["Animation", "Fantasy", "Adventure"],
    durationSec: 888,
    description: "A lone warrior searches the world for the baby dragon she lost.",
    src: `${G}/Sintel.mp4`,
    rating: 7.5,
    tint: ["#5a2d6d", "#e0743a"]
  },
  {
    id: "tears-of-steel",
    title: "Tears of Steel",
    year: 2012,
    categories: ["Sci-Fi", "Action"],
    durationSec: 734,
    description: "Fighters try to save the world from killer robots in a ruined Amsterdam.",
    src: `${G}/TearsOfSteel.mp4`,
    rating: 6.4,
    tint: ["#17324d", "#4aa3c9"]
  },
  {
    id: "elephants-dream",
    title: "Elephant's Dream",
    year: 2006,
    categories: ["Animation", "Sci-Fi", "Surreal"],
    durationSec: 653,
    description: "Two strangers wander an impossible machine that reality forgot.",
    src: `${G}/ElephantsDream.mp4`,
    rating: 6.1,
    tint: ["#6b2c2c", "#c9a14a"]
  },
  {
    id: "for-bigger-blazes",
    title: "For Bigger Blazes",
    year: 2013,
    categories: ["Short", "Action"],
    durationSec: 15,
    description: "A fifteen-second burst of heat. Perfect for testing seeks.",
    src: `${G}/ForBiggerBlazes.mp4`,
    rating: 5,
    tint: ["#7a1f10", "#f2a33a"]
  },
  {
    id: "for-bigger-escapes",
    title: "For Bigger Escapes",
    year: 2013,
    categories: ["Short", "Adventure"],
    durationSec: 15,
    description: "A quick getaway in fifteen seconds flat.",
    src: `${G}/ForBiggerEscapes.mp4`,
    rating: 5.1,
    tint: ["#1c4a5a", "#e8d5a2"]
  },
  {
    id: "for-bigger-fun",
    title: "For Bigger Fun",
    year: 2013,
    categories: ["Short", "Comedy"],
    durationSec: 60,
    description: "One minute of pure play.",
    src: `${G}/ForBiggerFun.mp4`,
    rating: 5.3,
    tint: ["#b0306a", "#f5c24a"]
  },
  {
    id: "for-bigger-joyrides",
    title: "For Bigger Joyrides",
    year: 2013,
    categories: ["Short", "Adventure"],
    durationSec: 15,
    description: "Wind, road and a very short trip.",
    src: `${G}/ForBiggerJoyrides.mp4`,
    rating: 5.2,
    tint: ["#2a5d8a", "#f0e08a"]
  },
  {
    id: "for-bigger-meltdowns",
    title: "For Bigger Meltdowns",
    year: 2013,
    categories: ["Short", "Comedy"],
    durationSec: 15,
    description: "Everything goes wrong, quickly.",
    src: `${G}/ForBiggerMeltdowns.mp4`,
    rating: 4.9,
    tint: ["#4a2a6a", "#d96a6a"]
  },
  {
    id: "subaru-outback",
    title: "Subaru Outback: Street & Dirt",
    year: 2012,
    categories: ["Lifestyle", "Cars"],
    durationSec: 594,
    description: "An all-wheel-drive wagon takes on tarmac and trail.",
    src: `${G}/SubaruOutbackOnStreetAndDirt.mp4`,
    rating: 5.8,
    tint: ["#2f4a2a", "#c8b27a"]
  },
  {
    id: "vw-gti-review",
    title: "Volkswagen GTI Review",
    year: 2012,
    categories: ["Lifestyle", "Cars"],
    durationSec: 584,
    description: "A hot-hatch road test, start to finish.",
    src: `${G}/VolkswagenGTIReview.mp4`,
    rating: 5.9,
    tint: ["#222a38", "#b23a3a"]
  },
  {
    id: "bullrun",
    title: "We Are Going on Bullrun",
    year: 2012,
    categories: ["Lifestyle", "Adventure", "Cars"],
    durationSec: 47,
    description: "A rally convoy rolls out. Short and loud.",
    src: `${G}/WeAreGoingOnBullrun.mp4`,
    rating: 5.4,
    tint: ["#5a3a12", "#e6c35a"]
  },
  {
    id: "what-car-for-a-grand",
    title: "What Car Can You Get for a Grand?",
    year: 2012,
    categories: ["Lifestyle", "Comedy", "Cars"],
    durationSec: 44,
    description: "A budget challenge in under a minute.",
    src: `${G}/WhatCarCanYouGetForAGrand.mp4`,
    rating: 5.2,
    tint: ["#3a3a3a", "#9ac26a"]
  }
];
var CATEGORIES = [...new Set(CATALOG.flatMap((m) => m.categories))].sort();
var BY_ID = new Map(CATALOG.map((m) => [m.id, m]));
function getMedia(id2) {
  return BY_ID.get(id2);
}

// src/logger.ts
var ORDER = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
function createLogger(level) {
  const min = ORDER[level];
  const emit = (lvl) => (msg, extra) => {
    if (ORDER[lvl] < min) return;
    const line = JSON.stringify({ t: (/* @__PURE__ */ new Date()).toISOString(), level: lvl, msg, ...extra ? { extra } : {} });
    (lvl === "error" || lvl === "warn" ? console.error : console.log)(line);
  };
  return { debug: emit("debug"), info: emit("info"), warn: emit("warn"), error: emit("error") };
}

// src/manager.ts
import { createHmac, randomInt, timingSafeEqual } from "crypto";

// src/room.ts
import { randomBytes as randomBytes2 } from "crypto";
var PALETTE = ["#f2b441", "#5ec2b7", "#e86f68", "#8f9cf2", "#b6d86a", "#e58bd0", "#6fb7ee", "#f08a4b", "#a58be8", "#7bd6a0", "#e8c96a", "#d0827a"];
var DEDUPE_SEC = 0.4;
var MAX_HOLD_MS = 8e3;
var REEL_CLIP_SEC = 8;
var REEL_PREROLL_SEC = 2;
var REEL_MAX_CLIPS = 8;
var newId = (bytes = 6) => randomBytes2(bytes).toString("base64url");
var clean = (s, max) => (
  // eslint-disable-next-line no-control-regex
  s.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max)
);
var Room = class {
  constructor(code, deps) {
    this.code = code;
    this.deps = deps;
    this.createdAt = deps.now();
    this.lastActive = this.createdAt;
    this.state = { seq: 0, mediaId: null, status: "paused", pos: 0, anchor: this.createdAt, hold: false, by: null };
  }
  code;
  deps;
  createdAt;
  lastActive;
  state;
  settings = { controls: "everyone" };
  hostId = null;
  members = /* @__PURE__ */ new Map();
  chat = [];
  queue = [];
  polls = [];
  markers = [];
  heat = /* @__PURE__ */ new Map();
  heatDirty = false;
  reel = { active: false, idx: 0, total: 0, clips: [], nextAt: 0 };
  lastHealthAt = 0;
  lastHeatAt = 0;
  mediaSeq = 0;
  endedKey = "";
  colorIdx = 0;
  emptySince = null;
  // ───────────────────────── introspection ─────────────────────────
  get memberCount() {
    return this.members.size;
  }
  get connectedCount() {
    let n = 0;
    for (const m of this.members.values()) if (m.conn) n++;
    return n;
  }
  expectedPos(now = this.deps.now()) {
    return expectedPosition(this.state, now);
  }
  publicMembers() {
    return [...this.members.values()].sort((a, b) => a.joinedAt - b.joinedAt).map((m) => ({
      id: m.id,
      name: m.name,
      color: m.color,
      joinedAt: m.joinedAt,
      connected: m.conn !== null,
      buffering: m.buffering,
      isHost: m.id === this.hostId
    }));
  }
  snapshot() {
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
      serverNow: this.deps.now()
    };
  }
  // ───────────────────────── membership ─────────────────────────
  join(conn, rawName, resume) {
    const now = this.deps.now();
    this.lastActive = now;
    this.emptySince = null;
    const resumedId = resume ? this.deps.verify(resume, this.code) : null;
    const existing = resumedId ? this.members.get(resumedId) : void 0;
    if (existing) {
      const old = existing.conn;
      existing.conn = conn;
      existing.disconnectedAt = null;
      if (old && old !== conn) old.close(4e3, "replaced by newer connection");
      this.sendJoined(existing);
      this.broadcastMembers();
      return { memberId: existing.id };
    }
    if (this.members.size >= this.deps.maxMembers) {
      return { error: "room_full", message: `This room is full (${this.deps.maxMembers} people).` };
    }
    const m = {
      id: newId(),
      name: clean(rawName, LIMITS.name) || "Guest",
      color: PALETTE[this.colorIdx++ % PALETTE.length],
      joinedAt: now,
      conn,
      disconnectedAt: null,
      buffering: false,
      bufferingSince: 0,
      driftMs: null,
      rttMs: null,
      windows: /* @__PURE__ */ new Map()
    };
    this.members.set(m.id, m);
    if (!this.hostId) this.hostId = m.id;
    this.sendJoined(m);
    this.broadcastMembers();
    this.system(`${m.name} joined`);
    return { memberId: m.id };
  }
  sendJoined(m) {
    m.conn?.send({ t: "joined", you: m.id, resume: this.deps.sign(m.id, this.code), snapshot: this.snapshot() });
  }
  /** Socket closed. Seat is kept for the grace period so refreshes and Wi-Fi blips are invisible. */
  detach(memberId, conn) {
    const m = this.members.get(memberId);
    if (!m || m.conn !== conn) return;
    m.conn = null;
    m.disconnectedAt = this.deps.now();
    m.buffering = false;
    this.broadcastMembers();
    if (this.connectedCount === 0) this.freeze();
    else this.evalHold();
  }
  leave(memberId) {
    this.removeMember(memberId, true);
  }
  removeMember(id2, announce) {
    const m = this.members.get(id2);
    if (!m) return;
    this.members.delete(id2);
    m.conn = null;
    if (announce) this.system(`${m.name} left`);
    if (this.hostId === id2) this.electHost();
    if (this.members.size === 0) this.emptySince = this.deps.now();
    this.broadcastMembers();
    this.evalHold();
  }
  /** Oldest connected member inherits the room. */
  electHost() {
    const all = [...this.members.values()].sort((a, b) => a.joinedAt - b.joinedAt);
    const next = all.find((x) => x.conn) ?? all[0] ?? null;
    this.hostId = next?.id ?? null;
    if (next) this.system(`${next.name} is now the host`);
  }
  /** Nobody is connected: stop the clock so the room resumes where it was left. */
  freeze() {
    if (this.state.status === "playing") {
      this.state = { ...this.state, seq: this.state.seq + 1, status: "paused", pos: this.expectedPos(), anchor: this.deps.now(), hold: false, by: null };
    }
    this.stopReel(false);
  }
  // ───────────────────────── message dispatch ─────────────────────────
  handle(memberId, msg) {
    const m = this.members.get(memberId);
    if (!m) return;
    this.lastActive = this.deps.now();
    switch (msg.t) {
      case "play":
        return this.doPlay(m, msg.pos, msg.base, msg.cid);
      case "pause":
        return this.doPause(m, msg.base, msg.cid);
      case "seek":
        return this.doSeek(m, msg.pos, msg.base, msg.cid);
      case "setMedia":
        return this.doSetMedia(m, msg.mediaId);
      case "buffering":
        return this.doBuffering(m, msg.on);
      case "ended":
        return this.doEnded(m, msg.mediaId);
      case "drift":
        m.driftMs = msg.driftMs;
        m.rttMs = msg.rttMs;
        return;
      case "chat":
        return this.doChat(m, msg.text, msg.at);
      case "react":
        return this.doReact(m, msg.emoji);
      case "queueAdd":
        return this.doQueueAdd(m, msg.mediaId);
      case "queueRemove":
        return this.doQueueRemove(m, msg.itemId);
      case "queueMove":
        return this.doQueueMove(m, msg.itemId, msg.dir);
      case "playNext":
        if (!this.need(m)) return;
        if (!this.advance(m.id)) this.error(m, "queue_empty", "The queue is empty.");
        return;
      case "pollCreate":
        return this.doPollCreate(m, msg.question, msg.options);
      case "pollVote":
        return this.doPollVote(m, msg.pollId, msg.optionId);
      case "pollClose":
        return this.doPollClose(m, msg.pollId);
      case "transferHost":
        return this.doTransfer(m, msg.to);
      case "settings":
        if (m.id !== this.hostId) return this.error(m, "forbidden", "Only the host can change room settings.");
        this.settings = { controls: msg.controls };
        this.broadcast({ t: "settings", settings: this.settings });
        return;
      case "markerAdd":
        return this.doMarkerAdd(m, msg.label);
      case "markerVote":
        return this.doMarkerVote(m, msg.markerId);
      case "markerRemove":
        return this.doMarkerRemove(m, msg.markerId);
      case "reel":
        if (msg.on) return this.startReel(m);
        if (this.need(m)) this.stopReel(true);
        return;
      default:
        return;
    }
  }
  // ───────────────────────── playback ─────────────────────────
  canControl(m) {
    return this.settings.controls === "everyone" || m.id === this.hostId;
  }
  need(m) {
    if (this.canControl(m)) return true;
    this.error(m, "forbidden", "Only the host can control playback in this room.");
    return false;
  }
  /** Apply a state transition. Every transition bumps `seq`; clients drop anything older than what they hold. */
  commit(patch, by, cid2) {
    this.state = { ...this.state, ...patch, seq: this.state.seq + 1, by };
    this.broadcast({ t: "state", state: this.state, cid: cid2, s: this.deps.now() });
  }
  /**
   * Race guard #1: a command stamped with a `base` older than the last media change was issued against
   * a different video (somebody swapped movies while the click was in flight). Reject and resync the sender.
   */
  stale(m, base2, cid2) {
    if (base2 === void 0 || base2 >= this.mediaSeq) return false;
    m.conn?.send({ t: "state", state: this.state, cid: cid2, s: this.deps.now() });
    return true;
  }
  doPlay(m, pos2, base2, cid2) {
    if (!this.need(m) || this.stale(m, base2, cid2)) return;
    if (!this.state.mediaId) return this.error(m, "no_media", "Pick something to watch first.");
    this.stopReel(true);
    const now = this.deps.now();
    if (this.state.status === "playing" && !this.state.hold && Math.abs(pos2 - this.expectedPos(now)) < DEDUPE_SEC) {
      m.conn?.send({ t: "state", state: this.state, cid: cid2, s: now });
      return;
    }
    const target = this.state.status === "paused" && Math.abs(pos2 - this.state.pos) < DEDUPE_SEC ? this.state.pos : pos2;
    this.commit({ status: "playing", hold: false, pos: target, anchor: now + this.deps.playLeadMs }, m.id, cid2);
  }
  doPause(m, base2, cid2) {
    if (!this.need(m) || this.stale(m, base2, cid2)) return;
    this.stopReel(true);
    const now = this.deps.now();
    if (this.state.status === "paused" && !this.state.hold) {
      m.conn?.send({ t: "state", state: this.state, cid: cid2, s: now });
      return;
    }
    this.commit({ status: "paused", hold: false, pos: this.expectedPos(now), anchor: now }, m.id, cid2);
  }
  doSeek(m, pos2, base2, cid2) {
    if (!this.need(m) || this.stale(m, base2, cid2)) return;
    if (!this.state.mediaId) return;
    this.stopReel(true);
    const now = this.deps.now();
    const running = this.state.status === "playing" && !this.state.hold;
    this.commit({ pos: pos2, anchor: running ? now + this.deps.playLeadMs : now }, m.id, cid2);
  }
  doSetMedia(m, mediaId, autoplay = false) {
    if (!this.need(m)) return;
    this.applyMedia(mediaId, m.id, autoplay);
  }
  applyMedia(mediaId, by, autoplay) {
    const media = this.deps.getMedia(mediaId);
    if (!media) {
      if (by) this.members.get(by)?.conn?.send({ t: "error", code: "unknown_media", message: "That title is not in the catalog." });
      return false;
    }
    this.stopReel(false);
    const now = this.deps.now();
    this.commit(
      { mediaId, status: autoplay ? "playing" : "paused", pos: 0, anchor: autoplay ? now + this.deps.playLeadMs : now, hold: false },
      by
    );
    this.mediaSeq = this.state.seq;
    this.endedKey = "";
    this.system(`Now showing: ${media.title}`);
    this.broadcast({ t: "markers", markers: this.markersForCurrent() });
    this.broadcast({ t: "heat", mediaId, buckets: this.heatBuckets(mediaId) });
    return true;
  }
  /** Move to the next queue item (autoplay). Returns false when the queue is empty. */
  advance(by) {
    const next = this.queue.shift();
    if (!next) return false;
    this.broadcast({ t: "queue", queue: this.queue });
    return this.applyMedia(next.mediaId, by, true);
  }
  doEnded(m, mediaId) {
    if (this.state.mediaId !== mediaId || !this.canControl(m)) return;
    const key = `${mediaId}#${this.mediaSeq}`;
    if (this.endedKey === key) return;
    this.endedKey = key;
    if (!this.advance(null)) {
      const length = this.deps.getMedia(mediaId)?.durationSec ?? Infinity;
      const endPos = Math.min(this.expectedPos(), length);
      this.commit({ status: "paused", hold: false, pos: endPos, anchor: this.deps.now() }, null);
    }
  }
  // ───────────────────────── buffering hold ─────────────────────────
  doBuffering(m, on) {
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
  evalHold() {
    const now = this.deps.now();
    let blocking = 0;
    for (const m of this.members.values()) {
      if (m.conn && m.buffering && now - m.bufferingSince < MAX_HOLD_MS) blocking++;
    }
    if (blocking > 0 && this.state.status === "playing" && !this.state.hold) {
      this.commit({ status: "paused", hold: true, pos: this.expectedPos(now), anchor: now }, null);
    } else if (blocking === 0 && this.state.hold) {
      this.commit({ status: "playing", hold: false, anchor: now + this.deps.playLeadMs }, null);
    }
  }
  // ───────────────────────── chat & reactions ─────────────────────────
  allow(m, kind, max, perMs) {
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
  doChat(m, text, at) {
    if (!this.allow(m, "chat", 6, 5e3)) return this.error(m, "rate_limited", "Slow down a little.");
    const msg = {
      id: newId(),
      from: m.id,
      name: m.name,
      text: clean(text, LIMITS.chat),
      ts: this.deps.now(),
      at: at ?? this.expectedPos(),
      mediaId: this.state.mediaId
    };
    if (!msg.text) return;
    this.pushChat(msg);
  }
  system(text) {
    this.pushChat({ id: newId(), from: null, name: "Couchbeam", text, ts: this.deps.now(), at: this.expectedPos(), mediaId: this.state.mediaId, system: true });
  }
  pushChat(msg) {
    this.chat.push(msg);
    if (this.chat.length > LIMITS.chatHistory) this.chat.shift();
    this.broadcast({ t: "chat", msg });
  }
  doReact(m, emoji) {
    if (!this.allow(m, "react", 12, 2e3)) return;
    const at = this.expectedPos();
    this.broadcast({ t: "react", emoji, from: m.id, name: m.name, at });
    if (this.state.mediaId) {
      const bucket = Math.floor(at / LIMITS.heatBucketSec) * LIMITS.heatBucketSec;
      let map = this.heat.get(this.state.mediaId);
      if (!map) this.heat.set(this.state.mediaId, map = /* @__PURE__ */ new Map());
      map.set(bucket, (map.get(bucket) ?? 0) + 1);
      this.heatDirty = true;
    }
  }
  heatBuckets(mediaId) {
    const map = mediaId ? this.heat.get(mediaId) : void 0;
    if (!map) return [];
    return [...map.entries()].map(([t, n]) => ({ t, n })).sort((a, b) => a.t - b.t);
  }
  // ───────────────────────── queue ─────────────────────────
  doQueueAdd(m, mediaId) {
    if (!this.deps.getMedia(mediaId)) return this.error(m, "unknown_media", "That title is not in the catalog.");
    if (this.queue.length >= LIMITS.queue) return this.error(m, "queue_full", "The queue is full.");
    this.queue.push({ id: newId(), mediaId, addedBy: m.id });
    this.broadcast({ t: "queue", queue: this.queue });
  }
  doQueueRemove(m, itemId) {
    const i = this.queue.findIndex((q) => q.id === itemId);
    if (i < 0) return;
    if (this.queue[i].addedBy !== m.id && !this.canControl(m)) return this.error(m, "forbidden", "You can only remove your own picks.");
    this.queue.splice(i, 1);
    this.broadcast({ t: "queue", queue: this.queue });
  }
  doQueueMove(m, itemId, dir) {
    if (!this.need(m)) return;
    const i = this.queue.findIndex((q) => q.id === itemId);
    const j = dir === "up" ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= this.queue.length) return;
    [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
    this.broadcast({ t: "queue", queue: this.queue });
  }
  // ───────────────────────── polls ─────────────────────────
  doPollCreate(m, question, options) {
    if (!this.need(m)) return;
    const labels = [...new Set(options.map((o) => clean(o, LIMITS.label)).filter(Boolean))];
    const q = clean(question, 120);
    if (!q || labels.length < LIMITS.pollOptionsMin) return this.error(m, "invalid", "A poll needs a question and at least two different options.");
    if (this.polls.length >= LIMITS.polls) {
      const closed = this.polls.findIndex((p) => !p.open);
      if (closed < 0) return this.error(m, "too_many_polls", "Close a poll before starting another.");
      this.polls.splice(closed, 1);
    }
    this.polls.push({
      id: newId(),
      question: q,
      options: labels.map((label, i) => ({ id: `o${i + 1}`, label, votes: [] })),
      createdBy: m.id,
      open: true,
      createdAt: this.deps.now()
    });
    this.broadcast({ t: "polls", polls: this.polls });
  }
  doPollVote(m, pollId, optionId) {
    const poll = this.polls.find((p) => p.id === pollId);
    if (!poll || !poll.open) return;
    const opt = poll.options.find((o) => o.id === optionId);
    if (!opt) return;
    for (const o of poll.options) o.votes = o.votes.filter((v) => v !== m.id);
    opt.votes.push(m.id);
    this.broadcast({ t: "polls", polls: this.polls });
  }
  doPollClose(m, pollId) {
    const poll = this.polls.find((p) => p.id === pollId);
    if (!poll || !poll.open) return;
    if (poll.createdBy !== m.id && m.id !== this.hostId) return this.error(m, "forbidden", "Only the poll creator or the host can close it.");
    poll.open = false;
    this.broadcast({ t: "polls", polls: this.polls });
    const top = [...poll.options].sort((a, b) => b.votes.length - a.votes.length)[0];
    if (top && top.votes.length > 0) this.system(`Poll closed: "${poll.question}" \u2192 ${top.label} (${top.votes.length})`);
  }
  // ───────────────────────── host ─────────────────────────
  doTransfer(m, to) {
    if (m.id !== this.hostId) return this.error(m, "forbidden", "Only the host can hand over the room.");
    const target = this.members.get(to);
    if (!target || !target.conn) return this.error(m, "not_found", "That person is not connected.");
    this.hostId = target.id;
    this.system(`${m.name} handed the room to ${target.name}`);
    this.broadcastMembers();
  }
  // ───────────────────────── Moments (bonus) ─────────────────────────
  markersForCurrent() {
    const id2 = this.state.mediaId;
    return this.markers.filter((k) => k.mediaId === id2).sort((a, b) => a.at - b.at);
  }
  doMarkerAdd(m, rawLabel) {
    const mediaId = this.state.mediaId;
    if (!mediaId) return this.error(m, "no_media", "Nothing is playing.");
    if (!this.allow(m, "marker", 6, 1e4)) return this.error(m, "rate_limited", "Slow down a little.");
    const label = clean(rawLabel, LIMITS.label);
    if (!label) return;
    const at = Math.round(this.expectedPos() * 10) / 10;
    const near = this.markers.find((k) => k.mediaId === mediaId && Math.abs(k.at - at) <= 3);
    if (near) {
      if (!near.votes.includes(m.id)) near.votes.push(m.id);
    } else {
      if (this.markers.filter((k) => k.mediaId === mediaId).length >= LIMITS.markersPerMedia) {
        return this.error(m, "too_many_markers", "This title has the maximum number of Moments.");
      }
      this.markers.push({ id: newId(), mediaId, at, label, by: m.id, votes: [m.id] });
    }
    this.broadcast({ t: "markers", markers: this.markersForCurrent() });
  }
  doMarkerVote(m, markerId) {
    const k = this.markers.find((x) => x.id === markerId);
    if (!k) return;
    k.votes = k.votes.includes(m.id) ? k.votes.filter((v) => v !== m.id) : [...k.votes, m.id];
    this.broadcast({ t: "markers", markers: this.markersForCurrent() });
  }
  doMarkerRemove(m, markerId) {
    const i = this.markers.findIndex((x) => x.id === markerId);
    if (i < 0) return;
    if (this.markers[i].by !== m.id && m.id !== this.hostId) return this.error(m, "forbidden", "Only the author or the host can remove a Moment.");
    this.markers.splice(i, 1);
    this.broadcast({ t: "markers", markers: this.markersForCurrent() });
  }
  /** Highlight reel: the room's top-voted Moments, replayed in story order as short synchronized clips. */
  startReel(m) {
    if (!this.need(m)) return;
    const top = this.markersForCurrent().sort((a, b) => b.votes.length - a.votes.length || a.at - b.at).slice(0, REEL_MAX_CLIPS).sort((a, b) => a.at - b.at);
    if (top.length === 0) return this.error(m, "no_moments", "Add a few Moments first.");
    this.reel = { active: true, idx: -1, total: top.length, clips: top.map((k) => Math.max(0, k.at - REEL_PREROLL_SEC)), nextAt: 0 };
    this.stepReel(m.id);
  }
  stepReel(by) {
    const now = this.deps.now();
    this.reel.idx++;
    if (this.reel.idx >= this.reel.total) {
      this.reel.active = false;
      this.broadcast({ t: "reel", reel: this.publicReel() });
      this.commit({ status: "paused", hold: false, pos: this.expectedPos(now), anchor: now }, by);
      this.system("Highlight reel finished");
      return;
    }
    const start = this.reel.clips[this.reel.idx];
    this.reel.nextAt = now + this.deps.playLeadMs + (REEL_CLIP_SEC + REEL_PREROLL_SEC) * 1e3;
    this.commit({ status: "playing", hold: false, pos: start, anchor: now + this.deps.playLeadMs }, by);
    this.broadcast({ t: "reel", reel: this.publicReel() });
  }
  stopReel(announce) {
    if (!this.reel.active) return;
    this.reel = { active: false, idx: 0, total: 0, clips: [], nextAt: 0 };
    if (announce) this.broadcast({ t: "reel", reel: this.publicReel() });
  }
  publicReel() {
    return { active: this.reel.active, idx: this.reel.idx, total: this.reel.total };
  }
  // ───────────────────────── timers ─────────────────────────
  /** ~4 Hz: reel stepping, hold expiry, throttled heat + sync-health broadcasts. */
  tick(now = this.deps.now()) {
    if (this.reel.active && now >= this.reel.nextAt) this.stepReel(null);
    if (this.state.hold) this.evalHold();
    if (this.heatDirty && now - this.lastHeatAt >= 1e3) {
      this.heatDirty = false;
      this.lastHeatAt = now;
      this.broadcast({ t: "heat", mediaId: this.state.mediaId, buckets: this.heatBuckets(this.state.mediaId) });
    }
    if (now - this.lastHealthAt >= 2e3) {
      this.lastHealthAt = now;
      const entries = [...this.members.values()].filter((m) => m.conn && m.driftMs !== null).map((m) => ({ id: m.id, driftMs: Math.round(m.driftMs), rttMs: Math.round(m.rttMs ?? 0) }));
      if (entries.length > 0) {
        this.broadcast({ t: "health", maxAbsDriftMs: Math.max(...entries.map((e) => Math.abs(e.driftMs))), members: entries });
      }
    }
  }
  /** ~1 Hz: expire members whose grace period ran out. Returns true when the whole room can be deleted. */
  sweep(now = this.deps.now()) {
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
  broadcast(msg) {
    for (const m of this.members.values()) m.conn?.send(msg);
  }
  broadcastMembers() {
    this.broadcast({ t: "members", members: this.publicMembers(), hostId: this.hostId });
  }
  error(m, code, message) {
    m.conn?.send({ t: "error", code, message });
  }
};

// src/manager.ts
var TOKEN_TTL_MS = 24 * 60 * 60 * 1e3;
var b64 = (b) => Buffer.from(b).toString("base64url");
function signResume(secret, memberId, code, now) {
  const payload = b64(`${memberId}.${code}.${now + TOKEN_TTL_MS}`);
  const sig = b64(createHmac("sha256", secret).update(payload).digest());
  return `${payload}.${sig}`;
}
function verifyResume(secret, token, code, now) {
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = createHmac("sha256", secret).update(payload).digest();
  let given;
  try {
    given = Buffer.from(sig, "base64url");
  } catch {
    return null;
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const [memberId, tokenCode, exp] = Buffer.from(payload, "base64url").toString().split(".");
  if (!memberId || tokenCode !== code || Number(exp) < now) return null;
  return memberId;
}
var RoomManager = class {
  constructor(cfg, now = Date.now) {
    this.cfg = cfg;
    this.now = now;
  }
  cfg;
  now;
  rooms = /* @__PURE__ */ new Map();
  timers = [];
  deps() {
    return {
      now: this.now,
      getMedia,
      sign: (id2, code) => signResume(this.cfg.sessionSecret, id2, code, this.now()),
      verify: (token, code) => verifyResume(this.cfg.sessionSecret, token, code, this.now()),
      maxMembers: this.cfg.maxMembersPerRoom,
      graceMs: this.cfg.reconnectGraceMs,
      playLeadMs: this.cfg.playLeadMs,
      emptyTtlMs: this.cfg.roomEmptyTtlMs
    };
  }
  /** 6 chars from a 32-symbol alphabet (no I/O/0/1): 32^6 ≈ 1.07e9 codes, drawn with a CSPRNG. */
  newCode() {
    for (let attempt = 0; attempt < 20; attempt++) {
      let code = "";
      for (let i = 0; i < ROOM_CODE_LENGTH; i++) code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
      if (!this.rooms.has(code)) return code;
    }
    throw new Error("could not allocate a room code");
  }
  create() {
    if (this.rooms.size >= this.cfg.maxRooms) return null;
    const room = new Room(this.newCode(), this.deps());
    this.rooms.set(room.code, room);
    return room;
  }
  get(code) {
    return this.rooms.get(code);
  }
  tick() {
    const now = this.now();
    for (const room of this.rooms.values()) room.tick(now);
  }
  sweep() {
    const now = this.now();
    for (const [code, room] of this.rooms) if (room.sweep(now)) this.rooms.delete(code);
  }
  connectionCount() {
    let n = 0;
    for (const r of this.rooms.values()) n += r.connectedCount;
    return n;
  }
  start() {
    this.timers.push(setInterval(() => this.tick(), 250), setInterval(() => this.sweep(), 1e3));
    for (const t of this.timers) t.unref();
  }
  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }
};

// src/server.ts
var MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".map": "application/json"
};
var CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "media-src 'self' https: blob:",
  "connect-src 'self' ws: wss:",
  "frame-ancestors 'none'",
  "base-uri 'none'"
].join("; ");
async function startServer(overrides = {}) {
  const cfg = loadConfig(overrides);
  const log = createLogger(cfg.logLevel);
  const manager = new RoomManager(cfg);
  const startedAt = Date.now();
  const perIp = /* @__PURE__ */ new Map();
  const liveness = /* @__PURE__ */ new WeakMap();
  const http = createServer((req, res) => {
    try {
      route(req, res);
    } catch (err) {
      log.error("http handler crashed", String(err));
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  function json(res, status, body) {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(JSON.stringify(body));
  }
  function route(req, res) {
    const url = new URL(req.url ?? "/", "http://x");
    if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "method_not_allowed" });
    if (url.pathname === "/healthz") {
      return json(res, 200, { ok: true, uptimeSec: Math.round((Date.now() - startedAt) / 1e3), rooms: manager.rooms.size, connections: manager.connectionCount() });
    }
    if (url.pathname === "/api/categories") return json(res, 200, CATEGORIES);
    if (url.pathname === "/api/catalog") {
      const q = (url.searchParams.get("q") ?? "").slice(0, 80);
      const category = url.searchParams.get("category");
      let items = category ? CATALOG.filter((m) => m.categories.includes(category)) : CATALOG;
      items = fuzzySearch(items, q, (m) => `${m.title} ${m.categories.join(" ")} ${m.description}`);
      return json(res, 200, items);
    }
    if (cfg.clientDist) return serveStatic(url.pathname, req, res);
    return json(res, 404, { error: "not_found" });
  }
  function serveStatic(pathname, req, res) {
    const root = cfg.clientDist;
    let decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return json(res, 400, { error: "bad_request" });
    }
    const safe = normalize2(decoded).replace(/^(\.\.[/\\])+/, "");
    let file = resolve2(join(root, safe));
    if (file !== root && !file.startsWith(root + sep)) return json(res, 403, { error: "forbidden" });
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, "index.html");
    if (!existsSync(file)) return json(res, 404, { error: "client_not_built" });
    const isHtml = file.endsWith(".html");
    const size = statSync(file).size;
    const headers = {
      "content-type": MIME[extname(file)] ?? "application/octet-stream",
      "cache-control": isHtml ? "no-cache" : "public, max-age=31536000, immutable",
      "content-security-policy": CSP,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "x-frame-options": "DENY",
      "accept-ranges": "bytes"
    };
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
    if (range && size > 0) {
      let start = range[1] === "" ? Math.max(0, size - Number(range[2])) : Number(range[1]);
      let end = range[1] === "" || range[2] === "" ? size - 1 : Math.min(Number(range[2]), size - 1);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
        res.writeHead(416, { "content-range": `bytes */${size}` });
        return void res.end();
      }
      start = Math.max(0, start);
      end = Math.min(end, size - 1);
      res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": end - start + 1 });
      return void createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, "content-length": size });
    createReadStream(file).pipe(res);
  }
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024, perMessageDeflate: false });
  const clientIp = (req) => {
    if (cfg.trustProxy) {
      const xff = req.headers["x-forwarded-for"];
      const first = (Array.isArray(xff) ? xff[0] : xff)?.split(",")[0]?.trim();
      if (first) return first;
    }
    return req.socket.remoteAddress ?? "unknown";
  };
  http.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://x");
    const origin = req.headers.origin;
    const originOk = !origin || cfg.corsOrigins.includes("*") || cfg.corsOrigins.includes(origin);
    const ip = clientIp(req);
    const reject = (code, text) => {
      socket.write(`HTTP/1.1 ${code} ${text}\r
Connection: close\r
\r
`);
      socket.destroy();
    };
    if (url.pathname !== "/ws") return reject(404, "Not Found");
    if (!originOk) {
      log.warn("rejected websocket: bad origin", { origin });
      return reject(403, "Forbidden");
    }
    if ((perIp.get(ip) ?? 0) >= cfg.maxConnPerIp) return reject(429, "Too Many Requests");
    wss.handleUpgrade(req, socket, head, (ws) => {
      perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
      ws.once("close", () => {
        const n = (perIp.get(ip) ?? 1) - 1;
        if (n <= 0) perIp.delete(ip);
        else perIp.set(ip, n);
      });
      onConnection(ws);
    });
  });
  function onConnection(ws) {
    const conn = {
      send(msg) {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
      },
      close(code, reason) {
        ws.close(code, reason);
      }
    };
    let room = null;
    let memberId = null;
    liveness.set(ws, true);
    ws.on("pong", () => liveness.set(ws, true));
    let tokens = 120;
    let last = Date.now();
    ws.on("message", (data, isBinary) => {
      const now = Date.now();
      tokens = Math.min(120, tokens + (now - last) / 1e3 * 60);
      last = now;
      if (isBinary) return ws.close(1003, "text only");
      if (--tokens < 0) return ws.close(1008, "rate limit");
      let raw;
      try {
        raw = JSON.parse(data.toString());
      } catch {
        return conn.send({ t: "error", code: "bad_json", message: "Malformed message." });
      }
      const parsed = ClientMsgSchema.safeParse(raw);
      if (!parsed.success) return conn.send({ t: "error", code: "invalid", message: "Invalid message." });
      const msg = parsed.data;
      switch (msg.t) {
        case "ping":
          return conn.send({ t: "pong", c0: msg.c0, s: Date.now() });
        case "create": {
          if (room) return conn.send({ t: "error", code: "already_joined", message: "Already in a room." });
          const r = manager.create();
          if (!r) return conn.send({ t: "error", code: "server_full", message: "The server is at capacity. Try again soon." });
          const res = r.join(conn, msg.name);
          if ("error" in res) return conn.send({ t: "error", code: res.error, message: res.message });
          room = r;
          memberId = res.memberId;
          return;
        }
        case "join": {
          if (room) return conn.send({ t: "error", code: "already_joined", message: "Already in a room." });
          const r = manager.get(msg.code);
          if (!r) return conn.send({ t: "error", code: "no_such_room", message: `No room with code ${msg.code}.` });
          const res = r.join(conn, msg.name, msg.resume);
          if ("error" in res) return conn.send({ t: "error", code: res.error, message: res.message });
          room = r;
          memberId = res.memberId;
          return;
        }
        case "leave":
          if (room && memberId) room.leave(memberId);
          room = null;
          memberId = null;
          return;
        default:
          if (!room || !memberId) return conn.send({ t: "error", code: "not_in_room", message: "Join a room first." });
          return room.handle(memberId, msg);
      }
    });
    ws.on("close", () => {
      if (room && memberId) room.detach(memberId, conn);
    });
    ws.on("error", (err) => log.debug("socket error", String(err)));
  }
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (liveness.get(ws) === false) {
        ws.terminate();
        continue;
      }
      liveness.set(ws, false);
      ws.ping();
    }
  }, 1e4);
  heartbeat.unref();
  manager.start();
  await new Promise((ok) => http.listen(cfg.port, cfg.host, ok));
  const port = http.address().port;
  log.info("couchbeam listening", { port, env: cfg.nodeEnv });
  return {
    port,
    manager,
    async close() {
      clearInterval(heartbeat);
      manager.stop();
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      await new Promise((ok) => http.close(() => ok()));
    }
  };
}

// src/index.ts
import { existsSync as existsSync2 } from "fs";
import { resolve as resolve3 } from "path";
loadDotEnv();
if (process.argv.includes("--serve-client") && !process.env.CLIENT_DIST) {
  const found = [resolve3(process.cwd(), "../client/dist"), resolve3(process.cwd(), "client/dist")].find((d) => existsSync2(d));
  if (found) process.env.CLIENT_DIST = found;
  else console.warn("client/dist not found: run `npm run build` first.");
}
var server = await startServer();
console.log(`
  CouchBeam is running.  Open this link in Chrome:  http://localhost:${server.port}
`);
var shutdown = async (signal) => {
  console.log(JSON.stringify({ level: "info", msg: "shutting down", signal }));
  await server.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
//# sourceMappingURL=index.js.map