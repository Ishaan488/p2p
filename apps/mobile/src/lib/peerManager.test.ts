import { describe, it, expect } from 'vitest';
import { PeerManager, buildSnapshot, type PeerEvent } from './peerManager';
import { MAX_CONNECTED_PEERS, MAX_PAIRED_PEERS, STORAGE_KEYS, loadPeers, type PeerRecord } from './peers';
import { FakeApi, FakeTransport, ManualTimers, MemoryStore, flush, networkError, pairing } from './peerTestKit';

function setup(seed: Array<{ id: string; name?: string; address?: string; autoConnect?: boolean; lastConnectedAt?: number }> = []) {
  const store = new MemoryStore();
  if (seed.length) {
    const records: PeerRecord[] = seed.map((s, i) => ({
      id: s.id, pairing: pairing(s.id, s.name ?? `PC ${s.id}`), address: s.address ?? `10.0.0.${i + 1}:8080`,
      autoConnect: s.autoConnect ?? true, autoAccept: true, addedAt: 1, lastConnectedAt: s.lastConnectedAt
    }));
    store.setItem(STORAGE_KEYS.peers, JSON.stringify(records));
  }
  const apis = new Map<string, FakeApi>();
  const transports = new Map<string, FakeTransport>();
  const timers = new ManualTimers();
  const manager = new PeerManager({
    store,
    createApi: (p) => { const a = new FakeApi(); a.pairing = p; apis.set(p.serverId, a); return a; },
    createTransport: () => new FakeTransport(),
    setTimer: timers.setTimer, clearTimer: timers.clearTimer, random: () => 0.5, staggerMs: 250, now: () => 1000
  });
  // capture each connection's transport for driving it from the test
  const transportOf = (id: string) => manager.connection(id)!.transport as FakeTransport;
  const events: PeerEvent[] = [];
  manager.onEvent(e => events.push(e));
  return { manager, store, apis, timers, transportOf, events, transports };
}

describe('starting up', () => {
  it('connects the PCs that want to be connected: the most recent at once, the rest staggered', async () => {
    const t = setup([
      { id: 'old', lastConnectedAt: 1 }, { id: 'new', lastConnectedAt: 9 }, { id: 'off', autoConnect: false }
    ]);
    t.manager.start();
    await flush();
    expect(t.manager.getSnapshot().peers.find(p => p.id === 'new')!.status).toBe('connected');
    expect(t.manager.getSnapshot().peers.find(p => p.id === 'old')!.status).toBe('idle'); // waits its turn
    t.timers.runNext();
    await flush();
    expect(t.manager.getSnapshot().peers.find(p => p.id === 'old')!.status).toBe('connected');
    expect(t.manager.getSnapshot().peers.find(p => p.id === 'off')!.status).toBe('idle'); // user turned it off
  });

  it('never opens more than the connection cap at launch', async () => {
    const t = setup(Array.from({ length: 9 }, (_, i) => ({ id: `p${i}` })));
    t.manager.start();
    while (t.timers.runNext()) await flush();
    await flush();
    expect(t.manager.getSnapshot().connected.length).toBe(MAX_CONNECTED_PEERS);
  });

  it('starts empty when nothing is paired', () => {
    const t = setup();
    t.manager.start();
    expect(t.manager.getSnapshot().peers).toEqual([]);
    expect(t.manager.getSnapshot().aggregate).toBe('disconnected');
  });
});

