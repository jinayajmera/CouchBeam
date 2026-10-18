import { useEffect, useRef, useState } from 'react';
import { LIMITS, getMedia, type ChatMessage } from '@couchbeam/shared';
import { fmtTime, useClient, useRoom, useTick } from '../lib/useRoom';
import type { RoomData } from '../lib/roomClient';

const nameOf = (room: RoomData, id: string): string => room.members.find((m) => m.id === id)?.name ?? 'someone';
const colorOf = (room: RoomData, id: string | null): string => room.members.find((m) => m.id === id)?.color ?? 'var(--muted)';

/** Current playhead of *this* viewer, in seconds (what the server calls "expected position" for them). */
function usePlayhead(): number {
  const client = useClient();
  const room = useRoom();
  useTick(1000);
  const st = room.state;
  if (st.status !== 'playing') return st.pos;
  return st.pos + Math.max(0, client.serverNow() - st.anchor) / 1000;
}

/* ───────────────────────── Chat + Spoiler Shield ───────────────────────── */

const SHIELD_GRACE_SEC = 8;

export function ChatPanel() {
  const client = useClient();
  const room = useRoom();
  const head = usePlayhead();
  const [text, setText] = useState('');
  const [shield, setShield] = useState(true);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [room.chat.length]);

  /** A message is "from the future" if its author was further into the SAME title than you are. */
  const ahead = (m: ChatMessage): boolean =>
    shield && !m.system && m.from !== room.you && m.mediaId !== null && m.mediaId === room.state.mediaId && m.at > head + SHIELD_GRACE_SEC;

  const send = () => {
    const t = text.trim();
    if (!t) return;
    client.send({ t: 'chat', text: t, at: head });
    setText('');
  };

  return (
    <div className="panel chat">
      <label className="shield">
        <input type="checkbox" checked={shield} onChange={(e) => setShield(e.target.checked)} />
        <span>
          <b>Spoiler Shield</b> — hide messages written further ahead than you are
        </span>
      </label>
      <div className="messages">
        {room.chat.map((m) =>
          m.system ? (
            <div key={m.id} className="sys">{m.text}</div>
          ) : ahead(m) && !revealed.has(m.id) ? (
            <button key={m.id} className="msg locked" onClick={() => setRevealed(new Set(revealed).add(m.id))}>
              🔒 {m.name} wrote this at {fmtTime(m.at)}, ahead of you. Click to reveal.
            </button>
          ) : (
            <div key={m.id} className={`msg ${m.from === room.you ? 'mine' : ''}`}>
              <b style={{ color: colorOf(room, m.from) }}>{m.name}</b>
              {m.mediaId && m.mediaId === room.state.mediaId && <time>{fmtTime(m.at)}</time>}
              <p>{m.text}</p>
            </div>
          ),
        )}
        <div ref={bottom} />
      </div>
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <input value={text} maxLength={LIMITS.chat} onChange={(e) => setText(e.target.value)} placeholder="Say something…" aria-label="Chat message" />
        <button className="primary">Send</button>
      </form>
    </div>
  );
}

/* ───────────────────────── Queue ───────────────────────── */

export function QueuePanel() {
  const client = useClient();
  const room = useRoom();
  const canControl = room.settings.controls === 'everyone' || room.hostId === room.you;
  const now = room.state.mediaId ? getMedia(room.state.mediaId) : undefined;

  return (
    <div className="panel">
      <h3 className="section">Now showing</h3>
      <div className="row-card">{now ? <b>{now.title}</b> : <span className="muted">Nothing yet</span>}</div>
      <h3 className="section">
        Up next <small>({room.queue.length})</small>
      </h3>
      {room.queue.length === 0 && <p className="muted">The queue is empty. Add titles from Discover; when one ends the next starts automatically.</p>}
      <ol className="queue">
        {room.queue.map((q, i) => {
          const m = getMedia(q.mediaId);
          return (
            <li key={q.id} className="row-card">
              <span className="idx">{i + 1}</span>
              <span className="grow">
                <b>{m?.title ?? q.mediaId}</b>
                <small> · added by {nameOf(room, q.addedBy)}</small>
              </span>
              <button disabled={!canControl || i === 0} onClick={() => client.send({ t: 'queueMove', itemId: q.id, dir: 'up' })} aria-label="Move up">↑</button>
              <button disabled={!canControl || i === room.queue.length - 1} onClick={() => client.send({ t: 'queueMove', itemId: q.id, dir: 'down' })} aria-label="Move down">↓</button>
              <button onClick={() => client.send({ t: 'queueRemove', itemId: q.id })} aria-label="Remove">✕</button>
            </li>
          );
        })}
      </ol>
      <button className="primary" disabled={!canControl || room.queue.length === 0} onClick={() => client.send({ t: 'playNext' })}>
        ⏭ Play next
      </button>
    </div>
  );
}

/* ───────────────────────── Polls ───────────────────────── */

