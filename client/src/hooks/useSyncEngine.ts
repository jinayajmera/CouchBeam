import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { DRIFT, computeCorrection, expectedPosition } from '@couchbeam/shared';
import type { RoomClient } from '../lib/roomClient';

export interface SyncStats {
  /** localPosition - expectedPosition, ms. + = ahead, - = behind. */
  driftMs: number;
  rate: number;
  rttMs: number;
  /** Worst-case clock error (rtt/2), ms. */
  clockErrMs: number;
  clockSamples: number;
  hardSeeks: number;
  synced: boolean;
}

const TICK_MS = 100; // control-loop period: 10 Hz is plenty for a 500 ms budget and cheap on battery
const STALL_DEBOUNCE_MS = 400; // ignore sub-400 ms hiccups so they do not pause the whole room
const SEEK_GRACE_MS = 2000; // our own corrective seeks emit `waiting`; never report those as network stalls

/**
 * Drift Detection & Video Sync Engine.
 *
 * Every tick:
 *   expected = pos + (serverNow - anchor)/1000        (serverNow = local clock + Cristian offset)
 *   drift    = video.currentTime - expected
 * and `computeCorrection` decides: leave it, nudge playbackRate to 0.95/1.05, or hard-seek.
 *
 * The <video> element has NO native controls: every pause/play/seek comes from the server state,
 * so there is no feedback loop between "what the user did" and "what the room is doing".
 */
export function useSyncEngine(client: RoomClient, videoRef: RefObject<HTMLVideoElement | null>, src: string | null) {
  const [stats, setStats] = useState<SyncStats>({ driftMs: 0, rate: 1, rttMs: 0, clockErrMs: 0, clockSamples: 0, hardSeeks: 0, synced: false });
  const [needsGesture, setNeedsGesture] = useState(false);
  const live = useRef({ driftMs: 0, hardSeeks: 0, lastSeekAt: 0 });
  const tickRef = useRef<() => void>(() => {});

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;

    const tick = (): void => {
      const room = client.room;
      if (!room || !room.state.mediaId || !client.clock.synced || v.readyState < 1) return;

      const st = room.state;
      const now = client.serverNow();
      const expected = expectedPosition(st, now);
      const drift = v.currentTime - expected;
      live.current.driftMs = drift * 1000;

      // Paused, held, or waiting for the scheduled start instant: sit exactly on the target frame.
      const shouldPlay = st.status === 'playing' && now >= st.anchor;
      if (!shouldPlay) {
        if (!v.paused) v.pause();
        if (v.playbackRate !== 1) v.playbackRate = 1;
        if (computeCorrection(drift, false, 1).action === 'seek') {
          live.current.lastSeekAt = performance.now();
          v.currentTime = expected;
        }
        return;
      }

      if (v.paused) {
        v.play().then(
          () => setNeedsGesture(false),
          () => setNeedsGesture(true), // autoplay blocked: wait for a click
        );
        return;
      }

      const c = computeCorrection(drift, true, v.playbackRate);
      if (c.action === 'seek') {
        const target = expected + DRIFT.seekLeadSec;
        live.current.lastSeekAt = performance.now();
        live.current.hardSeeks++;
        v.playbackRate = 1;
        v.currentTime = Number.isFinite(v.duration) ? Math.min(target, v.duration) : target;
      } else if (v.playbackRate !== c.rate) {
        v.playbackRate = c.rate;
      }
    };
    tickRef.current = tick;

    // Control loop + a precise one-shot at each scheduled start so playback begins on the beat, not up to 100 ms late.
    const loop = setInterval(tick, TICK_MS);
    let lastSeq = -1;
    let oneShot: ReturnType<typeof setTimeout> | undefined;
    const unsub = client.subscribe(() => {
      const st = client.room?.state;
      if (!st || st.seq === lastSeq) return;
      lastSeq = st.seq;
      clearTimeout(oneShot);
      const wait = st.anchor - client.serverNow();
      if (st.status === 'playing' && wait > 0 && wait < 2000) oneShot = setTimeout(tick, wait);
      else tick();
    });

    // Drift telemetry to the server (feeds the room's Sync Health panel and the benchmark).
    const report = setInterval(() => {
      if (!client.clock.synced || !client.room?.state.mediaId) return;
      client.send({ t: 'drift', driftMs: live.current.driftMs, rttMs: Number.isFinite(client.clock.rtt) ? client.clock.rtt : 0 });
    }, 2000);

    const ui = setInterval(() => {
      setStats({
        driftMs: Math.round(live.current.driftMs),
        rate: v.playbackRate,
        rttMs: Math.round(Number.isFinite(client.clock.rtt) ? client.clock.rtt : 0),
        clockErrMs: Math.round(Number.isFinite(client.clock.uncertainty) ? client.clock.uncertainty : 0),
        clockSamples: client.clock.count,
        hardSeeks: live.current.hardSeeks,
        synced: client.clock.synced,
      });
    }, 500);

    // Buffering -> tell the room (debounced); recovery -> tell the room.
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    let reported = false;
    const clearStall = (): void => {
      clearTimeout(stallTimer);
      if (reported) {
        reported = false;
        client.send({ t: 'buffering', on: false });
      }
    };
    const onWaiting = (): void => {
      if (performance.now() - live.current.lastSeekAt < SEEK_GRACE_MS || v.seeking) return;
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        if (v.readyState < 3 && !reported) {
          reported = true;
          client.send({ t: 'buffering', on: true });
        }
      }, STALL_DEBOUNCE_MS);
    };
    const onEnded = (): void => {
      const id = client.room?.state.mediaId;
      if (id) client.send({ t: 'ended', mediaId: id });
    };
    v.addEventListener('waiting', onWaiting);
    for (const e of ['playing', 'canplay', 'seeked']) v.addEventListener(e, clearStall);
    v.addEventListener('ended', onEnded);
    v.addEventListener('loadedmetadata', tick);

    return () => {
      clearInterval(loop);
      clearInterval(report);
      clearInterval(ui);
      clearTimeout(oneShot);
      clearTimeout(stallTimer);
      unsub();
      v.removeEventListener('waiting', onWaiting);
      for (const e of ['playing', 'canplay', 'seeked']) v.removeEventListener(e, clearStall);
      v.removeEventListener('ended', onEnded);
      v.removeEventListener('loadedmetadata', tick);
    };
    // `src` is a dependency so listeners re-bind cleanly when the media element is re-mounted.
  }, [client, videoRef, src]);

  /** Called from a click when the browser blocked autoplay. */
  const resume = useCallback(() => {
    setNeedsGesture(false);
    tickRef.current();
  }, []);

  return { stats, needsGesture, resume };
}