describe('several PCs connected at once', () => {
  it('keeps independent connections and reports each', async () => {
    const t = setup([{ id: 'a' }, { id: 'b' }]);
    await t.manager.connect('a');
    await t.manager.connect('b');
    const s = t.manager.getSnapshot();
    expect(s.connected.map(p => p.id)).toEqual(['a', 'b']);
    expect(s.aggregate).toBe('connected');
  });

  it('one PC dropping does not affect the other', async () => {
    const t = setup([{ id: 'a' }, { id: 'b' }]);
    await t.manager.connect('a');
    await t.manager.connect('b');
    t.transportOf('a').drop();
    const s = t.manager.getSnapshot();
    expect(s.peers.find(p => p.id === 'a')!.status).toBe('offline');
    expect(s.peers.find(p => p.id === 'b')!.status).toBe('connected');
    expect(s.aggregate).toBe('connected');
    expect(t.events.some(e => e.type === 'dropped' && e.peerId === 'a')).toBe(true);
  });

  it('routes incoming messages with the PC they came from', async () => {
    const t = setup([{ id: 'a' }, { id: 'b' }]);
    const got: Array<[string, string]> = [];
    t.manager.onMessage((id, data) => got.push([id, data]));
    await t.manager.connect('a');
    await t.manager.connect('b');
    t.transportOf('b').receive('from-b');
    t.transportOf('a').receive('from-a');
    expect(got).toEqual([['b', 'from-b'], ['a', 'from-a']]);
  });

  it('sends to exactly the PC asked for', async () => {
    const t = setup([{ id: 'a' }, { id: 'b' }]);
    await t.manager.connect('a');
    await t.manager.connect('b');
    expect(t.manager.send('a', 'hi')).toBe(true);
    expect(t.transportOf('a').sent).toEqual(['hi']);
    expect(t.transportOf('b').sent).toEqual([]);
    expect(t.manager.send('nope', 'x')).toBe(false);
  });

  it('refuses a connection beyond the cap with a clear message, and allows it again after a disconnect', async () => {
    const t = setup(Array.from({ length: MAX_CONNECTED_PEERS + 1 }, (_, i) => ({ id: `p${i}` })));
    for (let i = 0; i < MAX_CONNECTED_PEERS; i++) await t.manager.connect(`p${i}`);
    const extra = await t.manager.connect(`p${MAX_CONNECTED_PEERS}`);
    expect(extra).toMatchObject({ ok: false, kind: 'limit' });
    expect((extra as { message: string }).message).toContain(String(MAX_CONNECTED_PEERS));
    t.manager.disconnect('p0');
    expect((await t.manager.connect(`p${MAX_CONNECTED_PEERS}`)).ok).toBe(true);
  });

  it('a PC that is already connected is not blocked by the cap', async () => {
    const t = setup(Array.from({ length: MAX_CONNECTED_PEERS }, (_, i) => ({ id: `p${i}` })));
    for (let i = 0; i < MAX_CONNECTED_PEERS; i++) await t.manager.connect(`p${i}`);
    expect((await t.manager.connect('p0')).ok).toBe(true);
  });
});

