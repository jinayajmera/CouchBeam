import { useEffect, useRef, useState } from 'react';
import { LIMITS, REACTION_EMOJI, getMedia, type HeatBucket, type Marker } from '@couchbeam/shared';
import { useSyncEngine } from '../hooks/useSyncEngine';
import { fmtTime, useClient, useRoom, useTick } from '../lib/useRoom';
import type { ReactEvent } from '../lib/roomClient';

/* ───────────────────────── seek bar with heat strip + Moment pips ───────────────────────── */

function SeekBar(props: {
  pos: number;
  duration: number;
  heat: HeatBucket[];
  markers: Marker[];
  disabled: boolean;
  onSeek: (t: number) => void;
}) {
  const { pos, duration, heat, markers, disabled, onSeek } = props;
  const max = Math.max(1, ...heat.map((h) => h.n));
  const pct = (t: number) => `${Math.min(100, Math.max(0, (t / duration) * 100))}%`;

  return (
    <div
      className={`seek ${disabled ? 'disabled' : ''}`}
      onClick={(e) => {
        if (disabled || !duration) return;
        const r = e.currentTarget.getBoundingClientRect();
        onSeek(((e.clientX - r.left) / r.width) * duration);
      }}
      role="slider"
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round(pos)}
    >
      {/* Reaction heatmap: where the room reacted most. Opacity = share of the busiest 5 s bucket. */}
      <div className="heat">
        {heat.map((h) => (
          <i
            key={h.t}
            style={{ left: pct(h.t), width: `${(LIMITS.heatBucketSec / duration) * 100}%`, opacity: 0.25 + 0.75 * (h.n / max) }}
            title={`${fmtTime(h.t)} · ${h.n} reaction${h.n === 1 ? '' : 's'}`}
          />
        ))}
      </div>
      <div className="seek-fill" style={{ width: pct(pos) }} />
      <div className="seek-knob" style={{ left: pct(pos) }} />
      {markers.map((k) => (
        <button
          key={k.id}
          className="pip"
          style={{ left: pct(k.at), height: `${10 + Math.min(10, k.votes.length * 3)}px` }}
          title={`${fmtTime(k.at)} · ${k.label} · ${k.votes.length} vote${k.votes.length === 1 ? '' : 's'}`}
          onClick={(e) => {
            e.stopPropagation();
            if (!disabled) onSeek(Math.max(0, k.at - 2));
          }}
        />
      ))}
    </div>
  );
}

/* ───────────────────────── floating emoji ───────────────────────── */

interface Floater {
  id: number;
  emoji: string;
  x: number;
  dx: number;
  name: string;
}

function ReactionLayer() {
  const client = useClient();
  const [items, setItems] = useState<Floater[]>([]);
  const n = useRef(0);

  useEffect(
    () =>
      client.onReact((e: ReactEvent) => {
        // A "burst": three particles per reaction, staggered, so a room-wide 🔥 looks like fireworks.
        const batch: Floater[] = Array.from({ length: 3 }, (_, i) => ({
          id: ++n.current,
          emoji: e.emoji,
          x: 8 + Math.random() * 84,
          dx: (Math.random() - 0.5) * 80,
          name: i === 0 ? e.name : '',
        }));
        setItems((cur) => [...cur.slice(-40), ...batch]);
        setTimeout(() => setItems((cur) => cur.filter((f) => !batch.includes(f))), 2600);
      }),
    [client],
  );

  return (
    <div className="floaters" aria-hidden>
      {items.map((f) => (
        <span key={f.id} className="floater" style={{ left: `${f.x}%`, ['--dx' as string]: `${f.dx}px` }}>
          {f.emoji}
          {f.name && <small>{f.name}</small>}
        </span>
      ))}
    </div>
  );
}

/* ───────────────────────── sync health HUD ───────────────────────── */

function Hud(props: { stats: ReturnType<typeof useSyncEngine>['stats'] }) {
  const room = useRoom();
  const [open, setOpen] = useState(false);
  const { stats } = props;
  const abs = Math.abs(stats.driftMs);
  const level = !stats.synced ? 'warn' : abs <= 150 ? 'good' : abs <= 500 ? 'warn' : 'bad';

  return (
    <div className={`hud ${level}`} onClick={() => setOpen((o) => !o)} role="button" tabIndex={0}>
      <b>{stats.synced ? `${stats.driftMs > 0 ? '+' : ''}${stats.driftMs} ms` : 'syncing clock…'}</b>
      <span>
        rtt {stats.rttMs} ms · ×{stats.rate.toFixed(2)}
      </span>
      {open && (
        <div className="hud-more">
          <div>clock error ≤ ±{stats.clockErrMs} ms ({stats.clockSamples} samples)</div>
          <div>hard seeks: {stats.hardSeeks}</div>
          <div>room worst drift: {Math.round(room.health.maxAbsDriftMs)} ms</div>
        </div>
      )}
    </div>
  );
}

/* ───────────────────────── player ───────────────────────── */

