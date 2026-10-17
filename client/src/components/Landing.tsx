import { useState } from 'react';
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, ROOM_CODE_RE } from '@couchbeam/shared';
import { useClient, useClientSnapshot } from '../lib/useRoom';
import { Logo } from './Logo';

const NAME_KEY = 'couchbeam:name';

function codeFromUrl(): string {
  const m = /^\/r\/([A-Za-z0-9]{6})\/?$/.exec(location.pathname);
  return m ? m[1]!.toUpperCase() : '';
}

export function Landing() {
  const client = useClient();
  const { status, error } = useClientSnapshot();
  const [name, setName] = useState(() => {
    try {
      return localStorage.getItem(NAME_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const [code, setCode] = useState(codeFromUrl);
  const invited = codeFromUrl() !== '';
  const busy = status === 'connecting';
  const cleanName = name.trim();
  const codeOk = ROOM_CODE_RE.test(code);

  const remember = () => {
    try {
      localStorage.setItem(NAME_KEY, cleanName);
    } catch {
      /* private mode */
    }
  };

  return (
    <div className="landing">
      <div className="beam" aria-hidden />
      <div className="hero">
        <Logo big />
        <h1>Watch together.<br />Frame for frame.</h1>
        <p>
          Spin up a room, share the link, and everyone's playback stays locked within half a second — with time-locked chat, a crowd-sourced highlight reel and a live reaction heatmap.
        </p>

        <div className="card join">
          <label>
            Your name
            <input value={name} maxLength={24} onChange={(e) => setName(e.target.value)} placeholder="e.g. Baburoa" autoFocus />
          </label>

          {invited ? (
            <button
              className="primary big"
              disabled={!cleanName || busy || !codeOk}
              onClick={() => {
                remember();
                client.connect({ kind: 'join', code, name: cleanName });
              }}
            >
              {busy ? 'Joining…' : `Join room ${code}`}
            </button>
          ) : (
            <>
              <button
                className="primary big"
                disabled={!cleanName || busy}
                onClick={() => {
                  remember();
                  client.connect({ kind: 'create', name: cleanName });
                }}
              >
                {busy ? 'Creating…' : 'Create a room'}
              </button>
              <div className="or"><span>or join with a code</span></div>
              <form
                className="row"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!cleanName || !codeOk) return;
                  remember();
                  client.connect({ kind: 'join', code, name: cleanName });
                }}
              >
                <input
                  className="code-input"
                  value={code}
                  maxLength={ROOM_CODE_LENGTH}
                  onChange={(e) => setCode(e.target.value.toUpperCase().replace(new RegExp(`[^${ROOM_CODE_ALPHABET}]`, 'g'), ''))}
                  placeholder="K7M2QX"
                  aria-label="Room code"
                />
                <button disabled={!cleanName || !codeOk || busy}>Join</button>
              </form>
            </>
          )}
          {error && <p className="error" role="alert">{error}</p>}
        </div>
      </div>
    </div>
  );
}
