import { describe, it, expect, vi } from 'vitest';
import { DeviceRegistry, deviceKey, type DiscoveredDevice, type RegistryConfig } from './discoveryRegistry';

/** A registry on a fake clock whose HTTP verification the test answers by hand. */
function setup(overrides: Partial<RegistryConfig> = {}) {
  let t = 1_000_000;
  const events: Array<{ type: 'device' | 'lost'; device?: DiscoveredDevice; key?: string }> = [];
  const pending: Array<{ device: DiscoveredDevice; resolve: (r: DiscoveredDevice | null) => void }> = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  let verifyCalls = 0;

  const reg = new DeviceRegistry({
    now: () => t,
    verify: device => {
      verifyCalls++;
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      return new Promise<DiscoveredDevice | null>(resolve =>
        pending.push({
          device,
          resolve: r => {
            concurrent--;
            resolve(r);
          }
        })
      );
    },
    onDevice: device => events.push({ type: 'device', device }),
    onLost: key => events.push({ type: 'lost', key }),
    ...overrides
  });

  const flush = () => new Promise<void>(r => setImmediate(r));
  return {
    reg,
    events,
    pending,
    flush,
    advance: (ms: number) => { t += ms; },
    now: () => t,
    stats: () => ({ verifyCalls, maxConcurrent }),
    /** Answers the oldest unanswered verification. */
    async answer(result: DiscoveredDevice | null | 'ok') {
      const p = pending.shift()!;
      p.resolve(result === 'ok' ? { ...p.device } : result);
      await flush();
    },
    states: () => events.filter(e => e.type === 'device').map(e => e.device!.state),
    lost: () => events.filter(e => e.type === 'lost').map(e => e.key)
  };
}

const pc = (over: Partial<DiscoveredDevice> = {}): DiscoveredDevice => ({
  name: 'Office PC', host: '192.168.1.10', port: 8080, scheme: 'http', id: 'srv-a', ...over
});

describe('appearing -> confirmed', () => {
  it('shows a sighting immediately as "appearing", before verification finishes', () => {
    const s = setup();
    s.reg.sighting(pc());
    expect(s.states()).toEqual(['appearing']);
    expect(s.pending).toHaveLength(1); // the probe is still running
  });

  it('marks it confirmed once the probe succeeds', async () => {
    const s = setup();
    s.reg.sighting(pc());
    await s.answer('ok');
    expect(s.states()).toEqual(['appearing', 'confirmed']);
    expect(s.reg.snapshot()[0].state).toBe('confirmed');
  });

  it('drops it silently (no confirmed state ever shown) when the probe fails', async () => {
    const s = setup();
    s.reg.sighting(pc());
    await s.answer(null);
    expect(s.states()).toEqual(['appearing']);
    expect(s.lost()).toEqual(['id:srv-a']);
    expect(s.reg.size).toBe(0);
  });

  it('backs off after a failed probe, then accepts the PC again', async () => {
    const s = setup({ backoffBaseMs: 5000 });
    s.reg.sighting(pc());
    await s.answer(null);
    s.advance(1000);
    s.reg.sighting(pc()); // announces keep arriving every 1-2s
    expect(s.stats().verifyCalls).toBe(1); // ...but must not re-probe inside the backoff
    expect(s.reg.size).toBe(0);
    s.advance(5000);
    s.reg.sighting(pc());
    expect(s.reg.size).toBe(1);
    expect(s.stats().verifyCalls).toBe(2);
  });

  it('grows the backoff exponentially for a PC that keeps failing', async () => {
    const s = setup({ backoffBaseMs: 1000, backoffCapMs: 60_000 });
    for (const wait of [1000, 2000, 4000]) {
      s.reg.sighting(pc());
      await s.answer(null);
      s.advance(wait - 1);
      s.reg.sighting(pc());
      expect(s.reg.size).toBe(0); // still blocked just before the window ends
      s.advance(2);
    }
  });

  it('trusts HTTPS PCs as announced (a page cannot probe a self-signed certificate)', () => {
    const s = setup();
    s.reg.sighting(pc({ scheme: 'https' }));
    expect(s.states()).toEqual(['confirmed']);
    expect(s.pending).toHaveLength(0);
  });

  it('rejects an address that answers as a different PC', async () => {
    const s = setup();
    s.reg.sighting(pc());
    await s.answer(pc({ id: 'someone-else' }));
    expect(s.reg.size).toBe(0);
  });

  it('adopts the address that answered when the announced one was unreachable', async () => {
    const s = setup();
    s.reg.sighting(pc({ host: '172.20.0.1', ips: ['172.20.0.1', '192.168.1.10'] }));
    await s.answer(pc({ host: '192.168.1.10' }));
    expect(s.reg.snapshot()[0].host).toBe('192.168.1.10');
  });
});

