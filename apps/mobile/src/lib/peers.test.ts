import { describe, it, expect } from 'vitest';
import {
  MAX_PAIRED_PEERS, STORAGE_KEYS, attributeLegacyItems, chipLabel, describeTargets, displayNames, isValidPairing,
  loadExcluded, loadPeers, pruneExcluded, removePeer, saveExcluded, savePeers, upsertPeer, type PeerRecord
} from './peers';
import { MemoryStore, pairing } from './peerTestKit';

const rec = (id: string, over: Partial<PeerRecord> = {}): PeerRecord => ({
  id, pairing: pairing(id), address: `10.0.0.${id.length}:8080`, autoConnect: true, autoAccept: true, addedAt: 1, ...over
});
const isValidPeer = (p: PeerRecord) => isValidPairing(p.pairing) && p.id === p.pairing.serverId;

describe('migration from the single-PC versions', () => {
  it('turns the old pairing + address + flags into one peer and removes the old pairing key', () => {
    const s = new MemoryStore();
    s.setItem(STORAGE_KEYS.legacyPairing, JSON.stringify(pairing('srv-1', 'Office')));
    s.setItem(STORAGE_KEYS.legacyAddress, '192.168.1.10:8080');
    s.setItem(STORAGE_KEYS.legacyAutoConnect, 'false');
    s.setItem(STORAGE_KEYS.legacyTrust, 'false');
    const peers = loadPeers(s, () => 42);
    expect(peers).toHaveLength(1);
    expect(peers[0]).toMatchObject({ id: 'srv-1', address: '192.168.1.10:8080', autoConnect: false, autoAccept: false, addedAt: 42 });
    expect(s.getItem(STORAGE_KEYS.legacyPairing)).toBeNull();
    expect(loadPeers(s)).toHaveLength(1); // now read from the new key
  });

  it('defaults to auto-connect and auto-accept when the old flags were never set', () => {
    const s = new MemoryStore();
    s.setItem(STORAGE_KEYS.legacyPairing, JSON.stringify(pairing('srv-1')));
    expect(loadPeers(s)[0]).toMatchObject({ autoConnect: true, autoAccept: true, address: '' });
  });

  it('ignores a corrupt or incomplete old pairing', () => {
    for (const bad of ['{not json', JSON.stringify({ serverId: 'x' }), JSON.stringify({ ...pairing('a'), key: 'short' })]) {
      const s = new MemoryStore();
      s.setItem(STORAGE_KEYS.legacyPairing, bad);
      expect(loadPeers(s)).toEqual([]);
    }
  });

  it('does not migrate again once the new list exists, even if empty', () => {
    const s = new MemoryStore();
    s.setItem(STORAGE_KEYS.peers, '[]');
    s.setItem(STORAGE_KEYS.legacyPairing, JSON.stringify(pairing('srv-1')));
    expect(loadPeers(s)).toEqual([]);
  });
});

describe('loading and saving the list', () => {
  it('drops invalid and duplicate entries and caps the length', () => {
    const s = new MemoryStore();
    const many = Array.from({ length: MAX_PAIRED_PEERS + 5 }, (_, i) => rec(`p${i}`));
    s.setItem(STORAGE_KEYS.peers, JSON.stringify([rec('a'), rec('a'), { junk: true }, null, 'x', ...many]));
    const out = loadPeers(s);
    expect(out.filter(p => p.id === 'a')).toHaveLength(1);
    expect(out.length).toBeLessThanOrEqual(MAX_PAIRED_PEERS);
    expect(out.every(isValidPeer)).toBe(true);
  });

  it('survives garbage in storage', () => {
    const s = new MemoryStore();
    s.setItem(STORAGE_KEYS.peers, '{{{');
    expect(loadPeers(s)).toEqual([]);
    s.setItem(STORAGE_KEYS.peers, '{"not":"an array"}');
    expect(loadPeers(s)).toEqual([]);
  });

  it('round-trips', () => {
    const s = new MemoryStore();
    savePeers(s, [rec('a'), rec('b', { autoAccept: false })]);
    expect(loadPeers(s).map(p => [p.id, p.autoAccept])).toEqual([['a', true], ['b', false]]);
  });

  it('does not throw when storage is full', () => {
    const s = new MemoryStore();
    s.setItem = () => { throw new DOMException('full', 'QuotaExceededError'); };
    expect(() => savePeers(s, [rec('a')])).not.toThrow();
  });

  it('upsert replaces the same PC but keeps its settings; remove drops it', () => {
    const list = [rec('a', { autoAccept: false, addedAt: 5 }), rec('b')];
    const next = upsertPeer(list, rec('a', { address: 'new:1', autoAccept: true, addedAt: 99 }));
    expect(next).toHaveLength(2);
    expect(next[0]).toMatchObject({ address: 'new:1', autoAccept: false, addedAt: 5 });
    expect(removePeer(next, 'a').map(p => p.id)).toEqual(['b']);
  });
});

