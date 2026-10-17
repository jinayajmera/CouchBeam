# ADR 0002: Server-authoritative state with scheduled starts

**Status:** accepted

## Context
Clients are at different network distances. If the server says "play now", the nearest client starts first and the farthest starts one one-way delay later. That is a built-in drift of tens of ms before any media-clock error.

## Decision
- The server owns one `PlaybackState {seq, status, pos, anchor}` per room. Position at server time `T` is `pos + max(0, T - anchor)/1000` while playing.
- On play, resume-from-hold and seek-while-playing, the server sets `anchor = now + PLAY_LEAD_MS` (default 200 ms). Clients convert `anchor` into their own clock with the Cristian offset and start there.
- Every transition increments `seq`; clients drop any state with `seq <=` what they hold.
- Pause uses the server's computed position, not the sender's.

## Why not peer-to-peer / vector clocks?
All commands are *absolute* (play at X, pause, seek to X), so a single total order assigned by the server makes them conflict-free without vector timestamps. Two small guards handle the remaining races: near-duplicate play/pause collapse into one transition, and commands stamped against a previous media change are rejected as stale.

## Consequences
A press of Play takes `PLAY_LEAD_MS` to take effect everywhere. That is the price of starting together and is tunable. Propagation of the command itself (what the 250 ms requirement measures) is unaffected.
