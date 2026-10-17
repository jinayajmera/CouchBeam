# Changelog

All notable changes to this project are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [0.1.0] - 2026-10-16

### Added
- Rooms with 6-character codes and shareable invite links; reconnect with signed resume tokens.
- Authoritative playback state with sequence numbers and **scheduled starts** so every client begins on the same instant.
- Cristian-style clock sync with low-RTT sample filtering; drift engine with 0.95x / 1.05x rate nudges, hysteresis and 500 ms hard-seek threshold.
- Buffering hold: the room pauses for a stalled member and resumes together.
- Live chat, emoji reaction bursts, shared queue with auto-advance, group polls, host transfer and automatic host failover.
- Catalog with categories, filters, "more like this" recommendations and typo-tolerant fuzzy search (shared by client and server).
- **Moments**: room-voted timestamp bookmarks, **Highlight Reel** playback, **Reaction Heatmap** on the seek bar, **Spoiler Shield** time-locked chat, live **Sync Health HUD**.
- Benchmark script (propagation percentiles, drift, races, reconnect, late join, host failover) and 52 unit tests.
- Docker image, CI (typecheck, tests, build, benchmark, gitleaks, CodeQL), Dependabot.
