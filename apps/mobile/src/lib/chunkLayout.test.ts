import { describe, expect, it } from 'vitest';
import { chunkLayout, DEFAULT_DOWNLOAD_CHUNK } from './chunkLayout';

describe('chunkLayout', () => {
  it('uses the announced chunk size, not size/chunks (the corrupted-video bug)', () => {
    const total = 4_060_815; // 4 chunks of 1 MiB; guessing ceil(total/4) = 1_015_204 would misplace every chunk
    const l = chunkLayout(total, 4, DEFAULT_DOWNLOAD_CHUNK);
    expect(l.offsetOf(1)).toBe(1_048_576);
    expect(l.offsetOf(3)).toBe(3 * 1_048_576);
    expect(l.lengthOf(3)).toBe(total - 3 * 1_048_576);
  });
  it('falls back to the 1 MiB default when nothing was announced', () => {
    expect(chunkLayout(4_060_815, 4).chunkSize).toBe(DEFAULT_DOWNLOAD_CHUNK);
  });
  it('distrusts an announcement that contradicts the chunk count', () => {
    expect(chunkLayout(10_000, 4, 1 << 20).chunkSize).toBe(2500);
  });
  it('lengths add up to the file size', () => {
    const l = chunkLayout(5_000_001, 5, 1 << 20);
    let sum = 0;
    for (let i = 0; i < 5; i++) sum += l.lengthOf(i);
    expect(sum).toBe(5_000_001);
  });
});
