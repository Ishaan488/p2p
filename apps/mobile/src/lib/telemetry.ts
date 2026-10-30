// Real-time transfer telemetry: Exponential Moving Average (EMA) speed,
// dynamic ETA calculation, and media type detection.

export class SpeedTracker {
  private lastTime: number = 0;
  private lastBytes: number = 0;
  private emaSpeed: number = 0;
  // Smoothing factor: 0.28 balances responsiveness to sudden network changes with smooth display
  private readonly alpha: number = 0.28;

  reset() {
    this.lastTime = 0;
    this.lastBytes = 0;
    this.emaSpeed = 0;
  }

  update(currentBytes: number): number {
    const now = performance.now();
    if (this.lastTime === 0) {
      this.lastTime = now;
      this.lastBytes = currentBytes;
      return 0;
    }

    const dt = (now - this.lastTime) / 1000;
    if (dt < 0.12) {
      // Avoid sampling too frequently to eliminate micro-fluctuations
      return this.emaSpeed;
    }

    const deltaBytes = Math.max(0, currentBytes - this.lastBytes);
    const instantSpeed = deltaBytes / dt;

    if (this.emaSpeed === 0) {
      this.emaSpeed = instantSpeed;
    } else {
      this.emaSpeed = this.alpha * instantSpeed + (1 - this.alpha) * this.emaSpeed;
    }

    this.lastTime = now;
    this.lastBytes = currentBytes;
    return this.emaSpeed;
  }

  getSpeed(): number {
    return this.emaSpeed;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  if (!bytes || bytes < 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  if (i < 0) return '0 B';
  const val = (bytes / Math.pow(k, i)).toFixed(i === 0 ? 0 : 1);
  return `${val} ${sizes[i] || 'GB'}`;
}

export function formatSpeed(bytesPerSec: number): string {
  if (!bytesPerSec || bytesPerSec <= 0) return '0 B/s';
  const k = 1024;
  const sizes = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  const i = Math.floor(Math.log(bytesPerSec) / Math.log(k));
  if (i < 0) return '0 B/s';
  const val = (bytesPerSec / Math.pow(k, i)).toFixed(1);
  return `${val} ${sizes[i] || 'GB/s'}`;
}

export function calculateEta(remainingBytes: number, speedBytesPerSec: number): string {
  if (!speedBytesPerSec || speedBytesPerSec <= 0 || remainingBytes <= 0) {
    return 'Estimating...';
  }

  const seconds = Math.ceil(remainingBytes / speedBytesPerSec);
  if (seconds < 1) return '< 1s remaining';
  if (seconds < 60) return `${seconds}s remaining`;

  const minutes = Math.floor(seconds / 60);
  const remainingSecs = seconds % 60;
  if (minutes < 60) {
    return remainingSecs > 0 ? `${minutes}m ${remainingSecs}s remaining` : `${minutes}m remaining`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMins = minutes % 60;
  return `${hours}h ${remainingMins}m remaining`;
}

export type MediaKind = 'image' | 'audio' | 'video' | 'pdf' | 'code' | 'other';

export function getMediaKind(filename: string): MediaKind {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'].includes(ext)) {
    return 'image';
  }
  if (['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'opus', 'wma'].includes(ext)) {
    return 'audio';
  }
  if (['mp4', 'webm', 'mov', 'mkv', 'm4v', 'avi'].includes(ext)) {
    return 'video';
  }
  if (['pdf'].includes(ext)) {
    return 'pdf';
  }
  if ([
    'txt', 'log', 'json', 'md', 'go', 'ts', 'tsx', 'js', 'jsx', 'py', 'rs', 'c',
    'cpp', 'h', 'hpp', 'sh', 'bat', 'cmd', 'ps1', 'yaml', 'yml', 'xml', 'env',
    'toml', 'sql', 'css', 'scss', 'html', 'ini', 'conf', 'csv', 'tsv', 'java',
    'kt', 'swift', 'dart', 'php', 'rb'
  ].includes(ext)) {
    return 'code';
  }
  return 'other';
}

export function getLanguageLabel(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    ts: 'TypeScript',
    tsx: 'React TSX',
    js: 'JavaScript',
    jsx: 'React JSX',
    json: 'JSON',
    md: 'Markdown',
    go: 'Go',
    py: 'Python',
    rs: 'Rust',
    c: 'C',
    cpp: 'C++',
    h: 'Header',
    sh: 'Shell',
    bat: 'Batch',
    ps1: 'PowerShell',
    yaml: 'YAML',
    yml: 'YAML',
    xml: 'XML',
    sql: 'SQL',
    css: 'CSS',
    html: 'HTML',
    log: 'Log',
    txt: 'Text',
    env: 'Env',
    toml: 'TOML',
  };
  return map[ext] || ext.toUpperCase();
}

/**
 * Reads the first ~12 lines of a text/code file for quick inline preview.
 */
export async function extractTextSnippet(blobOrFile: Blob): Promise<{ snippet: string; totalLines: number; fullContent?: string }> {
  try {
    // Read up to 64KB for snippet inspection
    const slice = blobOrFile.slice(0, 64 * 1024);
    const text = await slice.text();
    const lines = text.split('\n');
    const totalLines = lines.length;
    const snippetLines = lines.slice(0, 10);
    const snippet = snippetLines.join('\n');
    return {
      snippet,
      totalLines,
      fullContent: blobOrFile.size < 512 * 1024 ? text : undefined
    };
  } catch (err) {
    console.error('Failed to extract text snippet:', err);
    return { snippet: '', totalLines: 0 };
  }
}
