import { isNetworkError } from './api';
import { deviceKey, type DiscoveredDevice } from './discoveryRegistry';

/**
 * Tapping Connect on a PC that went offline moments before the list caught up.
 *
 * That is not an error the user should have to decode: the failure is caught,
 * the PC is removed from the list at once, and one automatic re-check decides
 * whether it was only a blip.
 */

export const OFFLINE_MESSAGE = 'This device just went offline — tap to retry';

export type ConnectFailureOutcome =
  /** Not a reachability failure (e.g. pairing refused): handle it as before. */
  | 'not-a-race'
  /** The PC is gone; it stays out of the list until it announces itself again. */
  | 'offline'
  /** The one-shot re-check answered: the PC is back in the list. */
  | 'back-online';

export interface ConnectRaceDeps {
  /** Removes the PC from the live list right now. */
  forget(key: string): void;
  /** One HTTP check of the PC; on success it is re-added to the list as confirmed. */
  reprobe(device: DiscoveredDevice): Promise<boolean>;
  showMessage(text: string): void;
  isNetworkError?(err: unknown): boolean;
  /** Pause before the re-check, so a PC that is mid-restart has a moment. */
  retryDelayMs?: number;
  wait?(ms: number): Promise<void>;
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

// One re-check per PC at a time: ten rapid taps (or a flapping PC) must not stack probes.
const recheckInFlight = new Set<string>();

export async function handleDiscoveredConnectFailure(
  device: DiscoveredDevice,
  err: unknown,
  deps: ConnectRaceDeps
): Promise<ConnectFailureOutcome> {
  if (!(deps.isNetworkError ?? isNetworkError)(err)) return 'not-a-race';

  const key = deviceKey(device);
  deps.forget(key);
  deps.showMessage(OFFLINE_MESSAGE);

  if (recheckInFlight.has(key)) return 'offline';
  recheckInFlight.add(key);
  try {
    await (deps.wait ?? sleep)(deps.retryDelayMs ?? 800);
    if (await deps.reprobe(device)) {
      deps.showMessage(`${device.serverName || device.name} is back online — tap to connect`);
      return 'back-online';
    }
    return 'offline';
  } finally {
    recheckInFlight.delete(key);
  }
}
