/**
 * MIME type from a file name. A Blob built without a type makes some Android WebViews refuse to play
 * video/audio ("can't play this file") even though the bytes are fine, so every Blob we build is typed.
 */
const MIME_BY_EXT: Record<string, string> = {
  // Video
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska',
  avi: 'video/x-msvideo', '3gp': 'video/3gpp',
  // Audio
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac',
  opus: 'audio/ogg', wma: 'audio/x-ms-wma',
  // Images
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif', heic: 'image/heic', heif: 'image/heif',
  // Documents & Office
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  odt: 'application/vnd.oasis.opendocument.text',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ppt: 'application/vnd.ms-powerpoint',
  odp: 'application/vnd.oasis.opendocument.presentation',
  rtf: 'application/rtf',
  txt: 'text/plain',
  md: 'text/markdown',
  epub: 'application/epub+zip',
  // Archives & Packages
  zip: 'application/zip',
  rar: 'application/vnd.rar',
  '7z': 'application/x-7z-compressed',
  tar: 'application/x-tar',
  gz: 'application/gzip',
  tgz: 'application/gzip',
  bz2: 'application/x-bzip2',
  xz: 'application/x-xz',
  apk: 'application/vnd.android.package-archive',
  // Web & Data
  json: 'application/json',
  xml: 'application/xml',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  yaml: 'application/x-yaml',
  yml: 'application/x-yaml',
  ics: 'text/calendar',
  vcf: 'text/vcard',
};

export function mimeFor(filename: string, declared?: string): string {
  if (declared && declared !== 'application/octet-stream') return declared;
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXT[ext] ?? declared ?? '';
}