export function PollsPanel() {
  const client = useClient();
  const room = useRoom();
  const canControl = room.settings.controls === 'everyone' || room.hostId === room.you;
  const [q, setQ] = useState('');
  const [opts, setOpts] = useState(['', '']);

  const create = () => {
    const options = opts.map((o) => o.trim()).filter(Boolean);
    if (!q.trim() || options.length < 2) return;
    client.send({ t: 'pollCreate', question: q.trim(), options });
    setQ('');
    setOpts(['', '']);
  };

  return (
    <div className="panel">
      {canControl ? (
        <form
          className="poll-form"
          onSubmit={(e) => {
            e.preventDefault();
            create();
          }}
        >
          <input placeholder="Ask the room…  (e.g. What next?)" value={q} maxLength={120} onChange={(e) => setQ(e.target.value)} />
          {opts.map((o, i) => (
            <input key={i} placeholder={`Option ${i + 1}`} value={o} maxLength={LIMITS.label} onChange={(e) => setOpts(opts.map((x, j) => (j === i ? e.target.value : x)))} />
          ))}
          <div className="row">
            {opts.length < LIMITS.pollOptionsMax && <button type="button" onClick={() => setOpts([...opts, ''])}>＋ option</button>}
            <button className="primary">Start poll</button>
          </div>
        </form>
      ) : (
        <p className="muted">Only the host can start polls in this room.</p>
      )}

      {[...room.polls].reverse().map((p) => {
        const total = p.options.reduce((n, o) => n + o.votes.length, 0);
        const mine = p.options.find((o) => o.votes.includes(room.you))?.id;
        return (
          <div key={p.id} className={`poll ${p.open ? '' : 'closed'}`}>
            <h4>
              {p.question} <small>by {nameOf(room, p.createdBy)} · {total} vote{total === 1 ? '' : 's'}</small>
            </h4>
            {p.options.map((o) => (
              <button key={o.id} className={`opt ${mine === o.id ? 'mine' : ''}`} disabled={!p.open} onClick={() => client.send({ t: 'pollVote', pollId: p.id, optionId: o.id })}>
                <i style={{ width: `${total ? (o.votes.length / total) * 100 : 0}%` }} />
                <span>{o.label}</span>
                <b>{o.votes.length}</b>
              </button>
            ))}
            {p.open && (p.createdBy === room.you || room.hostId === room.you) && (
              <button className="link" onClick={() => client.send({ t: 'pollClose', pollId: p.id })}>Close poll</button>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ───────────────────────── Moments ───────────────────────── */

export function MomentsPanel() {
  const client = useClient();
  const room = useRoom();
  const canControl = room.settings.controls === 'everyone' || room.hostId === room.you;
  const sorted = [...room.markers].sort((a, b) => b.votes.length - a.votes.length || a.at - b.at);

  return (
    <div className="panel">
      <p className="muted">
        Moments are bookmarks the whole room can vote on. Two people marking within 3 s of each other count as one vote for the same Moment. The top ones become the Highlight Reel.
      </p>
      {sorted.length === 0 && <p className="muted">No Moments yet. Hit <b>⚑ Mark moment</b> under the player.</p>}
      {sorted.map((k) => {
        const voted = k.votes.includes(room.you);
        return (
          <div key={k.id} className="row-card">
            <button className="time-chip" disabled={!canControl} onClick={() => client.command('seek', Math.max(0, k.at - 2))} title="Jump here for everyone">
              {fmtTime(k.at)}
            </button>
            <span className="grow">
              <b>{k.label}</b>
              <small> · {nameOf(room, k.by)}</small>
            </span>
            <button className={voted ? 'on' : ''} onClick={() => client.send({ t: 'markerVote', markerId: k.id })} aria-pressed={voted}>
              ▲ {k.votes.length}
            </button>
            {(k.by === room.you || room.hostId === room.you) && (
              <button onClick={() => client.send({ t: 'markerRemove', markerId: k.id })} aria-label="Remove">✕</button>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ───────────────────────── People ───────────────────────── */

export function PeoplePanel() {
  const client = useClient();
  const room = useRoom();
  const [copied, setCopied] = useState(false);
  const invite = `${location.origin}/r/${room.code}`;
  const isHost = room.hostId === room.you;

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      window.prompt('Copy this link:', text);
    }
  };

  return (
    <div className="panel">
      <div className="invite">
        <div>
          <small>Room code</small>
          <strong className="code">{room.code}</strong>
        </div>
        <button className="primary" onClick={() => void copy(invite)}>{copied ? 'Copied ✓' : 'Copy invite link'}</button>
      </div>
      <h3 className="section">In the room ({room.members.filter((m) => m.connected).length})</h3>
      {room.members.map((m) => {
        const h = room.health.byId[m.id];
        return (
          <div key={m.id} className={`row-card ${m.connected ? '' : 'away'}`}>
            <span className="dot" style={{ background: m.color }} />
            <span className="grow">
              <b>{m.name}</b>
              {m.id === room.you && <small> (you)</small>}
              {m.isHost && <span className="crown" title="Host"> ♛</span>}
              {!m.connected && <small> · reconnecting…</small>}
              {m.buffering && <small> · buffering</small>}
            </span>
            {h && m.connected && <small className={Math.abs(h.driftMs) > 500 ? 'bad' : 'muted'}>{h.driftMs > 0 ? '+' : ''}{h.driftMs} ms</small>}
            {isHost && m.id !== room.you && m.connected && (
              <button onClick={() => client.send({ t: 'transferHost', to: m.id })} title="Make host">♛ Make host</button>
            )}
          </div>
        );
      })}
    </div>
  );
}