describe('who a send goes to', () => {
  it('stores exclusions and forgets PCs that are gone', () => {
    const s = new MemoryStore();
    saveExcluded(s, new Set(['a', 'gone']));
    expect([...loadExcluded(s)].sort()).toEqual(['a', 'gone']);
    expect([...pruneExcluded(loadExcluded(s), ['a', 'b'])]).toEqual(['a']);
  });

  it('tolerates a corrupt exclusion list', () => {
    const s = new MemoryStore();
    s.setItem(STORAGE_KEYS.excluded, '[1,null,"ok",{}]');
    expect([...loadExcluded(s)]).toEqual(['ok']);
    s.setItem(STORAGE_KEYS.excluded, 'nope');
    expect(loadExcluded(s).size).toBe(0);
  });
});

describe('names', () => {
  it('keeps unique names as they are', () => {
    const n = displayNames([{ id: 'a', name: 'Office', address: '1.1.1.1:8080' }, { id: 'b', name: 'Laptop', address: '1.1.1.2:8080' }]);
    expect([n.get('a'), n.get('b')]).toEqual(['Office', 'Laptop']);
  });

  it('tells two PCs with the same name apart by address', () => {
    const n = displayNames([{ id: 'a', name: 'LAPTOP', address: '192.168.1.10:8080' }, { id: 'b', name: 'laptop', address: '192.168.1.22:8080' }]);
    expect(n.get('a')).toBe('LAPTOP (192.168.1.10)');
    expect(n.get('b')).toBe('laptop (192.168.1.22)');
  });

  it('still produces unique labels when the addresses are missing or equal', () => {
    const n = displayNames([{ id: 'a', name: 'PC', address: '' }, { id: 'b', name: 'PC', address: '' }, { id: 'c', name: 'PC', address: '' }]);
    expect(new Set(n.values()).size).toBe(3);
  });

  it('falls back to a generic name for blank ones', () => {
    expect(displayNames([{ id: 'a', name: '  ', address: '' }]).get('a')).toBe('Desktop PC');
  });

  it('words the recipients', () => {
    expect(describeTargets([])).toBe('');
    expect(describeTargets(['A'])).toBe('A');
    expect(describeTargets(['A', 'B'])).toBe('A and B');
    expect(describeTargets(['A', 'B', 'C', 'D'])).toBe('A, B +2');
    expect(chipLabel([])).toBe('No device');
    expect(chipLabel(['A'])).toBe('A');
    expect(chipLabel(['A', 'B', 'C'])).toBe('3 devices');
  });
});

describe('history from before multi-device support', () => {
  const items = [{ id: '1' }, { id: '2', peerId: 'x', peerName: 'X' }] as Array<{ id: string; peerId?: string; peerName?: string }>;
  it('is attributed to the only paired PC', () => {
    const out = attributeLegacyItems(items, [{ id: 'a', name: 'Office' }]);
    expect(out[0]).toMatchObject({ peerId: 'a', peerName: 'Office' });
    expect(out[1].peerId).toBe('x'); // never overwritten
  });
  it('is left alone when it cannot be known', () => {
    expect(attributeLegacyItems(items, []).every((it, i) => it === items[i])).toBe(true);
    expect(attributeLegacyItems(items, [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }])[0].peerId).toBeUndefined();
  });
});
