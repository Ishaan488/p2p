/**
 * MIME type from a file name. A Blob built without a type makes some Android WebViews refuse to play
 * video/audio ("can't play this file") even though the bytes are fine, so every Blob we build is typed.
 */
const MIME_BY_EXT: Record<string, string> = {
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska',
  avi: 'video/x-msvideo', '3gp': 'video/3gpp',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac',
  opus: 'audio/ogg', wma: 'audio/x-ms-wma',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif', heic: 'image/heic', heif: 'image/heif',
  pdf: 'application/pdf',
};

export function mimeFor(filename: string, declared?: string): string {
  if (declared && declared !== 'application/octet-stream') return declared;
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXT[ext] ?? declared ?? '';
}
