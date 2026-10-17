import type { Config } from './config';

const ORDER = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 } as const;

export interface Logger {
  debug(msg: string, extra?: unknown): void;
  info(msg: string, extra?: unknown): void;
  warn(msg: string, extra?: unknown): void;
  error(msg: string, extra?: unknown): void;
}

/** Structured one-line JSON logs. Never log tokens, secrets or message bodies. */
export function createLogger(level: Config['logLevel']): Logger {
  const min = ORDER[level];
  const emit = (lvl: keyof typeof ORDER) => (msg: string, extra?: unknown) => {
    if (ORDER[lvl] < min) return;
    const line = JSON.stringify({ t: new Date().toISOString(), level: lvl, msg, ...(extra ? { extra } : {}) });
    (lvl === 'error' || lvl === 'warn' ? console.error : console.log)(line);
  };
  return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') };
}
