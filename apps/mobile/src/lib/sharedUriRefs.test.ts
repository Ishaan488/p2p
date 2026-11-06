import { describe, it, expect } from 'vitest';
import { SharedUriRefs } from './sharedUriRefs';

describe('shared content URIs used by several uploads', () => {
  it('is released only by the last upload to finish', () => {
    const refs = new SharedUriRefs();
    refs.retain('content://a', 3);
    expect(refs.release('content://a')).toBe(false);
    expect(refs.release('content://a')).toBe(false);
    expect(refs.holders('content://a')).toBe(1);
    expect(refs.release('content://a')).toBe(true);
    expect(refs.holders('content://a')).toBe(0);
  });

  it('releases a URI that was never counted at once (the single-upload case)', () => {
    expect(new SharedUriRefs().release('content://solo')).toBe(true);
  });

  it('counts a single retained upload like an uncounted one', () => {
    const refs = new SharedUriRefs();
    refs.retain('content://a', 1);
    expect(refs.release('content://a')).toBe(true);
  });

  it('keeps URIs independent and tolerates bad input', () => {
    const refs = new SharedUriRefs();
    refs.retain('content://a', 2);
    refs.retain('content://b', 2);
    expect(refs.release('content://a')).toBe(false);
    expect(refs.holders('content://b')).toBe(2);
    refs.retain('', 3);
    refs.retain('content://c', 0);
    refs.retain('content://c', -4);
    expect(refs.holders('content://c')).toBe(0);
  });

  it('a cancelled upload and a finished one together release exactly once', () => {
    const refs = new SharedUriRefs();
    refs.retain('content://a', 2);
    const results = [refs.release('content://a'), refs.release('content://a')];
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results[1]).toBe(true);
  });
});