describe('removal: timeout is the reliable path', () => {
  it('removes a PC that stopped announcing, and not before the timeout', () => {
    const s = setup({ ttlMs: 5000 });
    s.reg.sighting(pc({ scheme: 'https' }));
    s.advance(5000);
    s.reg.sweep();
    expect(s.reg.size).toBe(1); // exactly at the limit: still alive
    s.advance(1);
    s.reg.sweep();
    expect(s.reg.size).toBe(0);
    expect(s.lost()).toEqual(['id:srv-a']);
  });

  it('keeps a PC that is heard from (liveness refresh) and drops it once it goes quiet', () => {
    const s = setup({ ttlMs: 5000 });
    s.reg.sighting(pc({ scheme: 'https' }));
    for (let i = 0; i < 6; i++) {
      s.advance(1500);
      s.reg.alive(['id:srv-a']);
      s.reg.sweep();
    }
    expect(s.reg.size).toBe(1);
    s.advance(5001);
    s.reg.sweep();
    expect(s.reg.size).toBe(0);
  });

  it('does not remove a PC whose announce lands just before the sweep', () => {
    const s = setup({ ttlMs: 5000 });
    s.reg.sighting(pc({ scheme: 'https' }));
    s.advance(4900);
    s.reg.alive(['id:srv-a']); // the announce arrives...
    s.advance(900); // ...and the sweep runs 900ms later: only 900ms of silence
    s.reg.sweep();
    expect(s.reg.size).toBe(1);
  });

  it('re-reads the PC before removing it, so a touch during the sweep wins', () => {
    // Simulates an announce being processed between the sweep's scan and its removal.
    let t = 1_000_000;
    let calls = 0;
    let inHook = false;
    let regRef!: DeviceRegistry;
    const reg = new DeviceRegistry({
      ttlMs: 5000,
      verify: async () => null,
      onDevice: () => {},
      onLost: () => {},
      now: () => {
        calls++;
        if (calls === 3 && !inHook) { // 1: sighting, 2: scan, 3: the re-check
          inHook = true;
          t += 6000;
          regRef.alive(['id:srv-a']);
          inHook = false;
        }
        return t;
      }
    });
    regRef = reg;
    reg.sighting(pc({ scheme: 'https' }));
    t += 6000; // stale by the scan
    reg.sweep();
    expect(reg.size).toBe(1);
  });

  it('only expires PCs that are actually stale, leaving fresh ones alone', () => {
    const s = setup({ ttlMs: 5000 });
    s.reg.sighting(pc({ scheme: 'https', id: 'old' }));
    s.advance(4000);
    s.reg.sighting(pc({ scheme: 'https', id: 'new', host: '192.168.1.11' }));
    s.advance(1500);
    s.reg.sweep();
    expect(s.reg.snapshot().map(d => d.id)).toEqual(['new']);
  });

  it('gives everything a fresh grace period when the app returns from the background', () => {
    const s = setup({ ttlMs: 5000 });
    s.reg.sighting(pc({ scheme: 'https' }));
    s.advance(60_000); // asleep: no announces were processed
    s.reg.touchAll();
    s.reg.sweep();
    expect(s.reg.size).toBe(1);
    s.advance(5001);
    s.reg.sweep();
    expect(s.reg.size).toBe(0); // still goes away if it really left
  });
});

