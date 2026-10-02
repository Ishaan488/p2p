export interface Transport {
  connect(address: string): Promise<void>;
  disconnect(): void;
  send(data: string): void;
  isConnected(): boolean;
  onMessage(callback: (data: string) => void): void;
  onStatusChange(callback: (status: 'connected' | 'disconnected' | 'connecting' | 'error') => void): void;
}

export class WebSocketTransport implements Transport {
  private ws: WebSocket | null = null;
  private messageCallback: ((data: string) => void) | null = null;
  private statusCallback: ((status: 'connected' | 'disconnected' | 'connecting' | 'error') => void) | null = null;

  async connect(address: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.setStatus('connecting');

      const timeoutId = setTimeout(() => {
        if (this.ws && this.ws.readyState !== WebSocket.OPEN) {
          this.ws.close();
          this.setStatus('error');
          reject(new Error("Connection timed out. Are you on the same Wi-Fi network?"));
        }
      }, 4000);

      try {
        this.ws = new WebSocket(`ws://${address}/ws`);
        
        this.ws.onopen = () => {
          clearTimeout(timeoutId);
          this.setStatus('connected');
          resolve();
        };

        this.ws.onclose = () => {
          clearTimeout(timeoutId);
          this.setStatus('disconnected');
        };

        this.ws.onerror = () => {
          clearTimeout(timeoutId);
          this.setStatus('error');
          if (this.ws?.readyState !== WebSocket.OPEN) {
            reject(new Error("Connection failed"));
          }
        };

        this.ws.onmessage = (event) => {
          if (this.messageCallback) {
            this.messageCallback(event.data);
          }
        };
      } catch (err) {
        this.setStatus('error');
        reject(err);
      }
    });
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
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

  onStatusChange(callback: (status: 'connected' | 'disconnected' | 'connecting' | 'error') => void): void {
    this.statusCallback = callback;
  }

  private setStatus(status: 'connected' | 'disconnected' | 'connecting' | 'error') {
    if (this.statusCallback) {
      this.statusCallback(status);
    }
  }
}