export function Player() {
  const client = useClient();
  const room = useRoom();
  const videoRef = useRef<HTMLVideoElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const media = room.state.mediaId ? getMedia(room.state.mediaId) : undefined;
  const { stats, needsGesture, resume } = useSyncEngine(client, videoRef, media?.src ?? null);
  const [momentOpen, setMomentOpen] = useState(false);
  const [momentText, setMomentText] = useState('');
  const [vid, setVid] = useState<'loading' | 'ready' | 'error'>('loading');
  useEffect(() => {
    setVid('loading');
  }, [media?.src]);
  useTick(250);

  const v = videoRef.current;
  const duration = v && Number.isFinite(v.duration) && v.duration > 0 ? v.duration : (media?.durationSec ?? 0);
  const pos = v?.currentTime ?? 0;
  const canControl = room.settings.controls === 'everyone' || room.hostId === room.you;
  const playing = room.state.status === 'playing';
  const holdNames = room.members.filter((m) => m.buffering).map((m) => m.name);
  const host = room.hostId === room.you;

  const toggle = () => {
    if (!media || !canControl) return;
    if (playing || room.state.hold) client.command('pause', pos);
    else client.command('play', pos);
  };
  const skip = (d: number) => canControl && client.command('seek', Math.max(0, pos + d));

  const submitMoment = () => {
    const label = momentText.trim();
    if (label) client.send({ t: 'markerAdd', label });
    setMomentText('');
    setMomentOpen(false);
  };

  return (
    <section className="player card">
      <div className="stage" ref={wrapRef}>
        {media ? (
          <video
            ref={videoRef}
            src={media.src}
            playsInline
            preload="auto"
            className="video"
            onLoadedData={() => setVid('ready')}
            onError={() => setVid('error')}
          />
        ) : (
          <div className="empty-stage">
            <h2>Nothing on yet</h2>
            <p>Pick a title from <b>Discover</b> and press play. Everyone in the room sees it start on the same frame.</p>
            <button className="primary" onClick={() => window.dispatchEvent(new CustomEvent('couchbeam:tab', { detail: 'discover' }))}>
              Choose a movie
            </button>
          </div>
        )}
        {media && vid === 'loading' && <div className="banner">Loading video…</div>}
        {media && vid === 'error' && (
          <div className="banner">Couldn&apos;t load this video. Your network may be blocking it. Pick a &quot;Sync Test Card&quot; in Discover: those play offline.</div>
        )}
        <ReactionLayer />
        {media && <Hud stats={stats} />}
        {media && room.state.hold && holdNames.length > 0 && <div className="banner">Waiting for {holdNames.join(', ')} to catch up…</div>}
        {media && room.reel.active && <div className="banner reel">Highlight reel · clip {room.reel.idx + 1}/{room.reel.total}</div>}
        {needsGesture && (
          <button className="gesture" onClick={resume}>
            ▶ Click to join the playback
          </button>
        )}
      </div>

      {media && (
        <>
          <SeekBar
            pos={pos}
            duration={duration}
            heat={room.heat}
            markers={room.markers}
            disabled={!canControl}
            onSeek={(t) => client.command('seek', t)}
          />
          <div className="controls">
            <button onClick={() => skip(-10)} disabled={!canControl} title="Back 10 s">⟲ 10</button>
            <button className="primary" onClick={toggle} disabled={!canControl}>
              {playing || room.state.hold ? '❚❚ Pause' : '▶ Play'}
            </button>
            <button onClick={() => skip(10)} disabled={!canControl} title="Forward 10 s">10 ⟳</button>
            <span className="time">
              {fmtTime(pos)} / {fmtTime(duration)}
            </span>
            <span className="spacer" />
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              defaultValue={1}
              aria-label="Volume (only for you)"
              onChange={(e) => {
                if (videoRef.current) videoRef.current.volume = Number(e.target.value);
              }}
            />
            <button onClick={() => void wrapRef.current?.requestFullscreen?.()} title="Fullscreen">⛶</button>
          </div>

          <div className="controls second">
            <div className="emoji-row">
              {REACTION_EMOJI.map((e) => (
                <button key={e} className="emoji" onClick={() => client.send({ t: 'react', emoji: e })} aria-label={`React ${e}`}>
                  {e}
                </button>
              ))}
            </div>
            <span className="spacer" />
            {momentOpen ? (
              <form
                className="moment-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  submitMoment();
                }}
              >
                <input autoFocus maxLength={LIMITS.label} placeholder={`Moment at ${fmtTime(pos)}…`} value={momentText} onChange={(e) => setMomentText(e.target.value)} />
                <button className="primary">Mark</button>
                <button type="button" onClick={() => setMomentOpen(false)}>✕</button>
              </form>
            ) : (
              <button onClick={() => setMomentOpen(true)} title="Bookmark this exact moment for the whole room">⚑ Mark moment</button>
            )}
            {canControl && (
              <button
                onClick={() => client.send({ t: 'reel', on: !room.reel.active })}
                disabled={!room.reel.active && room.markers.length === 0}
                title="Replay the room's top-voted Moments as a synchronized reel"
              >
                {room.reel.active ? '■ Stop reel' : `✦ Highlight reel (${room.markers.length})`}
              </button>
            )}
            {host && (
              <button
                onClick={() => client.send({ t: 'settings', controls: room.settings.controls === 'everyone' ? 'host' : 'everyone' })}
                title="Who may control playback"
              >
                {room.settings.controls === 'everyone' ? '🔓 Everyone controls' : '🔒 Host controls'}
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