describe('goodbye is a fast path on top of the timeout', () => {
  it('removes the PC at once', () => {
    const s = setup();
    s.reg.sighting(pc({ scheme: 'https', boot: 1, seq: 5 }));
    s.reg.remove({ id: 'srv-a', boot: 1, seq: 6 });
    expect(s.reg.size).toBe(0);
  });

  it('ignores an announce that was sent before the goodbye but arrived after it', () => {
    const s = setup();
    s.reg.sighting(pc({ scheme: 'https', boot: 1, seq: 5 }));
    s.reg.remove({ id: 'srv-a', boot: 1, seq: 6 });
    s.reg.sighting(pc({ scheme: 'https', boot: 1, seq: 5 })); // delayed
    s.reg.sighting(pc({ scheme: 'https', boot: 1, seq: 4 })); // delayed more
    expect(s.reg.size).toBe(0);
  });

  it('accepts the PC again after a restart (new boot) or a later announce', () => {
    const s = setup();
    s.reg.sighting(pc({ scheme: 'https', boot: 1, seq: 5 }));
    s.reg.remove({ id: 'srv-a', boot: 1, seq: 6 });
    s.reg.sighting(pc({ scheme: 'https', boot: 2, seq: 1 }));
    expect(s.reg.size).toBe(1);

    s.reg.remove({ id: 'srv-a', boot: 2, seq: 9 });
    s.reg.sighting(pc({ scheme: 'https', boot: 2, seq: 10 }));
    expect(s.reg.size).toBe(1);
  });

  it('ignores a stale goodbye that a newer announce already overtook', () => {
    const s = setup();
    s.reg.sighting(pc({ scheme: 'https', boot: 1, seq: 10 }));
    s.reg.remove({ id: 'srv-a', boot: 1, seq: 4 });
    expect(s.reg.size).toBe(1);
    // ...including a goodbye from the PC's previous run, delivered after it restarted
    s.reg.sighting(pc({ scheme: 'https', boot: 2, seq: 1 }));
    s.reg.remove({ id: 'srv-a', boot: 1, seq: 99 });
    expect(s.reg.size).toBe(1);
  });

  it('works without sequence numbers (older PCs), with a short quiet period against stale caches', () => {
    const s = setup();
    s.reg.sighting(pc({ scheme: 'https' }));
    s.reg.remove({ id: 'srv-a' });
    s.advance(500);
    s.reg.sighting(pc({ scheme: 'https' })); // e.g. a cached mDNS record
    expect(s.reg.size).toBe(0);
    s.advance(2000);
    s.reg.sighting(pc({ scheme: 'https' }));
    expect(s.reg.size).toBe(1);
  });

  it('removes by mDNS service name or host for PCs without an id', () => {
    const s = setup();
    s.reg.sighting({ name: 'Home', host: '10.0.0.5', port: 8080, scheme: 'https', nsdName: 'p2p-HOME' });
    s.reg.remove({ nsdName: 'p2p-HOME' });
    expect(s.reg.size).toBe(0);
    s.reg.sighting({ name: 'Home', host: '10.0.0.5', port: 8080, scheme: 'https' });
    s.reg.remove({ host: '10.0.0.5' });
    expect(s.reg.size).toBe(0);
  });
});

describe('duplicate and out-of-order announces', () => {
  it('treats the same announce arriving via several broadcast addresses as one', async () => {
    const s = setup();
    for (let i = 0; i < 3; i++) s.reg.sighting(pc({ boot: 1, seq: 7 }));
    expect(s.events.filter(e => e.type === 'device')).toHaveLength(1);
    expect(s.stats().verifyCalls).toBe(1);
  });

  it('does not let an older, reordered announce refresh a PC', () => {
    const s = setup({ ttlMs: 5000 });
    s.reg.sighting(pc({ scheme: 'https', boot: 1, seq: 20 }));
    s.advance(4000);
    s.reg.sighting(pc({ scheme: 'https', boot: 1, seq: 12 })); // delayed packet from long ago
    s.advance(1500);
    s.reg.sweep();
    expect(s.reg.size).toBe(0); // it proved nothing about now
  });

  it('refreshes on a newer announce without re-emitting an unchanged PC', () => {
    const s = setup({ ttlMs: 5000 });
    s.reg.sighting(pc({ scheme: 'https', boot: 1, seq: 1 }));
    const before = s.events.length;
    for (let seq = 2; seq < 8; seq++) {
      s.advance(1500);
      s.reg.sighting(pc({ scheme: 'https', boot: 1, seq }));
      s.reg.sweep();
    }
    expect(s.reg.size).toBe(1);
    expect(s.events.length).toBe(before); // heartbeats do not cause UI updates
  });

  it('lets a restarted PC (larger boot) supersede and ignores packets from its old run', () => {
    const s = setup({ ttlMs: 5000 });
    s.reg.sighting(pc({ scheme: 'https', boot: 1, seq: 50 }));
    s.reg.sighting(pc({ scheme: 'https', boot: 2, seq: 1 }));
    s.advance(4000);
    s.reg.sighting(pc({ scheme: 'https', boot: 1, seq: 51 })); // straggler from the old process
    s.advance(1500);
    s.reg.sweep();
    expect(s.reg.size).toBe(0);
  });
});

