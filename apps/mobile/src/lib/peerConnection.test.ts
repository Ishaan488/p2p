import { describe, it, expect, vi } from 'vitest';
import { PeerConnection } from './peerConnection';
import { FakeApi, FakeTransport, ManualTimers, deferred, flush, networkError, notPairedError } from './peerTestKit';
import { RECONNECT_FIRST_DELAY_MS } from './reconnect';

function setup(over: { autoConnect?: boolean } = {}) {
  const api = new FakeApi();
  const transport = new FakeTransport();
  const timers = new ManualTimers();
  const events = { change: 0, connected: 0, dropped: 0, messages: [] as string[] };
  const conn = new PeerConnection('192.168.1.10:8080', over.autoConnect ?? true, {
    api, transport, getName: () => 'Office PC',
    onChange: () => { events.change++; },
    onMessage: d => events.messages.push(d),
    onConnected: () => { events.connected++; },
    onDropped: () => { events.dropped++; },
    setTimer: timers.setTimer, clearTimer: timers.clearTimer, random: () => 0.5
  });
  return { api, transport, timers, events, conn };
}

describe('connecting', () => {
  it('goes connecting -> connected and uses the stored address', async () => {
    const { conn, api, events } = setup();
    const p = conn.connect();
    expect(conn.status).toBe('connecting');
    expect(await p).toEqual({ ok: true });
    expect(conn.status).toBe('connected');
    expect(api.host).toBe('192.168.1.10:8080');
    expect(events.connected).toBe(1);
  });

  it('accepts a new address and strips scheme and path', async () => {
    const { conn, api } = setup();
    await conn.connect('http://192.168.1.99:8081/index.html');
    expect(api.host).toBe('192.168.1.99:8081');
    expect(conn.address).toBe('http://192.168.1.99:8081/index.html');
  });

  it('shares one attempt between simultaneous calls', async () => {
    const { conn, api } = setup();
    const gate = deferred();
    api.hold = gate.promise;
    const a = conn.connect();
    const b = conn.connect();
    gate.release();
    await Promise.all([a, b]);
    expect(api.openCalls).toBe(1);
  });

  it('does nothing when already connected', async () => {
    const { conn, api } = setup();
    await conn.connect();
    expect(await conn.connect()).toEqual({ ok: true });
    expect(api.openCalls).toBe(1);
  });
});

describe('failing and retrying', () => {
  it('reports an unreachable PC in plain language and schedules a retry', async () => {
    const { conn, api, timers } = setup();
    api.failWith = networkError();
    const r = await conn.connect();
    expect(r).toMatchObject({ ok: false, kind: 'unreachable' });
    expect(conn.status).toBe('offline');
    expect(conn.error).toContain('Office PC');
    expect(conn.error).not.toMatch(/Failed to fetch/);
    expect(timers.delays).toEqual([RECONNECT_FIRST_DELAY_MS]);
  });

  it('retries on its own, and recovers when the PC returns', async () => {
    const { conn, api, timers, events } = setup();
    api.failWith = networkError();
    await conn.connect();
    api.failWith = null;
    timers.runNext();
    expect(conn.status).toBe('reconnecting');
    await flush();
    expect(conn.status).toBe('connected');
    expect(events.connected).toBe(1);
    expect(timers.pending.size).toBe(0);
  });

  it('backs off while the PC stays away and starts over once it is back', async () => {
    const { conn, api, timers } = setup();
    api.failWith = networkError();
    const seen: number[] = [];
    await conn.connect();
    for (let i = 0; i < 5; i++) {
      seen.push(...timers.delays);
      timers.runNext();
      await flush();
    }
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(seen[4]).toBeGreaterThan(seen[0]);
    api.failWith = null;
    timers.runNext();
    await flush();
    expect(conn.status).toBe('connected');
    // after a success the next failure starts from the short delay again
    conn.transport.disconnect();
    (conn.transport as FakeTransport).drop();
    expect(timers.delays).toEqual([RECONNECT_FIRST_DELAY_MS]);
  });

  it('does not retry when auto-connect is off', async () => {
    const { conn, api, timers } = setup({ autoConnect: false });
    api.failWith = networkError();
    await conn.connect();
    expect(conn.status).toBe('offline');
    expect(timers.pending.size).toBe(0);
  });

  it('treats a failed WebSocket handshake like an unreachable PC', async () => {
    const { conn, transport, timers } = setup();
    transport.failNext = new Error('Connection failed');
    expect(await conn.connect()).toMatchObject({ ok: false, kind: 'unreachable' });
    expect(timers.pending.size).toBe(1);
  });
});

