# Security policy

## Reporting a vulnerability

Please open a private security advisory on GitHub (Security → Report a vulnerability) rather than a public issue.

## What the server defends against

| Threat | Mitigation |
| --- | --- |
| Seat hijacking after a reconnect | Resume tokens are HMAC-SHA256 signed with `SESSION_SECRET`, bound to the room code, expire after 24 h and are compared in constant time. |
| Weak or leaked secrets | Production refuses to boot without a >= 32 char `SESSION_SECRET`. `.env` is git-ignored, `.env.example` holds dummies only, CI runs gitleaks. |
| Cross-site WebSocket hijacking | `Origin` is checked against `CORS_ORIGINS` on upgrade. |
| Malformed or hostile input | Every inbound message is validated by a strict zod schema before it reaches room state. 16 KiB max frame. Control characters stripped from names and chat. React escapes all rendered text. |
| Flooding | Per-socket token bucket (120 burst / 60 per s), per-member chat / reaction / Moment limits, per-IP connection cap, member / room / queue / poll / Moment caps. |
| Room code guessing | 6 chars from a 32-symbol alphabet (about 1.07 billion codes) drawn from a CSPRNG. Rooms are unlisted and expire when empty. |
| Dead connections | Protocol ping/pong every 10 s; missed pongs terminate the socket. |
| Clickjacking / XSS (served client) | Strict CSP, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`. |

## Known limits

- Anyone with a room code can join; there are no accounts. Treat the code like a password for private watch parties.
- Rate limits and room state are per process. A multi-node deployment needs the Redis backplane described in the README roadmap.
- Video URLs in the catalog are fetched by each viewer's browser directly from the media host.