describe('one PC, several channels', () => {
  it('merges an mDNS sighting (no id) with a UDP one (with id) at the same address', () => {
    const s = setup();
    s.reg.sighting({ name: 'Office PC', host: '192.168.1.10', port: 8080, scheme: 'https' });
    s.reg.sighting({ name: 'Office PC', host: '192.168.1.10', port: 8080, scheme: 'https', id: 'srv-a' });
    expect(s.reg.size).toBe(1);
    expect(s.reg.snapshot()[0].id).toBe('srv-a');
    expect(s.lost()).toEqual(['addr:192.168.1.10:8080']); // the list swaps the key, never shows two rows
    s.reg.sighting({ name: 'Office PC', host: '192.168.1.10', port: 8080, scheme: 'https' }); // mDNS again
    expect(s.reg.size).toBe(1);
  });

  it('follows a PC that moves to another address and verifies the new one', async () => {
    const s = setup();
    s.reg.sighting(pc());
    await s.answer('ok');
    s.reg.sighting(pc({ host: '192.168.1.99' }));
    expect(s.reg.size).toBe(1);
    expect(s.reg.snapshot()[0]).toMatchObject({ host: '192.168.1.99', state: 'appearing' });
    await s.answer('ok');
    expect(s.reg.snapshot()[0].state).toBe('confirmed');
  });

  it('ignores the answer of a probe that was started for an address the PC has since left', async () => {
    const s = setup();
    s.reg.sighting(pc());
    s.reg.sighting(pc({ host: '192.168.1.99' })); // moved while the first probe is running
    await s.answer(null); // the old address fails
    expect(s.reg.size).toBe(1); // must not tear down the entry that now lives at the new address
    await s.answer('ok');
    expect(s.reg.snapshot()[0]).toMatchObject({ host: '192.168.1.99', state: 'confirmed' });
  });
});

describe('bounded work on a busy network', () => {
  it('never lists more than maxDevices, evicting unverified PCs first', async () => {
    const s = setup({ maxDevices: 5 });
    for (let i = 0; i < 5; i++) s.reg.sighting(pc({ id: `p${i}`, host: `10.0.0.${i}`, scheme: 'https' }));
    s.reg.sighting(pc({ id: 'unverified', host: '10.0.1.1' })); // evicts a stale-or-appearing slot or is refused
    for (let i = 5; i < 50; i++) s.reg.sighting(pc({ id: `p${i}`, host: `10.0.0.${i}` }));
    expect(s.reg.size).toBeLessThanOrEqual(5);
  });

  it('refuses newcomers rather than evicting PCs that are all freshly heard', () => {
    const s = setup({ maxDevices: 3 });
    for (let i = 0; i < 3; i++) s.reg.sighting(pc({ id: `p${i}`, host: `10.0.0.${i}`, scheme: 'https' }));
    s.reg.sighting(pc({ id: 'late', host: '10.0.0.9', scheme: 'https' }));
    expect(s.reg.snapshot().map(d => d.id).sort()).toEqual(['p0', 'p1', 'p2']);
  });

  it('caps concurrent and queued verifications, so a burst of sightings cannot become a probe storm', async () => {
    const s = setup({ verifyConcurrency: 2, maxQueued: 4 });
    for (let i = 0; i < 40; i++) s.reg.sighting(pc({ id: `p${i}`, host: `10.0.0.${i}` }));
    expect(s.stats().maxConcurrent).toBeLessThanOrEqual(2);
    expect(s.reg.size).toBeLessThanOrEqual(2 + 4); // in flight + queued; the rest were shed
    while (s.pending.length) await s.answer('ok');
    expect(s.stats().maxConcurrent).toBeLessThanOrEqual(2);
  });

  it('does not re-probe PCs that flap back within the verified-memory window', async () => {
    const s = setup({ ttlMs: 5000, verifiedMemoryMs: 30_000 });
    for (let i = 0; i < 10; i++) s.reg.sighting(pc({ id: `p${i}`, host: `10.0.0.${i}` }));
    while (s.pending.length) await s.answer('ok');
    const probesAfterFirstRound = s.stats().verifyCalls;
    for (let round = 0; round < 3; round++) {
      s.advance(6000);
      s.reg.sweep(); // everyone "flaps" away...
      expect(s.reg.size).toBe(0);
      for (let i = 0; i < 10; i++) s.reg.sighting(pc({ id: `p${i}`, host: `10.0.0.${i}` })); // ...and back
      expect(s.reg.size).toBe(10);
    }
    expect(s.stats().verifyCalls).toBe(probesAfterFirstRound);
  });

  it('verifies again once the memory of a past verification has expired', async () => {
    const s = setup({ ttlMs: 5000, verifiedMemoryMs: 10_000 });
    s.reg.sighting(pc());
    await s.answer('ok');
    s.advance(20_000);
    s.reg.sweep();
    s.reg.sighting(pc());
    expect(s.reg.snapshot()[0].state).toBe('appearing');
    expect(s.stats().verifyCalls).toBe(2);
  });

  it('keeps its bookkeeping bounded when many different PCs fail', async () => {
    const s = setup({ verifyConcurrency: 100, maxQueued: 5000, maxDevices: 5000 });
    for (let i = 0; i < 900; i++) s.reg.sighting(pc({ id: `f${i}`, host: `10.1.${Math.floor(i / 250)}.${i % 250}` }));
    while (s.pending.length) await s.answer(null);
    expect(s.reg.size).toBe(0);
    // 900 distinct failures, each remembered under its id and its address, yet the memory stays capped.
    expect(s.reg.bookkeeping.failures).toBeLessThanOrEqual(512);
    expect(s.reg.bookkeeping.queued).toBe(0);
  });

  it('re-checks quiet PCs a few at a time and never removes one for a single missed probe', async () => {
    const s = setup({ ttlMs: 5000 });
    for (let i = 0; i < 5; i++) {
      s.reg.sighting(pc({ id: `q${i}`, host: `10.0.0.${i}` }));
      await s.answer('ok');
    }
    s.advance(3500);
    s.reg.refreshQuiet(3000, 2);
    expect(s.pending).toHaveLength(2); // bounded per tick
    await s.answer(null); // one probe is lost
    expect(s.reg.size).toBe(5);
    await s.answer('ok'); // the other answers and is refreshed
    s.advance(2000);
    s.reg.sweep();
    expect(s.reg.size).toBe(1); // only the one that answered stayed fresh; the silent ones aged out by the TTL
  });
});

