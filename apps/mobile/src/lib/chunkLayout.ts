/** The PC always cuts downloads into fixed-size chunks (default 1 MiB); only the last one is shorter. */
export const DEFAULT_DOWNLOAD_CHUNK = 1 << 20;

export interface ChunkLayout {
  chunkSize: number;
  /** Exact byte length chunk `index` must have. */
  lengthOf(index: number): number;
  /** Byte offset of chunk `index` inside the file. */
  offsetOf(index: number): number;
}

/**
 * Where each chunk belongs. The chunk size must come from the PC's announcement: guessing it from
 * totalSize/totalChunks is wrong for every file that is not an exact multiple of the chunk size, and
 * writing chunks at guessed offsets silently corrupts the file (videos stop playing, images tear).
 */
export function chunkLayout(totalSize: number, totalChunks: number, announced?: number): ChunkLayout {
  let chunkSize = announced && announced > 0 ? announced : DEFAULT_DOWNLOAD_CHUNK;
  // An announcement that does not produce the announced chunk count is untrustworthy.
  if (totalChunks > 0 && Math.ceil(totalSize / chunkSize) !== totalChunks) {
    chunkSize = Math.ceil(totalSize / totalChunks);
  }
  return {
    chunkSize,
    lengthOf: index => Math.max(0, Math.min(chunkSize, totalSize - index * chunkSize)),
    offsetOf: index => index * chunkSize,
  };
}
