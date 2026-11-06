import { describe, it, expect, vi } from 'vitest';
import { HttpError } from './api';
import { handleDiscoveredConnectFailure, OFFLINE_MESSAGE, type ConnectRaceDeps } from './connectRace';
import { DeviceRegistry, deviceKey, type DiscoveredDevice } from './discoveryRegistry';

const device: DiscoveredDevice = {
  name: 'Office PC', serverName: 'Office PC', host: '192.168.1.10', port: 8080, scheme: 'http', id: 'srv-a', state: 'confirmed'
};
const networkError = new TypeError('Failed to fetch');
const instantly = () => Promise.resolve();

function deps(over: Partial<ConnectRaceDeps> = {}) {
  const messages: string[] = [];
  const order: string[] = [];
  const d: ConnectRaceDeps = {
    forget: key => order.push(`forget:${key}`),
    reprobe: vi.fn(async () => { order.push('reprobe'); return false; }),
    showMessage: text => { messages.push(text); order.push('message'); },
    wait: instantly,
    ...over
  };
  return { d, messages, order };
}

describe('tapping Connect on a PC that just went offline', () => {
  it('removes the device from the list immediately and shows a clear message, not the raw error', async () => {
    const { d, messages, order } = deps();
    const outcome = await handleDiscoveredConnectFailure(device, networkError, d);
    expect(outcome).toBe('offline');
    expect(order.slice(0, 2)).toEqual(['forget:id:srv-a', 'message']); // removed before anything else happens
    expect(messages[0]).toBe(OFFLINE_MESSAGE);
    expect(OFFLINE_MESSAGE).toContain('just went offline');
    expect(OFFLINE_MESSAGE).toContain('tap to retry');
    expect(messages.join(' ')).not.toMatch(/Failed to fetch|timed out|network/i);
  });

  it('does the one-shot re-probe after the message, and only once', async () => {
    const { d, order } = deps();
    await handleDiscoveredConnectFailure(device, networkError, d);
    expect(order).toEqual(['forget:id:srv-a', 'message', 'reprobe']);
    expect(d.reprobe).toHaveBeenCalledTimes(1);
  });

  it('says the PC is back when the re-probe answers', async () => {
    const { d, messages } = deps({ reprobe: vi.fn(async () => true) });
    const outcome = await handleDiscoveredConnectFailure(device, networkError, d);
    expect(outcome).toBe('back-online');
    expect(messages[messages.length - 1]).toMatch(/Office PC is back online/);
  });

  it('treats timeouts and aborts like any other unreachable-PC failure', async () => {
    for (const err of [new DOMException('t', 'TimeoutError'), new DOMException('a', 'AbortError'), new Error('Connection timed out')]) {
      const { d } = deps();
      expect(await handleDiscoveredConnectFailure(device, err, d)).toBe('offline');
    }
  });

  it('leaves real server answers (pairing refused, not paired) to the normal error handling', async () => {
    const { d, messages } = deps();
    const forget = vi.fn();
    const outcome = await handleDiscoveredConnectFailure(device, new HttpError(403, 'The PC did not approve this device'), { ...d, forget });
    expect(outcome).toBe('not-a-race');
    expect(forget).not.toHaveBeenCalled();
    expect(messages).toEqual([]);
    expect(d.reprobe).not.toHaveBeenCalled();
  });

  it('does not stack re-probes when the same PC fails repeatedly (rapid taps, flapping)', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const { d } = deps({ wait: () => gate });
    const first = handleDiscoveredConnectFailure(device, networkError, d);
    const second = handleDiscoveredConnectFailure(device, networkError, d);
    const third = handleDiscoveredConnectFailure(device, networkError, d);
    release();
    await Promise.all([first, second, third]);
    expect(d.reprobe).toHaveBeenCalledTimes(1);
    // once it has finished, a later failure may re-probe again
    await handleDiscoveredConnectFailure(device, networkError, d);
    expect(d.reprobe).toHaveBeenCalledTimes(2);
  });

  it('different PCs are re-probed independently', async () => {
    const { d } = deps();
    await Promise.all([
      handleDiscoveredConnectFailure(device, networkError, d),
      handleDiscoveredConnectFailure({ ...device, id: 'srv-b', host: '192.168.1.11' }, networkError, d)
    ]);
    expect(d.reprobe).toHaveBeenCalledTimes(2);
  });

  it('waits the configured pause before re-probing', async () => {
    const wait = vi.fn(instantly);
    const { d } = deps({ wait, retryDelayMs: 1234 });
    await handleDiscoveredConnectFailure(device, networkError, d);
    expect(wait).toHaveBeenCalledWith(1234);
  });
});

describe('together with the live device list', () => {
  /** Registry whose HTTP probe answers according to `reachable`. */
  function liveList(reachable: { value: boolean }) {
    const list = new Map<string, DiscoveredDevice>();
    let t = 5_000_000;
    const reg = new DeviceRegistry({
      now: () => t,
      backoffBaseMs: 10_000,
      verify: async d => (reachable.value ? { ...d } : null),
      onDevice: d => list.set(deviceKey(d), d),
      onLost: key => list.delete(key)
    });
    return { reg, list, advance: (ms: number) => { t += ms; } };
  }

  it('a device that went offline: it vanishes from the list on the failed tap and stays gone', async () => {
    const reachable = { value: true };
    const { reg, list, advance } = liveList(reachable);
    reg.confirmed(device);
    expect([...list.keys()]).toEqual(['id:srv-a']);

    reachable.value = false; // the PC just shut down, but the list has not caught up yet
    const { messages } = (() => {
      const m: string[] = [];
      return { messages: m };
    })();
    const outcome = await handleDiscoveredConnectFailure(device, networkError, {
      forget: key => reg.forget(key),
      reprobe: d => reg.reprobe(d),
      showMessage: t => messages.push(t),
      wait: instantly
    });

    expect(outcome).toBe('offline');
    expect(list.size).toBe(0); // removed from the discovered list
    expect(messages[0]).toBe(OFFLINE_MESSAGE);

    // The PC's announces that were already in flight must not bring it straight back.
    advance(1500);
    reg.sighting({ ...device, state: undefined });
    expect(list.size).toBe(0);
  });

  it('a blip: the automatic re-probe puts the device back as confirmed', async () => {
    const reachable = { value: true };
    const { reg, list } = liveList(reachable);
    reg.confirmed(device);
    reachable.value = true; // it answers the re-probe even though the connect attempt just failed
    const outcome = await handleDiscoveredConnectFailure(device, networkError, {
      forget: key => reg.forget(key),
      reprobe: d => reg.reprobe(d),
      showMessage: () => {},
      wait: instantly
    });
    expect(outcome).toBe('back-online');
    expect(list.get('id:srv-a')?.state).toBe('confirmed');
  });

  it('after the backoff, a PC that really returns appears again', async () => {
    const reachable = { value: false };
    const { reg, list, advance } = liveList(reachable);
    reg.confirmed(device);
    await handleDiscoveredConnectFailure(device, networkError, {
      forget: key => reg.forget(key), reprobe: d => reg.reprobe(d), showMessage: () => {}, wait: instantly
    });
    expect(list.size).toBe(0);
    reachable.value = true;
    advance(11_000);
    reg.sighting({ ...device, state: undefined });
    expect(list.get('id:srv-a')?.state).toBe('appearing');
    await new Promise(r => setImmediate(r));
    expect(list.get('id:srv-a')?.state).toBe('confirmed');
  });
});