describe('who a send goes to', () => {
  it('defaults to every connected PC', async () => {
    const t = setup([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    await t.manager.connect('a');
    await t.manager.connect('b');
    expect(t.manager.getSnapshot().targets.map(p => p.id)).toEqual(['a', 'b']); // c is not connected
  });

  it('lets the user switch one off, and on again, and remembers it', async () => {
    const t = setup([{ id: 'a' }, { id: 'b' }]);
    await t.manager.connect('a');
    await t.manager.connect('b');
    t.manager.setExcluded('b', true);
    expect(t.manager.getSnapshot().targets.map(p => p.id)).toEqual(['a']);
    expect(t.manager.getSnapshot().peers.find(p => p.id === 'b')!.excluded).toBe(true);
    const again = new PeerManager({ store: t.store, createApi: () => new FakeApi(), createTransport: () => new FakeTransport() });
    expect(again.getSnapshot().peers.find(p => p.id === 'b')!.excluded).toBe(true);
    t.manager.setExcluded('b', false);
    expect(t.manager.getSnapshot().targets.map(p => p.id)).toEqual(['a', 'b']);
  });

  it('can end up with no recipients, which the UI must handle', async () => {
    const t = setup([{ id: 'a' }]);
    await t.manager.connect('a');
    t.manager.setExcluded('a', true);
    expect(t.manager.getSnapshot().targets).toEqual([]);
    expect(t.manager.getSnapshot().connected).toHaveLength(1);
  });

  it('a PC that drops stops being a target, and is a target again when it returns', async () => {
    const t = setup([{ id: 'a' }, { id: 'b' }]);
    await t.manager.connect('a');
    await t.manager.connect('b');
    t.transportOf('b').drop();
    expect(t.manager.getSnapshot().targets.map(p => p.id)).toEqual(['a']);
    t.timers.runNext();
    await flush();
    expect(t.manager.getSnapshot().targets.map(p => p.id).sort()).toEqual(['a', 'b']);
  });

  it('ignores unknown ids', () => {
    const t = setup([{ id: 'a' }]);
    t.manager.setExcluded('ghost', true);
    expect(t.manager.getSnapshot().peers.every(p => !p.excluded)).toBe(true);
  });
});

describe('which PC settings apply to', () => {
  it('prefers the chosen connected PC, else the first connected, else the chosen, else the first', async () => {
    const t = setup([{ id: 'a' }, { id: 'b' }]);
    expect(t.manager.getSnapshot().focused!.id).toBe('a');
    await t.manager.connect('b');
    expect(t.manager.getSnapshot().focused!.id).toBe('b');
    await t.manager.connect('a');
    t.manager.setFocused('a');
    expect(t.manager.getSnapshot().focused!.id).toBe('a');
    t.transportOf('a').drop();
    expect(t.manager.getSnapshot().focused!.id).toBe('b'); // the one that is actually reachable
  });

  it('is null when nothing is paired', () => {
    expect(setup().manager.getSnapshot().focused).toBeNull();
  });
});

describe('adding, re-pairing, removing', () => {
  it('adds a PC, persists it, and announces it', () => {
    const t = setup();
    const r = t.manager.add(pairing('new-1', 'Office'), '10.0.0.5:8080');
    expect(r).toEqual({ ok: true, id: 'new-1', replaced: false });
    expect(loadPeers(t.store).map(p => p.id)).toEqual(['new-1']);
    expect(t.events).toContainEqual({ type: 'added', peerId: 'new-1', replaced: false });
  });

  it('pairing with a PC again replaces it instead of listing it twice, and keeps its settings', () => {
    const t = setup([{ id: 'a' }]);
    t.manager.setAutoAccept('a', false);
    const r = t.manager.add({ ...pairing('a', 'Renamed'), key: 'cd'.repeat(32) }, '10.0.0.77:8080');
    expect(r).toMatchObject({ ok: true, replaced: true });
    const peers = t.manager.getSnapshot().peers;
    expect(peers).toHaveLength(1);
    expect(peers[0]).toMatchObject({ serverName: 'Renamed', address: '10.0.0.77:8080', autoAccept: false });
    expect(t.manager.record('a')!.pairing.key).toBe('cd'.repeat(32));
  });

  it('stops at the pairing limit, but still lets an existing PC be refreshed', () => {
    const t = setup(Array.from({ length: MAX_PAIRED_PEERS }, (_, i) => ({ id: `p${i}` })));
    expect(t.manager.add(pairing('extra'), 'x:1')).toMatchObject({ ok: false, reason: 'limit' });
    expect(t.manager.add(pairing('p3'), 'x:1')).toMatchObject({ ok: true, replaced: true });
    expect(t.manager.pairedCount).toBe(MAX_PAIRED_PEERS);
  });

  it('removing tells the PC, closes the link, and forgets every trace', async () => {
    const t = setup([{ id: 'a' }, { id: 'b' }]);
    await t.manager.connect('a');
    t.manager.setExcluded('a', true);
    t.manager.setFocused('a');
    await t.manager.remove('a');
    expect(t.apis.get('a')!.unpairCalls).toBe(1);
    expect(t.manager.getSnapshot().peers.map(p => p.id)).toEqual(['b']);
    expect(loadPeers(t.store).map(p => p.id)).toEqual(['b']);
    expect(t.store.getItem(STORAGE_KEYS.excluded)).not.toContain('a');
    expect(t.manager.getSnapshot().focused!.id).toBe('b');
    expect(t.events).toContainEqual({ type: 'removed', peerId: 'a' });
  });

  it('removing an offline PC still works (it cannot be told)', async () => {
    const t = setup([{ id: 'a' }]);
    await t.manager.remove('a');
    expect(t.apis.get('a')!.unpairCalls).toBe(0);
    expect(t.manager.pairedCount).toBe(0);
  });

  it('survives removing an unknown PC', async () => {
    const t = setup([{ id: 'a' }]);
    await expect(t.manager.remove('ghost')).resolves.toBeUndefined();
    expect(t.manager.pairedCount).toBe(1);
  });
});

describe('disconnect is the user\'s choice and sticks', () => {
  it('a disconnected PC is not brought back by wakeAll or a restart', async () => {
    const t = setup([{ id: 'a' }, { id: 'b' }]);
    await t.manager.connect('a');
    await t.manager.connect('b');
    t.manager.disconnect('a');
    expect(t.manager.getSnapshot().peers.find(p => p.id === 'a')!.status).toBe('idle');
    t.manager.wakeAll();
    await flush();
    expect(t.manager.getSnapshot().peers.find(p => p.id === 'a')!.status).toBe('idle');
    expect(loadPeers(t.store).find(p => p.id === 'a')!.autoConnect).toBe(false);
    // ...until the user connects it again
    expect((await t.manager.connect('a')).ok).toBe(true);
    expect(loadPeers(t.store).find(p => p.id === 'a')!.autoConnect).toBe(true);
  });

  it('wakeAll brings back PCs that dropped while the app was away', async () => {
    const t = setup([{ id: 'a' }, { id: 'b' }]);
    await t.manager.connect('a');
    await t.manager.connect('b');
    t.transportOf('a').drop();
    t.transportOf('b').drop();
    t.manager.wakeAll();
    await flush();
    expect(t.manager.getSnapshot().connected).toHaveLength(2);
  });
});

describe('a PC changes address', () => {
  it('remembers the new address and reconnects a PC that was down', async () => {
    const t = setup([{ id: 'a', address: '10.0.0.1:8080' }]);
    t.apis.get('a')!.failWith = networkError();
    await t.manager.connect('a');
    expect(t.manager.getSnapshot().peers[0].status).toBe('offline');
    t.apis.get('a')!.failWith = null;
    t.manager.updateAddress('a', '10.0.0.99:8080');
    await flush();
    expect(t.manager.getSnapshot().peers[0]).toMatchObject({ status: 'connected', address: '10.0.0.99:8080' });
    expect(t.apis.get('a')!.host).toBe('10.0.0.99:8080');
    expect(loadPeers(t.store)[0].address).toBe('10.0.0.99:8080');
  });

  it('does not disturb a PC that is connected', async () => {
    const t = setup([{ id: 'a', address: '10.0.0.1:8080' }]);
    await t.manager.connect('a');
    t.manager.updateAddress('a', '10.0.0.2:8080');
    expect(t.apis.get('a')!.openCalls).toBe(1);
    expect(t.manager.getSnapshot().peers[0].status).toBe('connected');
    // a PC with several adapters announces from each; a healthy link must not chase them
    expect(t.manager.getSnapshot().peers[0].address).toBe('10.0.0.1:8080');
    expect(loadPeers(t.store)[0].address).toBe('10.0.0.1:8080');
  });

  it('ignores an unchanged address or an unknown PC', () => {
    const t = setup([{ id: 'a', address: '10.0.0.1:8080' }]);
    t.manager.updateAddress('a', '10.0.0.1:8080');
    t.manager.updateAddress('ghost', 'x:1');
    expect(t.manager.getSnapshot().peers[0].address).toBe('10.0.0.1:8080');
  });
});

describe('what the UI sees', () => {
  it('tells two PCs with the same name apart', () => {
    const t = setup([{ id: 'a', name: 'LAPTOP', address: '10.0.0.1:8080' }, { id: 'b', name: 'LAPTOP', address: '10.0.0.2:8080' }]);
    const [a, b] = t.manager.getSnapshot().peers;
    expect(a.name).not.toBe(b.name);
    expect(a.serverName).toBe(b.serverName);
  });

  it('aggregate status: connected > connecting > error > disconnected', () => {
    const rec = (id: string): PeerRecord => ({ id, pairing: pairing(id), address: '', autoConnect: true, autoAccept: true, addedAt: 1 });
    const recs = [rec('a'), rec('b')];
    const agg = (a: string, b: string) => buildSnapshot(recs, new Map([['a', { status: a as never }], ['b', { status: b as never }]]), new Set(), null).aggregate;
    expect(agg('connected', 'offline')).toBe('connected');
    expect(agg('offline', 'reconnecting')).toBe('connecting');
    expect(agg('offline', 'idle')).toBe('error');
    expect(agg('unpaired', 'idle')).toBe('error');
    expect(agg('idle', 'idle')).toBe('disconnected');
  });

  it('hands out a new snapshot only when something changed, and stops notifying after unsubscribe', async () => {
    const t = setup([{ id: 'a' }]);
    const first = t.manager.getSnapshot();
    expect(t.manager.getSnapshot()).toBe(first); // stable between changes (required by useSyncExternalStore)
    let calls = 0;
    const off = t.manager.subscribe(() => { calls++; });
    await t.manager.connect('a');
    expect(calls).toBeGreaterThan(0);
    expect(t.manager.getSnapshot()).not.toBe(first);
    off();
    const before = calls;
    t.manager.setExcluded('a', true);
    expect(calls).toBe(before);
  });

  it('records when a PC was last connected', async () => {
    const t = setup([{ id: 'a' }]);
    await t.manager.connect('a');
    expect(t.manager.getSnapshot().peers[0].lastConnectedAt).toBe(1000);
  });

  it('is quiet after dispose', async () => {
    const t = setup([{ id: 'a' }]);
    await t.manager.connect('a');
    let calls = 0;
    t.manager.subscribe(() => { calls++; });
    t.manager.dispose();
    expect(calls).toBe(0);
  });
});