describe('the PC has forgotten this phone', () => {
  it('stops and asks for pairing instead of retrying forever', async () => {
    const { conn, api, timers } = setup();
    api.failWith = notPairedError();
    const r = await conn.connect();
    expect(r).toMatchObject({ ok: false, kind: 'unpaired' });
    expect(conn.status).toBe('unpaired');
    expect(conn.error).toContain('Scan its QR code');
    expect(timers.pending.size).toBe(0);
  });

  it('wake() leaves an unpaired PC alone', async () => {
    const { conn, api } = setup();
    api.failWith = notPairedError();
    await conn.connect();
    conn.wake();
    expect(api.openCalls).toBe(1);
  });
});

describe('dropping and waking', () => {
  it('notices a dropped link, says so, and retries', async () => {
    const { conn, transport, timers, events } = setup();
    await conn.connect();
    transport.drop();
    expect(conn.status).toBe('offline');
    expect(conn.error).toBe('Connection lost');
    expect(events.dropped).toBe(1);
    expect(timers.pending.size).toBe(1);
  });

  it('ignores transport noise that is not a drop of an established link', async () => {
    const { conn, transport, events } = setup();
    transport.drop('error'); // while idle
    expect(events.dropped).toBe(0);
    expect(conn.status).toBe('idle');
  });

  it('wake() reconnects at once instead of waiting out the backoff', async () => {
    const { conn, api, transport, timers } = setup();
    await conn.connect();
    transport.drop();
    expect(timers.pending.size).toBe(1);
    conn.wake();
    await flush();
    expect(conn.status).toBe('connected');
    expect(timers.pending.size).toBe(0);
    expect(api.openCalls).toBe(2);
  });

  it('wake() does nothing while connected, while connecting, or when auto-connect is off', async () => {
    const { conn, api } = setup();
    await conn.connect();
    conn.wake();
    expect(api.openCalls).toBe(1);

    const off = setup({ autoConnect: false });
    off.conn.wake();
    expect(off.api.openCalls).toBe(0);
  });
});

describe('disconnecting', () => {
  it('stops everything: no retry, idle, socket closed', async () => {
    const { conn, transport, api, timers } = setup();
    api.failWith = networkError();
    await conn.connect();
    expect(timers.pending.size).toBe(1);
    conn.disconnect();
    expect(timers.pending.size).toBe(0);
    expect(conn.status).toBe('idle');
    expect(transport.connected).toBe(false);
  });

  it('a disconnect during a connect wins: the late success is discarded and the socket closed', async () => {
    const { conn, transport, api } = setup();
    const gate = deferred();
    api.hold = gate.promise;
    const p = conn.connect();
    conn.disconnect();
    gate.release();
    const r = await p;
    expect(r.ok).toBe(false);
    expect(conn.status).toBe('idle');
    expect(transport.connectCalls).toBe(0); // never even opened the socket
  });

  it('a disconnect while the socket is opening closes it', async () => {
    const { conn, transport } = setup();
    const gate = deferred();
    transport.hold = gate.promise;
    const p = conn.connect();
    await flush();
    conn.disconnect();
    gate.release();
    await p;
    expect(transport.connected).toBe(false);
    expect(conn.status).toBe('idle');
  });

  it('can be connected again afterwards', async () => {
    const { conn } = setup();
    await conn.connect();
    conn.disconnect();
    expect(await conn.connect()).toEqual({ ok: true });
    expect(conn.status).toBe('connected');
  });

  it('dispose is final: no messages, no retries, no connecting', async () => {
    const { conn, transport, timers, events } = setup();
    await conn.connect();
    conn.dispose();
    transport.receive('late');
    expect(events.messages).toEqual([]);
    expect((await conn.connect()).ok).toBe(false);
    expect(timers.pending.size).toBe(0);
  });
});

describe('messages', () => {
  it('forwards what the PC sends', async () => {
    const { conn, transport, events } = setup();
    await conn.connect();
    transport.receive('{"type":"text"}');
    expect(events.messages).toEqual(['{"type":"text"}']);
  });

  it('send() only works on a live link', async () => {
    const { conn, transport } = setup();
    expect(conn.send('x')).toBe(false);
    await conn.connect();
    expect(conn.send('hello')).toBe(true);
    expect(transport.sent).toEqual(['hello']);
    transport.drop();
    expect(conn.send('again')).toBe(false);
  });

  it('notifies listeners of each status change', async () => {
    const { conn, events } = setup();
    const before = events.change;
    await conn.connect();
    expect(events.change).toBeGreaterThan(before);
    void vi;
  });
});
