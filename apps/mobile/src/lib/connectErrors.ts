import { isNetworkError } from './api';

/** Plain-language reason for a failed connection, for the one place a person reads it. */
export function describeConnectFailure(err: unknown, host: string, name?: string): string {
  if (!isNetworkError(err)) return err instanceof Error ? err.message : 'Connection failed';
  const timedOut = err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError');
  const who = name ? name : `the desktop at ${host}`;
  return `${timedOut ? 'No answer from' : 'Could not reach'} ${who}. Check that P2P Link is running on the PC ` +
    'and both devices are on the same Wi-Fi (campus/public Wi-Fi often isolates devices; a mobile hotspot works).';
}
