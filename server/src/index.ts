import { loadDotEnv } from './config';
import { startServer } from './server';

loadDotEnv();

const server = await startServer();

const shutdown = async (signal: string): Promise<void> => {
  console.log(JSON.stringify({ level: 'info', msg: 'shutting down', signal }));
  await server.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
