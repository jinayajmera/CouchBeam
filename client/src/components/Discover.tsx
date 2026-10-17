import { useMemo, useState } from 'react';
import { CATALOG, CATEGORIES, fuzzySearch, getMedia, type MediaItem } from '@couchbeam/shared';
import { useClient, useRoom } from '../lib/useRoom';

type Sort = 'match' | 'rating' | 'newest' | 'shortest';

/** "More like this": category overlap (Jaccard) blended with rating, excluding what is already on. */
function similar(current: MediaItem, limit = 3): MediaItem[] {
  const a = new Set(current.categories);
  return CATALOG.filter((m) => m.id !== current.id)
    .map((m) => {
      const inter = m.categories.filter((c) => a.has(c)).length;
      const union = new Set([...a, ...m.categories]).size;
      return { m, score: inter / union + m.rating / 40 };
    })
    .filter((x) => x.score > 0.2)
    .sort((x, y) => y.score - x.score)
    .slice(0, limit)
    .map((x) => x.m);
}

function Card({ m, canControl, onPlay, onQueue }: { m: MediaItem; canControl: boolean; onPlay: () => void; onQueue: () => void }) {
  return (
    <article className="title">
      <div className="poster" style={{ background: `linear-gradient(145deg, ${m.tint[0]}, ${m.tint[1]})` }}>
        <span>{m.title.replace(/^(the|a|an)\s+/i, '').charAt(0)}</span>
        <em>★ {m.rating.toFixed(1)}</em>
      </div>
      <div className="meta">
        <h4>{m.title}</h4>
        <small>
          {m.year} · {m.durationSec >= 120 ? `${Math.round(m.durationSec / 60)} min` : `${m.durationSec} s`}
        </small>
        <p>{m.description}</p>
        <div className="tags">
          {m.categories.map((c) => (
            <span key={c}>{c}</span>
          ))}
        </div>
        <div className="row">
          <button className="primary" disabled={!canControl} onClick={onPlay}>▶ Play now</button>
          <button onClick={onQueue}>＋ Queue</button>
        </div>
      </div>
    </article>
  );
}

export function Discover() {
  const client = useClient();
  const room = useRoom();
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>('match');
  const canControl = room.settings.controls === 'everyone' || room.hostId === room.you;
  const current = room.state.mediaId ? getMedia(room.state.mediaId) : undefined;

  const items = useMemo(() => {
    let list = cat ? CATALOG.filter((m) => m.categories.includes(cat)) : CATALOG;
    list = fuzzySearch(list, q, (m) => `${m.title} ${m.categories.join(' ')} ${m.description}`);
    if (sort === 'rating') list = [...list].sort((a, b) => b.rating - a.rating);
    if (sort === 'newest') list = [...list].sort((a, b) => b.year - a.year);
    if (sort === 'shortest') list = [...list].sort((a, b) => a.durationSec - b.durationSec);
    return list; // 'match' keeps fuzzy order (or catalog order when the query is empty)
  }, [q, cat, sort]);

  const recs = useMemo(() => (current && !q ? similar(current) : []), [current, q]);

  const play = (m: MediaItem) => client.send({ t: 'setMedia', mediaId: m.id });
  const queue = (m: MediaItem) => client.send({ t: 'queueAdd', mediaId: m.id });

  return (
    <div className="discover">
      <div className="filters">
        <input type="search" placeholder="Search titles, genres… (typos are fine)" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search the catalog" />
        <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort">
          <option value="match">Best match</option>
          <option value="rating">Top rated</option>
          <option value="newest">Newest</option>
          <option value="shortest">Shortest</option>
        </select>
      </div>
      <div className="chips">
        <button className={cat === null ? 'on' : ''} onClick={() => setCat(null)}>All</button>
        {CATEGORIES.map((c) => (
          <button key={c} className={cat === c ? 'on' : ''} onClick={() => setCat(cat === c ? null : c)}>
            {c}
          </button>
        ))}
      </div>

      {recs.length > 0 && (
        <>
          <h3 className="section">More like {current!.title}</h3>
          <div className="grid">
            {recs.map((m) => (
              <Card key={m.id} m={m} canControl={canControl} onPlay={() => play(m)} onQueue={() => queue(m)} />
            ))}
          </div>
        </>
      )}

      <h3 className="section">{q || cat ? `${items.length} result${items.length === 1 ? '' : 's'}` : 'Everything'}</h3>
      <div className="grid">
        {items.map((m) => (
          <Card key={m.id} m={m} canControl={canControl} onPlay={() => play(m)} onQueue={() => queue(m)} />
        ))}
        {items.length === 0 && <p className="muted">Nothing matches “{q}”. Try fewer letters.</p>}
      </div>
    </div>
  );
}
