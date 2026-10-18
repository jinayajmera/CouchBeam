import { loadDotEnv } from './config';
import { startServer } from './server';

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

loadDotEnv();

// `npm start` passes --serve-client: serve the built web page from this same process (http://localhost:8080).
if (process.argv.includes('--serve-client') && !process.env.CLIENT_DIST) {
  const found = [resolve(process.cwd(), '../client/dist'), resolve(process.cwd(), 'client/dist')].find((d) => existsSync(d));
  if (found) process.env.CLIENT_DIST = found;
  else console.warn('client/dist not found: run `npm run build` first.');
}

const server = await startServer();

// Human-friendly line (the JSON log above is for machines).
console.log(`\n  CouchBeam is running.  Open this link in Chrome:  http://localhost:${server.port}\n`);

const shutdown = async (signal: string): Promise<void> => {
  console.log(JSON.stringify({ level: 'info', msg: 'shutting down', signal }));
  await server.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
