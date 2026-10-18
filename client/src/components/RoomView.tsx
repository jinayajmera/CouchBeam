import { useEffect, useState } from 'react';
import { useClient, useClientSnapshot, useRoom } from '../lib/useRoom';
import { Player } from './Player';
import { Discover } from './Discover';
import { ChatPanel, MomentsPanel, PeoplePanel, PollsPanel, QueuePanel } from './Panels';
import { Logo } from './Logo';

type Tab = 'chat' | 'discover' | 'queue' | 'polls' | 'moments' | 'people';

export function RoomView() {
  const client = useClient();
  const room = useRoom();
  const { status, toast } = useClientSnapshot();
  const [tab, setTab] = useState<Tab>('chat');
  const [shownToast, setShownToast] = useState<string | null>(null);

  useEffect(() => {
    if (!toast) return;
    setShownToast(toast.text);
    const id = setTimeout(() => setShownToast(null), 3500);
    return () => clearTimeout(id);
  }, [toast]);

  useEffect(() => {
    const on = (e: Event) => setTab((e as CustomEvent<Tab>).detail);
    window.addEventListener('couchbeam:tab', on);
    return () => window.removeEventListener('couchbeam:tab', on);
  }, []);

  const openPolls = room.polls.filter((p) => p.open).length;
  const tabs: [Tab, string, number?][] = [
    ['chat', 'Chat'],
    ['discover', 'Discover'],
    ['queue', 'Queue', room.queue.length],
    ['polls', 'Polls', openPolls],
    ['moments', 'Moments', room.markers.length],
    ['people', 'People', room.members.filter((m) => m.connected).length],
  ];

  return (
    <div className="room">
      <header className="topbar">
        <Logo />
        <button className="code-pill" onClick={() => setTab('people')} title="Show invite options">
          {room.code}
        </button>
        {status === 'reconnecting' && <span className="status warn">Reconnecting…</span>}
        <span className="spacer" />
        <button onClick={() => client.disconnect(true)}>Leave</button>
      </header>

      <main className="layout">
        <Player />
        <aside className="side card">
          <nav className="tabs" role="tablist">
            {tabs.map(([id, label, n]) => (
              <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>
                {label}
                {n ? <span className="badge">{n}</span> : null}
              </button>
            ))}
          </nav>
          <div className="tabbody">
            {tab === 'chat' && <ChatPanel />}
            {tab === 'discover' && <Discover />}
            {tab === 'queue' && <QueuePanel />}
            {tab === 'polls' && <PollsPanel />}
            {tab === 'moments' && <MomentsPanel />}
            {tab === 'people' && <PeoplePanel />}
          </div>
        </aside>
      </main>

      {shownToast && <div className="toast" role="status">{shownToast}</div>}
    </div>
  );
}
