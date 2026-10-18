# ADR 0001: Raw `ws` WebSockets instead of Socket.IO

**Status:** accepted

## Context
Playback commands have a 250 ms p95 propagation budget and the protocol is tiny (26 client and 14 server message types, all JSON, typically well under 1 KiB; the largest is the join snapshot, bounded by the 100-message chat cap).

## Decision
Use the `ws` library directly with a zod-validated message union shared by client and server.

## Why
- No long-polling fallback layer, no packet framing overhead, no per-message acks we do not need.
- `perMessageDeflate` is off and Nagle is off: for sub-kilobyte frames compression only adds CPU and delay.
- One schema (`ClientMsgSchema`) is both the validator and the TypeScript type, so the protocol cannot drift between client and server.
- Reconnect, resume and ordering are things we need to control anyway (seq numbers, signed resume tokens), so Socket.IO's built-ins would not have saved the code.

## Consequences
We own reconnect/backoff (`RoomClient`) and heartbeat code. Both are small and covered by the benchmark.
