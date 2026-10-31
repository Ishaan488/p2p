import { Cipher, utf8ToBytes } from './crypto';

export type TransportStatus = 'connected' | 'disconnected' | 'connecting' | 'error';

export interface Transport {
  connect(url: string, cipher: Cipher): Promise<void>;
  disconnect(): void;
  send(data: string): void;
  isConnected(): boolean;
  onMessage(callback: (data: string) => void): void;
  onStatusChange(callback: (status: TransportStatus) => void): void;
}

export class WebSocketTransport implements Transport {
  private ws: WebSocket | null = null;
  private messageCallback: ((data: string) => void) | null = null;
  private statusCallback: ((status: TransportStatus) => void) | null = null;
  // Sealing and opening are async, so both directions run through a queue
  // that keeps frames in order.
  private cipher: Cipher | null = null;
  private outbox: Promise<void> = Promise.resolve();
  private inbox: Promise<void> = Promise.resolve();
  private sent = 0;
  private received = 0;

  // Every frame is encrypted with the session's cipher and numbered, so a
  // frame that is forged, replayed or out of order fails to open.
  async connect(url: string, cipher: Cipher): Promise<void> {
    return new Promise((resolve, reject) => {
      this.disconnect();
      this.setStatus('connecting');

      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch (err) {
        this.setStatus('error');
        reject(err);
        return;
      }
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      this.cipher = cipher;
      this.outbox = this.inbox = Promise.resolve();
      this.sent = this.received = 0;

      // Events from a socket that has since been replaced must not touch the status.
      const current = () => this.ws === ws;

      const timeoutId = setTimeout(() => {
        if (current() && ws.readyState !== WebSocket.OPEN) {
          ws.close();
          this.ws = null;
          this.setStatus('error');
          reject(new Error("Connection timed out. Are you on the same Wi-Fi network?"));
        }
      }, 4000);

      ws.onopen = () => {
        clearTimeout(timeoutId);
        if (!current()) return;
        this.setStatus('connected');
        resolve();
      };

      ws.onclose = () => {
        clearTimeout(timeoutId);
        if (!current()) return;
        this.ws = null;
        this.setStatus('disconnected');
      };

      ws.onerror = () => {
        clearTimeout(timeoutId);
        if (!current()) return;
        const wasOpen = ws.readyState === WebSocket.OPEN;
        this.setStatus('error');
        if (!wasOpen) {
          this.ws = null;
          reject(new Error("Connection failed"));
        }
      };

      ws.onmessage = (event) => {
        this.inbox = this.inbox.then(async () => {
          if (!current()) return;
          try {
            const frame = await cipher.open(new Uint8Array(event.data as ArrayBuffer), `s2c\n${this.received++}`);
            if (current() && this.messageCallback) {
              this.messageCallback(new TextDecoder().decode(frame));
            }
          } catch {
            // The stream can no longer be trusted (or is out of step): start over.
            if (current()) ws.close();
          }
        });
      };
    });
  }

  disconnect(): void {
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.close();
    }
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  send(data: string): void {
    const ws = this.ws;
    const cipher = this.cipher;
    if (!ws || !cipher || ws.readyState !== WebSocket.OPEN) return;
    this.outbox = this.outbox.then(async () => {
      if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(await cipher.seal(utf8ToBytes(data), `c2s\n${this.sent++}`));
    });
  }

  onMessage(callback: (data: string) => void): void {
    this.messageCallback = callback;
  }

  onStatusChange(callback: (status: TransportStatus) => void): void {
    this.statusCallback = callback;
  }

  private setStatus(status: TransportStatus) {
    if (this.statusCallback) {
      this.statusCallback(status);
    }
  }
}
