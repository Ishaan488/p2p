import {
  Cipher, bytesToHex, chunkContext, deviceKeyFromCode, hexToBytes, hmacHex, randomBytes, randomHex, sessionKey, signRequest, utf8ToBytes
} from './crypto';

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
  scheme?: 'http' | 'https';
  certFingerprint?: string;
}

interface Session {
  id: string;
  key: Uint8Array;
  cipher: Cipher;
}

interface SignedRequest {
  url: string;
  nonce: string;
  session: Session;
}

const REQUEST_TIMEOUT = 5000;
const APPROVAL_TIMEOUT = 70000; // the PC waits up to 60 s for its owner to approve

// Errors are the one thing the server sends in the clear (a session may not
// exist yet), so they carry a message and a code but never data to act on.
async function failure(res: Response, fallback: string): Promise<HttpError> {
  const body = await res.json().catch(() => undefined);
  return new HttpError(res.status, body?.error || `${fallback} (${res.status})`, body);
}

// Used by the two calls that run before a session exists.
async function postJSON(url: string, body: unknown, signal?: AbortSignal): Promise<any> {
  // The body is sent without a JSON content type on purpose: it keeps the
  // request "simple" so cross-origin calls skip preflight.
  const res = await fetch(url, { method: 'POST', body: JSON.stringify(body), signal });
  if (!res.ok) throw await failure(res, 'Request failed');
  return res.json();
}

// True when a request never got an answer (wrong address, firewall, Wi-Fi
// isolation), as opposed to the PC replying with an error.
export const isNetworkError = (err: unknown) => !(err instanceof HttpError);

// Pairs with the PC at `host` using the secret from its QR code. The secret
// itself is never sent: both sides derive the device key from it.
export async function pairWithQr(host: string, secret: string, deviceId: string, deviceName: string, scheme = 'http', certFingerprint?: string): Promise<Pairing> {
  const key = deviceKeyFromCode(secret, deviceId);
  const res = await postJSON(`${scheme}://${host}/pair`, {
    deviceId,
    name: deviceName,
    mac: hmacHex(key, `pair\n${deviceId}\n${deviceName}`)
  }, AbortSignal.timeout(REQUEST_TIMEOUT));
  const p = finishPairing(res, key, deviceId);
  p.scheme = scheme as 'http' | 'https';
  p.certFingerprint = certFingerprint;
  return p;
}

// Pairs with the PC at `host` knowing only its address: this device picks its
// own key, and the person at the PC approves the request in the terminal.
export async function pairWithApproval(host: string, deviceId: string, deviceName: string, scheme = 'http'): Promise<Pairing> {
  const key = randomBytes(32);
  const res = await postJSON(`${scheme}://${host}/pair`, {
    deviceId,
    name: deviceName,
    key: bytesToHex(key)
  }, AbortSignal.timeout(APPROVAL_TIMEOUT));
  const p = finishPairing(res, key, deviceId);
  p.scheme = scheme as 'http' | 'https';
  return p;
}

function finishPairing(res: any, key: Uint8Array, deviceId: string): Pairing {
  if (res.proof !== hmacHex(key, `paired\n${res.serverId}`)) {
    throw new Error('The PC could not prove it knows this device');
  }
  return { serverId: res.serverId, serverName: res.serverName, deviceId, deviceName: res.deviceName, key: bytesToHex(key) };
}

// HTTP side of the protocol: file data and transfer control. Every request is
// tied to a session, signed with its key, and its content is encrypted.
export class ServerApi {
  host = '';
  scheme: 'http' | 'https' = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'https' : 'http';
  private currentPairing: Pairing | null = null;
  private session: Promise<Session> | null = null;

  get pairing(): Pairing | null {
    return this.currentPairing;
  }

  set pairing(pairing: Pairing | null) {
    this.currentPairing = pairing;
    if (pairing?.scheme) {
      this.scheme = pairing.scheme;
    }
    this.session = null;
  }

