export class HttpError extends Error {
  constructor(public status: number, message: string, public body?: any) {
    super(message);
  }
}

// HTTP side of the protocol: file data and transfer control.
export class ServerApi {
  host = '';

  url(path: string, params: Record<string, string> = {}): string {
    const query = new URLSearchParams(params).toString();
    return `http://${this.host}${path}${query ? `?${query}` : ''}`;
  }

  // JSON request/response. The body is sent without a JSON content type on
  // purpose: it keeps the request "simple" so cross-origin calls skip preflight.
  async call<T = unknown>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const res = await fetch(this.url(path), { method: 'POST', body: JSON.stringify(body), signal });
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
    return data as T;
  }

  async uploadChunk(transferId: string, chunkIndex: number, data: Blob, signal?: AbortSignal): Promise<void> {
    const res = await fetch(this.url('/upload', { transferId, chunkIndex: String(chunkIndex) }), {
      method: 'POST',
      body: data,
      signal
    });
    if (!res.ok) {
      throw new HttpError(res.status, `Chunk upload failed (${res.status})`);
    }
  }

  downloadUrl(transferId: string): string {
    return this.url('/download_full', { transferId });
  }
}
