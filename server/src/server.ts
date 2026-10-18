import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import { CATALOG, CATEGORIES, ClientMsgSchema, fuzzySearch, type ServerMsg } from '@couchbeam/shared';
import { loadConfig, type Config } from './config';
import { createLogger } from './logger';
import { RoomManager } from './manager';
import type { Conn, Room } from './room';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.map': 'application/json',
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "media-src 'self' https: blob:",
  "connect-src 'self' ws: wss:",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join('; ');

export interface RunningServer {
  port: number;
  manager: RoomManager;
  close(): Promise<void>;
}

export async function startServer(overrides: Partial<Config> = {}): Promise<RunningServer> {
  const cfg = loadConfig(overrides);
  const log = createLogger(cfg.logLevel);
  const manager = new RoomManager(cfg);
  const startedAt = Date.now();
  const perIp = new Map<string, number>();
  const liveness = new WeakMap<WebSocket, boolean>();

  // ───────────── HTTP ─────────────
  const http = createServer((req, res) => {
    try {
      route(req, res);
    } catch (err) {
      log.error('http handler crashed', String(err));
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });

  function json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(JSON.stringify(body));
  }

  function route(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://x');
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method_not_allowed' });

    if (url.pathname === '/healthz') {
      return json(res, 200, { ok: true, uptimeSec: Math.round((Date.now() - startedAt) / 1000), rooms: manager.rooms.size, connections: manager.connectionCount() });
    }
    if (url.pathname === '/api/categories') return json(res, 200, CATEGORIES);
    if (url.pathname === '/api/catalog') {
      const q = (url.searchParams.get('q') ?? '').slice(0, 80);
      const category = url.searchParams.get('category');
      let items = category ? CATALOG.filter((m) => m.categories.includes(category)) : CATALOG;
      items = fuzzySearch(items, q, (m) => `${m.title} ${m.categories.join(' ')} ${m.description}`);
      return json(res, 200, items);
    }
    if (cfg.clientDist) return serveStatic(url.pathname, req, res);
    return json(res, 404, { error: 'not_found' });
  }

  function serveStatic(pathname: string, req: IncomingMessage, res: ServerResponse): void {
    const root = cfg.clientDist!;
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return json(res, 400, { error: 'bad_request' }); // malformed % escape
    }
    const safe = normalize(decoded).replace(/^(\.\.[/\\])+/, '');
    let file = resolve(join(root, safe));
    if (file !== root && !file.startsWith(root + sep)) return json(res, 403, { error: 'forbidden' });
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html'); // SPA fallback
    if (!existsSync(file)) return json(res, 404, { error: 'client_not_built' });
    const isHtml = file.endsWith('.html');
    const size = statSync(file).size;
    const headers: Record<string, string | number> = {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'cache-control': isHtml ? 'no-cache' : 'public, max-age=31536000, immutable',
      'content-security-policy': CSP,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY',
      'accept-ranges': 'bytes',
    };
    // HTTP Range: browsers need it to seek inside a video without re-downloading it.
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    if (range && size > 0) {
      let start = range[1] === '' ? Math.max(0, size - Number(range[2])) : Number(range[1]);
      let end = range[1] === '' || range[2] === '' ? size - 1 : Math.min(Number(range[2]), size - 1);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
        res.writeHead(416, { 'content-range': `bytes */${size}` });
        return void res.end();
      }
      start = Math.max(0, start);
      end = Math.min(end, size - 1);
      res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 });
      return void createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, 'content-length': size });
    createReadStream(file).pipe(res);
  }

  // ───────────── WebSocket ─────────────
  // perMessageDeflate off: compression adds CPU + latency and our messages are tiny.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024, perMessageDeflate: false });

  const clientIp = (req: IncomingMessage): string => {
    if (cfg.trustProxy) {
      const xff = req.headers['x-forwarded-for'];
      const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim();
      if (first) return first;
    }
    return req.socket.remoteAddress ?? 'unknown';
  };

  http.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const origin = req.headers.origin;
    const originOk = !origin || cfg.corsOrigins.includes('*') || cfg.corsOrigins.includes(origin);
    const ip = clientIp(req);
    const reject = (code: number, text: string): void => {
      socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    if (url.pathname !== '/ws') return reject(404, 'Not Found');
    if (!originOk) {
      log.warn('rejected websocket: bad origin', { origin });
      return reject(403, 'Forbidden');
    }
    if ((perIp.get(ip) ?? 0) >= cfg.maxConnPerIp) return reject(429, 'Too Many Requests');
    wss.handleUpgrade(req, socket, head, (ws) => {
      perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
      ws.once('close', () => {
        const n = (perIp.get(ip) ?? 1) - 1;
        if (n <= 0) perIp.delete(ip);
        else perIp.set(ip, n);
      });
      onConnection(ws);
    });
  });

  function onConnection(ws: WebSocket): void {
    const conn: Conn = {
      send(msg: ServerMsg) {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
      },
      close(code, reason) {
        ws.close(code, reason);
      },
    };
    let room: Room | null = null;
    let memberId: string | null = null;
    liveness.set(ws, true);
    ws.on('pong', () => liveness.set(ws, true));

    // Token bucket: 120 burst, 60 msg/s sustained. A flooding client is dropped, not served.
    let tokens = 120;
    let last = Date.now();

    ws.on('message', (data, isBinary) => {
      const now = Date.now();
      tokens = Math.min(120, tokens + ((now - last) / 1000) * 60);
      last = now;
      if (isBinary) return ws.close(1003, 'text only');
      if (--tokens < 0) return ws.close(1008, 'rate limit');

      let raw: unknown;
      try {
        raw = JSON.parse(data.toString());
      } catch {
        return conn.send({ t: 'error', code: 'bad_json', message: 'Malformed message.' });
      }
      const parsed = ClientMsgSchema.safeParse(raw);
      if (!parsed.success) return conn.send({ t: 'error', code: 'invalid', message: 'Invalid message.' });
      const msg = parsed.data;

      switch (msg.t) {
        case 'ping': // answered before anything else so RTT samples stay clean
          return conn.send({ t: 'pong', c0: msg.c0, s: Date.now() });

        case 'create': {
          if (room) return conn.send({ t: 'error', code: 'already_joined', message: 'Already in a room.' });
          const r = manager.create();
          if (!r) return conn.send({ t: 'error', code: 'server_full', message: 'The server is at capacity. Try again soon.' });
          const res = r.join(conn, msg.name);
          if ('error' in res) return conn.send({ t: 'error', code: res.error, message: res.message });
          room = r;
          memberId = res.memberId;
          return;
        }

        case 'join': {
          if (room) return conn.send({ t: 'error', code: 'already_joined', message: 'Already in a room.' });
          const r = manager.get(msg.code);
          if (!r) return conn.send({ t: 'error', code: 'no_such_room', message: `No room with code ${msg.code}.` });
          const res = r.join(conn, msg.name, msg.resume);
          if ('error' in res) return conn.send({ t: 'error', code: res.error, message: res.message });
          room = r;
          memberId = res.memberId;
          return;
        }

        case 'leave':
          if (room && memberId) room.leave(memberId);
          room = null;
          memberId = null;
          return;

        default:
          if (!room || !memberId) return conn.send({ t: 'error', code: 'not_in_room', message: 'Join a room first.' });
          return room.handle(memberId, msg);
      }
    });

    ws.on('close', () => {
      if (room && memberId) room.detach(memberId, conn);
    });
    ws.on('error', (err) => log.debug('socket error', String(err)));
  }

  // Protocol-level heartbeat: detects half-open TCP connections that never fire 'close'.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (liveness.get(ws) === false) {
        ws.terminate(); // missed a whole interval: the TCP connection is dead
        continue;
      }
      liveness.set(ws, false);
      ws.ping();
    }
  }, 10_000);
  heartbeat.unref();

  manager.start();
  await new Promise<void>((ok) => http.listen(cfg.port, cfg.host, ok));
  const port = (http.address() as AddressInfo).port;
  log.info('couchbeam listening', { port, env: cfg.nodeEnv });

  return {
    port,
    manager,
    async close() {
      clearInterval(heartbeat);
      manager.stop();
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      await new Promise<void>((ok) => http.close(() => ok()));
    },
  };
}