  async unpair(): Promise<void> {
    try {
      await this.call('/unpair', {});
    } catch (err) {
      console.debug('Server unpair notice:', err);
    }
    this.currentPairing = null;
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
      const res = await postJSON(`${this.scheme}://${this.host}/hello`, {
        deviceId: pairing.deviceId,
        clientNonce: bytesToHex(clientNonce)
      }, AbortSignal.timeout(REQUEST_TIMEOUT));
      const key = sessionKey(hexToBytes(pairing.key), clientNonce, hexToBytes(res.serverNonce));
      if (res.proof !== hmacHex(key, 'server')) {
        throw new Error('The PC failed to prove its identity');
      }
      return { id: res.sessionId as string, key, cipher: new Cipher(key) };
    })();
    this.session = session;
    session.catch(() => {
      if (this.session === session) this.session = null;
    });
    return session;
  }

  // Every request carries a one-off nonce: it is covered by the signature and
  // ties the encrypted reply to this particular request.
  private async sign(method: string, path: string, params: Record<string, string> = {}, scheme?: string): Promise<SignedRequest> {
    const session = await (this.session || this.openSession());
    const nonce = randomHex(8);
    const signed = { ...params, sid: session.id, n: nonce };
    const query = new URLSearchParams({ ...signed, mac: signRequest(session.key, method, path, signed) });
    const effectiveScheme = scheme || this.scheme;
    return { url: `${effectiveScheme}://${this.host}${path}?${query}`, nonce, session };
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
    return this.withSession(async () => {
      const { url, nonce, session } = await this.sign('POST', path);
      const sealed = await session.cipher.seal(utf8ToBytes(JSON.stringify(body)), `req\n${path}\n${nonce}`);
      const res = await fetch(url, { method: 'POST', body: sealed as BodyInit, signal });
      if (!res.ok) throw await failure(res, 'Request failed');
      const reply = await session.cipher.open(new Uint8Array(await res.arrayBuffer()), `res\n${path}\n${nonce}`);
      return JSON.parse(new TextDecoder().decode(reply)) as T;
    });
  }

  uploadChunk(transferId: string, chunkIndex: number, data: Blob, signal?: AbortSignal): Promise<void> {
    return this.withSession(async () => {
      const { url, session } = await this.sign('POST', '/upload', { transferId, chunkIndex: String(chunkIndex) });
      const sealed = await session.cipher.seal(new Uint8Array(await data.arrayBuffer()), chunkContext(transferId, chunkIndex));
      const res = await fetch(url, { method: 'POST', body: sealed as BodyInit, signal });
      if (!res.ok) throw await failure(res, 'Chunk upload failed');
    });
  }

  downloadChunk(transferId: string, chunkIndex: number, signal?: AbortSignal): Promise<Uint8Array> {
    return this.withSession(async () => {
      const { url, session } = await this.sign('GET', '/download', { transferId, chunkIndex: String(chunkIndex) });
      const res = await fetch(url, { signal });
      if (!res.ok) throw await failure(res, 'Chunk download failed');
      return session.cipher.open(new Uint8Array(await res.arrayBuffer()), chunkContext(transferId, chunkIndex));
    });
  }

  // Link for the device's own download manager. It is authenticated but the
  // file travels unencrypted, because nothing outside the app can decrypt it.
  async directDownloadUrl(transferId: string): Promise<string> {
    return (await this.sign('GET', '/download_full', { transferId })).url;
  }

  // A WebSocket cannot report why a handshake was refused, so always start it
  // from a brand new session: that surfaces "not paired" and "unreachable" up
  // front. The session is then dedicated to that socket.
  async openSocket(): Promise<{ url: string; cipher: Cipher }> {
    await this.openSession();
    const wsScheme = this.scheme === 'https' ? 'wss' : 'ws';
    const { url, session } = await this.sign('GET', '/ws', {}, wsScheme);
    return { url, cipher: session.cipher };
  }
}
