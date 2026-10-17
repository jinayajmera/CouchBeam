import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import type { RoomClient, ClientSnapshot, RoomData } from './roomClient';

export const ClientContext = createContext<RoomClient | null>(null);

export function useClient(): RoomClient {
  const c = useContext(ClientContext);
  if (!c) throw new Error('RoomClient missing');
  return c;
}

export function useClientSnapshot(): ClientSnapshot {
  const c = useClient();
  return useSyncExternalStore(c.subscribe, c.getSnapshot);
}

/** Only call inside the room view, where `room` is guaranteed. */
export function useRoom(): RoomData {
  const { room } = useClientSnapshot();
  if (!room) throw new Error('not in a room');
  return room;
}

/** Re-render every `ms` (for clocks and Spoiler Shield, which depend on the live playhead). */
export function useTick(ms: number): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setN((x) => x + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
  return n;
}

export function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