describe('forget / reprobe (used after a failed connect)', () => {
  it('forget removes the PC now and keeps it away while it backs off', () => {
    const s = setup({ backoffBaseMs: 10_000 });
    s.reg.sighting(pc({ scheme: 'https' }));
    s.reg.forget('id:srv-a');
    expect(s.reg.size).toBe(0);
    expect(s.lost()).toEqual(['id:srv-a']);
    s.advance(1500);
    s.reg.sighting(pc({ scheme: 'https' })); // it still announces (UDP works, TCP does not)
    expect(s.reg.size).toBe(0);
    s.advance(10_000);
    s.reg.sighting(pc({ scheme: 'https' }));
    expect(s.reg.size).toBe(1);
  });

  it('forgetting also drops the memory of a past verification, so a returning PC is probed again', async () => {
    const s = setup({ backoffBaseMs: 1000 });
    s.reg.sighting(pc());
    await s.answer('ok');
    s.reg.forget('id:srv-a');
    s.advance(1500);
    s.reg.sighting(pc());
    expect(s.reg.snapshot()[0].state).toBe('appearing');
  });

  it('reprobe re-adds a PC that answers, even during the backoff', async () => {
    const s = setup({ backoffBaseMs: 60_000 });
    s.reg.sighting(pc({ scheme: 'https' }));
    s.reg.forget('id:srv-a');
    const result = s.reg.reprobe(pc());
    await s.answer('ok');
    expect(await result).toBe(true);
    expect(s.reg.snapshot()[0]).toMatchObject({ id: 'srv-a', state: 'confirmed' });
  });

  it('reprobe leaves the PC out when it does not answer', async () => {
    const s = setup();
    const result = s.reg.reprobe(pc());
    await s.answer(null);
    expect(await result).toBe(false);
    expect(s.reg.size).toBe(0);
  });

  it('shares one probe between concurrent reprobes of the same PC', async () => {
    const s = setup();
    const a = s.reg.reprobe(pc());
    const b = s.reg.reprobe(pc());
    expect(s.stats().verifyCalls).toBe(1);
    await s.answer('ok');
    expect(await Promise.all([a, b])).toEqual([true, true]);
  });

  it('treats a verify() that throws as unreachable', async () => {
    const reg = new DeviceRegistry({ verify: () => Promise.reject(new Error('boom')), onDevice: vi.fn(), onLost: vi.fn() });
    expect(await reg.reprobe(pc())).toBe(false);
  });
});

describe('teardown', () => {
  it('emits nothing after dispose, even for probes still in flight', async () => {
    const s = setup();
    s.reg.sighting(pc());
    const seen = s.events.length;
    s.reg.dispose();
    await s.answer('ok');
    s.reg.sighting(pc({ id: 'x' }));
    s.reg.sweep();
    expect(s.events.length).toBe(seen);
    expect(s.reg.size).toBe(0);
  });

  it('deviceKey prefers the server id', () => {
    expect(deviceKey({ id: 'a', host: 'h', port: 1 })).toBe('id:a');
    expect(deviceKey({ host: 'h', port: 1 })).toBe('addr:h:1');
  });
});
