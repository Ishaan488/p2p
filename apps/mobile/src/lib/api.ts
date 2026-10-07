import { bytesToHex, deviceKeyFromCode, hexToBytes, hmacHex, randomBytes, sessionKey, signRequest } from './crypto';

export class HttpError extends Error {
  code?: string; // machine-readable reason from the server, e.g. 'not_paired'
  constructor(public status: number, message: string, public body?: any) {
    super(message);
    this.code = body?.code;
  }
}

// What a device keeps after pairing with a PC.
export interface Pairing {
  serverId: string;
  serverName: string;
  deviceId: string;
  deviceName: string;
  key: string; // hex device key
}

interface Session {
  id: string;
  key: Uint8Array;
}

const REQUEST_TIMEOUT = 5000;

async function postJSON(url: string, body: unknown, signal?: AbortSignal): Promise<any> {
  // The body is sent without a JSON content type on purpose: it keeps the
  // request "simple" so cross-origin calls skip preflight.
  const res = await fetch(url, { method: 'POST', body: JSON.stringify(body), signal });
  const text = await res.text();
  let data: any;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  if (!res.ok) {
    throw new HttpError(res.status, data?.error || `Request failed (${res.status})`, data);
  }
  return data;
}

// Pairs this device with the PC at `host` using the code shown in its terminal.
// The code itself is never sent: both sides derive the device key from it.
export async function pairDevice(host: string, code: string, deviceId: string, deviceName: string): Promise<Pairing> {
  const key = deviceKeyFromCode(code, deviceId);
  const res = await postJSON(`http://${host}/pair`, {
    deviceId,
    name: deviceName,
    mac: hmacHex(key, `pair\n${deviceId}\n${deviceName}`)
  }, AbortSignal.timeout(REQUEST_TIMEOUT));
  if (res.proof !== hmacHex(key, `paired\n${res.serverId}`)) {
    throw new Error('The PC could not prove it knows the pairing code');
  }
  return { serverId: res.serverId, serverName: res.serverName, deviceId, deviceName: res.deviceName, key: bytesToHex(key) };
}

// HTTP side of the protocol: file data and transfer control. Every request is
// tied to a session and signed with its key.
export class ServerApi {
  host = '';
  private currentPairing: Pairing | null = null;
  private session: Promise<Session> | null = null;

  get pairing(): Pairing | null {
    return this.currentPairing;
  }

  set pairing(pairing: Pairing | null) {
    this.currentPairing = pairing;
    this.session = null;
  }

  // Starts a fresh session: both sides contribute a nonce, and the reply
  // proves the PC holds the device key as well.
  openSession(): Promise<Session> {
    const pairing = this.currentPairing;
    if (!pairing) {
      return Promise.reject(new HttpError(401, 'This device is not paired', { code: 'not_paired' }));
    }
    const session = (async () => {
      const clientNonce = randomBytes(16);
      const res = await postJSON(`http://${this.host}/hello`, {
        deviceId: pairing.deviceId,
        clientNonce: bytesToHex(clientNonce)
      }, AbortSignal.timeout(REQUEST_TIMEOUT));
      const key = sessionKey(hexToBytes(pairing.key), clientNonce, hexToBytes(res.serverNonce));
      if (res.proof !== hmacHex(key, 'server')) {
        throw new Error('The PC failed to prove its identity');
      }
      return { id: res.sessionId as string, key };
    })();
    this.session = session;
    session.catch(() => {
      if (this.session === session) this.session = null;
    });
    return session;
  }

  private async signedUrl(method: string, path: string, params: Record<string, string> = {}, scheme = 'http'): Promise<string> {
    const session = await (this.session || this.openSession());
    const signed = { ...params, sid: session.id };
    const query = new URLSearchParams({ ...signed, mac: signRequest(session.key, method, path, signed) });
    return `${scheme}://${this.host}${path}?${query}`;
  }

  // Runs a request, transparently opening a new session once if the PC no
  // longer knows ours (it restarted, or the session timed out).
  private async withSession<T>(request: () => Promise<T>): Promise<T> {
    try {
      return await request();
    } catch (err) {
      if (!(err instanceof HttpError && err.code === 'no_session')) throw err;
      this.session = null;
      return request();
    }
  }

  call<T = unknown>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    return this.withSession(async () => postJSON(await this.signedUrl('POST', path), body, signal));
  }

  uploadChunk(transferId: string, chunkIndex: number, data: Blob, signal?: AbortSignal): Promise<void> {
    return this.withSession(async () => {
      const url = await this.signedUrl('POST', '/upload', { transferId, chunkIndex: String(chunkIndex) });
      const res = await fetch(url, { method: 'POST', body: data, signal });
      if (!res.ok) {
        const body = await res.json().catch(() => undefined);
        throw new HttpError(res.status, body?.error || `Chunk upload failed (${res.status})`, body);
      }
    });
  }

  downloadUrl(transferId: string): Promise<string> {
    return this.signedUrl('GET', '/download_full', { transferId });
  }

  // A WebSocket cannot report why a handshake was refused, so always start it
  // from a brand new session: that surfaces "not paired" and "unreachable" up front.
  async wsUrl(): Promise<string> {
    await this.openSession();
    return this.signedUrl('GET', '/ws', {}, 'ws');
  }
}
