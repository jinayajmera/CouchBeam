# ADR 0003: In-memory rooms first, Redis/Postgres on the roadmap

**Status:** accepted

## Context
A room is a small, hot, short-lived object (tens of members, state changes a few times per minute). Rooms do not need durability; they need low latency and simple failure modes.

## Decision
Keep rooms in process memory behind a transport-agnostic `Room` class (it only sees a `Conn { send, close }`). Ship v0.1 as a single node. Document the scale-out path instead of half-building it.

## Scale-out path
1. Route all members of a room to one node (consistent hashing on the room code at the load balancer). The room stays single-writer, which keeps the ordering guarantees in ADR 0002.
2. Use Redis only for the code -> node directory and for cross-node "does this room exist" lookups.
3. Postgres for opt-in history (watch logs, saved playlists), never on the hot path.

`REDIS_URL` and `DATABASE_URL` are therefore listed in `.env.example` but marked `[RESERVED]`; v0.1 does not read them.

## Consequences
A node restart drops its rooms (clients see "no such room"). Acceptable for watch parties; the roadmap item above fixes it if it ever matters.
