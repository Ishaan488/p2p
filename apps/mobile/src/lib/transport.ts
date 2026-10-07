export type TransportStatus = 'connected' | 'disconnected' | 'connecting' | 'error';

export interface Transport {
  connect(url: string): Promise<void>;
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

  async connect(url: string): Promise<void> {
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
      this.ws = ws;

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
        if (current() && this.messageCallback) {
          this.messageCallback(event.data);
        }
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
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    }
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
