import { useEffect, useMemo } from 'react';
import { RoomClient, loadSession } from './lib/roomClient';
import { ClientContext, useClientSnapshot } from './lib/useRoom';
import { Landing } from './components/Landing';
import { RoomView } from './components/RoomView';

function Shell() {
  const { room } = useClientSnapshot();
  return room ? <RoomView /> : <Landing />;
}

export default function App() {
  const client = useMemo(() => new RoomClient(), []);

  // Page refresh / tab restore: silently rejoin the same seat with the signed resume token.
  useEffect(() => {
    const saved = loadSession();
    const urlCode = /^\/r\/([A-Za-z0-9]{6})\/?$/.exec(location.pathname)?.[1]?.toUpperCase();
    if (saved && (!urlCode || urlCode === saved.code)) {
      client.connect({ kind: 'join', code: saved.code, name: saved.name, resume: saved.resume });
    }
    return () => client.disconnect(false);
  }, [client]);

  return (
    <ClientContext.Provider value={client}>
      <Shell />
    </ClientContext.Provider>
  );
}
